// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaScheduleService} from "@lattice/interfaces/external/hedera/IHederaScheduleService.sol";

/// @notice The one cheatcode {MockHederaScheduleService} needs, declared locally so the mock pulls in no test
///         framework of its own. Same address and same ABI as forge-std's `Vm`.
interface IVmPrank {
    /// @notice Sets `msg.sender` for the caller's NEXT external call, and only that call.
    /// @param msgSender The address the callee will see as `msg.sender`.
    function prank(address msgSender) external;
}

/// @title MockHederaScheduleService
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice `vm.etch`-able stand-in for the Hedera Schedule Service system contract at 0x16b (HIP-755 /
///         HIP-1215). Returns RESPONSE CODES and never reverts on an HSS selector, like the real system
///         contract; keeps just enough state to book, delete and later FIRE a scheduled call; and lets a test
///         force any code for the next call of a selector.
/// @dev Sibling of `@lattice-test/mocks/hedera/MockHederaTokenService.sol` (0x167) and written to the same
///      conventions — the two are etched together in Tenor's suites. Like that mock it must not rely on
///      constructor state: an etched account starts with EMPTY STORAGE, so every steering knob here is stored
///      INVERTED where its permissive value must be the default (`capacityExhausted == false` means
///      {hasScheduleCapacity} answers true out of the box), and the cheatcode address is a bytecode-embedded
///      `constant`, never an `immutable`.
///
///      Only the four functions `HSSAdapterLib` actually calls are implemented — `hasScheduleCapacity`,
///      `scheduleCall`, `deleteSchedule`, `authorizeSchedule`. Everything else falls through to a `fallback`
///      that answers `NOT_SUPPORTED`, exactly as the HTS mock does.
contract MockHederaScheduleService {
    //*//////////////////////////////////////////////////////////////////////////
    //                                   TYPES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice A booked scheduled contract call.
    /// @param to The target the network will call at expiry — the diamond itself for a self-call.
    /// @param expirySecond The consensus second at which the network fires the call.
    /// @param gasLimit The gas the scheduled call is given.
    /// @param value Tinybars forwarded with the call; Tenor always books zero.
    /// @param executed True once {fireSchedule} has run it. A schedule fires at most once.
    /// @param callData The calldata to deliver — for Tenor, `abi.encodeCall(ITenorCoupon.payCoupon, (id))`.
    struct ScheduledCall {
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        uint64 value;
        bool executed;
        bytes callData;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  STORAGE
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev The HEVM cheatcode account, `address(uint160(uint256(keccak256("hevm cheat code"))))`. A `constant`
    ///      so it lives in the bytecode and survives `vm.etch`.
    IVmPrank internal constant VM = IVmPrank(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    /// @notice Response code forced for the next call of a selector; 0 means "behave normally".
    mapping(bytes4 selector => int64 code) public forcedCode;
    /// @notice When true, {hasScheduleCapacity} answers false for every second. Steer with {setScheduleCapacity}.
    bool public capacityExhausted;
    /// @notice Seconds with no room left. Steer with {setExpiryFull}.
    mapping(uint256 expirySecond => bool full) public expiryFull;
    /// @notice Largest gas limit {hasScheduleCapacity} will accept; 0 (the etched default) means unlimited.
    uint256 public gasLimitCap;
    /// @dev Booked calls by schedule address. A record with `to == address(0)` does not exist.
    mapping(address scheduleAddress => ScheduledCall) private _schedules;

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ERRORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice TEST HELPER failure — no schedule is booked at this address (never booked, or deleted).
    /// @dev The test helpers DO revert, unlike the HSS selectors: a test firing a schedule that was never
    ///      booked has a bug, and a silent response code would hide it.
    /// @param scheduleAddress The address asked about.
    error ScheduleNotFound(address scheduleAddress);

    /// @notice TEST HELPER failure — that schedule has already fired. The network never fires one twice.
    /// @param scheduleAddress The address asked about.
    error ScheduleAlreadyExecuted(address scheduleAddress);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   EVENTS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice A call was booked.
    /// @param scheduleAddress The deterministic address assigned to it.
    /// @param to The target to be called.
    /// @param expirySecond The second it is due.
    /// @param gasLimit The gas it will be given.
    event ScheduleCreated(address indexed scheduleAddress, address indexed to, uint256 expirySecond, uint256 gasLimit);

    /// @notice A booked call was deleted before firing.
    /// @param scheduleAddress The deleted schedule.
    event ScheduleDeleted(address indexed scheduleAddress);

    /// @notice A booked call was fired by {fireSchedule}.
    /// @param scheduleAddress The fired schedule.
    /// @param to The target that was called.
    /// @param success Whether the target's frame succeeded. A failure is recorded, not bubbled.
    event ScheduleFired(address indexed scheduleAddress, address indexed to, bool success);

    /// @notice TEST STEERING — global schedule capacity changed.
    /// @param available True when {hasScheduleCapacity} may answer true.
    event ScheduleCapacitySet(bool available);

    /// @notice TEST STEERING — one second's capacity changed.
    /// @param expirySecond The second concerned.
    /// @param full True when that second is out of room.
    event ExpiryFullSet(uint256 expirySecond, bool full);

    /// @notice TEST STEERING — the accepted gas ceiling changed.
    /// @param cap The new ceiling; 0 means unlimited.
    event GasLimitCapSet(uint256 cap);

    //*//////////////////////////////////////////////////////////////////////////
    //                                TEST HELPERS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Force the next call of `selector` to return `code` (0 clears).
    /// @dev Matches the HTS mock's helper. Only reaches the MUTATING selectors — `scheduleCall`,
    ///      `deleteSchedule`, `authorizeSchedule` — because consuming a forced code is a storage write and
    ///      {hasScheduleCapacity} is `view` (Lattice staticcalls it). Steer capacity with
    ///      {setScheduleCapacity} / {setExpiryFull} / {setGasLimitCap} instead.
    /// @param selector The HSS function to poison.
    /// @param code The Hedera response code to return once.
    function force(bytes4 selector, int64 code) external {
        forcedCode[selector] = code;
    }

    /// @notice TEST STEERING — turns all schedule capacity on or off.
    /// @dev Stored inverted, so the etched default (empty storage) is "capacity available".
    /// @param available False to make {hasScheduleCapacity} answer false everywhere.
    function setScheduleCapacity(bool available) external {
        capacityExhausted = !available;
        emit ScheduleCapacitySet(available);
    }

    /// @notice TEST STEERING — marks one second as out of room, for the per-second capacity path.
    /// @param expirySecond The second to mark.
    /// @param full True to report no capacity at that second.
    function setExpiryFull(uint256 expirySecond, bool full) external {
        expiryFull[expirySecond] = full;
        emit ExpiryFullSet(expirySecond, full);
    }

    /// @notice TEST STEERING — caps the gas limit {hasScheduleCapacity} will accept.
    /// @param cap The ceiling; 0 means unlimited.
    function setGasLimitCap(uint256 cap) external {
        gasLimitCap = cap;
        emit GasLimitCapSet(cap);
    }

    /// @notice TEST HELPER — reads back a booked call.
    /// @param scheduleAddress The schedule to read.
    /// @return call_ The record; `to == address(0)` when nothing is booked there.
    function getScheduledCall(address scheduleAddress) external view returns (ScheduledCall memory call_) {
        return _schedules[scheduleAddress];
    }

    /// @notice TEST HELPER — the address {scheduleCall} will assign to these arguments.
    /// @dev Deterministic and argument-derived, so a test can predict a schedule address before booking it.
    ///      An identical (to, expirySecond, gasLimit, value, callData) tuple therefore maps to the SAME
    ///      address — which is how the network treats a duplicate schedule — so rebooking an identical call
    ///      overwrites an identical record.
    /// @param to The target.
    /// @param expirySecond The due second.
    /// @param gasLimit The gas limit.
    /// @param value Tinybars to forward.
    /// @param callData The calldata.
    /// @return scheduleAddress The address that tuple maps to.
    function scheduleAddressFor(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        public
        pure
        returns (address scheduleAddress)
    {
        return address(uint160(uint256(keccak256(abi.encode(to, expirySecond, gasLimit, value, callData)))));
    }

    /// @notice TEST HELPER — fires a booked call the way the network would at expiry.
    /// @dev **The target sees `msg.sender == the target itself.`** The mock cannot forge that from its own
    ///      frame, so it uses the HEVM `prank` cheatcode: the real network presents a self-scheduled call as
    ///      coming from the scheduling contract, and that identity is exactly what gates
    ///      `HSSAdapterLib.completeSelfCall` / `checkScheduledSelfCall`. Consequences a test must know:
    ///      - `tx.origin` is untouched — only `msg.sender` is presented as the target.
    ///      - The cheatcode must be reachable from this account, so the etch recipe should ALWAYS finish with
    ///        `vm.allowCheatcodes(0x16b)`: it is idempotent, harmless when unnecessary, and it settles the
    ///        question for forked runs as well as local ones.
    ///      - Do not call this from inside a `vm.startPrank` window — the cheatcode refuses to override an
    ///        ongoing prank. A single `vm.prank` immediately before this call is fine; it is consumed by it.
    ///      - Without cheatcodes at all, the equivalent is `vm.prank(diamond); ITenorCoupon(diamond)
    ///        .payCoupon(couponId);` — which exercises the same guard, just not through a booked schedule.
    ///
    ///      The schedule is marked executed BEFORE the call, and a reverting target is reported in
    ///      `success`, not bubbled: the network consumes a schedule whether or not the contract frame
    ///      succeeds. Assert `success` on happy paths — silence here is not proof of settlement. Note also
    ///      that firing is NOT gated on `expirySecond`: forget the `vm.warp(payAt)` and `payCoupon` reverts
    ///      `CouponNotDue`, which surfaces here only as `success == false`.
    /// @param scheduleAddress The schedule to fire.
    /// @return success True when the target's frame succeeded.
    /// @return returnData The target's return or revert data.
    function fireSchedule(address scheduleAddress) external returns (bool success, bytes memory returnData) {
        ScheduledCall storage booked = _schedules[scheduleAddress];
        if (booked.to == address(0)) revert ScheduleNotFound(scheduleAddress);
        if (booked.executed) revert ScheduleAlreadyExecuted(scheduleAddress);

        booked.executed = true;
        address target = booked.to;
        uint256 gasLimit = booked.gasLimit;
        uint256 value = booked.value;
        bytes memory callData = booked.callData;

        VM.prank(target);
        (success, returnData) = target.call{gas: gasLimit, value: value}(callData);

        emit ScheduleFired(scheduleAddress, target, success);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 HIP-1215
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Whether the network has room to run `gasLimit` at `expirySecond`.
    /// @dev Answers true with empty storage; {setScheduleCapacity}, {setExpiryFull} and {setGasLimitCap} steer
    ///      it. `view`, because `HSSAdapterLib.hasScheduleCapacity` staticcalls it.
    /// @param expirySecond The second being asked about.
    /// @param gasLimit The gas the caller wants.
    /// @return hasCapacity True when the schedule would be accepted.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity) {
        if (capacityExhausted || expiryFull[expirySecond]) return false;
        return gasLimitCap == 0 || gasLimit <= gasLimitCap;
    }

    /// @notice Books `callData` to be delivered to `to` at `expirySecond`, with the CALLER as payer and admin.
    /// @dev Stores the call so {fireSchedule} can run it later, and returns a deterministic address (see
    ///      {scheduleAddressFor}). Force `SCHEDULE_EXPIRY_IS_BUSY` (370) here to exercise Lattice's
    ///      `HSSExpiryBusy`, or any other code to exercise `HSSCallFailed`.
    /// @param to The target to call at expiry.
    /// @param expirySecond The consensus second to fire at; must be in the future.
    /// @param gasLimit The gas to give the call.
    /// @param value Tinybars to forward with the call.
    /// @param callData The calldata to deliver.
    /// @return responseCode `SUCCESS` (22) when booked.
    /// @return scheduleAddress The booked schedule, or the zero address on failure.
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes calldata callData)
        external
        returns (int64 responseCode, address scheduleAddress)
    {
        int64 forced = _consumeForced(IHederaScheduleService.scheduleCall.selector);
        if (forced != 0) return (forced, address(0));
        if (to == address(0)) return (HederaResponseCodes.INVALID_CONTRACT_ID, address(0));
        if (expirySecond <= block.timestamp) return (HederaResponseCodes.INVALID_TRANSACTION, address(0));
        if (capacityExhausted || expiryFull[expirySecond] || (gasLimitCap != 0 && gasLimit > gasLimitCap)) {
            return (HederaResponseCodes.SCHEDULE_EXPIRY_IS_BUSY, address(0));
        }

        scheduleAddress = scheduleAddressFor(to, expirySecond, gasLimit, value, callData);

        ScheduledCall storage booked = _schedules[scheduleAddress];
        booked.to = to;
        booked.expirySecond = expirySecond;
        booked.gasLimit = gasLimit;
        booked.value = value;
        booked.executed = false;
        booked.callData = callData;

        emit ScheduleCreated(scheduleAddress, to, expirySecond, gasLimit);
        return (HederaResponseCodes.SUCCESS, scheduleAddress);
    }

    /// @notice Deletes a booked call that has not fired yet.
    /// @dev Note what this does NOT do: clear Lattice's `_schedules[jobId]` mapping. That is why
    ///      `TenorCoupon` must nonce its job ids (`GROUND-TRUTH.md` §3.1.3) — a cancel-then-reschedule of the
    ///      same coupon would otherwise hit `HSSJobAlreadyScheduled`.
    /// @param scheduleAddress The schedule to delete.
    /// @return responseCode `SUCCESS` (22) when deleted; `INVALID_TRANSACTION` (1) when there is nothing
    ///         deletable at that address. The vendored code list has no `INVALID_SCHEDULE_ID` (216), so do not
    ///         assert on that ordinal — assert that it is not `SUCCESS`.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode) {
        int64 forced = _consumeForced(IHederaScheduleService.deleteSchedule.selector);
        if (forced != 0) return forced;

        ScheduledCall storage booked = _schedules[scheduleAddress];
        if (booked.to == address(0) || booked.executed) return HederaResponseCodes.INVALID_TRANSACTION;

        delete _schedules[scheduleAddress];
        emit ScheduleDeleted(scheduleAddress);
        return HederaResponseCodes.SUCCESS;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  HIP-755
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Signs a booked schedule with the calling contract's key.
    /// @dev A no-op acknowledgement: HIP-1215 schedules are already admin'd by their creator, so there is no
    ///      signature state worth modelling. Only the existence check is real.
    /// @param schedule The schedule to authorize.
    /// @return responseCode `SUCCESS` (22) when the schedule exists and has not fired, else
    ///         `INVALID_TRANSACTION` (1) — see {deleteSchedule} on why not `INVALID_SCHEDULE_ID`.
    function authorizeSchedule(address schedule) external returns (int64 responseCode) {
        int64 forced = _consumeForced(IHederaScheduleService.authorizeSchedule.selector);
        if (forced != 0) return forced;

        ScheduledCall storage booked = _schedules[schedule];
        if (booked.to == address(0) || booked.executed) return HederaResponseCodes.INVALID_TRANSACTION;
        return HederaResponseCodes.SUCCESS;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 INTERNALS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Reads and clears the forced code for `selector`, exactly as the HTS mock does.
    /// @param selector The selector being served.
    /// @return code The forced code, or 0 when none was set.
    function _consumeForced(bytes4 selector) private returns (int64 code) {
        code = forcedCode[selector];
        if (code != 0) delete forcedCode[selector];
    }

    /// @dev Every selector this mock does not implement answers `NOT_SUPPORTED` (13) rather than reverting,
    ///      which is how the HTS mock handles its unimplemented surface. Callers expecting a two-word
    ///      `(int64, address)` return — `scheduleCallWithPayer`, `executeCallOnPayerSignature` — will fail to
    ///      decode the single word; `HSSAdapterLib` calls neither.
    fallback() external payable {
        bytes memory unsupported = abi.encode(HederaResponseCodes.NOT_SUPPORTED);
        assembly {
            return(add(unsupported, 0x20), mload(unsupported))
        }
    }

    /// @dev Lets a test `vm.deal` the mock so a non-zero-`value` schedule can actually pay out when fired.
    receive() external payable {}
}
