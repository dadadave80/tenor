// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ITenorCoupon
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Bond coupon funding and automated payment, driven by Hedera Scheduled Transactions.
/// @dev The issuer funds a coupon in USDC and schedules its payment through the Hedera Schedule Service; the
///      network fires `payCoupon` at the scheduled second with no manual action. `payCoupon` is permissionless
///      and idempotent, so correctness never depends on the scheduled call's sender identity — if scheduling
///      is unavailable, anyone can settle a due coupon and the product still works.
interface ITenorCoupon {
    //*//////////////////////////////////////////////////////////////////////////
    //                                   TYPES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice One coupon period.
    /// @param payAt Unix second from which the coupon may be paid.
    /// @param amountPerToken USDC atomic units (6 dp) paid per WHOLE security token held.
    /// @param funded USDC pulled from the issuer and held by the diamond for this coupon.
    /// @param paid USDC actually delivered to holders.
    /// @param scheduleNonce Bumped on every cancel so a re-schedule gets a fresh HSS job id.
    /// @param settled True once `payCoupon` has run; blocks a second settlement.
    struct Coupon {
        uint64 payAt;
        uint256 amountPerToken;
        uint256 funded;
        uint256 paid;
        uint64 scheduleNonce;
        bool settled;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   EVENTS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice A holder was added to the coupon register.
    event HolderRegistered(address indexed holder);

    /// @notice The issuer funded a coupon; `amount` USDC moved issuer to diamond.
    event CouponFunded(uint256 indexed couponId, uint256 amount, uint256 amountPerToken, uint64 payAt);

    /// @notice A coupon payment was booked with the Hedera Schedule Service.
    event CouponScheduled(uint256 indexed couponId, address scheduleAddress, uint64 payAt, bytes32 jobId);

    /// @notice The issuer cancelled a booked schedule. The coupon can be re-scheduled or paid manually.
    /// @dev `responseCode` is the Schedule Service's answer to the delete, which is deliberately NOT
    ///      required to succeed. A schedule that already fired cannot be deleted, and refusing to
    ///      cancel in that case would strand the coupon: the nonce bump that permits a re-booking is
    ///      unconditional, and this code records what actually happened to the old booking.
    event CouponScheduleCancelled(uint256 indexed couponId, address scheduleAddress, int64 responseCode);

    /// @notice A coupon settled. `totalPaid` may be below the entitlement if holders were skipped.
    event CouponPaid(uint256 indexed couponId, uint256 totalPaid, uint256 holderCount);

    /// @notice One holder could not be paid — not associated with USDC, frozen, or otherwise rejected by HTS.
    /// @dev Recorded rather than reverted: one unreachable holder must not strand everyone else's coupon.
    event CouponPaymentSkipped(uint256 indexed couponId, address indexed holder, uint256 amount, int64 responseCode);

    /// @notice Surplus funding was returned to the caller-specified recipient after settlement.
    event CouponSurplusWithdrawn(uint256 indexed couponId, address indexed to, uint256 amount);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ERRORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The coupon has already been settled.
    error CouponAlreadySettled(uint256 couponId);

    /// @notice `block.timestamp` has not reached `payAt`.
    error CouponNotDue(uint256 couponId, uint64 payAt);

    /// @notice Holder balances grew after funding. The issuer tops up and re-calls.
    error InsufficientFunding(uint256 required, uint256 funded);

    /// @notice The Schedule Service has no room at `payAt` for `gasLimit`.
    error NoScheduleCapacity(uint64 payAt, uint256 gasLimit);

    /// @notice The coupon has no funding, so there is nothing to schedule or pay.
    error CouponNotFunded(uint256 couponId);

    /// @notice `payAt` is not strictly in the future.
    error CouponInvalidPayAt(uint64 payAt);

    /// @notice `amountPerToken` is zero.
    error CouponInvalidAmount();

    /// @notice No schedule is booked for this coupon.
    error CouponNotScheduled(uint256 couponId);

    /// @notice The coupon has not settled, so surplus cannot be withdrawn yet.
    error CouponNotSettled(uint256 couponId);

    /// @notice A schedule is booked for this coupon, so its terms cannot be changed.
    /// @dev The booked call fires at the second it was booked for. Letting `payAt` or `amountPerToken`
    ///      move underneath it would leave the network firing a payment for terms that no longer
    ///      exist. Call `cancelSchedule` first, then re-fund and re-schedule. Topping up funding at
    ///      the SAME terms is always allowed.
    error CouponTermsLocked(uint256 couponId, uint64 payAt, uint256 amountPerToken);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ISSUER
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Adds holders to the coupon register. Idempotent per address. Requires `ISSUER_ROLE`.
    /// @dev The register is what `payCoupon` iterates. Entitlement is always read from the token's live
    ///      balance at payment time, so registering an address never itself grants anything.
    function registerHolders(address[] calldata holders) external;

    /// @notice Funds coupon `couponId`, pulling `amountPerToken * totalRegisteredBalance` USDC from the caller.
    /// @dev The issuer approves the diamond for that amount first. Requires `ISSUER_ROLE`. Callable again
    ///      to top up after holder balances grow. While a schedule is booked the terms are frozen —
    ///      `payAt` and `amountPerToken` must match the stored values or this reverts
    ///      {CouponTermsLocked}; cancel the schedule to re-date.
    function fundCoupon(uint256 couponId, uint256 amountPerToken, uint64 payAt) external;

    /// @notice Books `payCoupon(couponId)` with the Hedera Schedule Service to fire at `payAt`.
    /// @dev The diamond is the schedule's payer and admin, so it must hold HBAR for the call to fire.
    ///      Requires `ISSUER_ROLE`.
    function scheduleCoupon(uint256 couponId, uint256 gasLimit) external;

    /// @notice Deletes the booked schedule for `couponId` and bumps its nonce so it can be re-scheduled.
    /// @dev Requires `ISSUER_ROLE`.
    function cancelSchedule(uint256 couponId) external;

    /// @notice Returns funding left over after settlement (skipped holders, or a shrunken register).
    /// @dev Requires `ISSUER_ROLE`.
    function withdrawCouponSurplus(uint256 couponId, address to) external;

    //*//////////////////////////////////////////////////////////////////////////
    //                                 SETTLEMENT
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Pays every registered holder their entitlement for `couponId`.
    /// @dev Permissionless and idempotent: callable by anyone once `block.timestamp >= payAt`, and refuses a
    ///      second run. Normally invoked by the network as the scheduled call, but nothing about correctness
    ///      depends on that — a per-holder HTS failure is recorded with {CouponPaymentSkipped} and the
    ///      remaining holders are still paid.
    function payCoupon(uint256 couponId) external;

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns coupon `couponId`.
    function getCoupon(uint256 couponId) external view returns (Coupon memory coupon);

    /// @notice The HSS schedule address booked for `couponId`, or the zero address if none.
    function couponScheduleAddress(uint256 couponId) external view returns (address scheduleAddress);

    /// @notice The coupon register.
    function couponHolders() external view returns (address[] memory holders);

    /// @notice `amountPerToken * balanceOf(holder)` for the current register — what a coupon must fund.
    function couponRequirement(uint256 amountPerToken) external view returns (uint256 required);

    /// @notice What `holder` would receive for `couponId` at the current balance.
    function couponEntitlement(uint256 couponId, address holder) external view returns (uint256 amount);

    /// @notice The security token whose holders receive coupons.
    function couponToken() external view returns (address token);
}
