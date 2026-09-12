# Tenor — Engineering Specification (v4, annotated)

**A compliance-native secondary market for Hedera ATS security tokens, built as a Lattice EIP-2535 diamond with Hedera system-contract facets.**

Event: ETHOnline 2026 · Track: Start Fresh · Partner prizes: Hedera (Tokenization of Anything), Privy (Best financial flow)

Companion documents: `docs/DESIGN.md` (UX flows, screens, components, copy) · **`docs/GROUND-TRUTH.md` (verified external APIs)**.

> ### ⚠️ Read `docs/GROUND-TRUTH.md` first
>
> This document is the v4 design intent, preserved as written. Its §5.3 (Lattice HTS/HSS surface) was
> written from memory and **does not match the pinned branch** — code written against it does not
> compile. §5.1 (ATS holds) was checked against the package and **is accurate**.
>
> Deviations forced by the real APIs are marked **[DEV-n]** inline below and explained in full in
> `GROUND-TRUTH.md`:
>
> | | Deviation |
> |---|---|
> | **DEV-1** | Permissionless USDC legs call `0x167` directly via `src/TenorHTS.sol`, not Lattice's role-gated `HTSAdapterLib`. Lattice's HTS facet keeps the admin paths. |
> | **DEV-2** | `withdrawFees` is removed from `ITenorMarket`; fees leave via `HTSAdapter.transferToken` under `HTS_OPERATOR_ROLE`. |
> | **DEV-3** | USDC self-association moves out of `TenorInit` into a post-deploy admin transaction. |
> | **DEV-4** | Coupons use `HSSAdapterLib.scheduleSelfCall` with a nonced job id; `scheduleAddress` is dropped from `Coupon` storage and read from `scheduleOf(jobId)`. |
> | **DEV-5** | No `PAUSER_ROLE`. Lattice's `PausableLib` gates pause/unpause on `DEFAULT_ADMIN_ROLE`, and Tenor cuts that facet as-is. |
> | **DEV-6** | `Listing` caches `tokenDecimals` at listing time, so `quote`/`fill` need no external `decimals()` call. Pricing semantics are unchanged. |
> | **DEV-7** | No `via_ir`. SPEC §4's "via_ir = true to match Lattice" is wrong; Lattice's default profile sets none. |

---

## 1. Goals and non-goals

### Goals
1. Let verified investors trade ATS-issued bond tokens peer-to-peer with atomic delivery-versus-payment in USDC, while every ATS compliance rule (KYC, allow/block lists, freeze, pause) is enforced on each fill by the token itself.
2. Automate bond coupon payments through Hedera Scheduled Transactions.
3. Ship the on-chain component as a single EIP-2535 diamond composed from Lattice modules, including new reusable facets for the Hedera Token Service (HTS) and Hedera Schedule Service (HSS).
4. Provide a production-quality web client with passkey login, embedded wallets (Privy), and a transaction UX in which no user is ever asked to sign a transaction that will fail.
5. Make testnet onboarding self-serve: in-app HBAR and demo-USDC drips.

### Non-goals
- Order matching, bids, or price-time priority (sell listings + taker fills only).
- Price oracles, NAV, or HBAR-denominated pricing.
- Custody of security tokens by the market; custody of USDC beyond coupon funding and optional fees.
- Issuing securities or granting KYC (ATS does both). Freeze and pause actions stay in ATS.
- Mainnet deployment.

---

## 2. Requirements

### 2.1 Event requirements
| Requirement | Detail |
|---|---|
| Deadline | Sunday 13 Sep 2026, 12:00 EDT (17:00 WAT). Internal freeze 14:00 WAT. |
| Start Fresh | All project code authored after 4 Sep 2026. Public libraries are permitted and must be disclosed: Lattice (MIT, pre-existing) as a Forge dependency; Lattice's HTS/HSS modules authored during the event (commit links in README); ATS as a public open-source kit. |
| Hedera — qualification | Use ATS (SDK, contracts, web app, or a combination) to issue or manage a tokenized asset; deploy and demo on Hedera testnet; public repo; contracts verified on HashScan; demo video ≤ 5 min showing issuance, configuration, and at least one lifecycle operation. |
| Hedera — extra points targeted | Secondary market for ATS assets; compliance controls exercised (KYC grants, freeze, pause, transfer restrictions); Scheduled Transactions for coupon payments. |
| Privy — qualification | Privy is core to the product; at least one Privy wallet created/used; at least one functional financial flow via a generally-available feature (fill signed by the embedded wallet); README explains the UX benefit. |
| Video | 2–4 minutes, ≥720p, human narration, no phone recording. |
| AI tools | README section naming the tools and what they produced; this spec, `DESIGN.md`, and all prompt/plan files committed to this repository. |
| Version control | Granular commits throughout the event, in both repositories. |

