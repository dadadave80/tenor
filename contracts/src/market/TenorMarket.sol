// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITenorMarket} from "../interfaces/ITenorMarket.sol";
import {TenorMarketLib} from "./TenorMarketLib.sol";

/// @title TenorMarket
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Diamond facet exposing Tenor's sell-listing market: list, fill, cancel, expire, and the fee and
///         duration admin levers.
/// @dev Stateless delegator — all logic and storage live in {TenorMarketLib}. Cut alongside Lattice's
///      AccessControl and Pausable facets, whose state this module reads through their libraries:
///      `list` / `fill` honour the pause flag and the admin setters check `DEFAULT_ADMIN_ROLE`. There is no
///      `withdrawFees` by design — accrued fees leave the diamond through Lattice's `HTSAdapter.transferToken`
///      under `HTS_OPERATOR_ROLE` (`docs/SPEC.md` [DEV-2]).
contract TenorMarket is ITenorMarket {
    //*//////////////////////////////////////////////////////////////////////////
    //                                   WRITES
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorMarket
    function list(address token, bytes32 partition, uint256 amount, uint256 pricePerToken, uint64 expiry)
        external
        virtual
        override
        returns (uint256 id)
    {
        return TenorMarketLib.list(token, partition, amount, pricePerToken, expiry);
    }

    /// @inheritdoc ITenorMarket
    function fill(uint256 id, uint256 amount) external virtual override {
        TenorMarketLib.fill(id, amount);
    }

    /// @inheritdoc ITenorMarket
    function cancel(uint256 id) external virtual override {
        TenorMarketLib.cancel(id);
    }

    /// @inheritdoc ITenorMarket
    function expire(uint256 id) external virtual override {
        TenorMarketLib.expire(id);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ADMIN
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorMarket
    function setFeeBps(uint16 newFeeBps) external virtual override {
        TenorMarketLib.setFeeBps(newFeeBps);
    }

    /// @inheritdoc ITenorMarket
    function setMaxDuration(uint64 newMaxDuration) external virtual override {
        TenorMarketLib.setMaxDuration(newMaxDuration);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @inheritdoc ITenorMarket
    function getListing(uint256 id) external view virtual override returns (Listing memory listing) {
        return TenorMarketLib.getListing(id);
    }

    /// @inheritdoc ITenorMarket
    function quote(uint256 id, uint256 amount) external view virtual override returns (uint256 cost, uint256 fee) {
        return TenorMarketLib.quote(id, amount);
    }

    /// @inheritdoc ITenorMarket
    function nextListingId() external view virtual override returns (uint256 id) {
        return TenorMarketLib.nextListingId();
    }

    /// @inheritdoc ITenorMarket
    function usdc() external view virtual override returns (address usdcToken) {
        return TenorMarketLib.usdc();
    }

    /// @inheritdoc ITenorMarket
    function feeBps() external view virtual override returns (uint16 bps) {
        return TenorMarketLib.feeBps();
    }

    /// @inheritdoc ITenorMarket
    function maxDuration() external view virtual override returns (uint64 duration) {
        return TenorMarketLib.maxDuration();
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  SELECTORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice ERC-8153 selector export: this facet's cuttable selectors, tightly packed (4 bytes each).
    /// @dev Excludes `exportSelectors()` itself (0x0ef22643) - it is never cut into a diamond. Order matches
    ///      `forge inspect TenorMarket methodIdentifiers` (alphabetical by signature). Chunks:
    ///      `cancel(uint256)` 0x40e58ee5
    ///      `expire(uint256)` 0xbf81bf43
    ///      `feeBps()` 0x24a9d853
    ///      `fill(uint256,uint256)` 0x3c29fc43
    ///      `getListing(uint256)` 0x107a274a
    ///      `list(address,bytes32,uint256,uint256,uint64)` 0x11ae49dc
    ///      `maxDuration()` 0x6db5c8fd
    ///      `nextListingId()` 0xaaccf1ec
    ///      `quote(uint256,uint256)` 0x315f1a41
    ///      `setFeeBps(uint16)` 0x023b1fc9
    ///      `setMaxDuration(uint64)` 0xf0147832
    ///      `usdc()` 0x3e413bee
    /// @return selectors The packed selector list.
    function exportSelectors() external pure virtual returns (bytes memory selectors) {
        selectors =
            hex"40e58ee5bf81bf4324a9d8533c29fc43107a274a11ae49dc6db5c8fdaaccf1ec315f1a41023b1fc9f01478323e413bee";
    }
}
