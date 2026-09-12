// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControlLib} from "@lattice/access/libraries/AccessControlLib.sol";
import {HSSAdapterLib, HSS_SCHEDULER_ROLE} from "@lattice/oracles/hedera/HSSAdapterLib.sol";
import {PausableLib} from "@lattice/security/libraries/PausableLib.sol";
import {HTSAdapterLib, HTS_MANAGER_ROLE, HTS_OPERATOR_ROLE} from "@lattice/tokens/hedera/HTSAdapterLib.sol";
import {TenorCouponLib, ISSUER_ROLE} from "./coupon/TenorCouponLib.sol";
import {TenorMarketLib} from "./market/TenorMarketLib.sol";

/// @title TenorInit
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice One-shot initializer for the Tenor diamond: roles, module storage, and ERC-165 ids.
/// @dev Delegatecalled by `Diamond.initialize` INSIDE the initializing window, so — exactly like
///      Lattice's own `HTSAdapterInit` — it must not open its own `preInitializer`/`postInitializer`.
///      Each `__X_init()` it calls asserts `InitializableLib.checkInitializing` for itself.
///
///      It deliberately does NOT associate the diamond with USDC. `HTSAdapterLib.associateToken` is
///      gated on `AccessControlLib.checkRole(HTS_MANAGER_ROLE)`, and inside this delegatecall
///      `msg.sender` is the factory that created the diamond — not the `admin` granted a line earlier —
///      so the call would revert. The association is a post-deploy transaction sent by `admin` through
///      the HTSAdapter facet instead. See `docs/GROUND-TRUTH.md` §2.2.3.
contract TenorInit {
    /// @notice Seeds access control, both Tenor modules, and the Lattice Hedera modules.
    /// @dev MUST be invoked only through the diamond's `initialize` `_init` delegatecall.
    ///
    ///      Role layout, and why:
    ///      - `admin` takes `DEFAULT_ADMIN_ROLE`, which also gates `pause`/`unpause` (Lattice's
    ///        `PausableLib` checks role `0x00`; there is no separate `PAUSER_ROLE` to grant).
    ///      - `admin` takes `HTS_MANAGER_ROLE` (to associate USDC) and `HTS_OPERATOR_ROLE` (to move the
    ///        diamond's own USDC, which is how protocol fees are withdrawn).
    ///      - `issuer` takes `ISSUER_ROLE` (fund, register holders, cancel) and `HSS_SCHEDULER_ROLE`,
    ///        which Lattice's `scheduleSelfCall` requires of whoever books the coupon payment.
    /// @param admin The address granted `DEFAULT_ADMIN_ROLE` and both HTS roles.
    /// @param issuer The address granted `ISSUER_ROLE` and `HSS_SCHEDULER_ROLE`.
    /// @param usdc The HTS token the market settles in and coupons are paid in (6 dp).
    /// @param token The ATS security token: the only token the market will list, and the one whose
    ///        holders receive coupons.
    /// @param feeBps The initial protocol fee in basis points; must be <= 100.
    /// @param maxDuration The initial cap on how far ahead a listing may expire, in seconds.
    function init(address admin, address issuer, address usdc, address token, uint16 feeBps, uint64 maxDuration)
        external
    {
        AccessControlLib.__AccessControl_init(admin);
        AccessControlLib._grantRole(HTS_MANAGER_ROLE, admin);
        AccessControlLib._grantRole(HTS_OPERATOR_ROLE, admin);
        AccessControlLib._grantRole(ISSUER_ROLE, issuer);
        AccessControlLib._grantRole(HSS_SCHEDULER_ROLE, issuer);

        PausableLib.__Pausable_init();
        HTSAdapterLib.__HTSAdapter_init();
        HSSAdapterLib.__HSSAdapter_init();

        TenorMarketLib.__TenorMarket_init(usdc, token, feeBps, maxDuration);
        TenorCouponLib.__TenorCoupon_init(token, usdc);
    }
}