### 2.2 Functional requirements
- **FR1** A seller enables selling once (ERC-20 approval of the bond token to the diamond), then creates each listing in a single transaction: the diamond reserves the tokens through an ATS hold with itself as escrow and records the listing atomically.
- **FR2** A buyer fills all or part of a listing; USDC moves buyer → seller and tokens move via hold execution in one transaction; any ATS compliance failure reverts the whole fill.
- **FR3** A seller cancels an active listing before expiry in one transaction; remaining tokens are released and the seller's approval is restored by the token.
- **FR4** The issuer funds a coupon and schedules its payment; payment executes at the scheduled time with no manual action.
- **FR5** The client simulates every write before offering it, gates primary actions on readiness, decodes all reverts to plain language, and links every transaction to HashScan.
- **FR6** New wallets can obtain test HBAR and demo USDC from inside the app on testnet.
- **FR7** Diamond facets are enumerable via the loupe and displayed in the client as verified contracts.

### 2.3 Quality requirements
- Every external function has NatSpec; errors are custom errors; events cover every state transition.
- `forge fmt`, `forge build`, `forge test` clean in CI; invariants in §6.5 covered by tests.
- No function of the diamond can move a security token to or from the diamond itself.
- All Hedera system-contract calls check the returned response code and revert on non-success.
- The client never presents a primary action whose simulation fails.

---

## 3. Architecture

```
  Issuer (ATS web app / SDK scripts)                      Investors (Privy embedded wallets, passkey login)
        │ issue · grant KYC · mint · fund & schedule coupons         │ enable selling · list · approve USDC · fill · cancel
        ▼                                                            ▼
 ┌────────────────────────────────┐  createHoldFrom / executeHold  ┌────────────────────────────────────────┐
 │ ATS security token             │◄─────────────────────────────►│ TenorDiamond  (EIP-2535 via Lattice)    │
 │ diamond · ERC-1400 / ERC-3643  │        escrow = diamond        │  DiamondCut · Loupe · ERC165            │
 │ Hold · KYC · ControlList       │                                │  AccessControl · Pausable               │
 │ Pause · Freeze                 │                                │  TenorMarket · TenorCoupon              │
 └────────────────────────────────┘                                │  HTSAdapter ──► 0x167 Token Service     │
                                                                   │  HSSAdapter ──► 0x16b Schedule Service  │
                                                                   └────────────────────────────────────────┘
                                                                          │ transferFrom(buyer → seller)   │ scheduleCall(payCoupon)
                                                                          ▼                                ▼
                                                                    USDC (HTS token)              Executed by the network at expiry

  Web client (Next.js on Vercel) ── reads chain + mirror node ── one serverless route: POST /api/faucet (testnet only)
```

Design properties
- **No token custody.** Listed tokens stay in the seller's balance under an ATS hold; the diamond is only the hold's escrow. The diamond therefore needs no KYC status.
- **Compliance by construction.** `executeHoldByPartition` enforces KYC on both parties, control lists, and pause state inside the token. Tenor contains no compliance logic of its own.
- **USDC custody limited** to coupon funding and optional fees; the diamond self-associates with USDC **[DEV-3: as a post-deploy admin transaction, not in init]** for exactly that purpose.
- **No persistent backend.** The only server-side code is a stateless faucet route for testnet onboarding.
- **Fallbacks are first-class.** The USDC leg has an ERC-20-facade path and coupons have an SDK-scheduling path (§10), selected by build-time gates.

---

## 4. Repository layout

```
tenor/
├── contracts/                          Foundry
│   ├── lib/lattice                     submodule, pinned to a commit on the `feat/hedera-system-contract-modules` branch
│   ├── src/interfaces/ITenorMarket.sol · ITenorCoupon.sol
│   ├── src/TenorHTS.sol                [DEV-1] direct 0x167 calls for the permissionless legs
│   ├── src/market/TenorMarketLib.sol · TenorMarket.sol
│   ├── src/coupon/TenorCouponLib.sol · TenorCoupon.sol
│   ├── src/TenorInit.sol
│   ├── script/DeployTenor.s.sol
│   ├── test/TenorMarket.t.sol · TenorCoupon.t.sol · Deploy.t.sol
│   ├── test/mocks/MockATSToken.sol · MockHederaScheduleService.sol
│   ├── foundry.toml · remappings.txt
├── apps/web/                           Next.js App Router · Privy · wagmi/viem
│   └── app/api/faucet/route.ts         testnet drip (HBAR, demo USDC)
├── scripts/                            Bun/TypeScript: ATS issuance and KYC helpers, integration run, SDK coupon fallback, verification
├── docs/SPEC.md · docs/GROUND-TRUTH.md · docs/DESIGN.md · docs/DEMO.md
├── .github/workflows/ci.yml
└── README.md
```

