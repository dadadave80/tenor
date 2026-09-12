// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IHoldTypes} from "@ats/facets/hold/IHoldTypes.sol";
import {IHoldByPartition} from "@ats/facets/holdByPartition/IHoldByPartition.sol";
import {ERC165Lib} from "@diamond/libraries/ERC165Lib.sol";
import {AccessControlLib} from "@lattice/access/libraries/AccessControlLib.sol";
import {PausableLib} from "@lattice/security/libraries/PausableLib.sol";
import {ReentrancyGuardLib} from "@lattice/security/libraries/ReentrancyGuardLib.sol";
import {InitializableLib} from "@lattice/utils/libraries/InitializableLib.sol";
import {Math} from "@lattice/utils/libraries/math/Math.sol";
import {TenorHTS} from "../TenorHTS.sol";
import {ITenorMarket} from "../interfaces/ITenorMarket.sol";

//*//////////////////////////////////////////////////////////////////////////
//                                  STORAGE
//////////////////////////////////////////////////////////////////////////*//

/// @dev `keccak256(abi.encode(uint256(keccak256("tenor.market.storage")) - 1)) & ~bytes32(uint256(0xff))`.
bytes32 constant MARKET_STORAGE_SLOT = 0x7113f4ea48b464025de9021bd84366679935cf65db6bede5d56e7a18c914bb00;

/// @dev Hard ceiling on the protocol fee: 100 bp (1%). Not raisable by an admin.
uint16 constant MARKET_MAX_FEE_BPS = 100;

/// @dev Basis-point denominator for the fee cut of a fill's gross cost.
uint256 constant MARKET_BPS_DENOMINATOR = 10_000;

/// @dev Ceiling on a listed token's `decimals()`. `10 ** decimals` is the divisor in every `cost`, so an
///      absurd value would overflow the exponentiation and leave the listing permanently unfillable. 36 is
///      far above any real security token (ATS issues this instrument at 6) and far below `uint256`'s limit.
uint8 constant MARKET_MAX_TOKEN_DECIMALS = 36;

/// @notice The single ERC-20 view the market needs from a security token.
/// @dev Declared locally rather than pulling in an ERC-20 library for one getter. ATS serves it from its
///      `Core` facet (`ICore.decimals()`), so every ATS-issued token answers it. Read once per listing and
///      cached on the {ITenorMarket.Listing} — see `docs/SPEC.md` [DEV-6].
interface IERC20Decimals {
    /// @notice The number of decimals the token's balances are denominated in.
    /// @return decimals_ The token's decimals.
    function decimals() external view returns (uint8 decimals_);
}

/// @notice ERC-7201 namespaced storage for TenorMarket.
/// @custom:storage-location erc7201:tenor.market.storage
struct MarketStorage {
    /// @notice The HTS USDC token every fill and fee settles in.
    address usdc;
    /// @notice The ONE ATS security token this venue trades. Fixed at initialisation.
    /// @dev A listing names its token, but the named token is checked against this. Without that check
    ///      `fill` would pay a seller real USDC on the say-so of a seller-supplied contract: a fake
    ///      token can return success from `createHoldFromByPartition` and then do nothing on
    ///      `executeHoldByPartition`, leaving the buyer paid-up and empty-handed. Tenor is a
    ///      single-instrument venue, so pinning the token closes that hole outright.
    address securityToken;
    /// @notice Protocol fee taken from a fill's gross cost, in basis points. Never above `MARKET_MAX_FEE_BPS`.
    uint16 feeBps;
    /// @notice Cap on how far past `block.timestamp` a listing may expire, in seconds.
    uint64 maxDuration;
    /// @notice The id the next listing will take. MONOTONIC — ids are never reused.
    uint256 nextId;
    /// @notice Every listing ever created, by id. Entries are never deleted, only deactivated.
    mapping(uint256 listingId => ITenorMarket.Listing listing) listings;
}

