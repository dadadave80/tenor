// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IHoldTypes} from "@ats/facets/hold/IHoldTypes.sol";
import {FacetCut} from "@diamond/libraries/DiamondLib.sol";
import {IAccessControl} from "@lattice/interfaces/access/IAccessControl.sol";
import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaTokenService} from "@lattice/interfaces/external/hedera/IHederaTokenService.sol";
import {IPausable} from "@lattice/interfaces/security/IPausable.sol";
import {IReentrancyGuard} from "@lattice/interfaces/security/IReentrancyGuard.sol";
import {IHTSAdapter} from "@lattice/interfaces/tokens/IHTSAdapter.sol";
import {DeployTenor} from "../script/DeployTenor.s.sol";
import {ITenorMarket} from "../src/interfaces/ITenorMarket.sol";
import {MARKET_MAX_FEE_BPS, MARKET_MAX_TOKEN_DECIMALS} from "../src/market/TenorMarketLib.sol";
import {Tenor} from "../src/Tenor.sol";
import {TenorHTS} from "../src/TenorHTS.sol";
import {MockATSToken} from "./mocks/MockATSToken.sol";
import {TenorTestBase} from "./TenorTestBase.sol";

/// @title ReentrantATSToken
/// @notice A HOSTILE stand-in for the ATS security token whose hold calls re-enter the market.
/// @dev Exists for one reason: SPEC §6.4 claims `fill` and `cancel` are `nonReentrant`, and the only
///      untrusted contract either of them calls is the security token. The market is PINNED to one token at
///      initialisation, so the attack can only be mounted from a venue pinned to this token — hence the
///      second diamond the reentrancy tests assemble. The hooks fire from `executeHoldByPartition` (the
///      delivery leg of `fill`) and `releaseHoldByPartition` (the release leg of `cancel`), which are exactly
///      the two call-outs the guard has to survive. `createHoldFromByPartition` deliberately carries NO hook:
///      `list` is not guarded (by design — it makes no payment), so re-entering it would only recurse.
contract ReentrantATSToken {
    /// @notice Which market function the next hold call-out should try to re-enter.
    enum Hook {
        None,
        Fill,
        Cancel
    }

    /// @notice Decimals, read once per listing by the market [DEV-6].
    uint8 public constant decimals = 6;

    /// @notice The venue to re-enter.
    address public market;
    /// @notice Hook fired from the delivery leg.
    Hook public onExecute;
    /// @notice Hook fired from the release leg.
    Hook public onRelease;
    /// @notice The listing the re-entrant call targets.
    uint256 public attackId;
    /// @notice The amount the re-entrant `fill` asks for.
    uint256 public attackAmount;

    /// @notice Arms the hooks. Called by the test between setup and the call under attack.
    function arm(address market_, Hook onExecute_, Hook onRelease_, uint256 id_, uint256 amount_) external {
        market = market_;
        onExecute = onExecute_;
        onRelease = onRelease_;
        attackId = id_;
        attackAmount = amount_;
    }

    /// @notice Reports a hold without doing any accounting — enough for `list` to record a listing.
    function createHoldFromByPartition(bytes32, address, IHoldTypes.Hold calldata, bytes calldata)
        external
        pure
        returns (bool success_, uint256 holdId_)
    {
        return (true, 1);
    }

    /// @notice The delivery leg of `fill`, with the re-entrancy attempt wired in.
    function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata idf, address, uint256)
        external
        returns (bool success_, bytes32 partition_)
    {
        _fire(onExecute);
        return (true, idf.partition);
    }

    /// @notice The release leg of `cancel`, with the re-entrancy attempt wired in.
    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata, uint256) external returns (bool success_) {
        _fire(onRelease);
        return true;
    }

    /// @dev High-level calls on purpose: the guard's revert must bubble out through the market, not be
    ///      swallowed here, or the test would prove nothing about what the caller sees.
    function _fire(Hook hook) private {
        if (hook == Hook.Fill) {
            ITenorMarket(market).fill(attackId, attackAmount);
        } else if (hook == Hook.Cancel) {
            ITenorMarket(market).cancel(attackId);
        }
    }
}

/// @title MisbehavingATSToken
/// @notice A security token that REPORTS FAILURE from a hold call instead of reverting, and can claim any
///         number of decimals.
/// @dev ATS reverts rather than returning false, so these paths are belt-and-braces in the market — but the
///      delivery leg is the one place where trusting a `false` would cost a buyer their money, because the
///      seller has already been paid by then. A venue pinned to this token is the only way to exercise them.
contract MisbehavingATSToken {
    /// @notice Decimals, which `list` reads once and caches [DEV-6].
    uint8 public decimals;
    /// @notice When true, `createHoldFromByPartition` reports failure.
    bool public failCreate;
    /// @notice When true, the delivery leg reports failure.
    bool public failExecute;
    /// @notice When true, the release leg reports failure.
    bool public failRelease;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    /// @notice Chooses which hold call lies about its result.
    function setFailures(bool create_, bool execute_, bool release_) external {
        failCreate = create_;
        failExecute = execute_;
        failRelease = release_;
    }

    function createHoldFromByPartition(bytes32, address, IHoldTypes.Hold calldata, bytes calldata)
        external
        view
        returns (bool success_, uint256 holdId_)
    {
        return (!failCreate, failCreate ? 0 : 1);
    }

    function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata idf, address, uint256)
        external
        view
        returns (bool success_, bytes32 partition_)
    {
        return (!failExecute, idf.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata, uint256) external view returns (bool) {
        return !failRelease;
    }
}

