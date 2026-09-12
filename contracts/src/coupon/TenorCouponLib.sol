// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC165Lib} from "@diamond/libraries/ERC165Lib.sol";
import {AccessControlLib} from "@lattice/access/libraries/AccessControlLib.sol";
import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaTokenService} from "@lattice/interfaces/external/hedera/IHederaTokenService.sol";
import {HSSAdapterLib} from "@lattice/oracles/hedera/HSSAdapterLib.sol";
import {InitializableLib} from "@lattice/utils/libraries/InitializableLib.sol";
import {TenorHSS} from "../TenorHSS.sol";
import {TenorHTS} from "../TenorHTS.sol";
import {ITenorCoupon} from "../interfaces/ITenorCoupon.sol";

//*//////////////////////////////////////////////////////////////////////////
//                                  STORAGE
//////////////////////////////////////////////////////////////////////////*//

/// @dev `keccak256(abi.encode(uint256(keccak256("tenor.coupon.storage")) - 1)) & ~bytes32(uint256(0xff))`.
bytes32 constant COUPON_STORAGE_SLOT = 0xa22e655fb2ceae4955a8e34882ef3be65648a98fec0e5d13f18880a96727a600;

/// @dev Role allowed to register holders and to fund, schedule, cancel and sweep coupons. Granted to the
///      issuer in `TenorInit`, alongside Lattice's `HSS_SCHEDULER_ROLE`.
bytes32 constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

/// @notice ERC-7201 namespaced storage for TenorCoupon.
/// @dev [DEV-4] There is deliberately no `scheduleAddress` here: Lattice's {HSSAdapterLib} already stores it
///      per job id, and `scheduleOf(jobId)` is the single source of truth. A second copy would diverge.
/// @custom:storage-location erc7201:tenor.coupon.storage
struct CouponStorage {
    /// @notice The ATS security token whose holders receive coupons.
    address token;
    /// @notice The HTS USDC token coupons are funded and paid in.
    address usdc;
    /// @notice The coupon register — the holders `payCoupon` iterates. APPEND-ONLY.
    address[] holders;
    /// @notice Register membership, which makes `registerHolders` idempotent per address.
    mapping(address holder => bool registered) isHolder;
    /// @notice Coupon periods by id.
    mapping(uint256 couponId => ITenorCoupon.Coupon coupon) coupons;
}

//*//////////////////////////////////////////////////////////////////////////
//                                   ERRORS
//////////////////////////////////////////////////////////////////////////*//

/// @notice The payload handed to {ITenorCouponSchedule-scheduleCouponSelfCall} is not the canonical
///         `payCoupon(couponId)` encoding, so it must never reach the Schedule Service.
/// @param couponId The coupon the payload claimed to settle.
error CouponInvalidSchedulePayload(uint256 couponId);

/// @notice The self-`delegatecall` that turns the schedule payload into calldata failed without revert data,
///         or returned something other than a schedule address.
/// @param couponId The coupon being scheduled.
error CouponScheduleDispatchFailed(uint256 couponId);

//*//////////////////////////////////////////////////////////////////////////
//                                  EXTERNALS
//////////////////////////////////////////////////////////////////////////*//

/// @title ITenorCouponSchedule
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The calldata trampoline `scheduleCoupon` needs, cut into the diamond alongside {ITenorCoupon}.
/// @dev `HSSAdapterLib.scheduleSelfCall` takes its payload as `bytes calldata`, and Solidity cannot turn a
///      `bytes memory` value into a calldata slice. So {TenorCouponLib-scheduleCoupon} encodes the payload and
///      re-enters the diamond through `address(this).delegatecall`, whose frame carries it as real calldata.
///      `DELEGATECALL` preserves `msg.sender` and `address(this)`, so the issuer — not the diamond — remains
///      the subject of both `ISSUER_ROLE` and `HSS_SCHEDULER_ROLE`, and storage stays the diamond's.
interface ITenorCouponSchedule {
    /// @notice Books `payload` with the Schedule Service as the diamond's own call at coupon `couponId`'s
    ///         `payAt`. Requires `ISSUER_ROLE`; `payload` must be exactly `payCoupon(couponId)`.
    /// @dev Externally callable so the trampoline hop resolves through the diamond's fallback, and therefore
    ///      re-validates everything itself: reaching it directly is equivalent to calling `scheduleCoupon`.
    /// @param couponId The coupon to schedule.
    /// @param gasLimit Gas the network must reserve for the scheduled call.
    /// @param payload The canonical `abi.encodeCall(ITenorCoupon.payCoupon, (couponId))` encoding.
    /// @return scheduleAddress The address the Schedule Service assigned the booking.
    function scheduleCouponSelfCall(uint256 couponId, uint256 gasLimit, bytes calldata payload)
        external
        returns (address scheduleAddress);
}

