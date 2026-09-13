// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC165Facet} from "@diamond/facets/ERC165Facet.sol";
import {IDiamondLoupe} from "@diamond/interfaces/IDiamondLoupe.sol";
import {Facet, FacetCut, FunctionDoesNotExist} from "@diamond/libraries/DiamondLib.sol";
import {OwnableLib} from "@diamond/libraries/OwnableLib.sol";
import {IAccessControl} from "@lattice/interfaces/access/IAccessControl.sol";
import {IERC8153} from "@lattice/interfaces/external/ercs/IERC8153.sol";
import {IHSSAdapter} from "@lattice/interfaces/oracles/IHSSAdapter.sol";
import {IPausable} from "@lattice/interfaces/security/IPausable.sol";
import {IHTSAdapter} from "@lattice/interfaces/tokens/IHTSAdapter.sol";
import {HSS_SCHEDULER_ROLE} from "@lattice/oracles/hedera/HSSAdapterLib.sol";
import {HTS_MANAGER_ROLE, HTS_OPERATOR_ROLE} from "@lattice/tokens/hedera/HTSAdapterLib.sol";
import {InvalidInitialization, NotInitializing} from "@lattice/utils/libraries/InitializableLib.sol";
import {DeployTenor} from "../script/DeployTenor.s.sol";
import {ITenorCouponSchedule, ISSUER_ROLE} from "../src/coupon/TenorCouponLib.sol";
import {ITenorCoupon} from "../src/interfaces/ITenorCoupon.sol";
import {ITenorMarket} from "../src/interfaces/ITenorMarket.sol";
import {Tenor} from "../src/Tenor.sol";
import {TenorInit} from "../src/TenorInit.sol";
import {TenorTestBase} from "./TenorTestBase.sol";

/// @title DeployTenorHarness
/// @notice Exposes {DeployTenor-_assembleTenor}, the creation step {DeployTenor-run} broadcasts, so the
///         production path can be driven from a test. Nothing is overridden; the external frame makes the
///         harness the diamond's creator and therefore its owner, exactly as the broadcaster is during
///         `forge script`.
contract DeployTenorHarness is DeployTenor {
    /// @notice Calls {DeployTenor-_assembleTenor}: create a {Tenor}, then initialize it as its owner.
    function assembleTenor(FacetCut[] memory cuts, address init, bytes memory initCalldata)
        external
        returns (address tenor)
    {
        return _assembleTenor(cuts, init, initCalldata);
    }
}

