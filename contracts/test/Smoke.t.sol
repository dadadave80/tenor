// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IHoldTypes} from "@ats/facets/hold/IHoldTypes.sol";
import {ITenorMarket} from "../src/interfaces/ITenorMarket.sol";
import {TenorTestBase} from "./TenorTestBase.sol";

/// @title SmokeTest
/// @notice Proves the harness and the whole settlement path work together before the detailed suites
///         are written: enable selling, list against a real ATS hold, and fill with atomic DVP.
contract SmokeTest is TenorTestBase {
    function test_happyPath_listThenFill() public {
        uint256 amount = 200 * ONE_TOKEN; // 200 notes
        uint256 price = 98 * 10 ** 6; // 98 USDC per whole note
        uint64 expiry = uint64(block.timestamp + 1 days);

        _enableSelling(alice, amount);

        vm.prank(alice);
        uint256 id = market.list(address(atsToken), bytes32(uint256(1)), amount, price, expiry);

        ITenorMarket.Listing memory l = market.getListing(id);
        assertEq(l.seller, alice, "seller");
        assertEq(l.remaining, amount, "remaining");
        assertTrue(l.active, "active");

        // The tokens never left Alice — they are reserved under a hold whose escrow is the diamond.
        assertEq(atsToken.balanceOf(alice), amount, "seller keeps custody");
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4: diamond holds no security token");
        (uint256 held,, address escrow,,,,) = atsToken.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({partition: bytes32(uint256(1)), tokenHolder: alice, holdId: l.holdId})
        );
        assertEq(held, amount, "invariant 2: hold mirrors remaining");
        assertEq(escrow, tenor, "invariant 2: diamond is escrow");

        // --- fill half, as the verified buyer -----------------------------------------------------
        uint256 buy = 50 * ONE_TOKEN;
        (uint256 cost, uint256 fee) = market.quote(id, buy);
        assertEq(cost, 50 * 98 * 10 ** 6, "cost = 50 notes x 98 USDC");
        assertEq(fee, 0, "feeBps is 0 in the harness");

        _fundUsdc(bob, cost);
        _approveUsdc(bob, cost);

        vm.prank(bob);
        market.fill(id, buy);

        // DVP: USDC to the seller, tokens to the buyer, one transaction.
        assertEq(uint256(uint64(hts.balanceOf(usdc, alice))), cost, "seller paid in USDC");
        assertEq(uint256(uint64(hts.balanceOf(usdc, bob))), 0, "buyer's USDC spent");
        assertEq(atsToken.balanceOf(bob), buy, "buyer received notes");
        assertEq(atsToken.balanceOf(alice), amount - buy, "seller's notes reduced");
        assertEq(atsToken.balanceOf(tenor), 0, "invariant 4 still holds");
        assertEq(market.getListing(id).remaining, amount - buy, "remaining decremented");
    }

    /// @notice The compliance guarantee: an unverified buyer cannot fill, and the USDC leg is undone
    ///         with it. This is invariant 1 — a fill moves both legs or neither.
    function test_unverifiedBuyer_cannotFill() public {
        uint256 amount = 100 * ONE_TOKEN;
        uint256 price = 98 * 10 ** 6;

        _enableSelling(alice, amount);
        vm.prank(alice);
        uint256 id = market.list(address(atsToken), bytes32(uint256(1)), amount, price, uint64(block.timestamp + 1 days));

        (uint256 cost,) = market.quote(id, 10 * ONE_TOKEN);
        _fundUsdc(carol, cost);
        _approveUsdc(carol, cost);

        vm.prank(carol);
        vm.expectRevert(); // ATS refuses: carol has no KYC
        market.fill(id, 10 * ONE_TOKEN);

        assertEq(uint256(uint64(hts.balanceOf(usdc, carol))), cost, "invariant 1: USDC not taken");
        assertEq(atsToken.balanceOf(carol), 0, "no tokens delivered");
        assertEq(market.getListing(id).remaining, amount, "listing untouched");
    }
}
