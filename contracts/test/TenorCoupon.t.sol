// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IAccessControl} from "@lattice/interfaces/access/IAccessControl.sol";
import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaScheduleService} from "@lattice/interfaces/external/hedera/IHederaScheduleService.sol";
import {IHederaTokenService} from "@lattice/interfaces/external/hedera/IHederaTokenService.sol";
import {IHSSAdapter} from "@lattice/interfaces/oracles/IHSSAdapter.sol";
import {Vm} from "forge-std/Vm.sol";
import {CouponInvalidSchedulePayload, ISSUER_ROLE, ITenorCouponSchedule} from "../src/coupon/TenorCouponLib.sol";
import {ITenorCoupon} from "../src/interfaces/ITenorCoupon.sol";
import {TenorHTS} from "../src/TenorHTS.sol";
import {TenorTestBase} from "./TenorTestBase.sol";

/// @title TenorCouponTest
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice SPEC §7.3 — the coupon module's register, funding, permissionless settlement and Hedera
///         Scheduled-Transaction automation.
/// @dev The organising claim of the whole module is that **automation is an optimisation over a
///      permissionless fallback**. Every group below is therefore paired: the happy path, and the
///      degrade path that must still leave the coupon payable. Nothing in settlement may depend on
///      the scheduled call's sender identity, and no single unreachable holder, refused delete or
///      consumed schedule may be able to wedge the instrument.
contract TenorCouponTest is TenorTestBase {
    /// @dev The coupon under test in nearly every case. Ids are issuer-chosen, not sequential.
    uint256 internal constant COUPON_ID = 1;
    /// @dev 5 USDC (6 dp) per WHOLE security token.
    uint256 internal constant PER_TOKEN = 5 * 10 ** 6;
    /// @dev Generous enough that a failed `fireSchedule` is a contract revert, never out-of-gas.
    uint256 internal constant GAS_LIMIT = 3_000_000;

    /// @dev A registered holder who is deliberately never associated with USDC, so HTS refuses his
    ///      coupon leg with a real response code rather than a forced one.
    address internal dave = makeAddr("dave");
    /// @dev An address with no role and no stake, used to prove `payCoupon` is permissionless.
    address internal keeper = makeAddr("keeper");

    //*//////////////////////////////////////////////////////////////////////////
    //                                   HELPERS
    //////////////////////////////////////////////////////////////////////////*//

    function _arr(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _arr(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        out[0] = a;
        out[1] = b;
    }

    function _arr(address a, address b, address c) internal pure returns (address[] memory out) {
        out = new address[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }

    function _register(address[] memory holders) internal {
        vm.prank(issuer);
        coupon.registerHolders(holders);
    }

    /// @dev Funds `couponId` to exactly what the register currently requires, seeding the issuer with the
    ///      USDC and the allowance for the top-up first. Returns the amount actually pulled.
    function _fund(uint256 couponId, uint256 perToken, uint64 payAt) internal returns (uint256 topUp) {
        uint256 required = coupon.couponRequirement(perToken);
        uint256 funded = coupon.getCoupon(couponId).funded;
        topUp = required > funded ? required - funded : 0;
        if (topUp != 0) {
            _fundUsdc(issuer, topUp);
            _approveUsdc(issuer, topUp);
        }
        vm.prank(issuer);
        coupon.fundCoupon(couponId, perToken, payAt);
    }

    function _schedule(uint256 couponId) internal returns (address scheduleAddress) {
        vm.prank(issuer);
        coupon.scheduleCoupon(couponId, GAS_LIMIT);
        scheduleAddress = coupon.couponScheduleAddress(couponId);
    }

    /// @dev The exact revert `AccessControlLib.checkRole(ISSUER_ROLE)` raises against `account`.
    function _notIssuer(address account) internal pure returns (bytes memory data) {
        data = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, ISSUER_ROLE);
    }

    function _usdcBal(address account) internal view returns (uint256 balance) {
        balance = uint256(uint64(hts.balanceOf(usdc, account)));
    }

    function _payAt() internal view returns (uint64 payAt) {
        payAt = uint64(block.timestamp + 30 days);
    }

    /// @dev The register + funding both the settlement groups start from: alice 100 notes, bob 50, one
    ///      coupon of 5 USDC per whole note — 750 USDC in total, 500 to alice and 250 to bob.
    function _standardCoupon() internal returns (uint64 payAt) {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        atsToken.mint(bob, 50 * ONE_TOKEN);
        _register(_arr(alice, bob));
        payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
    }

    function _countEvents(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) ++count;
        }
    }

    /// @dev The response code the one {ITenorCoupon-CouponScheduleCancelled} in `logs` carries.
    function _cancelCode(Vm.Log[] memory logs) internal pure returns (int64 code) {
        bytes32 topic0 = ITenorCoupon.CouponScheduleCancelled.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) {
                (, code) = abi.decode(logs[i].data, (address, int64));
                return code;
            }
        }
        revert("no CouponScheduleCancelled emitted");
    }

    /// @dev The error selector in raw revert data — `fireSchedule` reports a failure instead of bubbling it,
    ///      so a test that only checked `success == false` would not know WHY the scheduled call failed.
    function _errSelector(bytes memory ret) internal pure returns (bytes4 selector) {
        require(ret.length >= 4, "no revert data to decode");
        assembly ("memory-safe") {
            selector := mload(add(ret, 0x20))
        }
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                            REGISTER — SPEC §7.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The register is issuer-curated and observable: only `ISSUER_ROLE` may extend it, and every
    ///         genuinely new member is announced so an indexer can mirror it.
    function test_registerHolders_recordsEveryNewHolderAndAnnouncesIt() public {
        vm.expectEmit(true, false, false, false, tenor);
        emit ITenorCoupon.HolderRegistered(alice);
        vm.expectEmit(true, false, false, false, tenor);
        emit ITenorCoupon.HolderRegistered(bob);
        _register(_arr(alice, bob));

        address[] memory holders = coupon.couponHolders();
        assertEq(holders.length, 2, "both holders registered");
        assertEq(holders[0], alice, "registration order preserved");
        assertEq(holders[1], bob, "registration order preserved");
        assertEq(coupon.couponToken(), address(atsToken), "register is pinned to the security token");
    }

    /// @notice The register decides who gets paid, so extending it is issuer-only.
    function testRevert_registerHolders_requiresIssuerRole() public {
        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        coupon.registerHolders(_arr(bob));
    }

    /// @notice Idempotence per address across calls: re-registering announces nothing and duplicates
    ///         nothing, so a retried or replayed issuer transaction cannot double an entitlement.
    function test_registerHolders_repeatIsSilentAndAddsNothing() public {
        _register(_arr(alice));

        vm.recordLogs();
        _register(_arr(alice, bob));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countEvents(logs, ITenorCoupon.HolderRegistered.selector), 1, "only the genuinely new holder announced"
        );
        address[] memory holders = coupon.couponHolders();
        assertEq(holders.length, 2, "alice not appended twice");
        assertEq(holders[0], alice, "the original entry is the one kept");
    }

    /// @notice A holder named twice in ONE call is registered once — the membership flag is written before
    ///         the next iteration reads it.
    function test_registerHolders_dedupesWithinASingleCall() public {
        vm.recordLogs();
        _register(_arr(alice, alice, alice));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countEvents(logs, ITenorCoupon.HolderRegistered.selector), 1, "one announcement for one holder");
        assertEq(coupon.couponHolders().length, 1, "one register entry");
    }

    /// @notice The consequence that actually matters: a duplicate in one call must not double what the
    ///         coupon costs the issuer, nor what the holder receives.
    function test_registerHolders_duplicateInOneCallIsPaidOnce() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(alice, alice));

        assertEq(coupon.couponRequirement(PER_TOKEN), 500 * 10 ** 6, "alice counted once in the requirement");

        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice paid once, not twice");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 500 * 10 ** 6, "paid matches the single entitlement");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                             FUNDING — SPEC §7.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Funding pulls the issuer's own USDC, so only the issuer may trigger the pull.
    function testRevert_fundCoupon_requiresIssuerRole() public {
        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, _payAt());
    }

    /// @notice A zero rate would book a coupon that can never pay anyone while still marking terms —
    ///         rejected outright rather than stored.
    function testRevert_fundCoupon_rejectsZeroAmountPerToken() public {
        vm.prank(issuer);
        vm.expectRevert(ITenorCoupon.CouponInvalidAmount.selector);
        coupon.fundCoupon(COUPON_ID, 0, _payAt());
    }

    /// @notice `payAt` must be strictly in the future: a coupon that is due the instant it is funded could
    ///         never be scheduled (`scheduleCall` refuses a non-future expiry) and leaves no window to book.
    function testRevert_fundCoupon_rejectsPayAtAtOrBeforeNow() public {
        uint64 now_ = uint64(block.timestamp);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponInvalidPayAt.selector, now_));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, now_);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponInvalidPayAt.selector, now_ - 1));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, now_ - 1);
    }

    /// @notice Funding pulls EXACTLY `amountPerToken * Σ balanceOf / 10**decimals` and no more, even when
    ///         the issuer has over-approved. Over-pulling would let the diamond sweep the issuer's wallet.
    function test_fundCoupon_pullsExactlyTheRequirement() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        atsToken.mint(bob, 50 * ONE_TOKEN);
        _register(_arr(alice, bob));

        uint256 required = coupon.couponRequirement(PER_TOKEN);
        assertEq(required, 750 * 10 ** 6, "150 notes x 5 USDC");

        uint256 slack = 10 * 10 ** 6;
        _fundUsdc(issuer, required + slack);
        _approveUsdc(issuer, required + slack);

        uint64 payAt = _payAt();
        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponFunded(COUPON_ID, required, PER_TOKEN, payAt);
        vm.prank(issuer);
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, payAt);

        assertEq(_usdcBal(issuer), slack, "only the requirement left the issuer");
        assertEq(_usdcBal(tenor), required, "the diamond custodies exactly the funding");
        assertEq(hts.allowances(usdc, issuer, tenor), slack, "only the requirement was spent from the allowance");

        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertEq(c.funded, required, "funded recorded");
        assertEq(c.amountPerToken, PER_TOKEN, "terms recorded");
        assertEq(c.payAt, payAt, "payAt recorded");
        assertEq(c.paid, 0, "nothing paid yet");
        assertFalse(c.settled, "not settled by funding");
    }

    /// @notice A second `fundCoupon` after balances grew charges the DIFFERENCE, never the coupon again.
    ///         Double-charging the issuer to cover a 1-note purchase would make the instrument unusable.
    function test_fundCoupon_topUpChargesOnlyTheDifference() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(alice));
        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
        assertEq(coupon.getCoupon(COUPON_ID).funded, 500 * 10 ** 6, "first funding");

        atsToken.mint(alice, 20 * ONE_TOKEN);
        uint256 expectedTopUp = 100 * 10 ** 6;

        _fundUsdc(issuer, expectedTopUp);
        _approveUsdc(issuer, expectedTopUp);
        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponFunded(COUPON_ID, expectedTopUp, PER_TOKEN, payAt);
        vm.prank(issuer);
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, payAt);

        assertEq(coupon.getCoupon(COUPON_ID).funded, 600 * 10 ** 6, "funded is cumulative");
        assertEq(_usdcBal(issuer), 0, "the issuer paid only the difference");
        assertEq(_usdcBal(tenor), 600 * 10 ** 6, "the diamond holds the whole requirement");
    }

    /// @notice A shrunken register never refunds through `fundCoupon`: `funded` is a high-water mark and the
    ///         overhang leaves only through `withdrawCouponSurplus` after settlement.
    function test_fundCoupon_chargesNothingWhenTheRequirementFell() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(alice));
        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);

        vm.prank(alice);
        atsToken.transfer(carol, 40 * ONE_TOKEN); // carol is not registered, so the requirement drops

        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponFunded(COUPON_ID, 0, PER_TOKEN, payAt);
        vm.prank(issuer);
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, payAt);

        assertEq(coupon.getCoupon(COUPON_ID).funded, 500 * 10 ** 6, "funding is never reduced by a re-call");
        assertEq(_usdcBal(issuer), 0, "nothing further pulled");
    }

    /// @notice A settled coupon is closed: re-funding it would strand USDC against terms nobody can execute.
    function testRevert_fundCoupon_alreadySettledCoupon() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponAlreadySettled.selector, COUPON_ID));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, uint64(block.timestamp + 1 days));
    }

    /// @notice The two reads a client prices from must agree with what settlement actually moves, including
    ///         where per-holder flooring bites: `couponRequirement` is summed BEFORE dividing, so it is never
    ///         below the sum of the individually floored entitlements, and the difference is recoverable dust.
    function test_couponReads_agreeWithWhatPayCouponPays() public {
        atsToken.mint(alice, ONE_TOKEN + ONE_TOKEN / 2); // 1.5 notes
        atsToken.mint(bob, 2 * ONE_TOKEN + ONE_TOKEN / 2); // 2.5 notes
        _register(_arr(alice, bob));

        uint256 perToken = 3; // 3 atomic USDC units per whole note — flooring is unavoidable
        uint64 payAt = _payAt();
        uint256 required = coupon.couponRequirement(perToken);
        assertEq(required, 12, "4 whole notes x 3, summed before dividing");
        _fund(COUPON_ID, perToken, payAt);

        uint256 aliceDue = coupon.couponEntitlement(COUPON_ID, alice);
        uint256 bobDue = coupon.couponEntitlement(COUPON_ID, bob);
        assertEq(aliceDue, 4, "1.5 notes x 3 floored");
        assertEq(bobDue, 7, "2.5 notes x 3 floored");
        assertGe(required, aliceDue + bobDue, "the requirement never under-funds the floored entitlements");

        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), aliceDue, "alice received exactly her preview");
        assertEq(_usdcBal(bob), bobDue, "bob received exactly his preview");
        assertEq(coupon.getCoupon(COUPON_ID).paid, aliceDue + bobDue, "paid is the sum of the floored entitlements");

        vm.prank(issuer);
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);
        assertEq(_usdcBal(issuer), required - (aliceDue + bobDue), "the rounding dust is recoverable, not stranded");
    }

    /// @notice Property: whatever the balance and rate, a holder receives exactly what `couponEntitlement`
    ///         previewed for them at payment time.
    function testFuzz_couponEntitlement_matchesWhatIsPaid(uint256 balance, uint256 perToken) public {
        balance = bound(balance, ONE_TOKEN, 1e12);
        perToken = bound(perToken, 1, 1e9);

        atsToken.mint(alice, balance);
        _register(_arr(alice));
        uint64 payAt = _payAt();
        _fund(COUPON_ID, perToken, payAt);

        uint256 due = coupon.couponEntitlement(COUPON_ID, alice);
        assertEq(due, perToken * balance / ONE_TOKEN, "entitlement is amountPerToken x balance / unit, floored");

        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);
        assertEq(_usdcBal(alice), due, "the preview is what settlement moved");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                           TERMS LOCK — SPEC §7.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice While a booking is live the network will fire at the second it accepted, so `payAt` cannot be
    ///         moved underneath it — the booked call would be either premature or late for terms that no
    ///         longer exist. The error carries the STORED terms, which is what the client must re-book against.
    function testRevert_fundCoupon_termsLockedAgainstAChangedPayAt() public {
        uint64 payAt = _standardCoupon();
        _schedule(COUPON_ID);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponTermsLocked.selector, COUPON_ID, payAt, PER_TOKEN));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, payAt + 1 days);
    }

    /// @notice Same guard on the rate: a booked call must not fire against an `amountPerToken` the issuer
    ///         changed after the network accepted it.
    function testRevert_fundCoupon_termsLockedAgainstAChangedRate() public {
        uint64 payAt = _standardCoupon();
        _schedule(COUPON_ID);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponTermsLocked.selector, COUPON_ID, payAt, PER_TOKEN));
        coupon.fundCoupon(COUPON_ID, PER_TOKEN * 2, payAt);
    }

    /// @notice The lock must NOT block the case the issuer actually needs: a pure top-up at the same terms
    ///         after balances grew. Otherwise a booked coupon could never be brought back into funding.
    function test_fundCoupon_topUpAtIdenticalTermsSurvivesTheLock() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        atsToken.mint(bob, 20 * ONE_TOKEN);
        uint256 topUp = _fund(COUPON_ID, PER_TOKEN, payAt);

        assertEq(topUp, 100 * 10 ** 6, "only the difference was pulled");
        assertEq(coupon.getCoupon(COUPON_ID).funded, 850 * 10 ** 6, "funding raised under a live booking");
        assertEq(coupon.couponScheduleAddress(COUPON_ID), scheduleAddress, "the booking is untouched by a top-up");
    }

    /// @notice Cancelling releases the lock, so re-dating works again. Cancel-then-re-fund is the documented
    ///         escape hatch the error tells the issuer to use.
    function test_fundCoupon_reDatingWorksAfterCancelSchedule() public {
        uint64 payAt = _standardCoupon();
        _schedule(COUPON_ID);

        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);
        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "no live booking after a cancel");

        uint64 newPayAt = payAt + 7 days;
        _fund(COUPON_ID, PER_TOKEN * 2, newPayAt);

        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertEq(c.payAt, newPayAt, "re-dated");
        assertEq(c.amountPerToken, PER_TOKEN * 2, "re-rated");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                          SETTLEMENT — SPEC §7.3
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice FR4's fallback, and the reason automation is only an optimisation: a due, funded coupon is
    ///         settleable by ANY address. If the Schedule Service never fires, the product still works.
    function test_payCoupon_isPermissionless() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);

        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponPaid(COUPON_ID, 750 * 10 ** 6, 2);
        vm.prank(keeper); // no role, no stake, no registration
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice paid by a stranger's transaction");
        assertEq(_usdcBal(bob), 250 * 10 ** 6, "bob paid by a stranger's transaction");
        assertTrue(coupon.getCoupon(COUPON_ID).settled, "settled");
    }

    /// @notice Nobody may pull a coupon forward, however permissionless settlement is.
    function testRevert_payCoupon_notDue() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt - 1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotDue.selector, COUPON_ID, payAt));
        coupon.payCoupon(COUPON_ID);
        assertEq(_usdcBal(alice), 0, "nothing moved");
    }

    /// @notice An unfunded id is not a coupon. Settling one would emit `CouponPaid` for a period that was
    ///         never financed, and mark it settled so it could never be funded.
    function testRevert_payCoupon_notFunded() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(alice));

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotFunded.selector, COUPON_ID));
        coupon.payCoupon(COUPON_ID);
    }

    /// @notice Idempotence: `settled` is written before any interaction, so a second settlement reverts and
    ///         nobody is paid twice — the property the network's at-least-once firing depends on.
    function testRevert_payCoupon_alreadySettledPaysNobodyTwice() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponAlreadySettled.selector, COUPON_ID));
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice still holds exactly one coupon");
        assertEq(_usdcBal(bob), 250 * 10 ** 6, "bob still holds exactly one coupon");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 750 * 10 ** 6, "paid unchanged by the second attempt");
    }

    /// @notice Entitlement follows the LIVE balance at payment time, not the balance at funding time. A bond
    ///         that traded between funding and the coupon date must pay whoever holds it on the date.
    function test_payCoupon_followsTheBalanceAtPaymentTimeNotFundingTime() public {
        uint64 payAt = _standardCoupon();

        // The secondary market does its job: 30 notes move from alice to bob after funding.
        vm.prank(alice);
        atsToken.transfer(bob, 30 * ONE_TOKEN);

        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 350 * 10 ** 6, "alice paid on 70 notes, not the 100 she funded against");
        assertEq(_usdcBal(bob), 400 * 10 ** 6, "bob paid on 80 notes, including the 30 he bought");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 750 * 10 ** 6, "the total is conserved");
    }

    /// @notice **Skip accounting.** One holder HTS refuses is recorded and stepped over — with the holder,
    ///         the amount and the response code — every other holder is still paid, `paid` excludes the
    ///         skipped amount, and the coupon still settles. One unreachable holder must never strand the rest.
    function test_payCoupon_skipsARefusedHolderAndStillPaysEveryoneElse() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);

        // One arbitrary Hedera failure, landing on the first holder with a non-zero entitlement.
        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);

        vm.expectEmit(true, true, false, true, tenor);
        emit ITenorCoupon.CouponPaymentSkipped(
            COUPON_ID, alice, 500 * 10 ** 6, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN
        );
        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponPaid(COUPON_ID, 250 * 10 ** 6, 2);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 0, "the refused holder received nothing");
        assertEq(_usdcBal(bob), 250 * 10 ** 6, "the reachable holder was still paid in full");

        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertTrue(c.settled, "the coupon still settles");
        assertEq(c.paid, 250 * 10 ** 6, "paid excludes the skipped amount");
        assertEq(c.funded, 750 * 10 ** 6, "funding is untouched, so the skipped amount stays recoverable");
        assertEq(_usdcBal(tenor), 500 * 10 ** 6, "the skipped USDC is still custodied by the diamond");
    }

    /// @notice The same degrade path without a cheat: a registered holder who never associated with USDC.
    ///         This is the real-network case §7.3 names, and the code in the event is HTS's own answer.
    function test_payCoupon_skipsAnUnassociatedHolderWithTheRealResponseCode() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        atsToken.mint(dave, 10 * ONE_TOKEN); // dave holds the bond but never associated with USDC
        _register(_arr(alice, dave));
        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
        vm.warp(payAt);

        vm.expectEmit(true, true, false, true, tenor);
        emit ITenorCoupon.CouponPaymentSkipped(
            COUPON_ID, dave, 50 * 10 ** 6, HederaResponseCodes.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT
        );
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "the associated holder was paid");
        assertEq(_usdcBal(dave), 0, "the unassociated holder could not be");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 500 * 10 ** 6, "paid counts only what landed");
    }

    /// @notice A registered holder who sold out is skipped silently — no event and no transfer. Emitting a
    ///         skip for a zero entitlement would make the log unreadable for a register that only grows.
    function test_payCoupon_zeroBalanceHolderIsSkippedSilently() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(carol, alice)); // carol is registered but holds nothing
        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
        vm.warp(payAt);

        vm.recordLogs();
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countEvents(logs, ITenorCoupon.CouponPaymentSkipped.selector), 0, "a zero balance is not a skip");
        assertEq(_usdcBal(carol), 0, "nothing delivered to the empty holder");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 500 * 10 ** 6, "only the real holder was paid");
    }

    /// @notice The stronger form of the same claim — no HTS CALL is made for a zero entitlement. Proven by
    ///         arming one forced failure: carol is first in the register, so if she were transferred to she
    ///         would consume it and alice would be paid. Alice being the one skipped proves no call was made
    ///         for carol.
    function test_payCoupon_zeroBalanceHolderMakesNoHtsCall() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(carol, alice));
        uint64 payAt = _payAt();
        _fund(COUPON_ID, PER_TOKEN, payAt);
        vm.warp(payAt);

        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);

        vm.expectEmit(true, true, false, true, tenor);
        emit ITenorCoupon.CouponPaymentSkipped(
            COUPON_ID, alice, 500 * 10 ** 6, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN
        );
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(coupon.getCoupon(COUPON_ID).paid, 0, "the forced code was spent on alice, never on carol");
    }

    /// @notice An underfunded coupon (balances grew after funding) reverts BEFORE paying anyone: entitlements
    ///         are totalled first, so the coupon fails whole instead of paying the early holders and
    ///         stranding the rest. GROUND-TRUTH §8 keeps this a revert rather than a pro-rata payment.
    function testRevert_payCoupon_underfundedPaysNobody() public {
        uint64 payAt = _standardCoupon();
        atsToken.mint(bob, 10 * ONE_TOKEN); // +50 USDC of entitlement, unfunded
        vm.warp(payAt);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.InsufficientFunding.selector, 800 * 10 ** 6, 750 * 10 ** 6));
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 0, "the first holder in the register was not paid");
        assertEq(_usdcBal(bob), 0, "nor the second");
        assertEq(_usdcBal(tenor), 750 * 10 ** 6, "the funding is intact");
        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertFalse(c.settled, "the coupon is still open, so the issuer's remedy remains available");
        assertEq(c.paid, 0, "nothing recorded as paid");
    }

    /// @notice The issuer's remedy from GROUND-TRUTH §8: top up and re-call, and the coupon settles. Note
    ///         that a coupon already past `payAt` must be re-dated forward to be topped up, because
    ///         `fundCoupon` refuses a non-future `payAt`.
    function test_payCoupon_settlesAfterTheIssuerTopsUp() public {
        uint64 payAt = _standardCoupon();
        atsToken.mint(bob, 10 * ONE_TOKEN);
        vm.warp(payAt);

        uint64 newPayAt = uint64(block.timestamp + 1 days);
        uint256 topUp = _fund(COUPON_ID, PER_TOKEN, newPayAt);
        assertEq(topUp, 50 * 10 ** 6, "only the shortfall was pulled");

        vm.warp(newPayAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice paid");
        assertEq(_usdcBal(bob), 300 * 10 ** 6, "bob paid on his grown position");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 800 * 10 ** 6, "settled in full");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                              SURPLUS SWEEP
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The surplus is the issuer's money, so only the issuer may direct it.
    function testRevert_withdrawCouponSurplus_requiresIssuerRole() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        coupon.withdrawCouponSurplus(COUPON_ID, bob);
    }

    /// @notice Nothing may leave before settlement: until `payCoupon` has run, every funded unit is still
    ///         owed to a holder, so "surplus" is not yet defined.
    function testRevert_withdrawCouponSurplus_beforeSettlement() public {
        _standardCoupon();

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotSettled.selector, COUPON_ID));
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);
    }

    /// @notice The sweep moves exactly `funded - paid` — here the amount a skipped holder left behind — and
    ///         drops `funded` to `paid`, so the coupon's books close at zero.
    function test_withdrawCouponSurplus_movesExactlyFundedMinusPaid() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        uint256 surplus = 500 * 10 ** 6;
        vm.expectEmit(true, true, false, true, tenor);
        emit ITenorCoupon.CouponSurplusWithdrawn(COUPON_ID, issuer, surplus);
        vm.prank(issuer);
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);

        assertEq(_usdcBal(issuer), surplus, "the skipped holder's coupon came back");
        assertEq(_usdcBal(tenor), 0, "the diamond retains nothing of this coupon");
        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertEq(c.funded, c.paid, "funded collapses onto paid, so the surplus is gone from the books");
    }

    /// @notice The surplus is zeroed BEFORE the transfer, so it cannot be withdrawn twice. The second call
    ///         is a no-op — it moves nothing and emits nothing — rather than a revert.
    function test_withdrawCouponSurplus_cannotBeWithdrawnTwice() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        vm.prank(issuer);
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);
        uint256 afterFirst = _usdcBal(issuer);

        vm.recordLogs();
        vm.prank(issuer);
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countEvents(logs, ITenorCoupon.CouponSurplusWithdrawn.selector), 0, "no second withdrawal event");
        assertEq(_usdcBal(issuer), afterFirst, "no second payout");
        assertEq(_usdcBal(tenor), 0, "and nothing conjured out of the diamond");
    }

    /// @notice A refused sweep reverts whole, restoring `funded` — the surplus must never be lost to a
    ///         failed HTS transfer, so a later attempt still works.
    function test_withdrawCouponSurplus_refusedTransferLeavesTheSurplusClaimable() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        hts.force(IHederaTokenService.transferToken.selector, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                TenorHTS.TenorHTSCallFailed.selector,
                IHederaTokenService.transferToken.selector,
                HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN
            )
        );
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);

        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertEq(c.funded - c.paid, 500 * 10 ** 6, "the surplus was restored with the revert");

        // The reverted frame rolled the mock's forced-code consumption back with it, so clear it by hand.
        hts.force(IHederaTokenService.transferToken.selector, 0);
        vm.prank(issuer);
        coupon.withdrawCouponSurplus(COUPON_ID, issuer);
        assertEq(_usdcBal(issuer), 500 * 10 ** 6, "and is still claimable afterwards");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                         SCHEDULING (HSS) — FR4
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Booking spends the diamond's own HBAR and pins the coupon's terms, so it is issuer-only. The
    ///         role check lives in the inner trampoline frame and its revert must bubble out unchanged.
    function testRevert_scheduleCoupon_requiresIssuerRole() public {
        _standardCoupon();

        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        coupon.scheduleCoupon(COUPON_ID, GAS_LIMIT);
    }

    /// @notice Booking an unfunded coupon would burn a schedule slot and HBAR on a call that can only revert.
    function testRevert_scheduleCoupon_unfundedCoupon() public {
        atsToken.mint(alice, 100 * ONE_TOKEN);
        _register(_arr(alice));

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotFunded.selector, COUPON_ID));
        coupon.scheduleCoupon(COUPON_ID, GAS_LIMIT);
    }

    /// @notice Same for a settled coupon: there is nothing left for the network to do.
    function testRevert_scheduleCoupon_settledCoupon() public {
        uint64 payAt = _standardCoupon();
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponAlreadySettled.selector, COUPON_ID));
        coupon.scheduleCoupon(COUPON_ID, GAS_LIMIT);
    }

    /// @notice Capacity is checked before booking, and a full network is reported as Tenor's own typed error
    ///         so the client can tell "no room at that second" from a genuine failure and fall back to the
    ///         permissionless path.
    function testRevert_scheduleCoupon_noScheduleCapacity() public {
        uint64 payAt = _standardCoupon();
        hss.setScheduleCapacity(false);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.NoScheduleCapacity.selector, payAt, GAS_LIMIT));
        coupon.scheduleCoupon(COUPON_ID, GAS_LIMIT);

        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "nothing booked");
    }

    /// @notice A successful booking is announced with its schedule address, job id and due second, and
    ///         `couponScheduleAddress` reads the same booking back from Lattice's job mapping — the single
    ///         source of truth, since the `Coupon` struct deliberately stores no copy.
    function test_scheduleCoupon_booksAndReadsBackTheSchedule() public {
        uint64 payAt = _standardCoupon();
        bytes32 jobId = keccak256(abi.encode(COUPON_ID, uint64(0)));
        address expected =
            hss.scheduleAddressFor(tenor, payAt, GAS_LIMIT, 0, abi.encodeCall(ITenorCoupon.payCoupon, (COUPON_ID)));

        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponScheduled(COUPON_ID, expected, payAt, jobId);
        vm.prank(issuer);
        coupon.scheduleCoupon(COUPON_ID, GAS_LIMIT);

        assertEq(coupon.couponScheduleAddress(COUPON_ID), expected, "the booking reads back");
        assertEq(hss.getScheduledCall(expected).to, tenor, "the network will call the diamond itself");
        assertEq(
            hss.getScheduledCall(expected).callData,
            abi.encodeCall(ITenorCoupon.payCoupon, (COUPON_ID)),
            "and only with payCoupon(couponId)"
        );
    }

    /// @notice **FR4 end to end.** Book it, let the second arrive, let the network fire it: holders are paid
    ///         with no manual transaction at all.
    function test_scheduledCoupon_firesAndPaysHolders() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        vm.warp(payAt);
        (bool success, bytes memory ret) = hss.fireSchedule(scheduleAddress);
        assertTrue(success, "the scheduled payCoupon must actually settle");
        assertEq(ret.length, 0, "payCoupon returns nothing");

        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice paid by the network");
        assertEq(_usdcBal(bob), 250 * 10 ** 6, "bob paid by the network");
        ITenorCoupon.Coupon memory c = coupon.getCoupon(COUPON_ID);
        assertTrue(c.settled, "settled by the scheduled call");
        assertEq(c.paid, 750 * 10 ** 6, "paid in full");
    }

    /// @notice A fired schedule has been consumed by the network, and `msg.sender == address(this)` is what
    ///         lets `completeSelfCall` clear the booking — so after automation runs, nothing is left booked.
    function test_firedSettlement_clearsTheBooking() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);
        assertEq(coupon.couponScheduleAddress(COUPON_ID), scheduleAddress, "booked before firing");

        vm.warp(payAt);
        (bool success,) = hss.fireSchedule(scheduleAddress);
        assertTrue(success, "fired");

        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "the self-call cleared its own booking");
    }

    /// @notice The guarded branch: a manual settlement from an EOA must NOT clear the booking, because
    ///         `completeSelfCall` requires `msg.sender == address(this)` and `payCoupon` is permissionless.
    ///         Settlement therefore succeeds while the bookkeeping stays honest about the live schedule.
    function test_manualSettlement_leavesTheBookingIntact() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        assertTrue(coupon.getCoupon(COUPON_ID).settled, "an EOA settled it");
        assertEq(coupon.couponScheduleAddress(COUPON_ID), scheduleAddress, "but could not clear the booking");
    }

    /// @notice A stale booking that later fires is harmless: the coupon is already settled, so the network's
    ///         call reverts rather than paying anyone twice.
    function test_firingAStaleScheduleAfterAManualSettlementPaysNobodyTwice() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);

        (bool success, bytes memory ret) = hss.fireSchedule(scheduleAddress);
        assertFalse(success, "the network's call finds the coupon settled");
        assertEq(_errSelector(ret), ITenorCoupon.CouponAlreadySettled.selector, "and says exactly why");
        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice still holds exactly one coupon");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                   THE PAYLOAD TRAMPOLINE — SECURITY CRITICAL
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice `scheduleCouponSelfCall` is cut into the diamond and therefore reachable directly, so it
    ///         re-checks the role itself. Reaching it must be exactly equivalent to calling `scheduleCoupon`.
    function testRevert_scheduleCouponSelfCall_rejectsANonIssuerCaller() public {
        _standardCoupon();
        bytes memory payload = abi.encodeCall(ITenorCoupon.payCoupon, (COUPON_ID));

        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        ITenorCouponSchedule(tenor).scheduleCouponSelfCall(COUPON_ID, GAS_LIMIT, payload);
    }

    /// @notice Nothing but `payCoupon(couponId)` may ever be booked as the diamond's own call. The payload is
    ///         pinned to the canonical encoding, so even an ISSUER_ROLE holder cannot make the network call
    ///         an arbitrary diamond function as `address(this)` — which would defeat every self-call guard
    ///         in the system.
    function testRevert_scheduleCouponSelfCall_rejectsAForeignPayload() public {
        _standardCoupon();

        // A payload that would have the NETWORK call the diamond's own privileged surface as itself.
        bytes memory hostile = abi.encodeCall(ITenorCoupon.withdrawCouponSurplus, (COUPON_ID, bob));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CouponInvalidSchedulePayload.selector, COUPON_ID));
        ITenorCouponSchedule(tenor).scheduleCouponSelfCall(COUPON_ID, GAS_LIMIT, hostile);

        // And a payload for a DIFFERENT coupon than the one being scheduled is equally rejected.
        bytes memory wrongId = abi.encodeCall(ITenorCoupon.payCoupon, (COUPON_ID + 1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CouponInvalidSchedulePayload.selector, COUPON_ID));
        ITenorCouponSchedule(tenor).scheduleCouponSelfCall(COUPON_ID, GAS_LIMIT, wrongId);

        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "nothing was booked");
    }

    /// @notice The canonical payload through the direct entry point books exactly what `scheduleCoupon`
    ///         books — the trampoline adds no privilege of its own.
    function test_scheduleCouponSelfCall_acceptsTheCanonicalPayload() public {
        uint64 payAt = _standardCoupon();
        bytes memory payload = abi.encodeCall(ITenorCoupon.payCoupon, (COUPON_ID));

        vm.prank(issuer);
        address scheduleAddress = ITenorCouponSchedule(tenor).scheduleCouponSelfCall(COUPON_ID, GAS_LIMIT, payload);

        assertEq(
            scheduleAddress,
            hss.scheduleAddressFor(tenor, payAt, GAS_LIMIT, 0, payload),
            "the same booking scheduleCoupon would make"
        );
        assertEq(coupon.couponScheduleAddress(COUPON_ID), scheduleAddress, "and it is recorded");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                            THE DEADLOCK GUARD
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice **The deadlock guard.** A scheduled `payCoupon` that FIRES AND FAILS has consumed its
    ///         schedule while leaving the coupon unsettled, so the network can no longer delete it. If
    ///         `cancelSchedule` insisted on a successful delete it would revert, the `scheduleNonce` bump
    ///         would never happen, and the coupon would be permanently un-re-schedulable — exactly the
    ///         situation the nonce exists for. So the bump is unconditional, the delete is best-effort, and
    ///         the non-SUCCESS code is recorded rather than raised.
    function test_cancelSchedule_survivesAFiredAndFailedScheduleAndPermitsAReschedule() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        // Balances grow after funding: the booked call will fire into an underfunded coupon.
        atsToken.mint(bob, 10 * ONE_TOKEN);
        vm.warp(payAt);
        (bool success, bytes memory ret) = hss.fireSchedule(scheduleAddress);
        assertFalse(success, "the scheduled call fired and failed");
        assertEq(_errSelector(ret), ITenorCoupon.InsufficientFunding.selector, "underfunded, as arranged");
        assertFalse(coupon.getCoupon(COUPON_ID).settled, "and the coupon is still open");

        // The schedule has been consumed, so the network refuses the delete — and cancel must still succeed.
        vm.recordLogs();
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(_cancelCode(logs) != HederaResponseCodes.SUCCESS, "the refused delete is recorded, not raised");
        assertEq(coupon.getCoupon(COUPON_ID).scheduleNonce, 1, "the nonce bump happened anyway");
        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "so the coupon reads as unscheduled");

        // Which is the whole point: it can be re-funded, re-booked and settled.
        uint64 newPayAt = uint64(block.timestamp + 1 days);
        _fund(COUPON_ID, PER_TOKEN, newPayAt);
        address rebooked = _schedule(COUPON_ID);
        assertTrue(rebooked != address(0), "re-scheduled");
        assertTrue(rebooked != scheduleAddress, "under a fresh job id, at a fresh second");

        vm.warp(newPayAt);
        (bool refired,) = hss.fireSchedule(rebooked);
        assertTrue(refired, "and the re-booked call settles");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 800 * 10 ** 6, "every holder paid in the end");
    }

    /// @notice The same tolerance against an arbitrary refusal from the Schedule Service: whatever code the
    ///         network answers a delete with, the cancel completes and records it. Scheduling is an
    ///         optimisation — it must never be able to wedge settlement.
    function test_cancelSchedule_toleratesARefusedDeleteAndRecordsTheCode() public {
        _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        hss.force(IHederaScheduleService.deleteSchedule.selector, HederaResponseCodes.INVALID_TRANSACTION);

        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponScheduleCancelled(COUPON_ID, scheduleAddress, HederaResponseCodes.INVALID_TRANSACTION);
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);

        assertEq(coupon.getCoupon(COUPON_ID).scheduleNonce, 1, "nonce bumped despite the refusal");
        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "re-schedulable");
    }

    /// @notice A clean cancel deletes the booking on the network too, and records SUCCESS.
    function test_cancelSchedule_deletesALiveBooking() public {
        uint64 payAt = _standardCoupon();
        address scheduleAddress = _schedule(COUPON_ID);

        vm.expectEmit(true, false, false, true, tenor);
        emit ITenorCoupon.CouponScheduleCancelled(COUPON_ID, scheduleAddress, HederaResponseCodes.SUCCESS);
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);

        assertEq(hss.getScheduledCall(scheduleAddress).to, address(0), "the network's booking is gone");
        // Nothing fires, and the coupon is still payable by anyone — the fallback is unaffected.
        vm.warp(payAt);
        vm.prank(keeper);
        coupon.payCoupon(COUPON_ID);
        assertEq(coupon.getCoupon(COUPON_ID).paid, 750 * 10 ** 6, "settlement never depended on the schedule");
    }

    /// @notice Cancelling nothing is an error, not a silent nonce bump: a silent bump would let an issuer
    ///         desynchronise the job id from a booking that a different nonce still owns.
    function testRevert_cancelSchedule_withNoBooking() public {
        _standardCoupon();

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotScheduled.selector, COUPON_ID));
        coupon.cancelSchedule(COUPON_ID);
    }

    /// @notice And a second cancel of an already-cancelled coupon reverts for the same reason — the new
    ///         nonce owns no booking.
    function testRevert_cancelSchedule_twiceOverTheSameBooking() public {
        _standardCoupon();
        _schedule(COUPON_ID);
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotScheduled.selector, COUPON_ID));
        coupon.cancelSchedule(COUPON_ID);
    }

    /// @notice Cancelling frees the terms lock and spends the diamond's HBAR, so it is issuer-only.
    function testRevert_cancelSchedule_requiresIssuerRole() public {
        _standardCoupon();
        _schedule(COUPON_ID);

        vm.prank(bob);
        vm.expectRevert(_notIssuer(bob));
        coupon.cancelSchedule(COUPON_ID);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                      NONCE BOOKKEEPING — FINDING [C-1]
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Documents current behaviour at the one place the nonce bookkeeping can drift, so a future
    ///         change to it is visible. `payCoupon` clears the booking at the coupon's CURRENT nonce, but
    ///         the call that fires may have been booked under an OLDER one — reachable whenever a cancel's
    ///         delete was refused, which is precisely the deadlock-guard case above.
    ///
    ///         Sequence: book at nonce 0, cancel with a refused delete (nonce -> 1, the network's schedule 0
    ///         survives), re-book at nonce 1, then let the stale schedule 0 fire. It settles the coupon and
    ///         clears the nonce-1 mapping entry — the LIVE booking — leaving schedule 1 orphaned on the
    ///         network: `couponScheduleAddress` reads zero and `cancelSchedule` can no longer delete it.
    ///
    ///         Consequence is bounded: the coupon is settled, no funds are at risk, the orphan later fires
    ///         into {ITenorCoupon-CouponAlreadySettled}, and Lattice's HSSAdapter facet is in the cut, so
    ///         the issuer can still delete it directly (proved by the sibling test below). Only the
    ///         diamond's HBAR for that booking is wasted. Reported, not asserted away.
    function test_firedStaleSchedule_clearsTheCurrentBooking_documentsNonceDrift() public {
        uint64 payAt = _standardCoupon();
        address stale = _schedule(COUPON_ID);

        // A cancel whose delete the network refuses: the nonce moves on, the old schedule does not.
        hss.force(IHederaScheduleService.deleteSchedule.selector, HederaResponseCodes.INVALID_TRANSACTION);
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);
        assertEq(hss.getScheduledCall(stale).to, tenor, "the refused delete left schedule 0 booked");

        uint64 newPayAt = payAt + 1 days;
        vm.prank(issuer);
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, newPayAt);
        address live = _schedule(COUPON_ID);
        assertTrue(live != stale, "a second, live booking exists at nonce 1");

        // The stale booking fires first. It settles the coupon correctly...
        vm.warp(newPayAt);
        (bool success,) = hss.fireSchedule(stale);
        assertTrue(success, "the stale call still settles the coupon correctly");
        assertEq(coupon.getCoupon(COUPON_ID).paid, 750 * 10 ** 6, "holders paid exactly once");

        // ...but clears the mapping entry for the LIVE booking, which is still alive on the network.
        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "[C-1] the live booking reads as cleared");
        assertEq(hss.getScheduledCall(live).to, tenor, "[C-1] while the live schedule still exists on HSS");
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ITenorCoupon.CouponNotScheduled.selector, COUPON_ID));
        coupon.cancelSchedule(COUPON_ID); // [C-1] so `cancelSchedule` can no longer reach it

        // The orphan is harmless when it fires: the coupon is settled and nobody is paid twice.
        (bool orphan, bytes memory ret) = hss.fireSchedule(live);
        assertFalse(orphan, "the orphan fires into a settled coupon");
        assertEq(_errSelector(ret), ITenorCoupon.CouponAlreadySettled.selector, "and pays nobody twice");
        assertEq(_usdcBal(alice), 500 * 10 ** 6, "alice holds exactly one coupon");
    }

    /// @notice Bounds finding [C-1]: even when `cancelSchedule` has lost track of a live booking, the
    ///         booking is not unreachable — Lattice's HSSAdapter facet is in the cut and the issuer holds
    ///         `HSS_SCHEDULER_ROLE`, so the orphan can still be deleted directly. The drift costs
    ///         bookkeeping, not control.
    function test_orphanedBooking_remainsDeletableThroughTheHssAdapterFacet() public {
        uint64 payAt = _standardCoupon();
        address stale = _schedule(COUPON_ID);

        hss.force(IHederaScheduleService.deleteSchedule.selector, HederaResponseCodes.INVALID_TRANSACTION);
        vm.prank(issuer);
        coupon.cancelSchedule(COUPON_ID);

        uint64 newPayAt = payAt + 1 days;
        vm.prank(issuer);
        coupon.fundCoupon(COUPON_ID, PER_TOKEN, newPayAt);
        address live = _schedule(COUPON_ID);

        vm.warp(newPayAt);
        (bool success,) = hss.fireSchedule(stale);
        assertTrue(success, "the stale call settled the coupon");
        assertEq(coupon.couponScheduleAddress(COUPON_ID), address(0), "[C-1] the live booking reads as cleared");

        vm.prank(issuer);
        IHSSAdapter(tenor).deleteSchedule(live);
        assertEq(hss.getScheduledCall(live).to, address(0), "the orphan was still deletable by the issuer");
    }
}