/// @title DeployTest
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice The assembly suite: proves the Tenor diamond that `DeployTenor` produces is CUT correctly and
///         INITIALISED correctly. Every other suite takes the diamond as a given; this one is the only place
///         the cut and `TenorInit` are checked against each other, and the only place the two post-deploy
///         transactions of `DeployTenor.run` are shown to be load-bearing rather than decorative.
/// @dev Four deployment paths appear here on purpose, because they are different risks:
///      - {_assembleRaw} (create a {Tenor}, then initialize it as its owner) — used wherever a test needs to
///        see a diamond BEFORE any post-deploy transaction has touched it.
///      - {DeployTenorHarness-assembleTenor} — `DeployTenor._assembleTenor`, the exact function {DeployTenor-run}
///        broadcasts.
///      - `DeployTenor.run` itself, broadcast included, in {test_run_deploysAConfiguredTenorOwnedByTheBroadcaster}.
///      - The base's `tenor`, a fully deployed diamond including the USDC association.
///
///      `run`'s two post-deploy transactions belong to `scripts/deploy-tenor.ts`, not forge; they are covered
///      compositionally (see the ASSOCIATION and HBAR groups).
contract DeployTest is TenorTestBase {
    /// @dev `type(IERC165).interfaceId`.
    bytes4 internal constant ERC165_ID = 0x01ffc9a7;
    /// @dev `type(IDiamondLoupe).interfaceId`, as diamond-lib's precomputed map slot encodes it.
    bytes4 internal constant DIAMOND_LOUPE_ID = 0x48e2b093;
    /// @dev `type(IDiamondCut).interfaceId`.
    bytes4 internal constant DIAMOND_CUT_ID = 0x1f931c1c;
    /// @dev ERC-8153's own `exportSelectors()` selector, which must never be routed on a diamond.
    bytes4 internal constant EXPORT_SELECTORS_ID = IERC8153.exportSelectors.selector;
    /// @dev The number of facets `DeployTenor.buildCuts` cuts. A facet lost or gained must fail loudly.
    uint256 internal constant EXPECTED_FACETS = 10;
    /// @dev Total selectors the ten facets export between them, i.e. the diamond's whole routed surface.
    ///      13 market + 13 coupon + 13 HTSAdapter + 7 HSSAdapter + 5 AccessControl + 4 loupe + 3 Pausable
    ///      + 1 ERC-165 + 1 AccessControlDiamondCut + 1 Receive (the zero selector).
    uint256 internal constant EXPECTED_SELECTORS = 61;
    /// @dev The role SPEC v3 asked for and [DEV-5] removed. Nothing may hold it, and nothing may need it.
    bytes32 internal constant ABSENT_PAUSER_ROLE = keccak256("PAUSER_ROLE");

    //*//////////////////////////////////////////////////////////////////////////
    //                                 THE CUT
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice FR7 — the client enumerates facets through the loupe, so the loupe must report the recipe it
    ///         was assembled from: all ten facets, each owning exactly the selector set its cut carried.
    ///         A facet silently dropped from the cut, or one whose selectors landed on a neighbour, fails here.
    function test_cut_loupeReportsAllTenFacetsWithTheirSelectors() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();

        assertEq(cuts.length, EXPECTED_FACETS, "the production recipe must be ten facets");
        Facet[] memory reported = IDiamondLoupe(diamond).facets();
        assertEq(reported.length, EXPECTED_FACETS, "facets() must enumerate all ten facets");
        assertEq(IDiamondLoupe(diamond).facetAddresses().length, EXPECTED_FACETS, "facetAddresses() must agree");

        uint256 matched;
        for (uint256 i; i < reported.length; ++i) {
            for (uint256 j; j < cuts.length; ++j) {
                if (reported[i].facetAddress != cuts[j].facetAddress) continue;
                _assertSameSelectorSet(reported[i].functionSelectors, cuts[j].functionSelectors, "facets() entry");
                ++matched;
            }
        }
        assertEq(matched, EXPECTED_FACETS, "every facet the loupe reports must be one of the recipe's ten");
    }

    /// @notice The cut/ABI agreement: every selector a facet ADVERTISES through ERC-8153 must actually be
    ///         routed to THAT facet. This is the check that catches a selector collision (two facets exporting
    ///         one selector, where the second silently loses the route) and an export blob that drifted out of
    ///         step with the recipe. It also pins the diamond's total routed surface, which is the only way a
    ///         shrunken export blob can be noticed at all: the cut is built from the same blob.
    function test_cut_everyExportedSelectorRoutesToItsOwnFacet() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();

        uint256 total;
        for (uint256 i; i < cuts.length; ++i) {
            bytes4[] memory exported = _exportedSelectors(cuts[i].facetAddress);
            assertEq(exported.length, cuts[i].functionSelectors.length, "cut does not carry the whole export");
            for (uint256 j; j < exported.length; ++j) {
                assertEq(IDiamondLoupe(diamond).facetAddress(exported[j]), cuts[i].facetAddress, "selector misrouted");
            }
            total += exported.length;
        }
        assertEq(total, EXPECTED_SELECTORS, "the recipe's routed selector surface changed");
    }

    /// @notice No selector may be claimed by two facets. The diamond cut would revert on a true duplicate, so
    ///         this is the pre-flight statement of that: the recipe is collision-free by construction, and the
    ///         routed surface on the diamond accounts for every exported selector with none swallowed.
    function test_cut_noSelectorIsRegisteredTwice() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();

        bytes4[] memory all = _flattenSelectors(cuts);
        assertEq(all.length, EXPECTED_SELECTORS, "flattened selector count");
        for (uint256 i; i < all.length; ++i) {
            for (uint256 j = i + 1; j < all.length; ++j) {
                assertTrue(all[i] != all[j], "two facets export the same selector");
            }
        }

        uint256 routed;
        address[] memory facetAddresses = IDiamondLoupe(diamond).facetAddresses();
        for (uint256 i; i < facetAddresses.length; ++i) {
            routed += IDiamondLoupe(diamond).facetFunctionSelectors(facetAddresses[i]).length;
        }
        assertEq(routed, all.length, "the diamond routes a different number of selectors than it was cut");
    }

    /// @notice The market facet's ERC-8153 export must be exactly `ITenorMarket` — no more, no less. A missing
    ///         entry is a function unreachable on the diamond; an extra one is a route to code that is not
    ///         there. Set equality in both directions is what makes an export blob trustworthy without an ABI
    ///         round-trip.
    function test_cut_marketFacetExportIsExactlyITenorMarket() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();
        address facet = IDiamondLoupe(diamond).facetAddress(ITenorMarket.list.selector);
        assertEq(facet, cuts[8].facetAddress, "the market facet must own ITenorMarket.list");
        _assertSameSelectorSet(_exportedSelectors(facet), _marketSelectors(), "TenorMarket export");
    }

    /// @notice Same agreement for the coupon facet, plus the reason this test exists at all: the module's
    ///         `scheduleCouponSelfCall` trampoline is NOT part of `ITenorCoupon`, so nothing but this export
    ///         puts it in the cut — and without it every `scheduleCoupon` fails at runtime, because the
    ///         trampoline is how a `bytes memory` payload becomes the `bytes calldata` Lattice's
    ///         `scheduleSelfCall` demands.
    function test_cut_couponFacetExportIsITenorCouponPlusTheScheduleTrampoline() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();
        address facet = IDiamondLoupe(diamond).facetAddress(ITenorCoupon.payCoupon.selector);
        assertEq(facet, cuts[9].facetAddress, "the coupon facet must own ITenorCoupon.payCoupon");
        _assertSameSelectorSet(_exportedSelectors(facet), _couponSelectors(), "TenorCoupon export");
    }

    /// @notice Every function of both Tenor interfaces resolves on the DEPLOYED diamond. The two preceding
    ///         tests compare blobs; this one asks the assembled article, which is what a client talks to.
    function test_cut_everyTenorInterfaceSelectorResolvesOnTheDiamond() public view {
        bytes4[] memory market = _marketSelectors();
        for (uint256 i; i < market.length; ++i) {
            assertTrue(IDiamondLoupe(tenor).facetAddress(market[i]) != address(0), "ITenorMarket selector unrouted");
        }
        bytes4[] memory coupon = _couponSelectors();
        for (uint256 i; i < coupon.length; ++i) {
            assertTrue(IDiamondLoupe(tenor).facetAddress(coupon[i]) != address(0), "ITenorCoupon selector unrouted");
        }
    }

    /// @notice The trampoline is not merely present in the selector map — it dispatches into real code. A
    ///         Tenor-layer revert (the ISSUER_ROLE gate `scheduleCouponSelfCall` re-checks because it is
    ///         reachable directly) proves the route lands on the coupon facet, where `FunctionDoesNotExist`
    ///         or a silent success would not.
    function testRevert_cut_scheduleTrampolineDispatchesIntoTheCouponFacet() public {
        assertEq(
            IDiamondLoupe(tenor).facetAddress(ITenorCouponSchedule.scheduleCouponSelfCall.selector),
            IDiamondLoupe(tenor).facetAddress(ITenorCoupon.payCoupon.selector),
            "the trampoline must live on the coupon facet"
        );

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, ISSUER_ROLE)
        );
        ITenorCouponSchedule(tenor).scheduleCouponSelfCall(0, 200_000, abi.encodeCall(ITenorCoupon.payCoupon, (0)));
    }

    /// @notice ERC-8153 introspection is a build-time facility, never a diamond function: `exportSelectors()`
    ///         must not be routed, or a facet's self-report would become part of the diamond's ABI and the
    ///         second facet to declare it could not be cut at all.
    function testRevert_cut_exportSelectorsIsNeverRouted() public {
        assertEq(IDiamondLoupe(tenor).facetAddress(EXPORT_SELECTORS_ID), address(0), "exportSelectors() is routed");

        vm.expectRevert(abi.encodeWithSelector(FunctionDoesNotExist.selector, EXPORT_SELECTORS_ID));
        IERC8153(tenor).exportSelectors();
    }

    /// @notice The {Receive} facet is cut under the ZERO selector — the `msg.sig` an empty-calldata call
    ///         presents to the diamond's fallback. That single route is what lets the diamond hold the HBAR it
    ///         needs to pay for its own scheduled coupon calls.
    function test_cut_receiveFacetOwnsTheZeroSelector() public {
        (address diamond, FacetCut[] memory cuts) = _freshDiamondWithCuts();

        address receiveFacet;
        for (uint256 i; i < cuts.length; ++i) {
            if (cuts[i].functionSelectors.length == 1 && cuts[i].functionSelectors[0] == bytes4(0)) {
                receiveFacet = cuts[i].facetAddress;
            }
        }
        assertTrue(receiveFacet != address(0), "no facet in the recipe claims the zero selector");
        assertEq(IDiamondLoupe(diamond).facetAddress(bytes4(0)), receiveFacet, "zero selector not routed to Receive");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 ERC-165
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice FR7/§9.2 — a client discovers what the diamond is by asking it. Every module the recipe cuts
    ///         must advertise its interface id, and an id nothing implements must answer false, so the answer
    ///         carries information rather than optimism.
    function test_erc165_advertisesEveryModuleInterfaceItCut() public view {
        assertTrue(ERC165Facet(tenor).supportsInterface(type(ITenorMarket).interfaceId), "ITenorMarket flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(type(ITenorCoupon).interfaceId), "ITenorCoupon flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(type(IAccessControl).interfaceId), "IAccessControl flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(type(IHTSAdapter).interfaceId), "IHTSAdapter flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(type(IHSSAdapter).interfaceId), "IHSSAdapter flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(DIAMOND_LOUPE_ID), "IDiamondLoupe flag");
        assertTrue(ERC165Facet(tenor).supportsInterface(DIAMOND_CUT_ID), "IDiamondCut flag: the diamond is cuttable");
        assertTrue(IDiamondLoupe(tenor).facetAddress(ERC165_ID) != address(0), "supportsInterface must be routed");

        assertFalse(ERC165Facet(tenor).supportsInterface(0xdeadbeef), "a random id must not be claimed");
        assertFalse(ERC165Facet(tenor).supportsInterface(0xffffffff), "ERC-165 forbids claiming 0xffffffff");
    }

    /// @notice FIXED (was a contract finding). ERC-165 requires a contract implementing
    ///         `supportsInterface` to answer TRUE for `0x01ffc9a7`, and the diamond routes
    ///         `supportsInterface` but answers false: nothing in the init chain calls
    ///         `ERC165Lib.registerInterface()`, which is the only writer of that flag (diamond-lib's stock
    ///         `DiamondInit`/`ERC165Init` call it; `DiamondIntrospectionInit` registers only the loupe and cut
    ///         ids, and `TenorInit` registers only the two Tenor ids). A client that probes ERC-165 support
    ///         before trusting any other `supportsInterface` answer therefore reads the Tenor diamond as
    ///         non-introspectable. The fix is one line in `TenorInit.init`: `ERC165Lib.registerInterface()`.
    ///         Inherited rather than introduced — Lattice's own `RecipeGuards` only assert that `0x01ffc9a7`
    ///         is ROUTED, which it is: {test_erc165_advertisesEveryModuleInterfaceItCut} asserts the routing
    ///         and passes. Unskip this test to see the flag itself come back false.
    function test_erc165_standardInterfaceIdIsAdvertised() public view {
        assertTrue(ERC165Facet(tenor).supportsInterface(ERC165_ID), "ERC-165's own id must be advertised");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                              TENORINIT EFFECTS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice §8 — the diamond's configuration is whatever `TenorInit` was handed, and both modules must have
    ///         been seeded, not just one: the market's pinned security token and the coupon module's token are
    ///         separate storage writes in the same init, and a venue whose two halves disagree about the
    ///         instrument is not a venue.
    function test_init_storesTheConfigurationItWasPassed() public view {
        assertEq(market.securityToken(), address(atsToken), "market securityToken");
        assertEq(market.usdc(), usdc, "market usdc");
        assertEq(market.feeBps(), FEE_BPS, "feeBps");
        assertEq(market.maxDuration(), MAX_DURATION, "maxDuration");
        assertEq(coupon.couponToken(), address(atsToken), "coupon token");
        assertEq(coupon.couponToken(), market.securityToken(), "both modules must name the same instrument");
        assertEq(market.nextListingId(), 0, "the first listing must take id 0");
        assertEq(coupon.couponHolders().length, 0, "the coupon register starts empty");
    }

    /// @notice The fee cap is INCLUSIVE at construction: 100 bp is installable, and the value that comes back
    ///         out is the value that went in. Paired with the revert test below, this pins invariant 3's
    ///         `feeBps <= 100` at the one moment an admin-side setter cannot police.
    function test_init_appliesADistinctFeeAndDurationAtTheCap() public {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory data) =
            deployer.buildCuts(admin, issuer, usdc, address(atsToken), 100, 7 days);
        address diamond = _assembleRaw(cuts, init, data);

        assertEq(ITenorMarket(diamond).feeBps(), 100, "the 100 bp cap must be installable at init");
        assertEq(ITenorMarket(diamond).maxDuration(), 7 days, "maxDuration must be the value passed in");
    }

    /// @notice Initialisation is observable. `__TenorMarket_init` announces the fee and the duration it
    ///         installs, so an indexer built on events sees the diamond's opening configuration without having
    ///         to special-case deployment.
    function test_init_emitsTheFeeAndDurationItInstalls() public {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory data) =
            deployer.buildCuts(admin, issuer, usdc, address(atsToken), 25, 3 days);

        Tenor diamond = new Tenor();
        vm.expectEmit(address(diamond));
        emit ITenorMarket.FeeUpdated(25);
        vm.expectEmit(address(diamond));
        emit ITenorMarket.MaxDurationUpdated(3 days);
        diamond.initialize(cuts, init, data);
    }

    /// @notice Invariant 3 at construction: the 100 bp ceiling cannot be bypassed by the deployer. `setFeeBps`
    ///         enforces it for every later change, and this is the proof the initial value is held to the same
    ///         rule — the revert bubbles verbatim through `MultiInit` and the diamond's init delegatecall.
    function testRevert_init_feeAboveTheCapReverts() public {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory data) =
            deployer.buildCuts(admin, issuer, usdc, address(atsToken), 101, MAX_DURATION);

        Tenor diamond = new Tenor();
        vm.expectRevert(abi.encodeWithSelector(ITenorMarket.FeeTooHigh.selector, uint16(101)));
        diamond.initialize(cuts, init, data);
    }

    /// @notice Initialisation is ONE-SHOT. `Tenor.initialize` is first-caller-wins, so a second run — which
    ///         would re-grant roles and re-point the security token on a live venue — must be impossible for
    ///         anyone, the original deployer included.
    function testRevert_init_cannotBeRunTwiceThroughTheDiamond() public {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory data) =
            deployer.buildCuts(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);

        vm.expectRevert(InvalidInitialization.selector);
        Tenor(payable(tenor)).initialize(cuts, init, data);
    }

    /// @notice The other half of one-shot: `TenorInit.init` is not a facet. Its selector is deliberately absent
    ///         from the cut, so there is no route through which a caller could re-run the initializer even if
    ///         the `initializer` guard were ever relaxed.
    function testRevert_init_theInitSelectorIsNotRoutedOnTheDiamond() public {
        assertEq(IDiamondLoupe(tenor).facetAddress(TenorInit.init.selector), address(0), "init must not be cut");

        vm.expectRevert(abi.encodeWithSelector(FunctionDoesNotExist.selector, TenorInit.init.selector));
        TenorInit(tenor).init(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);
    }

    /// @notice And the initializer contract itself is inert. Called directly rather than delegatecalled inside
    ///         `Diamond.initialize`'s window, every `__X_init` it drives asserts `checkInitializing` and
    ///         refuses — so a stray `TenorInit` address on a block explorer is not an attack surface.
    function testRevert_init_directCallOnTheInitContractReverts() public {
        TenorInit init = new TenorInit();
        vm.expectRevert(NotInitializing.selector);
        init.init(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                  ROLES
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice §8 — `admin` holds `DEFAULT_ADMIN_ROLE` (which is also what gates pause, [DEV-5]) plus both HTS
    ///         roles: `HTS_MANAGER_ROLE` to associate USDC post-deploy, `HTS_OPERATOR_ROLE` because fee
    ///         withdrawal leaves through Lattice's HTS facet rather than a `withdrawFees` of our own [DEV-2].
    function test_roles_adminHoldsTheAdminAndBothHtsRoles() public view {
        assertTrue(IAccessControl(tenor).hasRole(bytes32(0), admin), "admin must hold DEFAULT_ADMIN_ROLE");
        assertTrue(IAccessControl(tenor).hasRole(HTS_MANAGER_ROLE, admin), "admin must hold HTS_MANAGER_ROLE");
        assertTrue(IAccessControl(tenor).hasRole(HTS_OPERATOR_ROLE, admin), "admin must hold HTS_OPERATOR_ROLE");
    }

    /// @notice §8 — `issuer` holds `ISSUER_ROLE` for the coupon levers and Lattice's `HSS_SCHEDULER_ROLE`,
    ///         which `scheduleSelfCall` demands of whoever books the payment [DEV-4]. Missing the second one
    ///         would leave an issuer able to fund a coupon and unable to schedule it.
    function test_roles_issuerHoldsTheIssuerAndSchedulerRoles() public view {
        assertTrue(IAccessControl(tenor).hasRole(ISSUER_ROLE, issuer), "issuer must hold ISSUER_ROLE");
        assertTrue(IAccessControl(tenor).hasRole(HSS_SCHEDULER_ROLE, issuer), "issuer must hold HSS_SCHEDULER_ROLE");
    }

    /// @notice The SEPARATION, not just the grants. `issuer` must not be able to upgrade, pause or re-price the
    ///         venue, and `admin` must not be able to move coupon money — the whole point of two keys is that
    ///         compromising one does not yield the other. Unrelated accounts hold nothing at all.
    function test_roles_theAdminAndIssuerAuthoritiesAreDisjoint() public view {
        assertFalse(IAccessControl(tenor).hasRole(bytes32(0), issuer), "issuer must NOT hold DEFAULT_ADMIN_ROLE");
        assertFalse(IAccessControl(tenor).hasRole(HTS_MANAGER_ROLE, issuer), "issuer must NOT hold HTS_MANAGER_ROLE");
        assertFalse(IAccessControl(tenor).hasRole(HTS_OPERATOR_ROLE, issuer), "issuer must NOT hold HTS_OPERATOR_ROLE");

        assertFalse(IAccessControl(tenor).hasRole(ISSUER_ROLE, admin), "admin must NOT hold ISSUER_ROLE");
        assertFalse(IAccessControl(tenor).hasRole(HSS_SCHEDULER_ROLE, admin), "admin must NOT hold HSS_SCHEDULER_ROLE");

        assertFalse(IAccessControl(tenor).hasRole(bytes32(0), bob), "a trader must hold no admin authority");
        assertFalse(IAccessControl(tenor).hasRole(ISSUER_ROLE, bob), "a trader must hold no issuer authority");
    }

    /// @notice [DEV-5] — there is no `PAUSER_ROLE` in this diamond. SPEC v3 asked for one; Lattice's
    ///         `PausableLib` gates pause on `DEFAULT_ADMIN_ROLE` instead, so granting a `PAUSER_ROLE` would
    ///         have created a role that looks authoritative and controls nothing. Nobody holds it, and the
    ///         admin can pause regardless.
    function test_roles_noPauserRoleIsGrantedBecauseNoneExists() public {
        assertFalse(IAccessControl(tenor).hasRole(ABSENT_PAUSER_ROLE, admin), "admin must not hold a phantom role");
        assertFalse(IAccessControl(tenor).hasRole(ABSENT_PAUSER_ROLE, issuer), "issuer must not hold a phantom role");

        vm.prank(admin);
        IPausable(tenor).pause();
        assertTrue(IPausable(tenor).paused(), "DEFAULT_ADMIN_ROLE alone must be enough to pause");
    }

    /// @notice Separation, proved behaviourally rather than by reading the role map: the issuer cannot reach an
    ///         admin-only lever, and the error names the role it lacked.
    function testRevert_roles_issuerCannotUseAnAdminLever() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, issuer, bytes32(0))
        );
        market.setFeeBps(50);
    }

    /// @notice The mirror image: `DEFAULT_ADMIN_ROLE` is not a superset of `ISSUER_ROLE` at the call site. The
    ///         admin can GRANT itself the role — that is what an admin is — but it does not hold it implicitly,
    ///         which is what keeps the coupon path a separate key.
    function testRevert_roles_adminCannotUseAnIssuerLever() public {
        address[] memory holders = new address[](1);
        holders[0] = alice;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, ISSUER_ROLE)
        );
        coupon.registerHolders(holders);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                               PAUSE WIRING
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The Pausable facet is wired to the diamond's access control, both ways: the admin can pause and
    ///         unpause, the flag is readable through the same diamond, and each transition is announced with
    ///         the account responsible.
    function test_pause_adminCanPauseAndUnpause() public {
        assertFalse(IPausable(tenor).paused(), "a freshly deployed venue must be live");

        vm.expectEmit(tenor);
        emit IPausable.Paused(admin);
        vm.prank(admin);
        IPausable(tenor).pause();
        assertTrue(IPausable(tenor).paused(), "pause must take effect");

        vm.expectEmit(tenor);
        emit IPausable.Unpaused(admin);
        vm.prank(admin);
        IPausable(tenor).unpause();
        assertFalse(IPausable(tenor).paused(), "unpause must take effect");
    }

    /// @notice Pausing is only worth anything if the market facet reads the same flag the Pausable facet
    ///         writes. Two facets, one ERC-7201 slot: `list` must refuse while paused, and resume afterwards.
    function test_pause_pausingTheDiamondBlocksListing() public {
        _enableSelling(alice, 10 * ONE_TOKEN);

        vm.prank(admin);
        IPausable(tenor).pause();

        vm.prank(alice);
        vm.expectRevert(IPausable.EnforcedPause.selector);
        market.list(address(atsToken), bytes32(uint256(1)), 10 * ONE_TOKEN, 98e6, uint64(block.timestamp + 1 days));

        vm.prank(admin);
        IPausable(tenor).unpause();

        vm.prank(alice);
        uint256 id =
            market.list(address(atsToken), bytes32(uint256(1)), 10 * ONE_TOKEN, 98e6, uint64(block.timestamp + 1 days));
        assertTrue(market.getListing(id).active, "listing must be possible again once unpaused");
    }

    /// @notice [DEV-5] again, from the other side: pause is `DEFAULT_ADMIN_ROLE`-gated and nothing else opens
    ///         it. A trader cannot halt the venue.
    function testRevert_pause_nonAdminCannotPause() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, bytes32(0))
        );
        IPausable(tenor).pause();
    }

    /// @notice And cannot lift a halt either — otherwise an admin pause would be advisory.
    function testRevert_pause_nonAdminCannotUnpause() public {
        vm.prank(admin);
        IPausable(tenor).pause();

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, bytes32(0))
        );
        IPausable(tenor).unpause();
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                         OWNER-GATED CREATION PATH
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice §8 — production deploys through `DeployTenor._assembleTenor`: create a {Tenor}, which records its
    ///         creator as owner, then initialize it as that owner. This asserts the diamond it produces is a
    ///         configured, role-seeded `Tenor` owned by the account that created it.
    function test_assemble_producesAWorkingTenorOwnedByItsCreator() public {
        DeployTenorHarness harness = new DeployTenorHarness();
        address diamond = _assembleThroughScript(harness);

        assertEq(diamond.code, type(Tenor).runtimeCode, "the script must deploy Tenor");
        assertEq(_ownerOf(diamond), address(harness), "the creator must be the owner");
        assertEq(ITenorMarket(diamond).securityToken(), address(atsToken), "securityToken through the script path");
        assertEq(ITenorMarket(diamond).usdc(), usdc, "usdc through the script path");
        assertTrue(IAccessControl(diamond).hasRole(bytes32(0), admin), "admin role through the script path");
        assertTrue(IAccessControl(diamond).hasRole(ISSUER_ROLE, issuer), "issuer role through the script path");
        assertEq(IDiamondLoupe(diamond).facetAddresses().length, EXPECTED_FACETS, "ten facets via the script path");
    }

    /// @notice Creation is observable: the constructor announces its owner with ERC-173's
    ///         `OwnershipTransferred(0, creator)` and records it in `OwnableLib`'s slot.
    function test_owner_creationRecordsAndAnnouncesTheCreator() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(predicted);
        emit OwnableLib.OwnershipTransferred(address(0), address(this));
        Tenor diamond = new Tenor();

        assertEq(address(diamond), predicted, "the diamond must be at the CREATE address");
        assertEq(_ownerOf(address(diamond)), address(this), "the owner slot must hold the creator");
    }

    /// @notice The gap between the two deploy transactions is closed: between the CREATE and `initialize`, no
    ///         other account — not even the admin or issuer the recipe is about to empower — can install a cut.
    ///         The owner's own initialization still goes through afterwards.
    function test_owner_aHijackBetweenCreationAndInitializationFails() public {
        (FacetCut[] memory cuts, address init, bytes memory data) = _recipe();
        Tenor diamond = new Tenor();

        address[3] memory intruders = [bob, admin, issuer];
        for (uint256 i; i < intruders.length; ++i) {
            vm.prank(intruders[i]);
            vm.expectRevert(OwnableLib.Unauthorized.selector);
            diamond.initialize(cuts, init, data);
        }

        diamond.initialize(cuts, init, data);
        assertEq(IDiamondLoupe(address(diamond)).facetAddresses().length, EXPECTED_FACETS, "the owner's cut applies");
        assertTrue(IAccessControl(address(diamond)).hasRole(bytes32(0), admin), "the owner's recipe seeds the admin");
    }

    /// @notice Any caller but the owner is refused.
    function testFuzz_owner_nonOwnersCannotInitialize(address caller) public {
        Tenor diamond = new Tenor();
        vm.assume(caller != address(this));

        vm.prank(caller);
        vm.expectRevert(OwnableLib.Unauthorized.selector);
        diamond.initialize(new FacetCut[](0), address(0), "");
    }

    /// @notice The order `scripts/deploy-tenor.ts`'s post-deploy gate relies on: the owner check runs BEFORE Lattice's
    ///         one-time `initializer` guard. On an initialized diamond a stranger is still refused as a stranger
    ///         (`Unauthorized`); only the owner reaches the guard (`InvalidInitialization`).
    function testRevert_owner_theOwnerCheckRunsBeforeTheInitializerGuard() public {
        vm.prank(bob);
        vm.expectRevert(OwnableLib.Unauthorized.selector);
        Tenor(payable(tenor)).initialize(new FacetCut[](0), address(0), "");

        vm.expectRevert(InvalidInitialization.selector);
        Tenor(payable(tenor)).initialize(new FacetCut[](0), address(0), "");
    }

    /// @notice §8 — `DeployTenor.run` itself, end to end, including its `vm.startBroadcast()`. It reads no
    ///         environment, so it runs here as written and must hand back a configured, role-seeded {Tenor} that
    ///         is owned by the broadcaster, initialized, and not yet associated (association is
    ///         `scripts/deploy-tenor.ts`'s job).
    function test_run_deploysAConfiguredTenorOwnedByTheBroadcaster() public {
        address diamond = new DeployTenor().run(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);

        assertEq(diamond.code, type(Tenor).runtimeCode, "run must deploy Tenor");
        assertEq(_ownerOf(diamond), DEFAULT_SENDER, "the broadcaster must own the diamond");
        assertEq(IDiamondLoupe(diamond).facetAddresses().length, EXPECTED_FACETS, "ten facets through run()");
        assertEq(ITenorMarket(diamond).securityToken(), address(atsToken), "securityToken through run()");
        assertTrue(IAccessControl(diamond).hasRole(bytes32(0), admin), "admin role through run()");
        assertTrue(IAccessControl(diamond).hasRole(ISSUER_ROLE, issuer), "issuer role through run()");
        assertFalse(IHTSAdapter(diamond).isAssociated(usdc), "association is deploy-tenor.ts's job, not run's");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                         POST-DEPLOY: USDC ASSOCIATION
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice An HTS account cannot receive a token it is not associated with, and the diamond receives USDC
    ///         (coupon funding, and fees when `feeBps > 0`). A deployment that skips the association produces a
    ///         venue where `fundCoupon` fails — so the finished article must be associated.
    function test_association_theDeployedDiamondIsAssociatedWithUsdc() public view {
        assertTrue(hts.associated(tenor, usdc), "the diamond must end up associated with USDC");
    }

    /// @notice [DEV-3], the reason `deploy-tenor.ts` sends a SECOND transaction. `TenorInit` cannot associate
    ///         USDC itself: `HTSAdapterLib.associateToken` checks `HTS_MANAGER_ROLE` against `msg.sender`, and
    ///         inside the init delegatecall that is whoever called `initialize` — here this test contract, not the
    ///         `admin` granted a line earlier — and on Hedera it calls `0x167`, which forge cannot execute. This
    ///         proves the gap exists — a freshly initialised diamond is UNASSOCIATED — and that the post-deploy
    ///         admin transaction is what closes it.
    function test_association_initAloneDoesNotAssociateTheDiamond() public {
        address diamond = _assembleRecipe();

        assertFalse(hts.associated(diamond, usdc), "TenorInit must not have associated USDC by itself");

        vm.prank(admin);
        IHTSAdapter(diamond).associateToken(usdc);
        assertTrue(hts.associated(diamond, usdc), "the post-deploy admin transaction must associate USDC");
    }

    /// @notice The association is the admin's transaction and nobody else's: `associateToken` is
    ///         `HTS_MANAGER_ROLE`-gated on the Lattice facet, which is also why it could never have run inside
    ///         the init frame.
    function testRevert_association_aNonManagerCannotAssociateTheDiamond() public {
        address diamond = _assembleRecipe();

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, HTS_MANAGER_ROLE)
        );
        IHTSAdapter(diamond).associateToken(usdc);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                           POST-DEPLOY: HBAR SEED
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice [DEV-4] — `scheduleSelfCall` makes the DIAMOND the schedule's payer, so the diamond must be able
    ///         to hold HBAR or a booked coupon is never fired. The {Receive} facet is what makes a plain
    ///         transfer land, and the balance must be readable afterwards so an operator can top it up.
    function test_hbarSeed_aPlainTransferToTheDiamondLands() public {
        vm.deal(admin, 5 ether);

        vm.prank(admin);
        (bool ok,) = tenor.call{value: 2 ether}("");
        assertTrue(ok, "a plain HBAR transfer to the diamond must succeed");
        assertEq(tenor.balance, 2 ether, "the seed must be readable on the diamond");

        vm.prank(admin);
        (ok,) = tenor.call{value: 1 ether}("");
        assertTrue(ok, "a top-up must succeed too");
        assertEq(tenor.balance, 3 ether, "the balance must accumulate");
    }

    /// @notice The {Receive} facet is load-bearing, not decorative: `Tenor` (like `Lattice`) declares no `receive()`,
    ///         so a diamond cut without that facet REJECTS the HBAR seed and the deploy script's second
    ///         post-deploy transaction would revert. This is the failure the recipe's `cuts[4]` prevents.
    function test_hbarSeed_withoutTheReceiveFacetTheTransferIsRejected() public {
        address diamond = _assembleRecipeWithoutReceive();
        vm.deal(admin, 1 ether);

        vm.prank(admin);
        (bool ok, bytes memory ret) = diamond.call{value: 1 ether}("");
        assertFalse(ok, "a diamond without the Receive facet must refuse a plain transfer");
        assertEq(
            ret,
            abi.encodeWithSelector(FunctionDoesNotExist.selector, bytes4(0)),
            "the refusal must be the fallback's unrouted-zero-selector revert"
        );
        assertEq(diamond.balance, 0, "no HBAR may land");
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 HELPERS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev The production recipe at the harness's parameters. A fresh {DeployTenor} per call, so each recipe
    ///      gets its own facet instances and one test's diamond can never share a facet with another's.
    function _recipe() internal returns (FacetCut[] memory cuts, address init, bytes memory data) {
        DeployTenor deployer = new DeployTenor();
        return deployer.buildCuts(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);
    }

    /// @dev Create a {Tenor} as this test contract, its owner, then initialize it. Used wherever a test must see a
    ///      diamond BEFORE either post-deploy transaction has touched it.
    function _assembleRaw(FacetCut[] memory cuts, address init, bytes memory data) internal returns (address) {
        Tenor diamond = new Tenor();
        diamond.initialize(cuts, init, data);
        return address(diamond);
    }

    /// @dev A freshly initialised, un-associated, un-funded Tenor diamond.
    function _assembleRecipe() internal returns (address diamond) {
        (FacetCut[] memory cuts, address init, bytes memory data) = _recipe();
        diamond = _assembleRaw(cuts, init, data);
    }

    /// @dev A diamond and the cuts it was assembled from, so a test can check routing against the recipe.
    function _freshDiamondWithCuts() internal returns (address diamond, FacetCut[] memory cuts) {
        address init;
        bytes memory data;
        (cuts, init, data) = _recipe();
        diamond = _assembleRaw(cuts, init, data);
    }

    /// @dev The production recipe MINUS the {Receive} facet, identified by the zero selector it exports rather
    ///      than by its index, so the test keeps meaning if the recipe is reordered.
    function _assembleRecipeWithoutReceive() internal returns (address diamond) {
        (FacetCut[] memory cuts, address init, bytes memory data) = _recipe();
        FacetCut[] memory trimmed = new FacetCut[](cuts.length - 1);
        uint256 n;
        for (uint256 i; i < cuts.length; ++i) {
            if (cuts[i].functionSelectors.length == 1 && cuts[i].functionSelectors[0] == bytes4(0)) continue;
            trimmed[n++] = cuts[i];
        }
        assertEq(n, trimmed.length, "exactly one facet must claim the zero selector");
        diamond = _assembleRaw(trimmed, init, data);
    }

    /// @dev One diamond through `DeployTenor._assembleTenor`, the path {DeployTenor-run} broadcasts; the harness
    ///      creates it, so the harness owns it.
    function _assembleThroughScript(DeployTenorHarness harness) internal returns (address diamond) {
        (FacetCut[] memory cuts, address init, bytes memory data) =
            harness.buildCuts(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);
        diamond = harness.assembleTenor(cuts, init, data);
    }

    /// @dev The owner `OwnableLib` recorded, read from its slot: the diamond deliberately exposes no `owner()`.
    function _ownerOf(address diamond) internal view returns (address) {
        return address(uint160(uint256(vm.load(diamond, OwnableLib._OWNER_SLOT))));
    }

    /// @dev Decodes a facet's ERC-8153 export blob into selectors, validating its shape on the way. Read from
    ///      the FACET, not from the cut, so the assertion is about what the facet advertises.
    function _exportedSelectors(address facet) internal pure returns (bytes4[] memory selectors) {
        bytes memory packed = IERC8153(facet).exportSelectors();
        assertTrue(packed.length != 0, "a facet exported no selectors");
        assertEq(packed.length % 4, 0, "export blob is not a whole number of selectors");

        selectors = new bytes4[](packed.length / 4);
        for (uint256 i; i < selectors.length; ++i) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(add(packed, 0x20), mul(i, 4)))
            }
            selectors[i] = selector;
        }
    }

    /// @dev Every selector the recipe cuts, in one array.
    function _flattenSelectors(FacetCut[] memory cuts) internal pure returns (bytes4[] memory all) {
        uint256 total;
        for (uint256 i; i < cuts.length; ++i) {
            total += cuts[i].functionSelectors.length;
        }
        all = new bytes4[](total);
        uint256 n;
        for (uint256 i; i < cuts.length; ++i) {
            for (uint256 j; j < cuts[i].functionSelectors.length; ++j) {
                all[n++] = cuts[i].functionSelectors[j];
            }
        }
    }

    /// @dev Set equality in BOTH directions: a missing selector and an extra one are different bugs and both
    ///      must fail.
    function _assertSameSelectorSet(bytes4[] memory left, bytes4[] memory right, string memory what) internal pure {
        assertEq(left.length, right.length, string.concat(what, ": selector count"));
        for (uint256 i; i < left.length; ++i) {
            assertTrue(_contains(right, left[i]), string.concat(what, ": unexpected selector"));
        }
        for (uint256 i; i < right.length; ++i) {
            assertTrue(_contains(left, right[i]), string.concat(what, ": missing selector"));
        }
    }

    /// @dev True when `set` holds `selector`.
    function _contains(bytes4[] memory set, bytes4 selector) internal pure returns (bool) {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == selector) return true;
        }
        return false;
    }

    /// @dev Every function `ITenorMarket` declares — the authoritative list the market facet's export is
    ///      measured against.
    function _marketSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](13);
        selectors[0] = ITenorMarket.list.selector;
        selectors[1] = ITenorMarket.fill.selector;
        selectors[2] = ITenorMarket.cancel.selector;
        selectors[3] = ITenorMarket.expire.selector;
        selectors[4] = ITenorMarket.setFeeBps.selector;
        selectors[5] = ITenorMarket.setMaxDuration.selector;
        selectors[6] = ITenorMarket.getListing.selector;
        selectors[7] = ITenorMarket.quote.selector;
        selectors[8] = ITenorMarket.nextListingId.selector;
        selectors[9] = ITenorMarket.usdc.selector;
        selectors[10] = ITenorMarket.feeBps.selector;
        selectors[11] = ITenorMarket.maxDuration.selector;
        selectors[12] = ITenorMarket.securityToken.selector;
    }

    /// @dev Every function `ITenorCoupon` declares, PLUS the non-interface `scheduleCouponSelfCall`
    ///      trampoline, which must be cut or scheduling breaks at runtime.
    function _couponSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](13);
        selectors[0] = ITenorCoupon.registerHolders.selector;
        selectors[1] = ITenorCoupon.fundCoupon.selector;
        selectors[2] = ITenorCoupon.scheduleCoupon.selector;
        selectors[3] = ITenorCoupon.cancelSchedule.selector;
        selectors[4] = ITenorCoupon.withdrawCouponSurplus.selector;
        selectors[5] = ITenorCoupon.payCoupon.selector;
        selectors[6] = ITenorCoupon.getCoupon.selector;
        selectors[7] = ITenorCoupon.couponScheduleAddress.selector;
        selectors[8] = ITenorCoupon.couponHolders.selector;
        selectors[9] = ITenorCoupon.couponRequirement.selector;
        selectors[10] = ITenorCoupon.couponEntitlement.selector;
        selectors[11] = ITenorCoupon.couponToken.selector;
        selectors[12] = ITenorCouponSchedule.scheduleCouponSelfCall.selector;
    }
}