/// @title IERC20Metadata
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The two ERC-20 reads the coupon module makes on the security token.
/// @dev Declared locally, exactly as the market does, so the module depends on no token implementation. The
///      ATS token exposes both through its ERC-20 facade. `decimals` is what makes `amountPerToken` a price
///      per WHOLE token, consistent with the market's `pricePerToken`.
interface IERC20Metadata {
    /// @notice Atomic units per whole token, as a power of ten.
    function decimals() external view returns (uint8);

    /// @notice `account`'s balance, in atomic units.
    function balanceOf(address account) external view returns (uint256);
}

/// @title TenorCouponLib
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Logic + ERC-7201 storage for Tenor's bond coupons: the holder register, USDC funding, Hedera
///         Scheduled-Transaction booking, and permissionless settlement.
/// @dev USDC moves through {TenorHTS}, never Lattice's {HTSAdapterLib}: `payCoupon` is permissionless, so a
///      role-gated wrapper reading `msg.sender` would demand the role of an arbitrary caller, and a wrapper
///      that reverts on any non-SUCCESS code could not express the per-holder skip that
///      {ITenorCoupon-CouponPaymentSkipped} requires. See `docs/GROUND-TRUTH.md` §2.2.
///
///      Scheduling goes through Lattice's {HSSAdapterLib} under a NONCED job id, because `deleteSchedule`
///      does not clear Lattice's `_schedules[jobId]` mapping: re-using a bare `couponId` after a cancel would
///      hit `HSSJobAlreadyScheduled`. See `docs/GROUND-TRUTH.md` §3.1.
library TenorCouponLib {
    //*//////////////////////////////////////////////////////////////////////////
    //                                  STORAGE
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns the ERC-7201 storage struct for TenorCoupon.
    /// @return $ The coupon storage struct.
    function couponStorage() internal pure returns (CouponStorage storage $) {
        assembly {
            $.slot := COUPON_STORAGE_SLOT
        }
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                              INITIALISATION
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Writes the coupon module's immutable addresses and registers its ERC-165 id.
    /// @dev Must be called between `preInitializer` / `postInitializer` — i.e. from `TenorInit.init`, which
    ///      runs inside `Diamond.initialize`'s delegatecall.
    /// @param token The ATS security token whose holders receive coupons.
    /// @param usdc The HTS USDC token coupons are funded and paid in.
    function __TenorCoupon_init(address token, address usdc) internal {
        InitializableLib.checkInitializing(InitializableLib.initializableSlot());
        CouponStorage storage $ = couponStorage();
        $.token = token;
        $.usdc = usdc;
        ERC165Lib.erc165Storage().supportedInterfaces[type(ITenorCoupon).interfaceId] = true;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Returns coupon `couponId`.
    /// @param couponId The coupon to read.
    /// @return coupon The coupon record; an all-zero struct for an unknown id.
    function getCoupon(uint256 couponId) internal view returns (ITenorCoupon.Coupon memory coupon) {
        coupon = couponStorage().coupons[couponId];
    }

    /// @notice The HSS schedule address booked for `couponId`, or the zero address if none.
    /// @dev Read from Lattice's job mapping at the coupon's CURRENT nonce, so a cancelled booking reads as
    ///      unscheduled even though `deleteSchedule` leaves the old entry behind.
    /// @param couponId The coupon to look up.
    /// @return scheduleAddress The live schedule address, or zero.
    function couponScheduleAddress(uint256 couponId) internal view returns (address scheduleAddress) {
        scheduleAddress = HSSAdapterLib.scheduleOf(couponJobId(couponId));
    }

    /// @notice The coupon register.
    /// @return holders Every registered holder, in registration order.
    function couponHolders() internal view returns (address[] memory holders) {
        holders = couponStorage().holders;
    }

    /// @notice What a coupon of `amountPerToken` per WHOLE token must fund for the current register.
    /// @dev `amountPerToken * Σ balanceOf(holder) / 10**tokenDecimals`. Summed before the division, so this
    ///      is never below the sum of the per-holder entitlements `payCoupon` floors individually.
    /// @param amountPerToken USDC atomic units per whole security token.
    /// @return required USDC atomic units needed to pay every registered holder.
    function couponRequirement(uint256 amountPerToken) internal view returns (uint256 required) {
        CouponStorage storage $ = couponStorage();
        address token = $.token;
        address[] memory holders = $.holders;
        uint256 holderCount = holders.length;
        uint256 total;
        for (uint256 i; i < holderCount; ++i) {
            total += IERC20Metadata(token).balanceOf(holders[i]);
        }
        required = amountPerToken * total / _unit(token);
    }

    /// @notice What `holder` would receive for `couponId` at its current balance.
    /// @dev Registration is separate: only addresses in the register are ever paid, so this is a preview of
    ///      the arithmetic, not a claim.
    /// @param couponId The coupon to price.
    /// @param holder The holder to price it for.
    /// @return amount USDC atomic units, floored.
    function couponEntitlement(uint256 couponId, address holder) internal view returns (uint256 amount) {
        CouponStorage storage $ = couponStorage();
        address token = $.token;
        amount = $.coupons[couponId].amountPerToken * IERC20Metadata(token).balanceOf(holder) / _unit(token);
    }

    /// @notice The security token whose holders receive coupons.
    /// @return token The ATS security token.
    function couponToken() internal view returns (address token) {
        token = couponStorage().token;
    }

    /// @notice The HSS job id for `couponId` at its current schedule nonce.
    /// @param couponId The coupon to derive the job id for.
    /// @return jobId The nonced job id.
    function couponJobId(uint256 couponId) internal view returns (bytes32 jobId) {
        jobId = jobIdOf(couponId, couponStorage().coupons[couponId].scheduleNonce);
    }

    /// @notice Derives the HSS job id for a coupon at a given schedule nonce.
    /// @dev The nonce exists because `HSSAdapterLib.deleteSchedule` does NOT clear `_schedules[jobId]`;
    ///      without it, re-scheduling a cancelled coupon would revert `HSSJobAlreadyScheduled`.
    /// @param couponId The coupon.
    /// @param scheduleNonce The coupon's schedule nonce, bumped on every cancel.
    /// @return jobId `keccak256(abi.encode(couponId, scheduleNonce))`.
    function jobIdOf(uint256 couponId, uint64 scheduleNonce) internal pure returns (bytes32 jobId) {
        jobId = keccak256(abi.encode(couponId, scheduleNonce));
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ISSUER
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Adds `holders` to the coupon register. Caller must hold ISSUER_ROLE.
    /// @dev Idempotent per address: an address already registered is skipped without an event. Registering
    ///      grants nothing by itself — entitlements are read from live balances at payment time.
    /// @param holders The addresses to register.
    function registerHolders(address[] calldata holders) internal {
        AccessControlLib.checkRole(ISSUER_ROLE);
        CouponStorage storage $ = couponStorage();
        uint256 length = holders.length;
        for (uint256 i; i < length; ++i) {
            address holder = holders[i];
            if ($.isHolder[holder]) continue;
            $.isHolder[holder] = true;
            $.holders.push(holder);
            emit ITenorCoupon.HolderRegistered(holder);
        }
    }

    /// @notice Funds coupon `couponId` up to what the current register requires. Caller must hold ISSUER_ROLE.
    /// @dev Pulls only the TOP-UP — `required - funded` — through {TenorHTS-transferFrom}, so a second call
    ///      after balances grew charges the difference instead of the whole coupon again. The issuer approves
    ///      the diamond for at least that amount on USDC first.
    /// @param couponId The coupon to fund.
    /// @param amountPerToken USDC atomic units per WHOLE security token.
    /// @param payAt Unix second from which the coupon may be paid; must be strictly in the future.
    function fundCoupon(uint256 couponId, uint256 amountPerToken, uint64 payAt) internal {
        AccessControlLib.checkRole(ISSUER_ROLE);
        if (amountPerToken == 0) revert ITenorCoupon.CouponInvalidAmount();
        if (payAt <= block.timestamp) revert ITenorCoupon.CouponInvalidPayAt(payAt);
        CouponStorage storage $ = couponStorage();
        ITenorCoupon.Coupon storage coupon = $.coupons[couponId];
        if (coupon.settled) revert ITenorCoupon.CouponAlreadySettled(couponId);

        // A live booking pins the terms it was booked against. Moving `payAt` or `amountPerToken`
        // underneath a schedule the network has already accepted desynchronises the two: the call
        // still fires at the OLD second, which is now either premature (reverting `CouponNotDue`) or
        // late. Re-dating therefore requires an explicit `cancelSchedule` first; a pure top-up of the
        // same terms stays allowed, which is the case the issuer actually needs after balances grow.
        if (HSSAdapterLib.scheduleOf(jobIdOf(couponId, coupon.scheduleNonce)) != address(0)) {
            if (coupon.payAt != payAt || coupon.amountPerToken != amountPerToken) {
                revert ITenorCoupon.CouponTermsLocked(couponId, coupon.payAt, coupon.amountPerToken);
            }
        }

        uint256 funded = coupon.funded;
        uint256 required = couponRequirement(amountPerToken);
        uint256 topUp = required > funded ? required - funded : 0;

        coupon.amountPerToken = amountPerToken;
        coupon.payAt = payAt;
        if (topUp != 0) {
            coupon.funded = funded + topUp;
            TenorHTS.transferFrom($.usdc, msg.sender, address(this), topUp);
        }
        emit ITenorCoupon.CouponFunded(couponId, topUp, amountPerToken, payAt);
    }

    /// @notice Books `payCoupon(couponId)` with the Hedera Schedule Service. Caller must hold ISSUER_ROLE
    ///         and Lattice's HSS_SCHEDULER_ROLE.
    /// @dev The payload has to reach `HSSAdapterLib.scheduleSelfCall` as `bytes calldata`, which a
    ///      `bytes memory` value can never become. So it is encoded here and delivered through one
    ///      `delegatecall` back into the diamond — see {ITenorCouponSchedule}. `DELEGATECALL` preserves
    ///      `msg.sender`, `address(this)` and storage, so the hop changes nothing but the calldata region.
    ///      All validation, and the {ITenorCoupon-CouponScheduled} event, live in the inner frame.
    /// @param couponId The coupon to schedule.
    /// @param gasLimit Gas the network must reserve for the scheduled call.
    function scheduleCoupon(uint256 couponId, uint256 gasLimit) internal {
        bytes memory payload = abi.encodeCall(ITenorCoupon.payCoupon, (couponId));
        (bool ok, bytes memory ret) = address(this)
            .delegatecall(abi.encodeCall(ITenorCouponSchedule.scheduleCouponSelfCall, (couponId, gasLimit, payload)));
        if (!ok) _bubbleRevert(couponId, ret);
        if (ret.length != 32) revert CouponScheduleDispatchFailed(couponId);
    }

    /// @notice The inner half of {scheduleCoupon}: books `payload` as the diamond's own scheduled call.
    ///         Caller must hold ISSUER_ROLE and Lattice's HSS_SCHEDULER_ROLE.
    /// @dev Reachable directly through the diamond, so it re-checks the role, pins `payload` to the canonical
    ///      `payCoupon(couponId)` encoding, and re-reads the coupon: nothing but `payCoupon` can ever be
    ///      scheduled, whatever an ISSUER_ROLE holder sends.
    /// @param couponId The coupon to schedule.
    /// @param gasLimit Gas the network must reserve for the scheduled call.
    /// @param payload Must equal `abi.encodeCall(ITenorCoupon.payCoupon, (couponId))`.
    /// @return scheduleAddress The address the Schedule Service assigned the booking.
    function scheduleCouponSelfCall(uint256 couponId, uint256 gasLimit, bytes calldata payload)
        internal
        returns (address scheduleAddress)
    {
        AccessControlLib.checkRole(ISSUER_ROLE);
        if (keccak256(payload) != keccak256(abi.encodeCall(ITenorCoupon.payCoupon, (couponId)))) {
            revert CouponInvalidSchedulePayload(couponId);
        }
        ITenorCoupon.Coupon storage coupon = couponStorage().coupons[couponId];
        if (coupon.settled) revert ITenorCoupon.CouponAlreadySettled(couponId);
        if (coupon.funded == 0) revert ITenorCoupon.CouponNotFunded(couponId);

        uint64 payAt = coupon.payAt;
        if (!HSSAdapterLib.hasScheduleCapacity(payAt, gasLimit)) {
            revert ITenorCoupon.NoScheduleCapacity(payAt, gasLimit);
        }
        bytes32 jobId = jobIdOf(couponId, coupon.scheduleNonce);
        scheduleAddress = HSSAdapterLib.scheduleSelfCall(jobId, payAt, gasLimit, payload);
        emit ITenorCoupon.CouponScheduled(couponId, scheduleAddress, payAt, jobId);
    }

    /// @notice Deletes the booking for `couponId` and bumps its nonce so it can be re-scheduled. Caller must
    ///         hold ISSUER_ROLE and Lattice's HSS_SCHEDULER_ROLE.
    /// @dev The nonce bump is what makes a re-schedule possible at all: `deleteSchedule` leaves Lattice's
    ///      `_schedules[jobId]` entry in place, so the next booking must use a fresh job id.
    /// @param couponId The coupon whose booking to delete.
    function cancelSchedule(uint256 couponId) internal {
        AccessControlLib.checkRole(ISSUER_ROLE);
        ITenorCoupon.Coupon storage coupon = couponStorage().coupons[couponId];
        bytes32 jobId = jobIdOf(couponId, coupon.scheduleNonce);
        address scheduleAddress = HSSAdapterLib.scheduleOf(jobId);
        if (scheduleAddress == address(0)) revert ITenorCoupon.CouponNotScheduled(couponId);

        // The nonce bump is unconditional and the delete is best-effort, in that order. If the booked
        // call has already fired — a scheduled `payCoupon` that reverted, for instance — the delete
        // cannot succeed, and reverting here would leave the coupon permanently un-re-schedulable.
        // See {TenorHSS}.
        ++coupon.scheduleNonce;
        int64 code = TenorHSS.tryDeleteSchedule(scheduleAddress);
        emit ITenorCoupon.CouponScheduleCancelled(couponId, scheduleAddress, code);
    }

    /// @notice Returns funding left over after settlement to `to`. Caller must hold ISSUER_ROLE.
    /// @dev The surplus is zeroed — `funded` drops to `paid` — BEFORE the transfer, so it can never be
    ///      withdrawn twice; a non-SUCCESS response code reverts the whole call, restoring it.
    /// @param couponId The settled coupon to sweep.
    /// @param to The recipient of the surplus.
    function withdrawCouponSurplus(uint256 couponId, address to) internal {
        AccessControlLib.checkRole(ISSUER_ROLE);
        CouponStorage storage $ = couponStorage();
        ITenorCoupon.Coupon storage coupon = $.coupons[couponId];
        if (!coupon.settled) revert ITenorCoupon.CouponNotSettled(couponId);

        uint256 paid = coupon.paid;
        uint256 surplus = coupon.funded - paid;
        if (surplus == 0) return;

        coupon.funded = paid;
        int64 code = TenorHTS.tryTransfer($.usdc, to, surplus);
        if (code != HederaResponseCodes.SUCCESS) {
            revert TenorHTS.TenorHTSCallFailed(IHederaTokenService.transferToken.selector, code);
        }
        emit ITenorCoupon.CouponSurplusWithdrawn(couponId, to, surplus);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 SETTLEMENT
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Pays every registered holder their entitlement for `couponId`. PERMISSIONLESS.
    /// @dev Normally the network's scheduled call, but nothing here depends on that: `settled` is set before
    ///      any interaction, so a second run reverts whoever makes it, and the funding check runs before the
    ///      first transfer. A holder HTS refuses — unassociated, frozen, no KYC — is recorded with
    ///      {ITenorCoupon-CouponPaymentSkipped} and skipped; one unreachable holder never strands the rest.
    ///      The Schedule Service booking is cleared only on the self-call path, since `completeSelfCall`
    ///      requires `msg.sender == address(this)`.
    /// @param couponId The coupon to settle.
    function payCoupon(uint256 couponId) internal {
        CouponStorage storage $ = couponStorage();
        ITenorCoupon.Coupon storage coupon = $.coupons[couponId];
        if (coupon.settled) revert ITenorCoupon.CouponAlreadySettled(couponId);
        if (block.timestamp < coupon.payAt) revert ITenorCoupon.CouponNotDue(couponId, coupon.payAt);
        if (coupon.funded == 0) revert ITenorCoupon.CouponNotFunded(couponId);

        // Idempotence before interactions: a re-entrant or repeated call must find this already set.
        coupon.settled = true;

        address[] memory holders = $.holders;
        // Entitlements are computed for every holder BEFORE anyone is paid, so an underfunded coupon
        // reverts whole instead of paying the first few holders and stranding the rest.
        (uint256[] memory entitlements, uint256 required) = _entitlements(holders, $.token, coupon.amountPerToken);
        if (required > coupon.funded) revert ITenorCoupon.InsufficientFunding(required, coupon.funded);

        uint256 totalPaid = _payHolders(couponId, $.usdc, holders, entitlements);
        coupon.paid = totalPaid;
        emit ITenorCoupon.CouponPaid(couponId, totalPaid, holders.length);

        // Only the scheduled self-call may clear the booking; `completeSelfCall` requires
        // `msg.sender == address(this)`, and `payCoupon` is permissionless.
        if (msg.sender == address(this)) {
            HSSAdapterLib.completeSelfCall(jobIdOf(couponId, coupon.scheduleNonce));
        }
    }

    /// @dev Each holder's entitlement at the CURRENT balance, and their total.
    ///      Split out of {payCoupon} so the two loops' locals do not have to be live at once —
    ///      together they overflow the EVM's stack slots under the non-IR optimiser.
    /// @param holders The coupon register.
    /// @param token The security token whose balances set entitlement.
    /// @param amountPerToken USDC atomic units per WHOLE security token.
    /// @return entitlements Per-holder entitlement, index-aligned with `holders`.
    /// @return required The sum of `entitlements` — what the coupon must have funded.
    function _entitlements(address[] memory holders, address token, uint256 amountPerToken)
        private
        view
        returns (uint256[] memory entitlements, uint256 required)
    {
        uint256 unit = _unit(token);
        uint256 count = holders.length;
        entitlements = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            uint256 entitlement = amountPerToken * IERC20Metadata(token).balanceOf(holders[i]) / unit;
            entitlements[i] = entitlement;
            required += entitlement;
        }
    }

    /// @dev Pays each holder, recording rather than reverting on a per-holder HTS failure.
    ///      A holder who never associated with USDC, or whom the issuer froze, must not strand the others.
    /// @param couponId The coupon being settled, for the skip event.
    /// @param usdc The settlement token.
    /// @param holders The coupon register.
    /// @param entitlements Per-holder entitlement, index-aligned with `holders`.
    /// @return totalPaid The sum actually delivered.
    function _payHolders(uint256 couponId, address usdc, address[] memory holders, uint256[] memory entitlements)
        private
        returns (uint256 totalPaid)
    {
        for (uint256 i; i < holders.length; ++i) {
            uint256 entitlement = entitlements[i];
            if (entitlement == 0) continue;
            int64 code = TenorHTS.tryTransfer(usdc, holders[i], entitlement);
            if (code == HederaResponseCodes.SUCCESS) {
                totalPaid += entitlement;
            } else {
                emit ITenorCoupon.CouponPaymentSkipped(couponId, holders[i], entitlement, code);
            }
        }
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 INTERNALS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Atomic units per WHOLE security token — the divisor that turns `amountPerToken` into a price per
    ///      whole token, matching the market's `pricePerToken`. The exponent is widened to `uint256` so
    ///      `10 ** decimals` is never evaluated in `uint8`.
    /// @param token The security token to scale by.
    /// @return unit `10 ** token.decimals()`.
    function _unit(address token) private view returns (uint256 unit) {
        unit = 10 ** uint256(IERC20Metadata(token).decimals());
    }

    /// @dev Re-reverts the inner trampoline frame's revert data verbatim, so `scheduleCoupon` surfaces
    ///      `AccessControlUnauthorizedAccount`, `HSSExpiryBusy`, {ITenorCoupon-CouponNotFunded} and friends
    ///      unchanged. An empty frame — the only case with nothing to forward — becomes
    ///      {CouponScheduleDispatchFailed}.
    function _bubbleRevert(uint256 couponId, bytes memory ret) private pure {
        if (ret.length == 0) revert CouponScheduleDispatchFailed(couponId);
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
