// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DiamondLoupeFacet} from "@diamond/facets/DiamondLoupeFacet.sol";
import {ERC165Facet} from "@diamond/facets/ERC165Facet.sol";
import {FacetCut} from "@diamond/libraries/DiamondLib.sol";
import {BaseDeploy} from "@lattice-script/base/BaseDeploy.s.sol";
import {Receive} from "@lattice/Receive.sol";
import {AccessControl} from "@lattice/access/AccessControl.sol";
import {AccessControlDiamondCut} from "@lattice/governance/AccessControlDiamondCut.sol";
import {IHTSAdapter} from "@lattice/interfaces/tokens/IHTSAdapter.sol";
import {HSSAdapter} from "@lattice/oracles/hedera/HSSAdapter.sol";
import {Pausable} from "@lattice/security/Pausable.sol";
import {HTSAdapter} from "@lattice/tokens/hedera/HTSAdapter.sol";
import {TenorCoupon} from "../src/coupon/TenorCoupon.sol";
import {TenorInit} from "../src/TenorInit.sol";
import {TenorMarket} from "../src/market/TenorMarket.sol";

/// @title DeployTenor
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Ready-to-deploy recipe for the Tenor diamond, following Lattice's {BaseDeploy} pattern: a public
///         {buildCuts} that both production and the deployment test share, and a broadcasting {run}.
/// @dev Two post-deploy transactions are part of deployment, not afterthoughts, and {run} sends both:
///
///      1. `associateToken(usdc)`. An HTS account must be associated with a token before it can receive it,
///         and the diamond receives USDC for coupon funding and fees. This cannot live in {TenorInit}:
///         `HTSAdapterLib.associateToken` is gated on `HTS_MANAGER_ROLE` against `msg.sender`, and inside
///         the init delegatecall `msg.sender` is the factory, not `admin`. See `docs/GROUND-TRUTH.md` §2.2.3.
///
///      2. Seeding the diamond with HBAR. `HSSAdapterLib.scheduleSelfCall` makes the CALLING CONTRACT the
///         schedule's payer, so the diamond funds the scheduled `payCoupon` out of its own balance. Without
///         HBAR here the coupon is booked and then never fires — the {Receive} facet in the cut is what lets
///         a plain transfer land.
contract DeployTenor is BaseDeploy {
    /// @notice Builds the Tenor diamond cuts + initializer (no broadcast, no proxy deploy).
    /// @dev The cut is deliberately thin. Compliance lives in the ATS token, not here, so there is no KYC or
    ///      control-list facet; and there is no `PAUSER_ROLE` facet because Lattice's `Pausable` gates on
    ///      `DEFAULT_ADMIN_ROLE` (`docs/GROUND-TRUTH.md`, SPEC [DEV-5]).
    /// @param admin The address granted `DEFAULT_ADMIN_ROLE` and both HTS roles.
    /// @param issuer The address granted `ISSUER_ROLE` and `HSS_SCHEDULER_ROLE`.
    /// @param usdc The HTS settlement token (6 dp).
    /// @param token The ATS security token traded and couponed.
    /// @param feeBps Initial protocol fee, <= 100.
    /// @param maxDuration Initial cap on listing lifetime, in seconds.
    /// @return cuts The facet cuts.
    /// @return init The {MultiInit} running {TenorInit} then the diamond introspection init.
    /// @return initCalldata The matching `multiInit` calldata.
    function buildCuts(address admin, address issuer, address usdc, address token, uint16 feeBps, uint64 maxDuration)
        public
        returns (FacetCut[] memory cuts, address init, bytes memory initCalldata)
    {
        cuts = new FacetCut[](10);
        // --- diamond plumbing -----------------------------------------------------------------
        cuts[0] = _cut(address(new ERC165Facet()));
        cuts[1] = _cut(address(new DiamondLoupeFacet())); // FR7: facets are enumerable in the client
        cuts[2] = _cut(address(new AccessControlDiamondCut()));
        cuts[3] = _cut(address(new AccessControl()));
        // Lets the diamond hold HBAR, which it must to pay for its own scheduled coupon calls.
        cuts[4] = _cut(address(new Receive()));
        cuts[5] = _cut(address(new Pausable()));
        // --- reusable Hedera system-contract modules from Lattice -------------------------------
        cuts[6] = _cut(address(new HTSAdapter()));
        cuts[7] = _cut(address(new HSSAdapter()));
        // --- Tenor ------------------------------------------------------------------------------
        cuts[8] = _cut(address(new TenorMarket()));
        cuts[9] = _cut(address(new TenorCoupon()));

        (init, initCalldata) = _withUpgradeableIntrospection(
            address(new TenorInit()), abi.encodeCall(TenorInit.init, (admin, issuer, usdc, token, feeBps, maxDuration))
        );
    }

    /// @notice Deploys the Tenor diamond and completes the two post-deploy transactions.
    /// @dev Broadcasting entrypoint for `forge script ... --broadcast`. The caller must hold `admin` to send
    ///      the association, so `admin` should be the broadcasting key on testnet.
    /// @param admin The diamond admin (must be the broadcaster for the association to succeed).
    /// @param issuer The coupon issuer.
    /// @param usdc The HTS settlement token.
    /// @param token The ATS security token.
    /// @param feeBps Initial protocol fee, <= 100.
    /// @param maxDuration Initial listing lifetime cap, in seconds.
    /// @param hbarSeed Wei of HBAR (18 dp on the EVM side) to transfer to the diamond for scheduled calls.
    /// @return tenor The deployed Tenor diamond address.
    function run(
        address admin,
        address issuer,
        address usdc,
        address token,
        uint16 feeBps,
        uint64 maxDuration,
        uint256 hbarSeed
    ) external returns (address tenor) {
        vm.startBroadcast();
        (FacetCut[] memory cuts, address init, bytes memory initCalldata) =
            buildCuts(admin, issuer, usdc, token, feeBps, maxDuration);
        tenor = _assemble(cuts, init, initCalldata);

        // Post-deploy 1: the diamond associates itself with USDC, as `admin`.
        IHTSAdapter(tenor).associateToken(usdc);

        // Post-deploy 2: fund the diamond so it can pay for the coupon calls it schedules.
        if (hbarSeed != 0) {
            (bool ok,) = tenor.call{value: hbarSeed}("");
            require(ok, "DeployTenor: HBAR seed transfer failed (is the Receive facet cut in?)");
        }
        vm.stopBroadcast();
    }
}
