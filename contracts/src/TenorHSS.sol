// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaScheduleService} from "@lattice/interfaces/external/hedera/IHederaScheduleService.sol";

/// @title TenorHSS
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The one Hedera Schedule Service call Tenor must be able to make without reverting.
/// @dev Sibling of {TenorHTS}, and for the same reason: Lattice's `HSSAdapterLib.deleteSchedule` reverts
///      on any non-SUCCESS response code, and there is a case where that reverts something Tenor needs
///      to succeed.
///
///      When a scheduled `payCoupon` fires but its frame reverts — an underfunded coupon, say — the
///      network has consumed the schedule while the coupon is still unsettled. Deleting that schedule
///      now fails, so a `cancelSchedule` built on the reverting helper reverts too, and the
///      `scheduleNonce` bump that exists precisely to allow a re-booking can never happen. The coupon
///      would be permanently un-re-schedulable in exactly the situation the nonce was designed for.
///
///      So the nonce bump is the unconditional effect and the delete is best-effort: this returns the
///      response code, the caller records it, and bookkeeping moves on. Scheduling is an optimisation
///      over a permissionless `payCoupon` — it must never be able to wedge settlement.
library TenorHSS {
    /// @dev The Hedera Schedule Service system contract (HIP-755 / HIP-1215). No bytecode; never
    ///      `delegatecall` it.
    address internal constant HSS_SYSTEM_CONTRACT = 0x000000000000000000000000000000000000016B;

    /// @notice Attempts to delete `scheduleAddress`, returning the response code instead of reverting.
    /// @dev TOTAL by contract. A schedule that has already fired, already been deleted, or never
    ///      existed yields a non-SUCCESS code rather than a revert.
    /// @param scheduleAddress The schedule to delete.
    /// @return code The Hedera response code; `HederaResponseCodes.SUCCESS` (22) when the schedule was
    ///         deleted, `UNKNOWN` (21) when the frame itself halted.
    function tryDeleteSchedule(address scheduleAddress) internal returns (int64 code) {
        (bool ok, bytes memory ret) =
            HSS_SYSTEM_CONTRACT.call(abi.encodeCall(IHederaScheduleService.deleteSchedule, (scheduleAddress)));
        code = (ok && ret.length >= 32) ? abi.decode(ret, (int64)) : HederaResponseCodes.UNKNOWN;
    }
}