/// @title TenorMarketLib
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Logic + ERC-7201 storage for Tenor's sell-listing market: listing, filling, cancelling and
///         expiring reservations of ATS security tokens against USDC.
/// @dev The market never custodies a security token. `list` reserves the seller's balance with an ATS hold
///      whose escrow is the diamond — `escrow`, `to` and `expirationTimestamp` are set here, never taken from
///      calldata — and `fill` moves the tokens with `executeHoldByPartition`, which enforces every ATS
///      compliance rule (KYC on both parties, control lists, pause) inside the token itself.
///
///      The USDC leg goes through {TenorHTS}, i.e. straight to `0x167`, because `fill` is permissionless and
///      Lattice's {HTSAdapterLib} gates every mutating helper on the *caller's* role — see
///      `docs/GROUND-TRUTH.md` §2.2 [DEV-1]. Fees accumulate on the diamond and leave through Lattice's HTS
///      facet under `HTS_OPERATOR_ROLE`, so there is deliberately no `withdrawFees` here [DEV-2].
library TenorMarketLib {
    //*//////////////////////////////////////////////////////////////////////////
    //                                  STORAGE
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns the ERC-7201 storage struct for TenorMarket.
    /// @return $ Reference to the market storage struct at `MARKET_STORAGE_SLOT`.
    function marketStorage() internal pure returns (MarketStorage storage $) {
        assembly {
            $.slot := MARKET_STORAGE_SLOT
        }
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                              INITIALISATION
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Seeds the market's configuration and registers its ERC-165 interface id.
    /// @dev Must be called between `preInitializer` / `postInitializer` — `TenorInit` is delegatecalled by
    ///      `Diamond.initialize` inside the initializing window, so it calls this directly. `nextId` needs no
    ///      seeding (the first listing takes id 0) and `feeBps` is validated against the same ceiling
    ///      {setFeeBps} enforces, so an over-cap fee can never be installed at deploy time either.
    /// @param usdcToken The HTS USDC token the market settles in.
    /// @param token The ATS security token this venue trades; the only token `list` will accept.
    /// @param initialFeeBps The starting protocol fee in basis points; at most `MARKET_MAX_FEE_BPS`.
    /// @param initialMaxDuration The starting cap on listing lifetime, in seconds.
    function __TenorMarket_init(address usdcToken, address token, uint16 initialFeeBps, uint64 initialMaxDuration)
        internal
    {
        InitializableLib.checkInitializing(InitializableLib.initializableSlot());
        if (initialFeeBps > MARKET_MAX_FEE_BPS) revert ITenorMarket.FeeTooHigh(initialFeeBps);

        MarketStorage storage $ = marketStorage();
        $.usdc = usdcToken;
        $.securityToken = token;
        $.feeBps = initialFeeBps;
        $.maxDuration = initialMaxDuration;

        registerInterface();

        emit ITenorMarket.FeeUpdated(initialFeeBps);
        emit ITenorMarket.MaxDurationUpdated(initialMaxDuration);
    }

    /// @notice Registers the ITenorMarket ERC-165 interface id in the diamond's shared ERC-165 map.
    function registerInterface() internal {
        ERC165Lib.erc165Storage().supportedInterfaces[type(ITenorMarket).interfaceId] = true;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   WRITES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Reserves `amount` of the caller's tokens with an ATS hold and records a listing, atomically.
    /// @dev The id is assigned BEFORE the hold is created so the hold's `data` can carry it, which is what ties
    ///      a hold on the token back to its listing. The token itself verifies the seller's balance and the
    ///      ERC-20 allowance granted to the diamond, and reverts otherwise; a non-reverting `false` surfaces as
    ///      {ITenorMarket.HoldCreationFailed}. Decimals are cached here so `quote` and `fill` need no external
    ///      call [DEV-6]. Blocked while the market is paused.
    /// @param token The ATS security token to list; must equal the venue's configured security token.
    /// @param partition The ATS partition to hold under (the token's single default partition).
    /// @param amount The number of tokens to reserve, in the token's atomic units.
    /// @param pricePerToken USDC atomic units (6 dp) per WHOLE security token.
    /// @param expiry The listing deadline, also the hold's expiration timestamp.
    /// @return id The new listing id.
    function list(address token, bytes32 partition, uint256 amount, uint256 pricePerToken, uint64 expiry)
        internal
        returns (uint256 id)
    {
        PausableLib.checkNotPaused();
        if (amount == 0) revert ITenorMarket.InvalidAmount();
        if (pricePerToken == 0) revert ITenorMarket.InvalidPrice();

        MarketStorage storage $ = marketStorage();
        // The token is named in calldata but never trusted from it. `fill` pays the seller before the
        // delivery leg settles, so a seller-supplied contract that fakes a hold could take a buyer's
        // USDC and deliver nothing. This venue trades one instrument, so the named token must be it.
        if (token != $.securityToken) revert ITenorMarket.TokenNotListable(token, $.securityToken);

        uint64 minExpiry = uint64(block.timestamp) + 1;
        uint256 latest = block.timestamp + $.maxDuration;
        uint64 maxExpiry = latest > type(uint64).max ? type(uint64).max : uint64(latest);
        if (expiry < minExpiry || expiry > maxExpiry) {
            revert ITenorMarket.InvalidExpiry(expiry, minExpiry, maxExpiry);
        }

        id = $.nextId++;

        uint256 holdId = _createHold(token, partition, amount, expiry, id);
        uint8 decimals_ = _checkedDecimals(token);

        $.listings[id] = ITenorMarket.Listing({
            token: token,
            partition: partition,
            seller: msg.sender,
            holdId: holdId,
            remaining: amount,
            pricePerToken: pricePerToken,
            expiry: expiry,
            tokenDecimals: decimals_,
            active: true
        });

        emit ITenorMarket.Listed(id, token, msg.sender, partition, holdId, amount, pricePerToken, expiry);
    }

    /// @notice Buys `amount` tokens from listing `id`: USDC buyer to seller, tokens by hold execution.
    /// @dev Checks-effects-interactions: `remaining` is decremented and the listing deactivated at zero BEFORE
    ///      any external call, so a callback from the token or a compliance module can never see stale supply —
    ///      and the reentrancy lock rejects it regardless. The USDC legs run first and the hold execution last,
    ///      because the hold execution is the leg that enforces ATS compliance: an unverified buyer, a frozen
    ///      account or a paused token reverts the whole transaction, USDC included. Blocked while paused.
    /// @param id The listing to fill.
    /// @param amount The number of tokens to buy; must be within the listing's remaining amount.
    function fill(uint256 id, uint256 amount) internal {
        ReentrancyGuardLib.entry();
        PausableLib.checkNotPaused();

        MarketStorage storage $ = marketStorage();
        ITenorMarket.Listing storage listing = $.listings[id];

        if (!listing.active) revert ITenorMarket.ListingNotActive(id);
        if (block.timestamp >= listing.expiry) revert ITenorMarket.ListingExpired(id);
        if (amount == 0 || amount > listing.remaining) revert ITenorMarket.InvalidAmount();

        (uint256 cost, uint256 fee) = _quote(listing, $.feeBps, amount);

        address token = listing.token;
        bytes32 partition = listing.partition;
        address seller = listing.seller;
        uint256 holdId = listing.holdId;
        address usdcToken = $.usdc;

        // Effects.
        uint256 left = listing.remaining - amount;
        listing.remaining = left;
        if (left == 0) listing.active = false;

        // Interactions.
        TenorHTS.transferFrom(usdcToken, msg.sender, seller, cost - fee);
        if (fee > 0) TenorHTS.transferFrom(usdcToken, msg.sender, address(this), fee);
        (bool delivered,) = IHoldByPartition(token)
            .executeHoldByPartition(
                IHoldTypes.HoldIdentifier({partition: partition, tokenHolder: seller, holdId: holdId}),
                msg.sender,
                amount
            );
        // The seller has already been paid at this point, so a delivery leg that reports failure
        // without reverting must take the payment down with it. ATS reverts instead of returning
        // false, but this is the one place where trusting that would cost the buyer their money.
        if (!delivered) revert ITenorMarket.HoldCallFailed(token, id);

        emit ITenorMarket.Filled(id, msg.sender, amount, cost, fee);

        ReentrancyGuardLib.exit();
    }

    /// @notice Cancels a live listing, releasing the rest of its hold back to the seller's available balance.
    /// @dev Seller only, and only before expiry — after expiry the seller reclaims on the token itself, which
    ///      is the only path the token allows. Releasing restores the seller's ERC-20 allowance to the diamond
    ///      by exactly the released amount, because the token recorded the diamond as the hold's third party.
    ///      Deliberately NOT blocked while the market is paused: a seller must always be able to unwind.
    /// @param id The listing to cancel.
    function cancel(uint256 id) internal {
        ReentrancyGuardLib.entry();

        ITenorMarket.Listing storage listing = marketStorage().listings[id];

        // Existence before ownership: an id that was never created has `seller == address(0)`, and
        // reporting that as `NotSeller` would be misleading. `fill`, `expire` and `quote` all lead with
        // the existence check, so `cancel` matches them.
        if (!listing.active) revert ITenorMarket.ListingNotActive(id);
        if (listing.seller != msg.sender) revert ITenorMarket.NotSeller(id);
        if (block.timestamp >= listing.expiry) revert ITenorMarket.ListingExpired(id);

        uint256 released = listing.remaining;
        listing.remaining = 0;
        listing.active = false;

        bool released_ = IHoldByPartition(listing.token)
            .releaseHoldByPartition(
                IHoldTypes.HoldIdentifier({
                    partition: listing.partition, tokenHolder: msg.sender, holdId: listing.holdId
                }),
                released
            );
        // ATS reverts rather than returning false, so this is belt-and-braces — but a hold call that
        // reports failure must never be treated as settled.
        if (!released_) revert ITenorMarket.HoldCallFailed(listing.token, id);

        emit ITenorMarket.Cancelled(id, released);

        ReentrancyGuardLib.exit();
    }

    /// @notice Marks an expired listing inactive so the market's view of it matches the token's.
    /// @dev Permissionless and touches no token: after `expirationTimestamp` the ATS hold can only be reclaimed
    ///      by its holder, so the seller calls `reclaimHoldByPartition` on the token directly and this call
    ///      exists purely to settle Tenor's own state. `remaining` is left as it was, so a client can still
    ///      show how much there is to reclaim.
    /// @param id The listing to mark expired.
    function expire(uint256 id) internal {
        ITenorMarket.Listing storage listing = marketStorage().listings[id];

        if (!listing.active) revert ITenorMarket.ListingNotActive(id);
        if (block.timestamp < listing.expiry) revert ITenorMarket.ListingNotExpired(id, listing.expiry);

        listing.active = false;

        emit ITenorMarket.Expired(id);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ADMIN
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Sets the protocol fee in basis points. Caller must hold `DEFAULT_ADMIN_ROLE`.
    /// @dev Capped at `MARKET_MAX_FEE_BPS` (100 bp), which together with the floored fee split keeps
    ///      `fee <= cost` for every fill. Live listings price off the fee current at fill time.
    /// @param newFeeBps The new fee in basis points.
    function setFeeBps(uint16 newFeeBps) internal {
        AccessControlLib.checkRole(0x00);
        if (newFeeBps > MARKET_MAX_FEE_BPS) revert ITenorMarket.FeeTooHigh(newFeeBps);

        marketStorage().feeBps = newFeeBps;

        emit ITenorMarket.FeeUpdated(newFeeBps);
    }

    /// @notice Sets the cap on how far ahead a listing may expire. Caller must hold `DEFAULT_ADMIN_ROLE`.
    /// @dev Bounds how long a seller's tokens can stay reserved. Only new listings are affected; existing
    ///      holds keep the expiry they were created with.
    /// @param newMaxDuration The new cap on listing lifetime, in seconds.
    function setMaxDuration(uint64 newMaxDuration) internal {
        AccessControlLib.checkRole(0x00);

        marketStorage().maxDuration = newMaxDuration;

        emit ITenorMarket.MaxDurationUpdated(newMaxDuration);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns listing `id`.
    /// @param id The listing to read.
    /// @return listing A copy of the stored listing; zero-valued for an id that was never used.
    function getListing(uint256 id) internal view returns (ITenorMarket.Listing memory listing) {
        return marketStorage().listings[id];
    }

    /// @notice The gross USDC cost and protocol fee for buying `amount` from listing `id`.
    /// @dev Same arithmetic `fill` uses, so a client's quote and its fill agree to the unit. Reverts
    ///      {ITenorMarket.ListingNotActive} for a listing that was never created and
    ///      {ITenorMarket.ZeroCost} when a non-zero amount rounds to nothing; a zero amount returns zeroes.
    ///      A quote is deliberately available for an inactive or expired listing, so a client can render a
    ///      historical fill without special-casing.
    /// @param id The listing to quote.
    /// @param amount The number of tokens to price.
    /// @return cost The gross USDC cost, floored.
    /// @return fee The protocol fee taken out of `cost`; the seller receives `cost - fee`.
    function quote(uint256 id, uint256 amount) internal view returns (uint256 cost, uint256 fee) {
        MarketStorage storage $ = marketStorage();
        ITenorMarket.Listing storage listing = $.listings[id];

        if (listing.seller == address(0)) revert ITenorMarket.ListingNotActive(id);
        if (amount == 0) return (0, 0);

        return _quote(listing, $.feeBps, amount);
    }

    /// @notice The id the next listing will take.
    /// @return id The next listing id.
    function nextListingId() internal view returns (uint256 id) {
        return marketStorage().nextId;
    }

    /// @notice The one ATS security token this venue trades.
    /// @return token The configured security token.
    function securityToken() internal view returns (address token) {
        token = marketStorage().securityToken;
    }

    /// @notice The HTS USDC token the market settles in.
    /// @return usdcToken The settlement token.
    function usdc() internal view returns (address usdcToken) {
        return marketStorage().usdc;
    }

    /// @notice The protocol fee in basis points.
    /// @return bps The current fee.
    function feeBps() internal view returns (uint16 bps) {
        return marketStorage().feeBps;
    }

    /// @notice The cap on listing lifetime, in seconds.
    /// @return duration The current cap.
    function maxDuration() internal view returns (uint64 duration) {
        return marketStorage().maxDuration;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 INTERNALS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Places the ATS hold backing listing `id` and returns the id the token assigned it.
    ///      Extracted from {list} so its locals do not have to be live alongside the rest — together
    ///      they overflow the EVM's stack slots under the non-IR optimiser.
    ///
    ///      Escrow, recipient and expiry are set HERE, never taken from calldata: the escrow is the
    ///      diamond (so only the diamond can execute the hold), the recipient is left open so the
    ///      buyer can be chosen at fill time, and `data` carries the listing id so a hold on the token
    ///      can always be traced back to its listing.
    /// @param token The ATS security token.
    /// @param partition The partition to hold under.
    /// @param amount Tokens to reserve.
    /// @param expiry The hold's expiration timestamp, equal to the listing's.
    /// @param id The listing id, recorded in the hold's `data`.
    /// @return holdId The id the token assigned the hold.
    function _createHold(address token, bytes32 partition, uint256 amount, uint64 expiry, uint256 id)
        private
        returns (uint256 holdId)
    {
        bool success;
        (success, holdId) = IHoldByPartition(token)
            .createHoldFromByPartition(
                partition,
                msg.sender,
                IHoldTypes.Hold({
                    amount: amount,
                    expirationTimestamp: uint256(expiry),
                    escrow: address(this),
                    to: address(0),
                    data: abi.encode(id)
                }),
                ""
            );
        if (!success) revert ITenorMarket.HoldCreationFailed(token, msg.sender);
    }

    /// @dev The token's decimals, rejected if too large to price against.
    ///      `10 ** decimals` is the divisor in every later `quote` and `fill` for the listing, so an
    ///      absurd value is caught at the one point it is read rather than by a buyer whose fill reverts.
    /// @param token The ATS security token.
    /// @return decimals_ The token's decimals.
    function _checkedDecimals(address token) private view returns (uint8 decimals_) {
        decimals_ = IERC20Decimals(token).decimals();
        if (decimals_ > MARKET_MAX_TOKEN_DECIMALS) revert ITenorMarket.UnsupportedDecimals(token, decimals_);
    }

    /// @dev `cost = amount * pricePerToken / 10**tokenDecimals` and `fee = cost * feeBps / 10_000`, both
    ///      floored and both full-precision: {Math.mulDiv} carries the intermediate product in 512 bits, so a
    ///      large amount times a large price cannot overflow into a wrong cost. `fee <= cost` holds because
    ///      `feeBps <= MARKET_MAX_FEE_BPS`. Reverts {ITenorMarket.ZeroCost} on a dust fill that rounds to zero
    ///      USDC, which would otherwise hand over tokens for nothing. Assumes a non-zero `amount`.
    /// @param listing The listing being priced.
    /// @param currentFeeBps The fee in basis points to apply.
    /// @param amount The number of tokens being priced; must be non-zero.
    /// @return cost The gross USDC cost.
    /// @return fee The protocol fee taken out of `cost`.
    function _quote(ITenorMarket.Listing storage listing, uint16 currentFeeBps, uint256 amount)
        private
        view
        returns (uint256 cost, uint256 fee)
    {
        cost = Math.mulDiv(amount, listing.pricePerToken, 10 ** uint256(listing.tokenDecimals));
        if (cost == 0) revert ITenorMarket.ZeroCost();
        fee = Math.mulDiv(cost, currentFeeBps, MARKET_BPS_DENOMINATOR);
    }
}