Toolchain: Bun (web, scripts); Foundry with solc 0.8.36, `evm_version = "cancun"`, **no `via_ir` [DEV-7]**; remappings `@lattice/=lib/lattice/src/`, `@lattice-test/=lib/lattice/test/`, `@diamond/=lib/lattice/lib/diamond-lib/src/`, `forge-std/=lib/lattice/lib/forge-std/src/`, `@ats/=../node_modules/@hashgraph/asset-tokenization-contracts/contracts/` (with `allow_paths = ["../node_modules"]`).

Tenor modules follow Lattice's three-file convention: interface (ABI, errors, events) · `*Lib` (all logic and ERC-7201 storage) · stateless facet forwarding to the library, plus a single `TenorInit` for one-shot initialization.

---

## 5. External dependencies

> **§5.1 below is verified accurate. §5.3 is superseded in full by `docs/GROUND-TRUTH.md` §2–§3.**

### 5.1 ATS (`@hashgraph/asset-tokenization-contracts` 8.0.0) — VERIFIED
```solidity
struct Hold { uint256 amount; uint256 expirationTimestamp; address escrow; address to; bytes data; }
struct HoldIdentifier { bytes32 partition; address tokenHolder; uint256 holdId; }

function createHoldFromByPartition(bytes32 partition, address from, Hold calldata hold, bytes calldata operatorData) external returns (bool, uint256 holdId);
function executeHoldByPartition(HoldIdentifier calldata id, address to, uint256 amount) external returns (bool, bytes32 partition);
function releaseHoldByPartition(HoldIdentifier calldata id, uint256 amount) external returns (bool);
function reclaimHoldByPartition(HoldIdentifier calldata id) external returns (bool);
```
Third-party hold creation (`createHoldFromByPartition`)
- The "authorized" path: the caller consumes the holder's **ERC-20 allowance granted to the caller** for `hold.amount` (`decreaseAllowedBalance(from, caller, amount)`), and the token records the caller as the hold's third party. The allowance is restored to the caller on release or reclaim.
- Guarded by `onlyOperational`, `onlyActivated`, `onlyUnpaused`, `onlyClearingDisabled`, `onlyUnProtectedPartitionsOrWildCardRole`, and validation of expiry, addresses, and the default partition.
- Consequence for issuance: the token must be configured with **clearing disabled** and **unprotected partitions** (or the diamond must hold the wildcard role), using the single default partition.

Hold execution
- Caller must be `hold.escrow` (`IsNotEscrow`); if `hold.to == address(0)` the executor chooses the recipient, otherwise `to` must match; execution reverts after `expirationTimestamp` (the holder reclaims after expiry); modifiers `onlyUnpaused`, `onlyIdentifiedAddresses(tokenHolder, to)`, `onlyCompliant(address(0), to, false)`, and a blocked-holder check apply. Partial execution is supported.

### 5.2 Hedera system contracts
| Service | Address | Used for |
|---|---|---|
| Hedera Token Service | `0x167` | `associateToken`, `transferFrom` (allowance path, HIP-906), `transferToken` |
| Hedera Schedule Service | `0x16b` | `hasScheduleCapacity`, `scheduleCall`/`scheduleSelfCall`, `deleteSchedule` (HIP-1215) |

- Calls return `int64 responseCode`; `SUCCESS == 22`. Every call is checked; non-success reverts with the code (except the per-holder coupon path, §7.3).
- Source of truth for ABIs: the interface files vendored in Lattice under `src/interfaces/external/hedera/`.
- An ERC-20 `approve` on an HTS token sets the same allowance that `transferFrom` on `0x167` consumes, so the client's approve step is identical for both USDC paths.
- HTS accounts must be associated with a token before receiving it (sellers for USDC; the diamond for USDC).

### 5.3 Lattice — **SUPERSEDED, see `docs/GROUND-TRUTH.md` §2–§3**
The signatures printed here in v4 were wrong in arity, argument order, naming, error types, and — most consequentially — omitted that every mutating helper is `AccessControl`-gated on `msg.sender`. Do not write code from this section.

