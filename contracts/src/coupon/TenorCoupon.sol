// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITenorCouponSchedule, TenorCouponLib} from "./TenorCouponLib.sol";
import {ITenorCoupon} from "../interfaces/ITenorCoupon.sol";

/*
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣴⣾⣿⡆
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣿⣿⣿⡇
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⠀⠀⠀⠀⠀⠀⣀⣤⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⠀⠀⢀⣤⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣄⡀
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠃⠀⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣿⣷
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠛⠋⠁⠀⠀⠀⣀⣤⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠉⠀⠀⠀⣀⣴⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠋⠀⠀⢀⣠⣤⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠛⠉⠀⣀⣤⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⡿⠛⠋⠁⠀⠀⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⡿⠋⠉⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠙⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠙⠷⣄⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠈⠓⢦⣄⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠈⠛⢦⣀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠛⠛⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠁
*/

/// @title TenorCoupon
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Diamond facet for Tenor's bond coupons: the holder register, USDC funding, Hedera
///         Scheduled-Transaction booking, and permissionless settlement of a due coupon.
/// @dev Stateless delegator — all logic and storage live in {TenorCouponLib}. Beyond {ITenorCoupon} it also
///      implements {ITenorCouponSchedule}, the one-hop calldata trampoline `scheduleCoupon` needs because
///      `HSSAdapterLib.scheduleSelfCall` takes its payload as `bytes calldata`; that selector MUST be cut into
///      the diamond, and `exportSelectors()` includes it. Only meaningful on Hedera (chain ids 295 / 296 /
///      297 / 298).
/// @custom:lattice-version 0.1.0
/// @custom:lattice-source Hedera
contract TenorCoupon is ITenorCoupon, ITenorCouponSchedule {
    //*//////////////////////////////////////////////////////////////////////////
    //                                   ISSUER
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorCoupon
    function registerHolders(address[] calldata holders) external virtual override {
        TenorCouponLib.registerHolders(holders);
    }

    /// @inheritdoc ITenorCoupon
    function fundCoupon(uint256 couponId, uint256 amountPerToken, uint64 payAt) external virtual override {
        TenorCouponLib.fundCoupon(couponId, amountPerToken, payAt);
    }

    /// @inheritdoc ITenorCoupon
    function scheduleCoupon(uint256 couponId, uint256 gasLimit) external virtual override {
        TenorCouponLib.scheduleCoupon(couponId, gasLimit);
    }

    /// @inheritdoc ITenorCouponSchedule
    function scheduleCouponSelfCall(uint256 couponId, uint256 gasLimit, bytes calldata payload)
        external
        virtual
        override
        returns (address scheduleAddress)
    {
        return TenorCouponLib.scheduleCouponSelfCall(couponId, gasLimit, payload);
    }

    /// @inheritdoc ITenorCoupon
    function cancelSchedule(uint256 couponId) external virtual override {
        TenorCouponLib.cancelSchedule(couponId);
    }

    /// @inheritdoc ITenorCoupon
    function withdrawCouponSurplus(uint256 couponId, address to) external virtual override {
        TenorCouponLib.withdrawCouponSurplus(couponId, to);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 SETTLEMENT
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorCoupon
    function payCoupon(uint256 couponId) external virtual override {
        TenorCouponLib.payCoupon(couponId);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorCoupon
    function getCoupon(uint256 couponId) external view virtual override returns (Coupon memory coupon) {
        return TenorCouponLib.getCoupon(couponId);
    }

    /// @inheritdoc ITenorCoupon
    function couponScheduleAddress(uint256 couponId) external view virtual override returns (address scheduleAddress) {
        return TenorCouponLib.couponScheduleAddress(couponId);
    }

    /// @inheritdoc ITenorCoupon
    function couponHolders() external view virtual override returns (address[] memory holders) {
        return TenorCouponLib.couponHolders();
    }

    /// @inheritdoc ITenorCoupon
    function couponRequirement(uint256 amountPerToken) external view virtual override returns (uint256 required) {
        return TenorCouponLib.couponRequirement(amountPerToken);
    }

    /// @inheritdoc ITenorCoupon
    function couponEntitlement(uint256 couponId, address holder)
        external
        view
        virtual
        override
        returns (uint256 amount)
    {
        return TenorCouponLib.couponEntitlement(couponId, holder);
    }

    /// @inheritdoc ITenorCoupon
    function couponToken() external view virtual override returns (address token) {
        return TenorCouponLib.couponToken();
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  SELECTORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice ERC-8153 selector export: this facet's cuttable selectors, tightly packed (4 bytes each).
    /// @dev Excludes `exportSelectors()` itself (0x0ef22643) - it is never cut into a diamond. Order matches
    ///      `forge inspect TenorCoupon methodIdentifiers` (alphabetical by signature). Chunks:
    ///      `cancelSchedule(uint256)` 0x237fc2a6
    ///      `couponEntitlement(uint256,address)` 0x718c137d
    ///      `couponHolders()` 0x176abee8
    ///      `couponRequirement(uint256)` 0xc455289e
    ///      `couponScheduleAddress(uint256)` 0x89370539
    ///      `couponToken()` 0x457cf77a
    ///      `fundCoupon(uint256,uint256,uint64)` 0xb7157b6c
    ///      `getCoupon(uint256)` 0x936e3169
    ///      `payCoupon(uint256)` 0x932e2b86
    ///      `registerHolders(address[])` 0x2c43e576
    ///      `scheduleCoupon(uint256,uint256)` 0x20a18457
    ///      `scheduleCouponSelfCall(uint256,uint256,bytes)` 0x6d3489e5
    ///      `withdrawCouponSurplus(uint256,address)` 0xe2b4f64b
    /// @return selectors The packed selector blob.
    function exportSelectors() external pure virtual returns (bytes memory selectors) {
        selectors =
            hex"237fc2a6718c137d176abee8c455289e89370539457cf77ab7157b6c936e3169932e2b862c43e57620a184576d3489e5e2b4f64b";
    }
}