/// @title TenorMarketTest
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The market suite: SPEC §6.3's behaviour and all seven of §6.5's invariants, against a real
///         assembled diamond, a real ATS hold mechanic, and the etched Hedera Token Service.
/// @dev Every test names the invariant or SPEC clause it protects. Three known limitations from
///      `docs/GROUND-TRUTH.md` §8 are asserted in their INTENDED direction, never the opposite:
///      `remaining` is stale between expiry and `expire`, `quote` prices an inactive listing, and hold
///      execution does not restore allowance (only release and reclaim do).
contract TenorMarketTest is TenorTestBase {
    /// @dev The token's single default partition, as the harness and Smoke use it.
    bytes32 internal constant PARTITION = bytes32(uint256(1));
    /// @dev 98 USDC per whole note, matching the demo instrument.
    uint256 internal constant PRICE = 98 * 10 ** 6;
    /// @dev Default listing lifetime, comfortably inside `MAX_DURATION`.
    uint64 internal constant DEFAULT_LIFE = 1 days;

    /// @dev A third party with no role, no listing and no stake — used to prove permissionlessness.
    address internal stranger = makeAddr("stranger");

    /// @dev Realistic wall-clock time, so every `uint64(block.timestamp)` bound in the suite is a value a
    ///      client would actually send.
    function setUp() public virtual override {
        super.setUp();
        vm.warp(1_700_000_000);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  HELPERS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Lists as `seller`. Extracted so no test has to keep the whole argument list live — the
    ///      non-IR optimiser runs out of stack slots fast in the multi-step tests.
    function _list(address seller, uint256 amount, uint256 price, uint64 expiry) internal returns (uint256 id) {
        vm.prank(seller);
        id = market.list(address(atsToken), PARTITION, amount, price, expiry);
    }

    /// @dev The whole seller-side setup: mint, approve the diamond for exactly `amount`, list it all.
    function _aliceLists(uint256 amount) internal returns (uint256 id) {
        _enableSelling(alice, amount);
        id = _list(alice, amount, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @dev The buyer-side setup: USDC balance AND the allowance to the diamond that `fill` spends.
    function _fundAndApprove(address buyer, uint256 amount) internal {
        _fundUsdc(buyer, amount);
        _approveUsdc(buyer, amount);
    }

    /// @dev Quotes, funds, approves and fills in one step.
    function _buy(uint256 id, address buyer, uint256 amount) internal returns (uint256 cost, uint256 fee) {
        (cost, fee) = market.quote(id, amount);
        _fundAndApprove(buyer, cost);
        vm.prank(buyer);
        market.fill(id, amount);
    }

    /// @dev USDC balance as an unsigned amount; the HTS mock keeps `int64` like the real service.
    function _usdcOf(address account) internal view returns (uint256 balance) {
        balance = uint256(uint64(hts.balanceOf(usdc, account)));
    }

    /// @dev The (partition, holder, holdId) triple for the default partition.
    function _idf(address holder, uint256 holdId) internal pure returns (IHoldTypes.HoldIdentifier memory idf) {
        idf = IHoldTypes.HoldIdentifier({partition: PARTITION, tokenHolder: holder, holdId: holdId});
    }

    /// @dev A hold's outstanding amount and escrow, read from the TOKEN rather than from Tenor.
    function _hold(address holder, uint256 holdId) internal view returns (uint256 held, address escrow) {
        (held,, escrow,,,,) = atsToken.getHoldForByPartition(_idf(holder, holdId));
    }

    /// @dev INVARIANT 2 and INVARIANT 4 in one assertion, so a multi-step test can check both after every
    ///      operation. Escrow is only asserted while the listing is live: a drained or released hold is
    ///      deleted by the token, which zeroes `escrow` alongside the amount.
    function _assertHoldMirrors(uint256 id, string memory tag) internal view {
        ITenorMarket.Listing memory l = market.getListing(id);
        (uint256 held, address escrow) = _hold(l.seller, l.holdId);
        assertEq(held, l.remaining, string.concat(tag, ": invariant 2 - hold outstanding == remaining"));
        if (l.active) {
            assertEq(escrow, tenor, string.concat(tag, ": invariant 2 - escrow is the diamond"));
        }
        assertEq(atsToken.balanceOf(tenor), 0, string.concat(tag, ": invariant 4 - diamond holds no security token"));
    }

    /// @dev Pauses the market. `DEFAULT_ADMIN_ROLE` is the gate — there is no PAUSER_ROLE [DEV-5].
    function _pauseMarket() internal {
        vm.prank(admin);
        IPausable(tenor).pause();
    }

    /// @dev Assembles a SECOND diamond pinned to `token`. The market only ever trades its configured
    ///      token, so a hostile token can only be reached through a venue that was initialised with it.
    function _venueFor(address token) internal returns (address venue) {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory initCalldata) =
            deployer.buildCuts(admin, issuer, usdc, token, 0, MAX_DURATION);

        Tenor v = new Tenor();
        v.initialize(cuts, init, initCalldata);
        venue = address(v);

        vm.prank(admin);
        IHTSAdapter(venue).associateToken(usdc);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                          LIST — SPEC §6.3, FR1
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice FR1 and INVARIANT 2: one transaction produces a listing AND its hold, with the diamond as
    ///         escrow and no recipient pinned, and the seller keeps custody throughout. INVARIANT 4 holds
    ///         from the first operation.
    function test_list_reservesWithHoldAndKeepsCustody() public {
        uint256 amount = 200 * ONE_TOKEN;
        uint256 id = _aliceLists(amount);

        ITenorMarket.Listing memory l = market.getListing(id);
        assertEq(l.token, address(atsToken), "listing names the venue's token");
        assertEq(l.seller, alice, "seller is the caller, never calldata");
        assertEq(l.remaining, amount, "remaining seeded to the listed amount");
        assertEq(l.pricePerToken, PRICE, "price recorded");
        assertEq(l.expiry, uint64(block.timestamp + DEFAULT_LIFE), "expiry recorded");
        assertEq(l.tokenDecimals, TOKEN_DECIMALS, "[DEV-6] decimals cached at listing time");
        assertTrue(l.active, "listing is live");

        assertEq(atsToken.balanceOf(alice), amount, "seller keeps custody - the market never takes tokens");
        _assertHoldMirrors(id, "after list");

        (, uint256 expiration, address escrow, address destination,,,) =
            atsToken.getHoldForByPartition(_idf(alice, l.holdId));
        assertEq(expiration, uint256(l.expiry), "hold expiry == listing expiry");
        assertEq(escrow, tenor, "only the diamond may execute or release the hold");
        assertEq(destination, address(0), "recipient left open so the buyer is chosen at fill time");
    }

    /// @notice SPEC §6.3: the hold's `data` carries the listing id, so a hold on the token can always be
    ///         traced back to the listing that created it.
    function test_list_holdDataCarriesListingId() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 holdId = market.getListing(id).holdId;
        (,,,, bytes memory data,,) = atsToken.getHoldForByPartition(_idf(alice, holdId));
        assertEq(data, abi.encode(id), "hold data is abi.encode(listingId)");
    }

    /// @notice SPEC §6.3: `Listed` reports the hold id the token assigned, which is what a client needs to
    ///         follow the reservation on the token.
    function test_list_emitsListedWithTheTokensHoldId() public {
        uint256 amount = 100 * ONE_TOKEN;
        uint64 expiry = uint64(block.timestamp + DEFAULT_LIFE);
        uint256 expectedHoldId = atsToken.lastHoldId(PARTITION, alice) + 1;
        _enableSelling(alice, amount);

        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.Listed(0, address(atsToken), alice, PARTITION, expectedHoldId, amount, PRICE, expiry);
        vm.prank(alice);
        uint256 id = market.list(address(atsToken), PARTITION, amount, PRICE, expiry);

        assertEq(market.getListing(id).holdId, expectedHoldId, "recorded hold id matches the emitted one");
    }

    /// @notice SPEC §6.3: `amount > 0`.
    function testRevert_list_zeroAmount() public {
        _enableSelling(alice, 100 * ONE_TOKEN);
        vm.prank(alice);
        vm.expectRevert(ITenorMarket.InvalidAmount.selector);
        market.list(address(atsToken), PARTITION, 0, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice SPEC §6.3: `pricePerToken > 0`. A free listing would hand tokens over for nothing.
    function testRevert_list_zeroPrice() public {
        _enableSelling(alice, 100 * ONE_TOKEN);
        vm.prank(alice);
        vm.expectRevert(ITenorMarket.InvalidPrice.selector);
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, 0, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice SPEC §6.3: `block.timestamp < expiry`. The error carries the exact window a client must fit.
    function testRevert_list_expiryNotInFuture() public {
        _enableSelling(alice, 100 * ONE_TOKEN);
        uint64 minExpiry = uint64(block.timestamp) + 1;
        uint64 maxExpiry = uint64(block.timestamp + MAX_DURATION);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ITenorMarket.InvalidExpiry.selector, uint64(block.timestamp), minExpiry, maxExpiry)
        );
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp));
    }

    /// @notice SPEC §6.3 and §6.4: `maxDuration` bounds how long a seller's tokens stay reserved.
    function testRevert_list_expiryBeyondMaxDuration() public {
        _enableSelling(alice, 100 * ONE_TOKEN);
        uint64 minExpiry = uint64(block.timestamp) + 1;
        uint64 maxExpiry = uint64(block.timestamp + MAX_DURATION);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ITenorMarket.InvalidExpiry.selector, maxExpiry + 1, minExpiry, maxExpiry)
        );
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, PRICE, maxExpiry + 1);
    }

    /// @notice SPEC §6.3: the window is `block.timestamp + 1 ..= block.timestamp + maxDuration`, inclusive at
    ///         BOTH ends — a client offering "expires in exactly 30 days" must not be rejected.
    function test_list_expiryBoundsAreInclusive() public {
        _enableSelling(alice, 200 * ONE_TOKEN);
        uint64 minExpiry = uint64(block.timestamp) + 1;
        uint64 maxExpiry = uint64(block.timestamp + MAX_DURATION);

        uint256 first = _list(alice, 100 * ONE_TOKEN, PRICE, minExpiry);
        uint256 second = _list(alice, 100 * ONE_TOKEN, PRICE, maxExpiry);

        assertEq(market.getListing(first).expiry, minExpiry, "earliest admissible expiry accepted");
        assertEq(market.getListing(second).expiry, maxExpiry, "latest admissible expiry accepted");
    }

    /// @notice SPEC §6.4 custody: the venue trades ONE instrument. Accepting a seller-supplied token would
    ///         let a fake contract report a hold and deliver nothing after the buyer has paid.
    function testRevert_list_tokenNotListable() public {
        MockATSToken impostor = new MockATSToken("Impostor Note", "IMP", TOKEN_DECIMALS);
        impostor.mint(alice, 100 * ONE_TOKEN);
        vm.prank(alice);
        impostor.approve(tenor, 100 * ONE_TOKEN);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ITenorMarket.TokenNotListable.selector, address(impostor), address(atsToken))
        );
        market.list(address(impostor), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice FR1: the seller's ERC-20 allowance to the diamond is the selling cap, and the TOKEN enforces
    ///         it — Tenor carries no allowance logic of its own.
    function testRevert_list_allowanceBelowAmount() public {
        atsToken.mint(alice, 200 * ONE_TOKEN);
        vm.prank(alice);
        atsToken.approve(tenor, 100 * ONE_TOKEN);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockATSToken.InsufficientAllowance.selector, tenor, alice));
        market.list(address(atsToken), PARTITION, 150 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice FR1: the token verifies the seller's balance too. A listing can never over-reserve.
    function testRevert_list_balanceBelowAmount() public {
        atsToken.mint(alice, 50 * ONE_TOKEN);
        vm.prank(alice);
        atsToken.approve(tenor, 100 * ONE_TOKEN);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockATSToken.InsufficientBalance.selector, alice, 50 * ONE_TOKEN, 100 * ONE_TOKEN, PARTITION
            )
        );
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice SPEC §6.3: `list` is `whenNotPaused`. Pause stops new reservations being created.
    function testRevert_list_whenPaused() public {
        _enableSelling(alice, 100 * ONE_TOKEN);
        _pauseMarket();

        vm.prank(alice);
        vm.expectRevert(IPausable.EnforcedPause.selector);
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice SPEC §6.1: `nextId` is MONOTONIC — ids are never reused, not even after a listing is
    ///         cancelled or filled out, so a client's history can never be aliased.
    function test_list_idsAreMonotonicAndNeverReused() public {
        _enableSelling(alice, 400 * ONE_TOKEN);
        uint64 expiry = uint64(block.timestamp + DEFAULT_LIFE);

        assertEq(market.nextListingId(), 0, "first listing takes id 0");
        uint256 a = _list(alice, 100 * ONE_TOKEN, PRICE, expiry);
        uint256 b = _list(alice, 100 * ONE_TOKEN, PRICE, expiry);
        uint256 c = _list(alice, 100 * ONE_TOKEN, PRICE, expiry);
        assertEq(a, 0, "id 0");
        assertEq(b, 1, "id 1");
        assertEq(c, 2, "id 2");

        vm.prank(alice);
        market.cancel(b);
        _buy(c, bob, 100 * ONE_TOKEN);

        // Both a cancelled id and a filled-out id are retired for good.
        uint256 d = _list(alice, 100 * ONE_TOKEN, PRICE, expiry);
        assertEq(d, 3, "the next id continues past the retired ones");
        assertEq(market.nextListingId(), 4, "nextId advanced exactly once per listing");
        assertEq(market.getListing(b).remaining, 0, "cancelled listing was not overwritten");
        assertFalse(market.getListing(c).active, "filled-out listing was not overwritten");
    }

    /// @notice SPEC §6.1: a listing that reverts must not burn an id — the id is assigned before the hold
    ///         is created, so the rollback has to take it back with it.
    function test_list_revertedListingConsumesNoId() public {
        // Balance is ample; the allowance is what the token refuses, so the revert comes from inside the
        // hold creation — i.e. after `list` has already taken an id.
        atsToken.mint(alice, 40 * ONE_TOKEN);
        vm.prank(alice);
        atsToken.approve(tenor, 10 * ONE_TOKEN);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockATSToken.InsufficientAllowance.selector, tenor, alice));
        market.list(address(atsToken), PARTITION, 20 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));

        assertEq(market.nextListingId(), 0, "a failed list leaves nextId untouched");
        uint256 id = _list(alice, 10 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
        assertEq(id, 0, "the next successful listing still takes id 0");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                 FILL — SPEC §6.3, FR2, INVARIANTS 1, 2 AND 4
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 1 (positive direction) and FR2: a good fill moves BOTH legs in one transaction —
    ///         USDC buyer to seller, tokens seller to buyer through the hold.
    function test_fill_movesBothLegsAtomically() public {
        uint256 amount = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(amount);
        uint256 buy = 40 * ONE_TOKEN;

        (uint256 cost, uint256 fee) = _buy(id, bob, buy);

        assertEq(fee, 0, "harness runs at feeBps 0");
        assertEq(_usdcOf(alice), cost, "payment leg: seller received the gross cost");
        assertEq(_usdcOf(bob), 0, "payment leg: buyer's USDC spent exactly");
        assertEq(atsToken.balanceOf(bob), buy, "delivery leg: buyer holds the notes");
        assertEq(atsToken.balanceOf(alice), amount - buy, "delivery leg: seller's notes reduced");
        _assertHoldMirrors(id, "after a good fill");
    }

    /// @notice SPEC §6.3 and INVARIANT 2: partial fills decrement `remaining` and the hold in lockstep, and
    ///         the listing deactivates at EXACTLY zero — not before, not after.
    function test_fill_partialsDecrementAndDeactivateAtExactlyZero() public {
        uint256 amount = 300 * ONE_TOKEN;
        uint256 id = _aliceLists(amount);

        _buy(id, bob, 100 * ONE_TOKEN);
        assertEq(market.getListing(id).remaining, 200 * ONE_TOKEN, "first partial decremented");
        assertTrue(market.getListing(id).active, "still live with 200 left");
        _assertHoldMirrors(id, "after partial 1");

        _buy(id, bob, 150 * ONE_TOKEN);
        assertEq(market.getListing(id).remaining, 50 * ONE_TOKEN, "second partial decremented");
        assertTrue(market.getListing(id).active, "still live with 50 left");
        _assertHoldMirrors(id, "after partial 2");

        _buy(id, bob, 50 * ONE_TOKEN);
        assertEq(market.getListing(id).remaining, 0, "filled out");
        assertFalse(market.getListing(id).active, "deactivated at exactly zero");
        _assertHoldMirrors(id, "after the final partial");
        assertEq(atsToken.balanceOf(bob), amount, "buyer accumulated every note");
    }

    /// @notice SPEC §6.3: `Filled` reports the GROSS cost and the fee, so a client can show both sides.
    function test_fill_emitsFilledWithGrossCostAndFee() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 buy = 25 * ONE_TOKEN;
        (uint256 cost, uint256 fee) = market.quote(id, buy);
        _fundAndApprove(bob, cost);

        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.Filled(id, bob, buy, cost, fee);
        vm.prank(bob);
        market.fill(id, buy);
    }

    /// @notice SPEC §6.3: `0 < amount <= remaining`. An over-fill must never silently clamp.
    function testRevert_fill_aboveRemaining() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        _buy(id, bob, 60 * ONE_TOKEN);

        _fundAndApprove(bob, 100 * PRICE);
        vm.prank(bob);
        vm.expectRevert(ITenorMarket.InvalidAmount.selector);
        market.fill(id, 41 * ONE_TOKEN);
    }

    /// @notice SPEC §6.3: a zero-amount fill is rejected before any leg runs.
    function testRevert_fill_zeroAmount() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.prank(bob);
        vm.expectRevert(ITenorMarket.InvalidAmount.selector);
        market.fill(id, 0);
    }

    /// @notice INVARIANT 6 and SPEC §6.4: a fill AT expiry is already too late — the boundary is `>=`,
    ///         matching the token, which bars hold execution from `expirationTimestamp` on.
    function testRevert_fill_atExpiry() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint64 expiry = market.getListing(id).expiry;
        _fundAndApprove(bob, 100 * PRICE);

        vm.warp(expiry);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingExpired.selector, id));
        market.fill(id, 10 * ONE_TOKEN);
    }

    /// @notice INVARIANT 6: and still refused well after expiry.
    function testRevert_fill_afterExpiry() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint64 expiry = market.getListing(id).expiry;
        _fundAndApprove(bob, 100 * PRICE);

        vm.warp(uint256(expiry) + 7 days);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingExpired.selector, id));
        market.fill(id, 10 * ONE_TOKEN);
    }

    /// @notice SPEC §6.3: a cancelled listing is dead. Its hold no longer exists, so a fill must be refused
    ///         by Tenor rather than reaching the token.
    function testRevert_fill_cancelledListing() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.prank(alice);
        market.cancel(id);

        _fundAndApprove(bob, 100 * PRICE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, id));
        market.fill(id, 10 * ONE_TOKEN);
    }

    /// @notice SPEC §6.3: a filled-out listing cannot be filled again.
    function testRevert_fill_filledOutListing() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        _buy(id, bob, 100 * ONE_TOKEN);

        _fundAndApprove(bob, 100 * PRICE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, id));
        market.fill(id, 1 * ONE_TOKEN);
    }

    /// @notice SPEC §6.3: an id that was never created reports the same "not active" state, never a
    ///         zero-valued listing that could be filled.
    function testRevert_fill_unknownListing() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, uint256(7)));
        market.fill(7, 1 * ONE_TOKEN);
    }

    /// @notice SPEC §6.3: `fill` is `whenNotPaused`.
    function testRevert_fill_whenPaused() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        _fundAndApprove(bob, 100 * PRICE);
        _pauseMarket();

        vm.prank(bob);
        vm.expectRevert(IPausable.EnforcedPause.selector);
        market.fill(id, 10 * ONE_TOKEN);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //        INVARIANT 1 — A FILL MOVES BOTH LEGS OR NEITHER (NEGATIVE SIDE)
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Shared rollback assertion for every failed-fill test: the buyer's money, the buyer's allowance,
    ///      the seller's money, the reservation and the market's own accounting all as they were.
    ///      `remaining` matters most — `fill` decrements it BEFORE the interactions, so an intact value is
    ///      what proves the effect was rolled back with the interactions.
    function _assertNothingMoved(uint256 id, address buyer, uint256 buyerUsdc, uint256 listed) internal view {
        assertEq(_usdcOf(buyer), buyerUsdc, "invariant 1 - buyer's USDC untouched");
        assertEq(hts.allowances(usdc, buyer, tenor), buyerUsdc, "invariant 1 - buyer's USDC allowance unspent");
        assertEq(_usdcOf(alice), 0, "invariant 1 - seller was not paid");
        assertEq(_usdcOf(tenor), 0, "invariant 1 - the diamond took no fee");
        assertEq(atsToken.balanceOf(buyer), 0, "invariant 1 - no tokens delivered");
        assertEq(atsToken.balanceOf(alice), listed, "invariant 1 - the seller's balance is intact");
        assertEq(market.getListing(id).remaining, listed, "invariant 1 - the pre-interaction effect rolled back");
        _assertHoldMirrors(id, "after a failed fill");
    }

    /// @notice INVARIANT 1 and FR2: an unverified buyer fails the token's KYC check inside
    ///         `executeHoldByPartition`, and the USDC leg that already ran is undone with it.
    function testRevert_fill_unverifiedBuyer_movesNeitherLeg() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundAndApprove(carol, cost);

        vm.prank(carol);
        vm.expectRevert(MockATSToken.InvalidKycStatus.selector);
        market.fill(id, 10 * ONE_TOKEN);

        _assertNothingMoved(id, carol, cost, listed);
        assertEq(hts.allowances(usdc, carol, tenor), cost, "the unverified buyer's allowance is unspent");
    }

    /// @notice INVARIANT 1: a seller frozen by the issuer between listing and fill cannot deliver, so the
    ///         buyer must not pay. The control-list check lives in the TOKEN.
    function testRevert_fill_blockedSeller_movesNeitherLeg() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundAndApprove(bob, cost);
        atsToken.setBlocked(alice, true);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockATSToken.AccountIsBlocked.selector, alice));
        market.fill(id, 10 * ONE_TOKEN);

        _assertNothingMoved(id, bob, cost, listed);
    }

    /// @notice INVARIANT 1: a blocked BUYER is refused by the token on the same leg.
    function testRevert_fill_blockedBuyer_movesNeitherLeg() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundAndApprove(bob, cost);
        atsToken.setBlocked(bob, true);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockATSToken.AccountIsBlocked.selector, bob));
        market.fill(id, 10 * ONE_TOKEN);

        _assertNothingMoved(id, bob, cost, listed);
    }

    /// @notice INVARIANT 1: an issuer pausing the TOKEN (not the market) also stops settlement, and takes
    ///         the payment leg down with it.
    function testRevert_fill_pausedToken_movesNeitherLeg() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundAndApprove(bob, cost);
        atsToken.setPaused(true);

        vm.prank(bob);
        vm.expectRevert(MockATSToken.IsPaused.selector);
        market.fill(id, 10 * ONE_TOKEN);

        _assertNothingMoved(id, bob, cost, listed);
    }

    /// @notice INVARIANT 1, other direction: when the USDC leg fails, NO tokens move. Every Hedera response
    ///         code is checked (SPEC §2.3), so a non-SUCCESS code from `0x167` reverts the whole fill —
    ///         and the listing survives to be filled once the condition clears.
    function testRevert_fill_usdcLegFails_movesNoTokens() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundAndApprove(bob, cost);

        hts.force(IHederaTokenService.transferFrom.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                TenorHTS.TenorHTSCallFailed.selector,
                IHederaTokenService.transferFrom.selector,
                HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN
            )
        );
        market.fill(id, 10 * ONE_TOKEN);

        _assertNothingMoved(id, bob, cost, listed);

        // The forced code is consumed inside a frame that reverted, so it is still armed — clear it and
        // prove the reservation is intact and still fillable.
        hts.force(IHederaTokenService.transferFrom.selector, int64(0));
        vm.prank(bob);
        market.fill(id, 10 * ONE_TOKEN);
        assertEq(atsToken.balanceOf(bob), 10 * ONE_TOKEN, "the same listing settles once USDC clears");
        _assertHoldMirrors(id, "after the retry");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //          INVARIANT 2 — EVERY ACTIVE LISTING IS MIRRORED BY ITS HOLD
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 2: across a run of partial fills of differing sizes, the token's outstanding hold
    ///         amount and Tenor's `remaining` never diverge, and the escrow stays the diamond.
    function test_invariant2_holdMirrorsRemainingAcrossManyPartials() public {
        uint256 listed = 240 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        uint256 holdId = market.getListing(id).holdId;

        uint256[4] memory buys = [10 * ONE_TOKEN, 70 * ONE_TOKEN, 1 * ONE_TOKEN, 159 * ONE_TOKEN];
        uint256 sold;
        for (uint256 i; i < buys.length; ++i) {
            _buy(id, bob, buys[i]);
            sold += buys[i];
            (uint256 held, address escrow) = _hold(alice, holdId);
            assertEq(held, listed - sold, "invariant 2 - the token's hold tracks every fill");
            assertEq(market.getListing(id).remaining, held, "invariant 2 - remaining == the hold");
            if (held > 0) assertEq(escrow, tenor, "invariant 2 - escrow stays the diamond");
            assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - throughout");
        }
        assertFalse(market.getListing(id).active, "drained listing is inactive");
    }

    /// @notice INVARIANT 2: a cancel takes BOTH sides to zero — the token deletes the drained hold and the
    ///         listing reports nothing remaining, so no stale reservation can be read back.
    function test_invariant2_cancelClearsBothSides() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 holdId = market.getListing(id).holdId;
        _buy(id, bob, 30 * ONE_TOKEN);

        vm.prank(alice);
        market.cancel(id);

        (uint256 held, address escrow) = _hold(alice, holdId);
        assertEq(held, 0, "invariant 2 - the hold is gone");
        assertEq(escrow, address(0), "the token deleted the drained hold record");
        assertEq(market.getListing(id).remaining, 0, "invariant 2 - remaining zeroed with it");
        assertFalse(market.getListing(id).active, "listing retired");
        assertEq(atsToken.getHeldAmountForByPartition(PARTITION, alice), 0, "seller has nothing reserved");
        _assertHoldMirrors(id, "after cancel");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //           INVARIANT 3 — fee <= cost ALWAYS, AND feeBps <= 100 ALWAYS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 3: the 100 bp ceiling is not raisable by an admin.
    function testRevert_setFeeBps_aboveCeiling() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.FeeTooHigh.selector, uint16(MARKET_MAX_FEE_BPS + 1)));
        market.setFeeBps(MARKET_MAX_FEE_BPS + 1);
        assertEq(market.feeBps(), FEE_BPS, "the rejected fee was not installed");
    }

    /// @notice INVARIANT 3: for every admissible fee and every priced amount, `fee <= cost` and the fee is
    ///         exactly the floored basis-point cut — so the seller can never be handed less than
    ///         `cost - fee`, and the fee can never swallow the trade.
    function testFuzz_invariant3_feeNeverExceedsCost(uint16 rawFee, uint256 amount, uint256 price) public {
        uint16 bps = uint16(bound(uint256(rawFee), 0, MARKET_MAX_FEE_BPS));
        amount = bound(amount, 1, 1e11);
        price = bound(price, 1e6, 1e8);

        vm.prank(admin);
        market.setFeeBps(bps);
        assertLe(market.feeBps(), MARKET_MAX_FEE_BPS, "invariant 3 - feeBps never above the ceiling");

        _enableSelling(alice, amount);
        uint256 id = _list(alice, amount, price, uint64(block.timestamp + DEFAULT_LIFE));

        (uint256 cost, uint256 fee) = market.quote(id, amount);
        assertLe(fee, cost, "invariant 3 - fee <= cost");
        assertEq(fee, (cost * bps) / 10_000, "fee is the floored basis-point cut of cost");
        assertLe(fee * 100, cost, "at the ceiling the fee is at most 1% of cost");
    }

    /// @notice INVARIANT 3 and SPEC §6.3 fee math at the LOWEST non-zero setting: the seller receives
    ///         `cost - fee` and the diamond keeps `fee`, to the atomic unit.
    function test_fill_feeSplit_atOneBasisPoint() public {
        vm.prank(admin);
        market.setFeeBps(1);

        uint256 id = _aliceLists(100 * ONE_TOKEN);
        (uint256 cost, uint256 fee) = _buy(id, bob, 100 * ONE_TOKEN);

        assertEq(cost, 100 * PRICE, "gross cost");
        assertEq(fee, (100 * PRICE) / 10_000, "1 bp of the gross");
        assertEq(_usdcOf(alice), cost - fee, "seller received cost - fee");
        assertEq(_usdcOf(tenor), fee, "the diamond kept exactly the fee");
        assertEq(_usdcOf(alice) + _usdcOf(tenor), cost, "the two sides sum to the gross cost");
    }

    /// @notice INVARIANT 3 and SPEC §6.3 fee math at the CEILING: still `cost - fee` to the seller, `fee`
    ///         to the diamond, nothing unaccounted for.
    function test_fill_feeSplit_atTheCeiling() public {
        vm.prank(admin);
        market.setFeeBps(MARKET_MAX_FEE_BPS);

        uint256 id = _aliceLists(100 * ONE_TOKEN);
        (uint256 cost, uint256 fee) = _buy(id, bob, 100 * ONE_TOKEN);

        assertEq(fee, (100 * PRICE) / 100, "100 bp == 1% of the gross");
        assertEq(_usdcOf(alice), cost - fee, "seller received cost - fee");
        assertEq(_usdcOf(tenor), fee, "the diamond kept exactly the fee");
        assertEq(atsToken.balanceOf(bob), 100 * ONE_TOKEN, "delivery is unaffected by the fee");
    }

    /// @notice SPEC §6.4 rounding: a dust fill whose cost floors to zero is REFUSED. Without this guard the
    ///         buyer would receive tokens for no USDC at all — a real loss of funds for the seller.
    function testRevert_fill_dustRoundingToZeroCost() public {
        _enableSelling(alice, ONE_TOKEN);
        // One atomic USDC unit per WHOLE token: any sub-whole amount floors to nothing.
        uint256 id = _list(alice, ONE_TOKEN, 1, uint64(block.timestamp + DEFAULT_LIFE));

        vm.expectRevert(ITenorMarket.ZeroCost.selector);
        market.quote(id, 1);

        _fundAndApprove(bob, 1_000);
        vm.prank(bob);
        vm.expectRevert(ITenorMarket.ZeroCost.selector);
        market.fill(id, 1);

        assertEq(atsToken.balanceOf(bob), 0, "no tokens handed over for free");
        assertEq(market.getListing(id).remaining, ONE_TOKEN, "the listing is untouched");
        _assertHoldMirrors(id, "after a refused dust fill");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //      INVARIANT 4 — THE DIAMOND'S SECURITY-TOKEN BALANCE IS ALWAYS ZERO
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 4 and SPEC §2.3: no function of the diamond can move a security token to or from
    ///         the diamond. Asserted after EVERY operation of a full lifecycle: list, partial fill, cancel,
    ///         relist, fill out, expire, and the seller's direct reclaim on the token.
    function test_invariant4_diamondNeverHoldsSecurityToken() public {
        _enableSelling(alice, 400 * ONE_TOKEN);
        uint64 expiry = uint64(block.timestamp + DEFAULT_LIFE);

        uint256 first = _list(alice, 200 * ONE_TOKEN, PRICE, expiry);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after list");

        _buy(first, bob, 50 * ONE_TOKEN);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after a partial fill");

        vm.prank(alice);
        market.cancel(first);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after cancel");

        uint256 second = _list(alice, 200 * ONE_TOKEN, PRICE, expiry);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after relisting");

        _buy(second, bob, 200 * ONE_TOKEN);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after filling out");

        uint256 third = _list(alice, 150 * ONE_TOKEN, PRICE, expiry);
        uint256 holdId = market.getListing(third).holdId;
        vm.warp(uint256(expiry) + 1);
        market.expire(third);
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after expire");

        vm.prank(alice);
        atsToken.reclaimHoldByPartition(_idf(alice, holdId));
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after the seller reclaims on the token");
        assertEq(atsToken.balanceOf(alice), 150 * ONE_TOKEN, "the seller ends up with everything unsold");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //     INVARIANT 5 — AT feeBps == 0 THE DIAMOND'S USDC BALANCE NEVER MOVES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 5: with no fee the diamond is never a counterparty to a fill. Fuzzed over a
    ///         sequence of three partial fills by two different buyers.
    function testFuzz_invariant5_zeroFeeLeavesDiamondUsdcUnchanged(uint256 a1, uint256 a2, uint256 a3) public {
        assertEq(market.feeBps(), 0, "precondition: the harness runs fee-free");
        uint256 listed = 300 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);

        uint256 diamondBefore = _usdcOf(tenor);
        uint256[3] memory buys =
            [bound(a1, 1, 100 * ONE_TOKEN), bound(a2, 1, 100 * ONE_TOKEN), bound(a3, 1, 100 * ONE_TOKEN)];
        address[3] memory buyers = [bob, alice, bob];

        for (uint256 i; i < buys.length; ++i) {
            (uint256 cost, uint256 fee) = _buy(id, buyers[i], buys[i]);
            assertEq(fee, 0, "invariant 5 - no fee is charged");
            assertGt(cost, 0, "a settled fill always costs something");
            assertEq(_usdcOf(tenor), diamondBefore, "invariant 5 - the diamond's USDC is unchanged");
            assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - throughout the sequence");
        }
        assertEq(_usdcOf(tenor), diamondBefore, "invariant 5 - unchanged across the whole sequence");
    }

    /// @notice SPEC §6.3: `quote` is the same arithmetic `fill` charges, for any amount and any admissible
    ///         fee — the guarantee FR5 rests on (the client never shows a price the chain disagrees with).
    function testFuzz_quote_matchesWhatFillCharges(uint256 amount, uint16 rawFee) public {
        uint16 bps = uint16(bound(uint256(rawFee), 0, MARKET_MAX_FEE_BPS));
        vm.prank(admin);
        market.setFeeBps(bps);

        uint256 listed = 1e11;
        _enableSelling(alice, listed);
        uint256 id = _list(alice, listed, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
        amount = bound(amount, 1, listed);

        (uint256 cost, uint256 fee) = market.quote(id, amount);
        _fundAndApprove(bob, cost);
        uint256 buyerBefore = _usdcOf(bob);

        vm.prank(bob);
        market.fill(id, amount);

        assertEq(buyerBefore - _usdcOf(bob), cost, "the buyer paid exactly the quoted gross cost");
        assertEq(_usdcOf(alice), cost - fee, "the seller received exactly the quoted net");
        assertEq(_usdcOf(tenor), fee, "the diamond kept exactly the quoted fee");
        assertEq(atsToken.balanceOf(bob), amount, "and got exactly the tokens quoted for");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //       INVARIANT 6 — SELLER-ONLY CANCEL; NO CANCEL OR FILL AFTER EXPIRY
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 6: only the seller may cancel. A third party cannot unwind someone's listing.
    function testRevert_cancel_notSeller() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.NotSeller.selector, id));
        market.cancel(id);

        assertTrue(market.getListing(id).active, "the listing survived the attempt");
        _assertHoldMirrors(id, "after a refused cancel");
    }

    /// @notice INVARIANT 6: cancel is refused from `expiry` on — past that point the TOKEN only allows a
    ///         reclaim, which the seller performs directly (SPEC §6.3).
    function testRevert_cancel_atAndAfterExpiry() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint64 expiry = market.getListing(id).expiry;

        vm.warp(expiry);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingExpired.selector, id));
        market.cancel(id);

        vm.warp(uint256(expiry) + 3 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingExpired.selector, id));
        market.cancel(id);
    }

    /// @notice INVARIANT 6: a listing already cancelled cannot be cancelled again.
    function testRevert_cancel_alreadyCancelled() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.prank(alice);
        market.cancel(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, id));
        market.cancel(id);
    }

    /// @notice INVARIANT 6: an id that never existed reports `ListingNotActive`, not `NotSeller` — the
    ///         existence check leads, so the error a client decodes is never misleading.
    function testRevert_cancel_unknownListing() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, uint256(99)));
        market.cancel(99);
    }

    /// @notice SPEC §6.4: pausing the market blocks `list` and `fill` but NEVER `cancel`. A seller must
    ///         always be able to get out of a reservation, whatever state the venue is in.
    function test_cancel_worksWhilePaused() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 allowanceBefore = atsToken.allowance(alice, tenor);
        _pauseMarket();

        vm.prank(alice);
        market.cancel(id);

        assertFalse(market.getListing(id).active, "the seller unwound while paused");
        assertEq(
            atsToken.allowance(alice, tenor), allowanceBefore + 100 * ONE_TOKEN, "and got the whole reservation back"
        );
        assertTrue(IPausable(tenor).paused(), "the market is still paused");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //        INVARIANT 7 — CANCEL RESTORES ALLOWANCE BY EXACTLY THE RELEASE
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice INVARIANT 7 and FR3: the mechanic FR1 rests on. The token recorded the diamond as the hold's
    ///         third party, so releasing gives the seller's allowance back to the diamond — by exactly the
    ///         released amount, never more. Note that the earlier FILL restored nothing: execution moves
    ///         tokens out for good, only release and reclaim give allowance back.
    function test_invariant7_cancelRestoresAllowanceByExactlyTheRelease() public {
        uint256 listed = 100 * ONE_TOKEN;
        uint256 id = _aliceLists(listed);
        assertEq(atsToken.allowance(alice, tenor), 0, "the listing consumed the whole allowance");

        _buy(id, bob, 30 * ONE_TOKEN);
        assertEq(atsToken.allowance(alice, tenor), 0, "a fill restores nothing - the tokens are gone");

        uint256 before = atsToken.allowance(alice, tenor);
        uint256 released = market.getListing(id).remaining;

        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.Cancelled(id, released);
        vm.prank(alice);
        market.cancel(id);

        assertEq(released, 70 * ONE_TOKEN, "the release is the unsold remainder");
        assertEq(atsToken.allowance(alice, tenor), before + released, "invariant 7 - allowance restored by exactly it");
        assertEq(atsToken.transferableBalanceOf(alice), 70 * ONE_TOKEN, "and the tokens are free to move again");
    }

    /// @notice INVARIANT 7: with no fills, cancel returns the seller to precisely where they started — the
    ///         full allowance and the full transferable balance.
    function testFuzz_invariant7_cancelWithNoFillsIsWhole(uint256 amount) public {
        amount = bound(amount, 1, 1e12);
        _enableSelling(alice, amount);
        uint256 allowanceBefore = atsToken.allowance(alice, tenor);

        uint256 id = _list(alice, amount, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
        assertEq(atsToken.allowance(alice, tenor), allowanceBefore - amount, "the hold consumed the allowance");

        vm.prank(alice);
        market.cancel(id);

        assertEq(atsToken.allowance(alice, tenor), allowanceBefore, "invariant 7 - restored in full");
        assertEq(atsToken.transferableBalanceOf(alice), amount, "nothing is reserved any more");
    }

    /// @notice INVARIANT 7, complementary path: after expiry the seller reclaims on the TOKEN and the same
    ///         restoration happens there. This is why `expire` needs to touch no token state at all.
    function test_reclaimAfterExpiry_restoresAllowanceOnTheToken() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 holdId = market.getListing(id).holdId;
        uint64 expiry = market.getListing(id).expiry;

        vm.warp(uint256(expiry) + 1);
        market.expire(id);

        uint256 before = atsToken.allowance(alice, tenor);
        vm.prank(alice);
        atsToken.reclaimHoldByPartition(_idf(alice, holdId));

        assertEq(atsToken.allowance(alice, tenor), before + 100 * ONE_TOKEN, "reclaim restores the allowance");
        assertEq(atsToken.transferableBalanceOf(alice), 100 * ONE_TOKEN, "and frees the balance");
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - even on the reclaim path");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                         EXPIRE — SPEC §6.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice SPEC §6.3: `expire` is PERMISSIONLESS state sync and touches no token state. `remaining` is
    ///         deliberately left as it was so a client can still show how much there is to reclaim
    ///         (`GROUND-TRUTH.md` §8).
    function test_expire_isPermissionlessAndLeavesTheTokenUntouched() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint256 holdId = market.getListing(id).holdId;
        uint64 expiry = market.getListing(id).expiry;
        uint256 allowanceBefore = atsToken.allowance(alice, tenor);

        vm.warp(uint256(expiry) + 1);
        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.Expired(id);
        vm.prank(stranger);
        market.expire(id);

        assertFalse(market.getListing(id).active, "the listing is retired");
        assertEq(market.getListing(id).remaining, 100 * ONE_TOKEN, "remaining is left to show the reclaimable size");

        (uint256 held, address escrow) = _hold(alice, holdId);
        assertEq(held, 100 * ONE_TOKEN, "the hold on the token is untouched");
        assertEq(escrow, tenor, "and still escrowed to the diamond, for the seller to reclaim");
        assertEq(atsToken.allowance(alice, tenor), allowanceBefore, "no allowance was restored by expire");
        assertEq(atsToken.balanceOf(alice), 100 * ONE_TOKEN, "no balance moved");
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 - after expire");
    }

    /// @notice SPEC §6.3: `expire` only at or after expiry — the error carries the expiry a client should
    ///         wait for.
    function testRevert_expire_beforeExpiry() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        uint64 expiry = market.getListing(id).expiry;

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotExpired.selector, id, expiry));
        market.expire(id);

        vm.warp(uint256(expiry) - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotExpired.selector, id, expiry));
        market.expire(id);
    }

    /// @notice SPEC §6.3: expiry is inclusive — the listing can be expired at exactly `expiry`, the same
    ///         second a fill stops being possible. No dead window.
    function test_expire_atExactlyExpiry() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.warp(market.getListing(id).expiry);

        vm.prank(stranger);
        market.expire(id);
        assertFalse(market.getListing(id).active, "expired at exactly the boundary");
    }

    /// @notice SPEC §6.3: expiring twice is refused, so the event cannot be replayed by a griefer.
    function testRevert_expire_alreadyInactive() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.warp(uint256(market.getListing(id).expiry) + 1);
        market.expire(id);

        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, id));
        market.expire(id);
    }

    /// @notice SPEC §6.4: pause covers `list` and `fill` only. `expire` is pure state sync, so it keeps
    ///         working — a paused venue must not leave stale listings unresolvable.
    function test_expire_worksWhilePaused() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.warp(uint256(market.getListing(id).expiry) + 1);
        _pauseMarket();

        vm.prank(stranger);
        market.expire(id);
        assertFalse(market.getListing(id).active, "expired while paused");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                     ADMIN — SPEC §6.3, [DEV-5]
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice SPEC §6.3: `setFeeBps` requires `DEFAULT_ADMIN_ROLE`; the seller of a listing has no say.
    function testRevert_setFeeBps_nonAdmin() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0))
        );
        market.setFeeBps(50);
    }

    /// @notice SPEC §6.3: `setMaxDuration` requires `DEFAULT_ADMIN_ROLE`. Not even the issuer may change it.
    function testRevert_setMaxDuration_nonAdmin() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, issuer, bytes32(0))
        );
        market.setMaxDuration(1 days);
    }

    /// @notice SPEC §2.3: events cover every state transition — the fee change included.
    function test_setFeeBps_emitsFeeUpdated() public {
        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.FeeUpdated(75);
        vm.prank(admin);
        market.setFeeBps(75);

        assertEq(market.feeBps(), 75, "the new fee is live");
    }

    /// @notice SPEC §6.3: a tightened `maxDuration` binds NEW listings immediately, and the error reports
    ///         the new window.
    function test_setMaxDuration_emitsAndBindsNewListings() public {
        vm.expectEmit(true, true, true, true, tenor);
        emit ITenorMarket.MaxDurationUpdated(1 hours);
        vm.prank(admin);
        market.setMaxDuration(1 hours);
        assertEq(market.maxDuration(), 1 hours, "the new cap is live");

        _enableSelling(alice, 200 * ONE_TOKEN);
        uint64 minExpiry = uint64(block.timestamp) + 1;
        uint64 maxExpiry = uint64(block.timestamp + 1 hours);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ITenorMarket.InvalidExpiry.selector, maxExpiry + 1, minExpiry, maxExpiry)
        );
        market.list(address(atsToken), PARTITION, 100 * ONE_TOKEN, PRICE, maxExpiry + 1);

        uint256 id = _list(alice, 100 * ONE_TOKEN, PRICE, maxExpiry);
        assertEq(market.getListing(id).expiry, maxExpiry, "a listing inside the new cap is accepted");
    }

    /// @notice SPEC §6.3 and [DEV-5]: there is no PAUSER_ROLE — pause is gated on `DEFAULT_ADMIN_ROLE` by
    ///         Lattice's Pausable facet, which Tenor cuts as-is.
    function testRevert_pause_nonAdmin() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, issuer, bytes32(0))
        );
        IPausable(tenor).pause();
    }

    /// @notice SPEC §6.4: pause is reversible, and unpausing restores both blocked paths.
    function test_unpause_restoresListAndFill() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        _pauseMarket();

        vm.prank(admin);
        IPausable(tenor).unpause();

        _buy(id, bob, 10 * ONE_TOKEN);
        assertEq(atsToken.balanceOf(bob), 10 * ONE_TOKEN, "fill works again after unpause");
        _enableSelling(alice, 10 * ONE_TOKEN);
        _list(alice, 10 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                        QUOTE — SPEC §6.3, FR5
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice SPEC §6.3: a zero amount prices at zero rather than reverting, so a client's empty input box
    ///         does not look like a failure.
    function test_quote_zeroAmountReturnsZeroes() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        (uint256 cost, uint256 fee) = market.quote(id, 0);
        assertEq(cost, 0, "no amount, no cost");
        assertEq(fee, 0, "no amount, no fee");
    }

    /// @notice SPEC §6.3: `quote` reverts only for an id that was never created.
    function testRevert_quote_unknownListing() public {
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.ListingNotActive.selector, uint256(3)));
        market.quote(3, 1 * ONE_TOKEN);
    }

    /// @notice `GROUND-TRUTH.md` §8, asserted in its INTENDED direction: quoting an inactive listing
    ///         SUCCEEDS, so a client can price and render a historical fill. Only `fill` enforces liveness.
    function test_quote_onCancelledListing_stillPrices() public {
        uint256 id = _aliceLists(100 * ONE_TOKEN);
        vm.prank(alice);
        market.cancel(id);

        (uint256 cost, uint256 fee) = market.quote(id, 10 * ONE_TOKEN);
        assertEq(cost, 10 * PRICE, "a retired listing still prices");
        assertEq(fee, 0, "at the harness fee");
    }

    /// @notice SPEC §6.1 configuration readback: the venue reports the instrument and the settlement token
    ///         it was pinned to, which is what makes `TokenNotListable` checkable by a client up front.
    function test_config_readsBackWhatItWasInitialisedWith() public view {
        assertEq(market.securityToken(), address(atsToken), "pinned security token");
        assertEq(market.usdc(), usdc, "settlement token");
        assertEq(market.feeBps(), FEE_BPS, "initial fee");
        assertEq(market.maxDuration(), MAX_DURATION, "initial duration cap");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //        HOLD CALLS THAT REPORT FAILURE INSTEAD OF REVERTING — SPEC §6.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Lists 100 tokens of `token` on `venue` as alice. The misbehaving token needs no balance or
    ///      allowance — it reports whatever its flags say.
    function _listOn(address venue, address token) internal returns (uint256 id) {
        vm.prank(alice);
        id = ITenorMarket(venue).list(token, PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    /// @notice SPEC §6.3: a listing can never exist without its hold. A token that reports failure without
    ///         reverting must not leave a recorded listing behind.
    function testRevert_list_holdCreationReportsFailure() public {
        MisbehavingATSToken token = new MisbehavingATSToken(TOKEN_DECIMALS);
        token.setFailures(true, false, false);
        address venue = _venueFor(address(token));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.HoldCreationFailed.selector, address(token), alice));
        ITenorMarket(venue)
            .list(address(token), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));

        assertEq(ITenorMarket(venue).nextListingId(), 0, "no id was consumed and no listing recorded");
    }

    /// @notice INVARIANT 1 and SPEC §6.3: the seller is paid BEFORE the delivery leg settles, so a delivery
    ///         leg that reports failure without reverting has to take the payment down with it. This is the
    ///         one place where trusting a `false` would cost the buyer their money.
    function testRevert_fill_deliveryLegReportsFailure_takesThePaymentDown() public {
        MisbehavingATSToken token = new MisbehavingATSToken(TOKEN_DECIMALS);
        address venue = _venueFor(address(token));
        uint256 id = _listOn(venue, address(token));

        (uint256 cost,) = ITenorMarket(venue).quote(id, 10 * ONE_TOKEN);
        _fundUsdc(bob, cost);
        hts.seedAllowance(usdc, bob, venue, cost);
        token.setFailures(false, true, false);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.HoldCallFailed.selector, address(token), id));
        ITenorMarket(venue).fill(id, 10 * ONE_TOKEN);

        assertEq(_usdcOf(bob), cost, "invariant 1 - the buyer's USDC came back");
        assertEq(_usdcOf(alice), 0, "invariant 1 - the seller keeps nothing for an undelivered fill");
        assertEq(ITenorMarket(venue).getListing(id).remaining, 100 * ONE_TOKEN, "the listing is untouched");
    }

    /// @notice SPEC §6.3: a release that reports failure is not a settled cancel either — otherwise Tenor
    ///         would retire a listing whose reservation is still live on the token.
    function testRevert_cancel_releaseReportsFailure() public {
        MisbehavingATSToken token = new MisbehavingATSToken(TOKEN_DECIMALS);
        address venue = _venueFor(address(token));
        uint256 id = _listOn(venue, address(token));
        token.setFailures(false, false, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.HoldCallFailed.selector, address(token), id));
        ITenorMarket(venue).cancel(id);

        assertTrue(ITenorMarket(venue).getListing(id).active, "the listing stays live so the seller can retry");
        assertEq(ITenorMarket(venue).getListing(id).remaining, 100 * ONE_TOKEN, "and still shows its size");
    }

    /// @notice SPEC §6.4 rounding: `10 ** decimals` is the divisor in every cost, so a token claiming absurd
    ///         decimals is rejected at listing time — not left as a listing no buyer could ever fill.
    function testRevert_list_unsupportedDecimals() public {
        uint8 tooMany = MARKET_MAX_TOKEN_DECIMALS + 1;
        MisbehavingATSToken token = new MisbehavingATSToken(tooMany);
        address venue = _venueFor(address(token));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.UnsupportedDecimals.selector, address(token), tooMany));
        ITenorMarket(venue)
            .list(address(token), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                    REENTRANCY — SPEC §6.4, INVARIANT 1
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Lists 100 tokens on a venue pinned to `hostile` and funds `bob` for a 10-token fill.
    ///      Returns the venue and the listing id. The USDC allowance goes to THAT venue, not the harness's
    ///      diamond, so `_approveUsdc` cannot be used.
    function _armedHostileVenue(ReentrantATSToken hostile) internal returns (address venue, uint256 id, uint256 cost) {
        venue = _venueFor(address(hostile));
        vm.prank(alice);
        id = ITenorMarket(venue)
            .list(address(hostile), PARTITION, 100 * ONE_TOKEN, PRICE, uint64(block.timestamp + DEFAULT_LIFE));
        (cost,) = ITenorMarket(venue).quote(id, 10 * ONE_TOKEN);
        _fundUsdc(bob, cost);
        hts.seedAllowance(usdc, bob, venue, cost);
    }

    /// @notice SPEC §6.4: `fill` is `nonReentrant`. The delivery leg is the one untrusted call it makes, so
    ///         a token that calls back into `fill` mid-settlement is rejected — the buyer can never be
    ///         charged twice for one reservation.
    function testRevert_fill_reentrantFillFromTheDeliveryLeg() public {
        ReentrantATSToken hostile = new ReentrantATSToken();
        (address venue, uint256 id, uint256 cost) = _armedHostileVenue(hostile);
        hostile.arm(venue, ReentrantATSToken.Hook.Fill, ReentrantATSToken.Hook.None, id, 10 * ONE_TOKEN);

        vm.prank(bob);
        vm.expectRevert(IReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ITenorMarket(venue).fill(id, 10 * ONE_TOKEN);

        assertEq(_usdcOf(bob), cost, "invariant 1 - the payment leg rolled back with the guard");
        assertEq(ITenorMarket(venue).getListing(id).remaining, 100 * ONE_TOKEN, "the listing is untouched");
    }

    /// @notice SPEC §6.4: the same lock covers `cancel`, so the delivery leg cannot unwind the listing it
    ///         is settling.
    function testRevert_fill_reentrantCancelFromTheDeliveryLeg() public {
        ReentrantATSToken hostile = new ReentrantATSToken();
        (address venue, uint256 id, uint256 cost) = _armedHostileVenue(hostile);
        hostile.arm(venue, ReentrantATSToken.Hook.Cancel, ReentrantATSToken.Hook.None, id, 0);

        vm.prank(bob);
        vm.expectRevert(IReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ITenorMarket(venue).fill(id, 10 * ONE_TOKEN);

        assertEq(_usdcOf(bob), cost, "invariant 1 - nothing was paid");
    }

    /// @notice SPEC §6.4: `cancel` is `nonReentrant` too. Its release leg is an untrusted call, and a token
    ///         that re-enters `cancel` from it cannot release the same reservation twice.
    function testRevert_cancel_reentrantCancelFromTheReleaseLeg() public {
        ReentrantATSToken hostile = new ReentrantATSToken();
        (address venue, uint256 id,) = _armedHostileVenue(hostile);
        hostile.arm(venue, ReentrantATSToken.Hook.None, ReentrantATSToken.Hook.Cancel, id, 0);

        vm.prank(alice);
        vm.expectRevert(IReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ITenorMarket(venue).cancel(id);

        assertTrue(ITenorMarket(venue).getListing(id).active, "the listing survived the attempt");
    }

    /// @notice SPEC §6.4: and a release leg that tries to sell the tokens it is handing back is rejected on
    ///         the same lock.
    function testRevert_cancel_reentrantFillFromTheReleaseLeg() public {
        ReentrantATSToken hostile = new ReentrantATSToken();
        (address venue, uint256 id,) = _armedHostileVenue(hostile);
        hostile.arm(venue, ReentrantATSToken.Hook.None, ReentrantATSToken.Hook.Fill, id, 10 * ONE_TOKEN);

        vm.prank(alice);
        vm.expectRevert(IReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ITenorMarket(venue).cancel(id);

        assertTrue(ITenorMarket(venue).getListing(id).active, "the listing survived the attempt");
    }

    /// @notice Control for the four tests above: with the hooks disarmed the very same hostile venue settles
    ///         normally. Without this, a guard test could pass because the setup was broken rather than
    ///         because the lock fired.
    function test_hostileVenue_settlesWhenTheHooksAreDisarmed() public {
        ReentrantATSToken hostile = new ReentrantATSToken();
        (address venue, uint256 id,) = _armedHostileVenue(hostile);
        hostile.arm(venue, ReentrantATSToken.Hook.None, ReentrantATSToken.Hook.None, id, 0);

        vm.prank(bob);
        ITenorMarket(venue).fill(id, 10 * ONE_TOKEN);
        assertEq(ITenorMarket(venue).getListing(id).remaining, 90 * ONE_TOKEN, "the disarmed venue settles");

        vm.prank(alice);
        ITenorMarket(venue).cancel(id);
        assertFalse(ITenorMarket(venue).getListing(id).active, "and cancels");
    }
}