Also used: diamond-lib core facets (`DiamondCutFacet`, `DiamondLoupeFacet`, `ERC165Facet`, `OwnableFacet`), `AccessControl`, `Pausable`, `ReentrancyGuard`, `Initializable`, `LatticeFactory`/`LatticeRegistry`.

---

## 6. `TenorMarket`

### 6.1 Storage — `tenor.market.storage` (ERC-7201)

Precomputed slot, `keccak256(abi.encode(uint256(keccak256("tenor.market.storage")) - 1)) & ~bytes32(uint256(0xff))`:

```
0x7113f4ea48b464025de9021bd84366679935cf65db6bede5d56e7a18c914bb00
```

```solidity
struct Listing {
    address token;          // ATS security token (diamond)
    bytes32 partition;
    address seller;
    uint256 holdId;         // created by the diamond in list()
    uint256 remaining;      // tokens still available
    uint256 pricePerToken;  // USDC atomic units (6 dp) per whole token
    uint64  expiry;         // == hold.expirationTimestamp
    uint8   tokenDecimals;  // [DEV-6] cached at listing time
    bool    active;
}
struct MarketStorage {
    address usdc;
    uint16  feeBps;         // ≤ 100
    uint64  maxDuration;    // listing lifetime cap, e.g. 30 days
    uint256 nextId;
    mapping(uint256 => Listing) listings;
}
```

### 6.2 Interface
See `contracts/src/interfaces/ITenorMarket.sol` — authored, authoritative, and not to be edited by implementers.
**[DEV-2]** `withdrawFees` and `FeesWithdrawn` are absent by design.

