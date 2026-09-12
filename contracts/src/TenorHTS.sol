// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HederaResponseCodes} from "@lattice/interfaces/external/hedera/HederaResponseCodes.sol";
import {IHederaTokenService} from "@lattice/interfaces/external/hedera/IHederaTokenService.sol";

/// @title TenorHTS
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The two Hedera Token Service calls Tenor makes on its permissionless paths, straight to `0x167`.
/// @dev Tenor deliberately does NOT route these through Lattice's {HTSAdapterLib}. Every mutating helper there
///      calls `AccessControlLib.checkRole(...)`, which checks `msg.sender` — and a facet's `delegatecall` frame
///      preserves `msg.sender` as the ORIGINAL caller. Routing `fill()` through `HTSAdapterLib.transferTokenFrom`
///      would therefore demand that the *buyer* hold `HTS_OPERATOR_ROLE`, and `payCoupon()` that an arbitrary
///      caller hold it. Both are permissionless by design, so both call the system contract directly instead.
///      `HTSAdapterLib` also reverts on any non-SUCCESS code, which cannot express the per-holder
///      skip-and-continue that {ITenorCoupon-CouponPaymentSkipped} requires.
///
///      Lattice's HTS facet still earns its place in the cut on the ADMIN paths, where `msg.sender` is a role
///      holder: `associateToken` (USDC self-association) and `transferToken` (fee withdrawal).
///
///      The interface and response-code constants are Lattice's vendored copies, so the ABI stays identical to
///      the one the HTS facet uses. Only the authorization wrapper is bypassed, never the ABI.
///      See `docs/GROUND-TRUTH.md` §2.2.
library TenorHTS {
    /// @dev The Hedera Token Service system contract (HIP-206). Has no bytecode; never `delegatecall` it.
    address internal constant HTS_SYSTEM_CONTRACT = 0x0000000000000000000000000000000000000167;

    /// @notice An HTS call returned a non-SUCCESS response code.
    /// @param selector The HTS function that failed.
    /// @param responseCode The Hedera response code (`SUCCESS == 22`, `UNKNOWN == 21` for a halted frame).
    error TenorHTSCallFailed(bytes4 selector, int64 responseCode);

    /// @notice An amount could not be represented as the `int64` HTS expects.
    /// @dev Only {transferFrom} raises this. {tryTransfer} must never revert, so it reports the same
    ///      condition as a response code instead.
    error TenorHTSAmountOverflow(uint256 amount);

    /// @notice Spends the allowance `from` granted the diamond, moving `amount` of `token` from `from` to `to`.
    /// @dev The allowance path of HIP-906. An ERC-20 `approve` on an HTS token sets the same allowance this
    ///      consumes, so a wallet's ordinary approve step works unchanged. Reverts on any non-SUCCESS code —
    ///      this is the USDC leg of `fill()` and of `fundCoupon()`, where a partial effect must be impossible.
    /// @param token The HTS token to move.
    /// @param from The account whose allowance to the diamond is spent.
    /// @param to The recipient.
    /// @param amount The amount in the token's atomic units.
    function transferFrom(address token, address from, address to, uint256 amount) internal {
        int64 code = _callForCode(abi.encodeCall(IHederaTokenService.transferFrom, (token, from, to, amount)));
        if (code != HederaResponseCodes.SUCCESS) {
            revert TenorHTSCallFailed(IHederaTokenService.transferFrom.selector, code);
        }
    }

    /// @notice Moves `amount` of `token` from the diamond to `to`, returning the response code instead of
    ///         reverting.
    /// @dev The non-reverting form exists for `payCoupon`: one holder who never associated with USDC (or who
    ///      the issuer froze) must not strand every other holder's coupon. The caller records the code in
    ///      {ITenorCoupon-CouponPaymentSkipped} and moves on.
    /// @param token The HTS token to move.
    /// @param to The recipient.
    /// @param amount The amount in the token's atomic units.
    /// @return code The Hedera response code; `HederaResponseCodes.SUCCESS` (22) on success.
    function tryTransfer(address token, address to, uint256 amount) internal returns (int64 code) {
        // This function is TOTAL by contract: `payCoupon` records whatever comes back and moves on to
        // the next holder, so a revert here would be the one thing able to strand every other holder's
        // coupon. An amount too large for the `int64` HTS takes is therefore reported as a code — with
        // no call attempted — rather than raised.
        if (amount > uint256(uint64(type(int64).max))) return HederaResponseCodes.UNKNOWN;
        code = _callForCode(
            abi.encodeCall(IHederaTokenService.transferToken, (token, address(this), to, int64(uint64(amount))))
        );
    }

    /// @dev Plain `call` into HTS returning the response code. A halted frame — or a frame returning too little
    ///      data to decode — surfaces as `UNKNOWN` (21), which is how hiero-contracts' own helper reports it.
    function _callForCode(bytes memory data) private returns (int64 code) {
        (bool ok, bytes memory ret) = HTS_SYSTEM_CONTRACT.call(data);
        code = (ok && ret.length >= 32) ? abi.decode(ret, (int64)) : HederaResponseCodes.UNKNOWN;
    }
}
