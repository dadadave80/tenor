// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ITenorMarket
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Sell listings and taker fills for ATS security tokens, settled atomically against USDC.
/// @dev The market never custodies a security token. A listing reserves the seller's tokens through an ATS
///      hold whose escrow is the diamond; the tokens stay in the seller's balance until a buyer fills, at
///      which point `executeHoldByPartition` moves them and enforces every ATS compliance rule (KYC on both
///      parties, control lists, pause) inside the token. Tenor holds no compliance logic of its own.
interface ITenorMarket {
    //*//////////////////////////////////////////////////////////////////////////
    //                                   TYPES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice A live sell listing and the ATS hold backing it.
    /// @param token The ATS security token (itself a diamond).
    /// @param partition The ATS partition the hold lives under (the token's single default partition).
    /// @param seller The listing owner, and the holder whose balance the hold reserves.
    /// @param holdId The id the token assigned the hold, returned by `createHoldFromByPartition`.
    /// @param remaining Tokens still available; mirrors the hold's outstanding amount.
    /// @param pricePerToken USDC atomic units (6 dp) per WHOLE security token.
    /// @param expiry Listing deadline; equals the hold's `expirationTimestamp`.
    /// @param tokenDecimals The security token's decimals, cached at listing time.
    /// @param active False once the listing is filled out, cancelled, or expired.
    struct Listing {
        address token;
        bytes32 partition;
        address seller;
        uint256 holdId;
        uint256 remaining;
        uint256 pricePerToken;
        uint64 expiry;
        uint8 tokenDecimals;
        bool active;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   EVENTS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice A listing was created and its backing hold placed, in one transaction.
    event Listed(
        uint256 indexed id,
        address indexed token,
        address indexed seller,
        bytes32 partition,
        uint256 holdId,
        uint256 amount,
        uint256 pricePerToken,
        uint64 expiry
    );

    /// @notice A buyer filled part or all of a listing. `cost` is gross; the seller received `cost - fee`.
    event Filled(uint256 indexed id, address indexed buyer, uint256 amount, uint256 cost, uint256 fee);

    /// @notice The seller cancelled a live listing; `released` tokens returned to their available balance.
    event Cancelled(uint256 indexed id, uint256 released);

    /// @notice A listing was marked expired. The seller reclaims on the token itself.
    event Expired(uint256 indexed id);

    /// @notice The protocol fee changed.
    event FeeUpdated(uint16 feeBps);

    /// @notice The listing lifetime cap changed.
    event MaxDurationUpdated(uint64 maxDuration);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ERRORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The listing is filled out, cancelled, expired, or was never created.
    error ListingNotActive(uint256 id);

    /// @notice The listing is past its expiry and can no longer be filled or cancelled.
    error ListingExpired(uint256 id);

    /// @notice Only the listing's seller may do this.
    error NotSeller(uint256 id);

    /// @notice The listing has not reached its expiry yet.
    error ListingNotExpired(uint256 id, uint64 expiry);

    /// @notice Amount is zero, or exceeds the listing's remaining tokens.
    error InvalidAmount();

    /// @notice `pricePerToken` is zero.
    error InvalidPrice();

    /// @notice `expiry` is not strictly in the future, or exceeds `maxDuration`.
    error InvalidExpiry(uint64 expiry, uint64 minExpiry, uint64 maxExpiry);

    /// @notice The fill rounds to zero USDC. Raise the amount.
    error ZeroCost();

    /// @notice `feeBps` exceeds the 100 bp (1%) ceiling.
    error FeeTooHigh(uint16 feeBps);

    /// @notice The token reported failure creating the hold without reverting.
    error HoldCreationFailed(address token, address seller);

    /// @notice `token` is not the security token this venue trades.
    /// @dev The market is pinned to one instrument at initialisation. Accepting an arbitrary token would
    ///      let a seller settle a fill against a contract of their own choosing: `fill` pays the seller
    ///      before the delivery leg completes, so a fake token that reports a hold and then delivers
    ///      nothing would take the buyer's USDC for nothing.
    error TokenNotListable(address token, address expected);

    /// @notice A hold call on the token returned `false` instead of reverting.
    error HoldCallFailed(address token, uint256 id);

    /// @notice The token reports more decimals than the market can price against.
    error UnsupportedDecimals(address token, uint8 decimals);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   WRITES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Reserves `amount` of the caller's tokens through an ATS hold and records a listing, atomically.
    /// @dev Requires the caller to have approved the diamond for at least `amount` on `token` — that ERC-20
    ///      allowance is the seller's self-imposed selling cap, and the token consumes it on hold creation.
    ///      Escrow, recipient and expiry of the hold are set by the diamond, never taken from calldata, so a
    ///      listing can never exist without its hold and a Tenor hold never without its listing.
    /// @return id The new listing id.
    function list(address token, bytes32 partition, uint256 amount, uint256 pricePerToken, uint64 expiry)
        external
        returns (uint256 id);

    /// @notice Buys `amount` tokens from listing `id`: USDC buyer to seller, tokens via hold execution.
    /// @dev Requires the caller to have approved the diamond for the full `cost` on USDC. Any ATS compliance
    ///      failure — unverified buyer, frozen account, paused token — reverts the whole fill, USDC included.
    function fill(uint256 id, uint256 amount) external;

    /// @notice Cancels a live listing, releasing the remaining hold and restoring the seller's allowance.
    function cancel(uint256 id) external;

    /// @notice Marks an expired listing inactive. Callable by anyone; the seller reclaims on the token.
    function expire(uint256 id) external;

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ADMIN
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Sets the protocol fee in basis points, capped at 100 (1%). Requires `DEFAULT_ADMIN_ROLE`.
    function setFeeBps(uint16 feeBps) external;

    /// @notice Sets the cap on how far ahead a listing may expire. Requires `DEFAULT_ADMIN_ROLE`.
    function setMaxDuration(uint64 maxDuration) external;

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns listing `id`.
    function getListing(uint256 id) external view returns (Listing memory listing);

    /// @notice The gross USDC cost and protocol fee for buying `amount` from listing `id`.
    /// @dev `cost = amount * pricePerToken / 10**tokenDecimals`, floored; `fee = cost * feeBps / 10_000`.
    ///      The seller receives `cost - fee`. Reverts for no listing; returns zeroes only for a zero amount.
    function quote(uint256 id, uint256 amount) external view returns (uint256 cost, uint256 fee);

    /// @notice The id the next listing will take.
    function nextListingId() external view returns (uint256 id);

    /// @notice The USDC token the market settles in.
    function usdc() external view returns (address usdcToken);

    /// @notice The protocol fee in basis points.
    function feeBps() external view returns (uint16 bps);

    /// @notice The cap on listing lifetime, in seconds.
    function maxDuration() external view returns (uint64 duration);

    /// @notice The one ATS security token this venue trades.
    function securityToken() external view returns (address token);
}