### 6.3 Behaviour
- **Enable selling (client-side prerequisite)** — the seller calls `approve(diamond, amount)` on the bond token once; the allowance is the seller's self-imposed selling cap and is consumed per listing, restored on cancel/reclaim by the token.
- **list** — `whenNotPaused`. Requires `amount > 0`, `pricePerToken > 0`, `block.timestamp < expiry ≤ block.timestamp + maxDuration`. Calls `createHoldFromByPartition(partition, msg.sender, Hold{amount, expiry, escrow: address(this), to: address(0), data: abi.encode(id)}, "")` — the token verifies balance and allowance and reverts otherwise — then records the listing with the returned `holdId`. One transaction; a listing can never exist without its hold, and a Tenor hold can never exist without its listing.
- **fill** — `nonReentrant`, `whenNotPaused`. Requires active, `0 < amount ≤ remaining`, `block.timestamp < expiry`. `cost = mulDiv(amount, pricePerToken, 10**tokenDecimals)`, revert `ZeroCost` if zero; `fee = cost × feeBps / 10_000`. Effects before interactions: decrement `remaining`, deactivate at zero. Interactions: `TenorHTS.transferFrom(usdc, buyer, seller, cost − fee)`; if `fee > 0`, `TenorHTS.transferFrom(usdc, buyer, address(this), fee)`; then `executeHoldByPartition({partition, seller, holdId}, buyer, amount)`. Any revert in the hold execution reverts the USDC transfers.
- **cancel** — seller only, before expiry: `releaseHoldByPartition(idf, remaining)`; deactivate.
- **expire** — anyone, after expiry: deactivate and emit; the seller reclaims on the token directly.
- **Admin** — `setFeeBps` (`DEFAULT_ADMIN_ROLE`, ≤ 100), `setMaxDuration`, `pause`/`unpause` (`DEFAULT_ADMIN_ROLE` via Lattice's Pausable facet **[DEV-5]**). Fee withdrawal via `HTSAdapter.transferToken` **[DEV-2]**.

### 6.4 Security considerations
- Reentrancy: `ReentrancyGuard` on `fill`, `cancel`; checks-effects-interactions throughout.
- Listing integrity: the hold is created by the diamond, for `msg.sender`, in the same transaction that records the listing; escrow, recipient, and expiry are set by the diamond, never taken from calldata. The seller's ERC-20 allowance to the diamond bounds what the diamond can reserve.
- Accounting: `remaining` mirrors the hold's outstanding amount because every state change goes through the token (execute/release); tests assert the two never diverge.
- Rounding: costs floor via `mulDiv`; zero-cost fills revert; fee is a fraction of cost and can never exceed it.
- Expiry: listings cannot be filled at or after `expiry`; after expiry only the seller can reclaim on the token; `maxDuration` bounds reservation lifetime.
- Custody: no code path moves a security token to the diamond; the only USDC the diamond can receive is fees and coupon funding.
- Pausing the market blocks `list`/`fill` only; sellers can always cancel or reclaim.

### 6.5 Invariants (tests, mocks etched at `0x167`)
1. A fill either transfers USDC and executes the hold, or does neither.
2. Every active listing has a hold on the token with `escrow == diamond`, created in the listing transaction; `remaining` equals the hold's outstanding amount.
3. `fee ≤ cost` and `feeBps ≤ 100` always.
4. The diamond's security-token balance is always zero.
5. With `feeBps == 0`, the diamond's USDC balance is unchanged by any sequence of fills.
6. Only the seller can cancel; cancel and fill are mutually exclusive after expiry.
7. Cancel restores the seller's allowance by exactly the released amount.

---

## 7. `TenorCoupon`

### 7.1 Storage — `tenor.coupon.storage` (ERC-7201)

Precomputed slot:

```
0xa22e655fb2ceae4955a8e34882ef3be65648a98fec0e5d13f18880a96727a600
```

```solidity
struct Coupon {
    uint64  payAt;
    uint256 amountPerToken;
    uint256 funded;
    uint256 paid;
    uint64  scheduleNonce;  // [DEV-4] bumped on cancel so a re-schedule gets a fresh job id
    bool    settled;
}                            // [DEV-4] scheduleAddress removed — read HSSAdapterLib.scheduleOf(jobId)
struct CouponStorage {
    address token;
    address usdc;
    address[] holders;
    mapping(address => bool) isHolder;
    mapping(uint256 => Coupon) coupons;
}
```

### 7.2 Interface
See `contracts/src/interfaces/ITenorCoupon.sol` — authored, authoritative, and not to be edited by implementers.

### 7.3 Behaviour
- `fundCoupon` computes `required = amountPerToken × Σ balanceOf(holder)` at funding time and pulls exactly that (issuer approves first) via `TenorHTS.transferFrom`. **[DEV-3]** the diamond's USDC association is a post-deploy admin transaction.
- `scheduleCoupon` requires `hasScheduleCapacity(payAt, gasLimit)`, then **[DEV-4]** `HSSAdapterLib.scheduleSelfCall(jobId, payAt, gasLimit, abi.encodeCall(ITenorCoupon.payCoupon, (couponId)))` where `jobId = keccak256(abi.encode(couponId, scheduleNonce))`.
- `payCoupon` is **permissionless and idempotent**: callable by anyone once `block.timestamp ≥ payAt`; pays `amountPerToken × balanceOf(holder)` to each registered holder via `TenorHTS.tryTransfer`; a per-holder transfer failure (e.g. holder not associated) is recorded with `CouponPaymentSkipped` and does not block the others; marks `settled`. Correctness never depends on the scheduled call's sender identity. When `msg.sender == address(this)` it also calls `HSSAdapterLib.completeSelfCall(jobId)` to clear the job booking.
- Funding shortfalls (balances grew after funding) revert with `InsufficientFunding`; the issuer tops up and re-calls.
- `cancelSchedule` calls `HSSAdapterLib.deleteSchedule(scheduleOf(jobId))` and bumps `scheduleNonce`, because `deleteSchedule` does not clear Lattice's job mapping **[DEV-4]**.

---

## 8. Initialization and deployment

- `TenorInit.init(admin, issuer, usdc, token, feeBps, maxDuration)` **[DEV-5: no `pauser` parameter]**: calls `AccessControlLib.__AccessControl_init(admin)`, grants `admin` the Lattice module roles (`HTS_MANAGER_ROLE`, `HTS_OPERATOR_ROLE`) and `issuer` both `ISSUER_ROLE` and `HSS_SCHEDULER_ROLE`, runs `__HTSAdapter_init()` / `__HSSAdapter_init()` / `__Pausable_init()`, writes market and coupon storage, and registers the ERC-165 ids for `ITenorMarket` and `ITenorCoupon` via `ERC165Lib.erc165Storage().supportedInterfaces[...] = true`.
  **[DEV-3]** It does **not** associate USDC — `msg.sender` inside the init delegatecall is the factory, which holds no role.
- `DeployTenor.s.sol` follows the Lattice recipe pattern: deploy `LatticeRegistry` + `LatticeFactory` on `hedera-testnet` if `LATTICE_FACTORY` is unset; then a single create-and-initialize transaction cutting the facet set of §3; then **[DEV-3]** an admin transaction calling `HTSAdapter.associateToken(usdc)` on the new diamond. Deterministic address via `LATTICE_SALT` and `factory.predict`.
- Network: RPC alias `hedera-testnet` (chain id 296). Use `--legacy` if type-2 fee estimation fails on the relay; set explicit gas for the create-and-init transaction.
- Verification: every facet and the diamond verified on HashScan; links recorded in `deployments/296/` and the README.

---

## 9. Web client (`apps/web`)

Stack: Next.js App Router · TypeScript · Tailwind · `@privy-io/react-auth` + `@privy-io/wagmi` · wagmi/viem · TanStack Query. Deployed on Vercel through Git integration. Visual and interaction design is specified in `docs/DESIGN.md`; this section defines behaviour the client must implement.

### 9.1 Chain and wallet
```ts
import { defineChain } from 'viem';
export const hederaTestnet = defineChain({
  id: 296, name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.hashio.io/api'] } },
  blockExplorers: { default: { name: 'HashScan', url: 'https://hashscan.io/testnet' } },
  testnet: true,
});
// PrivyProvider: loginMethods ['passkey', 'email', 'wallet']; embeddedWallets createOnLogin 'users-without-wallets';
//                defaultChain hederaTestnet; supportedChains [hederaTestnet]
```
If embedded-wallet transactions fail on the custom chain, the same wagmi provider accepts an injected wallet; Privy login is retained either way.

### 9.2 Transaction model (applies to every write)
1. **Readiness.** Primary actions require: wallet connected on chain 296; HBAR balance above a fee threshold; USDC associated (for buys and coupon funding); issuer verification (KYC) for buys.
2. **Single primary button whose label is the state** (Uniswap/Aave pattern): `Connect wallet` → `Enter an amount` → `Insufficient USDC balance` → `Approve USDC` → `Buy`. The button is never a generic disabled control with a tooltip; the blocking condition is the label. Approval is an inline step in the same button; exact amount by default with an "Approve unlimited" option in the drawer.
3. **Simulation before signing.** On every input change the client runs `eth_call` for the exact transaction as the connected wallet. A simulated revert turns the button into a non-clickable state whose label is the decoded reason (`Verification required`, `Account frozen`, `Trading paused`, `Listing expired`) with a banner explaining what to do. The client never offers a signing prompt for a transaction whose simulation fails. Reverted transactions for demonstration purposes are produced by `scripts/integration.ts`, not by the UI.
4. **Pending state.** Spinner in the button, pending badge on the account chip, one toast per step with a HashScan link, and an activity tray listing every transaction with steps, status, and links, persisted per browser (`localStorage`) so a reload keeps context.
5. **Error decoding.** ATS custom errors (KYC, control list, pause, `IsNotEscrow`, hold errors), ERC-20 allowance/balance errors, Tenor errors (`TenorHTSCallFailed`, market and coupon errors), and Lattice's `IHTSAdapter.HTS*` / `IHSSAdapter.HSS*` typed errors map to plain-language messages with a next action; the raw error is one click away. **The v4 names `HTS__CallFailed` / `HSS__CallFailed` do not exist — see `GROUND-TRUTH.md` §2.3.**
6. **Freshness.** Contract events are watched; mirror-node-dependent state (schedules, association) is polled every ~4 s.

### 9.3 Flows
- **Landing (`/`).** Marketing page per `DESIGN.md`. Live stats (notes listed, volume settled, holders, next coupon, verified contracts) are read through the public RPC and the mirror node without a wallet; a failed read renders `—`, never a placeholder number. The app lives under `/market`, `/holdings`, `/coupons`, `/contracts`.
- **Sign-in and setup.** Passkey login → embedded wallet created silently → setup card with live rows: Wallet ready · Test HBAR (balance; `Get test HBAR` drip; faucet link fallback) · USDC enabled (`Enable USDC` sends `associateToken(wallet, usdc)` to `0x167` with an explicit gas limit ~1,000,000) · Demo USDC (`Get demo USDC` drip, enabled once associated) · Verified by issuer (read from the token's KYC view; not self-serve). The card stays until every row is complete.
- **Buy.** Fill drawer: amount with Max = min(remaining, affordable), live `quote` (cost, fee, total), primary button per §9.2. Receipt with both HashScan links and the investor's next coupon entitlement.
- **Enable selling and list.** First time: `Enable selling` = `approve(diamond, amount)` on the bond token (exact or unlimited). Every listing after that is one transaction: `list(token, partition, amount, price, expiry)`. Sell drawer: amount, price (prefilled with last fill or par), expiry (24h / 3d / 7d / custom ≤ `maxDuration`), preview of proceeds, one-sentence mechanism note ("Your tokens stay in your wallet, reserved for this listing. Cancel anytime before expiry.").
- **Cancel / reclaim.** Active listing → `Cancel` (one transaction). Expired listing → `Reclaim` (calls `reclaimHoldByPartition` on the token directly) and `expire(id)` for state sync.
- **Coupons.** Timeline of coupons with states Draft → Funded → Scheduled → Paid; investor view shows entitlement; issuer view (role check on the diamond) exposes Register holders, Fund (approve + fund stepper), Schedule (shows capacity check and schedule address), Cancel schedule; anyone sees `Pay now` when a coupon is due and unpaid.
- **Verified contracts.** `DiamondLoupe.facets()` rendered as facet name, address, selector count, verification badge, with the line "Composed with Lattice, including reusable HTS and HSS facets."
- **Issuer boundary.** Compliance state (KYC list, pause, freezes) is read-only with a "Manage in ATS" link; a "Trading paused by issuer" banner spans the market when the token is paused.

### 9.4 Faucet route (`POST /api/faucet`, testnet only)
- Request: `{ address, asset: 'HBAR' | 'USDC' }`. Refuses if the configured chain is not 296.
- HBAR: drip 5 HBAR when the address's balance is below a threshold (funding a fresh address creates the Hedera account).
- USDC: drip 5,000 test USDC only when the address is associated with USDC and its balance is below a threshold.
- Eligibility is decided by on-chain balance checks (stateless); no database. Faucet key and thresholds in Vercel env. Responses carry the transaction id for the activity tray. Rate-limit by IP through Vercel's edge config if available; otherwise rely on the balance thresholds.

---

## 10. Fallbacks

| Component | Primary | Fallback |
|---|---|---|
| USDC leg in `fill` | `TenorHTS.transferFrom` on `0x167` **[DEV-1]** | `SafeERC20.safeTransferFrom` on the HTS ERC-20 facade; skip self-association; `feeBps` fixed at 0 |
| Coupon scheduling | `HSSAdapterLib.scheduleSelfCall` (HIP-1215) **[DEV-4]** | `scripts/schedule-coupon.ts`: one `ScheduleCreateTransaction` per holder wrapping a USDC transfer, `setExpirationTime(payAt)`, `setWaitForExpiry(true)`; `TenorCoupon` keeps `fundCoupon`/`payCoupon` for manual settlement |

Both fallbacks are selected by build-time flags in the library and the deploy script, never by runtime branching in the facets.

**G2 status: unverified.** Lattice's day-0 probe (`script/config/hedera/ProbeHedera.s.sol`) exercises HIP-1215 but has no recorded testnet results. Treat the scheduling fallback as a live possibility until G2 passes. See `GROUND-TRUTH.md` §3.2.

---

## 11. Delivery plan and gates (WAT)

| Milestone | Definition of done | Gate |
|---|---|---|
| M1 Eligibility | ATS on testnet; bond issued with the §11.1 configuration; KYC granted to A and B, not C; mint; one successful transfer; one blocked transfer; transaction ids recorded | Tag `v0.1-eligible` before anything in M2 begins |
| M2 Market | `TenorDiamond` deployed through `LatticeFactory`; enable selling → list (one tx) → fill (verified buyer) → fill (unverified buyer reverts) → cancel on testnet; verified on HashScan | — |
| G1 HTS path | `TenorHTS.transferFrom` and `HTSAdapter.associateToken` passing unit tests and one real testnet transfer | Sat 22:00 — otherwise USDC-leg fallback |
| G2 HSS path | `hasScheduleCapacity` succeeds on testnet; one scheduled `payCoupon` executes at expiry | Sun 09:00 — otherwise scheduling fallback |
| M3 Coupons | Fund → schedule → automatic payment visible on HashScan | — |
| M4 Client | Setup, Market, Holdings, Coupons, Verified contracts against testnet; faucet route; Privy passkey login; deployed on Vercel | — |
| M5 Submission | README, DEMO.md, video, verification links, ETHGlobal form | Freeze Sun 14:00 |

Cut order if behind: M4 breadth (keep Setup + Market + Coupons), then M3, never M1 or M2.

### 11.1 ATS setup notes
1. Prefer official testnet addresses for the ATS Business Logic Resolver and Factory if published. Otherwise deploy the ATS system with its own Hardhat task from `packages/ats/contracts` (`npm run deploy:hardhat -- --network hedera-testnet`) — the only Hardhat step in the project.
2. Issue the bond through the ATS web app pointed at testnet (fastest) or a Bun script on `@hashgraph/asset-tokenization-sdk`. Capture: token address, default partition id (read from ATS constants; never hardcode), issuer role assignments (KYC, minter, controller, pauser, corporate actions).
3. **Required configuration for third-party holds:** clearing mode disabled; partitions unprotected (or grant the diamond the wildcard role); single default partition. Verify with a static call to `createHoldFromByPartition` before M2.
4. Instrument: "Tenor Green Note 2027" — USDC-denominated, 6% annual coupon paid quarterly (1.5 USDC per 100-USDC nominal), ~12-month maturity, supply 10,000.

---

## 12. Testing and CI

- Unit tests (Foundry): `MockATSToken` implementing `createHoldFromByPartition` with ERC-20 allowance accounting, execute/release/reclaim with a `kyc[address]` set, `paused` flag, and ATS revert semantics; **Lattice's `MockHederaTokenService` reused (not rewritten)** etched at `0x167`, and a new `MockHederaScheduleService` etched at `0x16b`, both returning configurable response codes. Cover §6.5 invariants, coupon idempotency, skipped-holder accounting, fee math edge cases, expiry and `maxDuration` boundaries.
- Deployment test: the recipe script against a local Anvil with mocks etched, asserting facet selectors and `TenorInit` effects.
- Integration (manual, scripted): `scripts/integration.ts` runs enable selling → list → fill → blocked fill → cancel → fund → schedule → pay on testnet and prints HashScan links; results pasted into the README.
- CI (`.github/workflows/ci.yml`): checkout with `submodules: recursive`; `bun install --frozen-lockfile`; `forge fmt --check`; `forge build`; `forge test -vvv`; `bun run --filter web typecheck && build`. Cache `~/.foundry` and `contracts/out`. Runs on pushes to `main` and pull requests.

---

## 13. Demo script (`docs/DEMO.md`, 3:30)

1. 0:00 Problem: compliant bonds can be issued on ATS but not traded; every fill must obey KYC, freezes, and pauses.
2. 0:15 Issuance on ATS: configuration, KYC grants, mint — HashScan ids on screen.
3. 0:50 Investor A signs in with a passkey, enables selling, and lists 200 tokens at 98 USDC with a 24h expiry in one transaction; the reservation is visible on the token.
4. 1:25 Investor B fills 50: USDC B→A through the Hedera Token Service, tokens via the ATS hold, one transaction.
5. 1:55 Investor C (unverified) opens the same listing — the button reads "Verification required" from the live simulation; the issuer freezes B in ATS — B's button flips to "Account frozen" without a reload.
6. 2:25 Coupon: issuer funds and schedules; the scheduled call executes at expiry and pays holders with no manual action.
7. 2:55 Verified contracts panel: an EIP-2535 diamond composed from Lattice modules, including reusable HTS and HSS facets.
8. 3:15 Architecture slide (≤ 4 bullets) and next steps.

---

## 14. Submission checklist

- [ ] README: overview, architecture, ATS usage (issuance, hold-based DVP), Hedera services (ATS, HTS via `0x167`, HSS via `0x16b`, Scheduled Transactions), Privy usage and UX rationale, addresses with HashScan verification links (diamond and every facet), M1 transaction ids, setup instructions, **AI tools**, **Pre-existing work** (Lattice as a public MIT dependency; HTS/HSS modules authored during the event with commit links; ATS as a public kit).
- [ ] `docs/SPEC.md`, `docs/GROUND-TRUTH.md`, `docs/DESIGN.md`, `docs/DEMO.md`, prompt/plan files committed.
- [ ] Lattice `feat/hedera-system-contract-modules` branch public; the submodule pin resolves for a fresh clone (`git submodule update --init --recursive`).
- [ ] HashScan verification complete; video 2–4 min, ≥720p, human narration.
- [ ] ETHGlobal form: Start Fresh; partner prizes Hedera (Tokenization of Anything) and Privy (Best financial flow); per-partner write-ups reference the extra-point items with links.

---

## 15. Operational notes

- System contracts have no bytecode; forked tests cannot exercise `0x167`/`0x16b`. Unit-test with etched mocks; integrate on testnet.
- Storage slots for the new Lattice modules must be globally unique at authoring time (Lattice's `StorageSlotVerificationTest`); Lattice attribution lines are added at file creation.
- Pin Lattice to a commit; the branch is **still under active development**, so re-pin deliberately and never rebase under the pin.
- Compile with `evm_version = "cancun"`; if deployment or execution fails on Hedera, fall back to `paris`, and record the choice in the README.
- Decimals: USDC 6; token decimals as configured at issuance; HBAR 8 natively and 18 on the EVM side.
- Mirror-node lag is a few seconds; poll no faster than that for schedule and transaction status.
- The faucet key is testnet-only and holds nothing of value; rotate it after the event.
