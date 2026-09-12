// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IHederaTokenService} from "@lattice/interfaces/external/hedera/IHederaTokenService.sol";
import {IHTSAdapter} from "@lattice/interfaces/tokens/IHTSAdapter.sol";
import {FacetCut} from "@diamond/libraries/DiamondLib.sol";
import {Lattice} from "@lattice/Lattice.sol";
import {MockHederaTokenService} from "@lattice-test/mocks/hedera/MockHederaTokenService.sol";
import {Test} from "forge-std/Test.sol";
import {DeployTenor} from "../script/DeployTenor.s.sol";
import {ITenorCoupon} from "../src/interfaces/ITenorCoupon.sol";
import {ITenorMarket} from "../src/interfaces/ITenorMarket.sol";
import {MockATSToken} from "./mocks/MockATSToken.sol";
import {MockHederaScheduleService} from "./mocks/MockHederaScheduleService.sol";
import {TenorHTS} from "../src/TenorHTS.sol";
import {HSS_SYSTEM_CONTRACT} from "@lattice/oracles/hedera/HSSAdapterLib.sol";

/// @title TenorTestBase
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Harness for Tenor's tests: a REAL assembled diamond, the two Hedera system contracts etched
///         as mocks, an ATS security token, and a funded HTS USDC.
/// @dev Two things about this setup are worth understanding before writing a test against it.
///
///      **The system contracts are etched, not deployed.** `0x167` and `0x16b` have no bytecode on a
///      fork, so `vm.etch` puts a mock there. An etched contract starts with EMPTY STORAGE — both mocks
///      are written for that, and it is why USDC has to be created through the mock at runtime rather
///      than configured in a constructor.
///
///      **USDC balances are not free.** Lattice's HTS mock faithfully enforces association AND balance
///      AND allowance, and it exposes only `seedAllowance` — there is no balance-seeding back door. So
///      the base creates the token through `createFungibleToken` (which credits `t.treasury`) and then
///      moves balance out with `transferToken`, which requires `sender == msg.sender`. {_fundUsdc}
///      wraps that. Give an account USDC with {_fundUsdc}, never by writing storage.
abstract contract TenorTestBase is Test {
    /// @dev The Hedera Token Service address. Mirrors `TenorHTS.HTS_SYSTEM_CONTRACT`.
    address internal constant HTS = TenorHTS.HTS_SYSTEM_CONTRACT;
    /// @dev The Hedera Schedule Service address, from Lattice.
    address internal constant HSS = HSS_SYSTEM_CONTRACT;

    /// @notice The assembled Tenor diamond.
    address internal tenor;
    /// @notice Typed handles on the diamond; every call dispatches through its `delegatecall` frame.
    ITenorMarket internal market;
    ITenorCoupon internal coupon;

    /// @notice The ATS security token being traded.
    MockATSToken internal atsToken;
    /// @notice The HTS settlement token, created inside the etched mock.
    address internal usdc;

    /// @notice The etched mocks, typed for their test helpers (`force`, `seedAllowance`, `fireSchedule`).
    MockHederaTokenService internal hts;
    MockHederaScheduleService internal hss;

    // --- actors ---------------------------------------------------------------------------------
    address internal admin = makeAddr("admin");
    address internal issuer = makeAddr("issuer");
    /// @notice Holds the whole USDC supply; {_fundUsdc} distributes from here.
    address internal treasury = makeAddr("usdcTreasury");
    /// @notice Verified seller.
    address internal alice = makeAddr("alice");
    /// @notice Verified buyer.
    address internal bob = makeAddr("bob");
    /// @notice UNVERIFIED buyer — no KYC on the ATS token, on purpose.
    address internal carol = makeAddr("carol");

    uint8 internal constant TOKEN_DECIMALS = 6;
    /// @dev Atomic units per whole security token; the divisor in `cost` and coupon entitlement.
    uint256 internal constant ONE_TOKEN = 10 ** uint256(TOKEN_DECIMALS);
    uint16 internal constant FEE_BPS = 0;
    uint64 internal constant MAX_DURATION = 30 days;

    function setUp() public virtual {
        // System contracts first: the diamond's init and the HTS adapter both call into them.
        vm.etch(HTS, address(new MockHederaTokenService()).code);
        vm.etch(HSS, address(new MockHederaScheduleService()).code);
        hts = MockHederaTokenService(payable(HTS));
        hss = MockHederaScheduleService(payable(HSS));
        vm.label(HTS, "HTS(0x167)");
        vm.label(HSS, "HSS(0x16b)");

        atsToken = new MockATSToken("Tenor Green Note 2027", "TGN27", TOKEN_DECIMALS);
        usdc = _createUsdc();

        tenor = _deployTenor();
        market = ITenorMarket(tenor);
        coupon = ITenorCoupon(tenor);

        // Every party that touches USDC must be associated, the diamond included — it receives fees
        // and coupon funding.
        _associate(tenor);
        _associate(alice);
        _associate(bob);
        _associate(carol);
        _associate(issuer);

        // KYC mirrors the demo: A and B verified, C deliberately not.
        atsToken.setKyc(alice, true);
        atsToken.setKyc(bob, true);
        atsToken.setKyc(issuer, true);
        // The diamond is never a holder — it is only the hold's escrow — so it needs no KYC. Leaving
        // it unverified is a live check that no code path tries to move tokens through it.
    }

    /// @dev Assembles the production recipe against a real {Lattice} diamond, exactly as Lattice's own
    ///      facet tests do. Deliberately NOT through `LatticeFactory`: tests must not read the
    ///      environment, or a developer's `.env` could change what they deploy. `Deploy.t.sol` covers
    ///      the factory path separately.
    function _deployTenor() internal returns (address diamond_) {
        DeployTenor deployer = new DeployTenor();
        (FacetCut[] memory cuts, address init, bytes memory initCalldata) =
            deployer.buildCuts(admin, issuer, usdc, address(atsToken), FEE_BPS, MAX_DURATION);

        Lattice d = new Lattice();
        d.initialize(cuts, init, initCalldata);
        diamond_ = address(d);

        // `TenorInit` cannot associate USDC itself — inside the init delegatecall `msg.sender` is the
        // deployer, not `admin`, and `associateToken` is HTS_MANAGER_ROLE-gated. Production does this
        // as a post-deploy transaction; so does the harness.
        vm.prank(admin);
        IHTSAdapter(diamond_).associateToken(usdc);
    }

    /// @dev Creates the HTS settlement token inside the etched mock, with `treasury` holding all of it.
    ///      `createFungibleToken` rejects a zero-value call, hence the `vm.deal`.
    function _createUsdc() internal returns (address token) {
        IHederaTokenService.HederaToken memory t;
        t.name = "Tenor Demo USDC";
        t.symbol = "USDC";
        t.treasury = treasury;
        t.tokenKeys = new IHederaTokenService.TokenKey[](0);

        vm.deal(treasury, 1 ether);
        vm.prank(treasury);
        (int64 code, address created) = IHederaTokenService(HTS).createFungibleToken{value: 1}(
            t, int64(uint64(1_000_000_000 * 10 ** 6)), int32(uint32(6))
        );
        assertEq(code, int64(22), "USDC create failed");
        token = created;
        vm.label(token, "USDC");
    }

    /// @dev Associates `account` with USDC. Association is a precondition of every HTS transfer, in the
    ///      mock and on the real network alike.
    function _associate(address account) internal {
        int64 code = IHederaTokenService(HTS).associateToken(account, usdc);
        // 194 == TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT; harmless when a test re-associates.
        assertTrue(code == int64(22) || code == int64(194), "associate failed");
    }

    /// @dev Gives `account` USDC out of the treasury's balance.
    function _fundUsdc(address account, uint256 amount) internal {
        vm.prank(treasury);
        int64 code = IHederaTokenService(HTS).transferToken(usdc, treasury, account, int64(uint64(amount)));
        assertEq(code, int64(22), "USDC funding failed");
    }

    /// @dev The USDC allowance `owner` grants the diamond — what `fill` and `fundCoupon` spend.
    function _approveUsdc(address owner, uint256 amount) internal {
        hts.seedAllowance(usdc, owner, tenor, amount);
    }

    /// @dev Mints security tokens to `holder` and approves the diamond for `amount` — the seller's
    ///      one-time "enable selling" step, which bounds what a listing may reserve.
    function _enableSelling(address holder, uint256 amount) internal {
        atsToken.mint(holder, amount);
        vm.prank(holder);
        atsToken.approve(tenor, amount);
    }
}
