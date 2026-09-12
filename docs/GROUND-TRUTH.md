# Ground truth — verified external APIs (supersedes SPEC.md §5.3)

Every signature below was read from source on 2026-09-12 at the pinned versions. Where `SPEC.md`
disagrees, **this file wins**. `SPEC.md` §5.3 was written from memory and is wrong in ways that do
not compile.

Pinned versions:
- Lattice submodule `contracts/lib/lattice` @ `7c8450b` (branch `feat/hedera-system-contract-modules`,
  https://github.com/dadadave80/lattice). **The branch is still under active development** — the pin
  is what makes the build reproducible. Re-pin deliberately, never by rebase.
- `@hashgraph/asset-tokenization-contracts@8.0.0` (npm, installed at repo root).
- solc 0.8.36, `evm_version = "cancun"`, no `via_ir` (matches Lattice's default profile; SPEC's
  "via_ir = true to match Lattice" is wrong — Lattice's default profile sets no via_ir and its
  `[profile.ci]` sets `via_ir = false`).

---

## 1. ATS — §5.1 is ACCURATE, verified

`@ats/facets/hold/IHoldTypes.sol`:

```solidity
struct HoldIdentifier { bytes32 partition; address tokenHolder; uint256 holdId; }
struct Hold { uint256 amount; uint256 expirationTimestamp; address escrow; address to; bytes data; }
```

`@ats/facets/holdByPartition/IHoldByPartition.sol` — all four signatures match SPEC §5.1 exactly:

```solidity
function createHoldFromByPartition(bytes32 _partition, address _from, IHoldTypes.Hold calldata _hold, bytes calldata _operatorData)
    external returns (bool success_, uint256 holdId_);
function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata _holdIdentifier, address _to, uint256 _amount)
    external returns (bool success_, bytes32 partition_);
function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata _holdIdentifier, uint256 _amount) external returns (bool success_);
function reclaimHoldByPartition(IHoldTypes.HoldIdentifier calldata _holdIdentifier) external returns (bool success_);
```

**The allowance mechanic is confirmed** (this is the linchpin of FR1 and invariant 7).
`HoldByPartition.createHoldFromByPartition` calls
`HoldOps.decreaseAllowedBalanceForHold(partition, from, hold.amount, holdId)`, which is
`HoldStorageWrapper.decreaseAllowedBalanceForHold` →

```solidity
address thirdPartyAddress = EvmAccessors.getMsgSender();       // == the Tenor diamond
ERC20StorageWrapper.decreaseAllowedBalance(_from, thirdPartyAddress, _amount);
setThirdPartyForHold(thirdPartyAddress, _partition, _from, _holdId);
```

So the seller's ERC-20 allowance **to the diamond** is what bounds the reservation, and the token
records the diamond as the hold's third party so release/reclaim restores the allowance to it.

Guard modifiers on `createHoldFromByPartition`, read from source:
`onlyOperational`, `onlyActivated`, `onlyUnpaused`, `onlyClearingDisabled`,
`onlyUnProtectedPartitionsOrWildCardRole`, `onlyValidCreateHoldFromByPartition(...)`.
→ The token **must** be issued with clearing disabled and unprotected partitions (SPEC §11.1.3 stands).

Import note: the ATS interfaces only pull in `domain/asset/types/ThirdPartyType.sol`, and their
pragma is `>=0.8.0 <0.9.0`, so they compile under 0.8.36 with no further ATS dependencies. Because
the package lives at the repo root, `contracts/foundry.toml` needs
`allow_paths = ["../node_modules"]` or solc refuses the import as "outside of allowed directories".

---

## 2. Lattice HTS — §5.3 is WRONG

Real surface, `@lattice/tokens/hedera/HTSAdapterLib.sol`:

```solidity
function associateToken(address token) internal;                                              // AccessControlLib.checkRole(HTS_MANAGER_ROLE)
function dissociateToken(address token) internal;                                             // HTS_MANAGER_ROLE
function transferToken(address token, address to, int64 amount) internal;                     // HTS_OPERATOR_ROLE
function transferTokenFrom(address token, address from, address to, int64 amount) internal;   // HTS_OPERATOR_ROLE
function isAssociated(address token) internal view returns (bool);                            // IHRC719 facade, ungated
function isHTSToken(address token) internal view returns (bool);                               // ungated
```

Differences from SPEC §5.3, each of which breaks a build or a flow:

| SPEC §5.3 claimed | Reality |
|---|---|
| `associateSelf(address token)` | `associateToken(address token)`, and it is `HTS_MANAGER_ROLE`-gated |
| `transferFrom(token, from, to, uint256 amount)` | `transferTokenFrom(token, from, to, int64 amount)`, `HTS_OPERATOR_ROLE`-gated |
| `transfer(token, to, int64)` | `transferToken(token, to, int64)`, `HTS_OPERATOR_ROLE`-gated |
| `error HTS__CallFailed(bytes4, int64)` | `IHTSAdapter.HTSCallFailed(bytes4, int64)` plus ~16 typed errors (see below) |
| (not mentioned) | every mutating function calls `AccessControlLib.checkRole(...)` |

### 2.1 The blocker: `checkRole` reads `msg.sender`

`AccessControlLib.checkRole(bytes32 role)` is `checkRole(role, msg.sender)`. In a facet, the
delegatecall frame preserves `msg.sender` as the **original caller**, so:

- `fill()` routing its USDC leg through `HTSAdapterLib.transferTokenFrom` would require the **buyer**
  to hold `HTS_OPERATOR_ROLE`. Unacceptable — `fill` is permissionless by design.
- `payCoupon()` (permissionless, §7.3) routing through `HTSAdapterLib.transferToken` would require the
  **arbitrary caller** to hold the role. Also unacceptable. Worse: the lib **reverts** on any
  non-SUCCESS code, but §7.3 requires per-holder skip-and-continue carrying the code in
  `CouponPaymentSkipped(couponId, holder, amount, responseCode)`. A reverting helper cannot express that.
- `TenorInit` calling `HTSAdapterLib.associateToken(usdc)` runs inside `Diamond.initialize`'s
  delegatecall, where `msg.sender` is the **factory/deployer**, not the `admin` that
  `__AccessControl_init(admin)` just granted. It would revert.

### 2.2 Resolution (deviation from SPEC §3, §6.3, §7.3, §8)

1. **Permissionless legs call `0x167` directly from Tenor's own libs**, reusing Lattice's *vendored
   interfaces* (`@lattice/interfaces/external/hedera/IHederaTokenService.sol`,
   `HederaResponseCodes.sol`) rather than its role-gated wrappers. Check
   `code == HederaResponseCodes.SUCCESS` (22); revert with a Tenor error carrying the code, or — in
   `payCoupon` — return the code so the holder can be skipped.
2. **The HTSAdapter facet stays in the cut and keeps earning its place** on the admin paths, where
   `msg.sender` *is* a role holder: `associateToken` (USDC self-association) and `transferToken`
   (fee withdrawal). Consequence: **`withdrawFees` is removed from `ITenorMarket`** — fees leave the
   diamond via `HTSAdapter.transferToken(usdc, to, amount)` under `HTS_OPERATOR_ROLE`.
3. **USDC self-association moves out of `TenorInit`** into a post-deploy admin transaction in
   `DeployTenor.s.sol` that calls the HTSAdapter facet's `associateToken(usdc)` as `admin`
   (who holds `HTS_MANAGER_ROLE`). This keeps the association on production Lattice code and
   sidesteps the init-frame `msg.sender` problem.

### 2.3 Typed errors the client must decode (§9.2.5)

`IHTSAdapter.*`, **not** `HTS__CallFailed`: `HTSTokenNotAssociated(token, account)`,
`HTSTokenAlreadyAssociated`, `HTSInsufficientBalance`, `HTSNonZeroBalance`, `HTSKeyNotActive`,
`HTSTokenNoSupplyKey`, `HTSMaxSupplyReached`, `HTSTokenPaused`, `HTSAccountFrozen`,
`HTSKycNotGranted`, `HTSAllowanceExceeded`, `HTSInsufficientGas`, `HTSNotAToken`,
`HTSInvalidAmount`, `HTSCallFailed(bytes4 selector, int64 responseCode)`.

---

## 3. Lattice HSS — §5.3 is WRONG

Real surface, `@lattice/oracles/hedera/HSSAdapterLib.sol`:

```solidity
function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) internal view returns (bool);   // ungated
function scheduleOf(bytes32 jobId) internal view returns (address);                                  // ungated
function checkScheduledSelfCall() internal view;                                                     // reverts unless msg.sender == address(this)
function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes calldata data)
    internal returns (address scheduleAddress);                                                      // HSS_SCHEDULER_ROLE
function scheduleSelfCall(bytes32 jobId, uint256 expirySecond, uint256 gasLimit, bytes calldata data)
    internal returns (address scheduleAddress);                                                      // HSS_SCHEDULER_ROLE
function completeSelfCall(bytes32 jobId) internal;                                                   // requires msg.sender == address(this)
function deleteSchedule(address scheduleAddress) internal;                                           // HSS_SCHEDULER_ROLE
function authorizeSchedule(address scheduleAddress) internal;                                        // HSS_SCHEDULER_ROLE
```

| SPEC §5.3 claimed | Reality |
|---|---|
| `scheduleCall(to, gasLimit, expirySecond, callData)` | `scheduleCall(to, expirySecond, gasLimit, value, data)` — **arg order differs**, extra `uint64 value` |
| `hasScheduleCapacity(uint64, uint256)` | `hasScheduleCapacity(uint256, uint256)` |
| `error HSS__CallFailed(bytes4, int64)` | `IHSSAdapter.HSSCallFailed(bytes4, int64)`, plus `HSSNotScheduledSelfCall`, `HSSJobAlreadyScheduled(jobId, existing)`, `HSSInvalidExpiry(expirySecond)`, `HSSExpiryBusy(expirySecond, gasLimit)` |
| (not mentioned) | `scheduleSelfCall` / `completeSelfCall` / `scheduleOf` job-id bookkeeping |

### 3.1 Resolution — use `scheduleSelfCall`, it fits better than the SPEC's plan

`scheduleCoupon` becomes, with `issuer` granted `HSS_SCHEDULER_ROLE` in `TenorInit`:

```solidity
HSSAdapterLib.scheduleSelfCall(jobId, payAt, gasLimit, abi.encodeCall(ITenorCoupon.payCoupon, (couponId)))
```

Consequences to honour:

1. **Drop `scheduleAddress` from the `Coupon` struct** — `HSSAdapterLib.scheduleOf(jobId)` already
   stores and returns it. Keeping a second copy invites divergence.
2. `completeSelfCall(jobId)` requires `msg.sender == address(this)`. `payCoupon` is permissionless,
   so guard it: `if (msg.sender == address(this)) HSSAdapterLib.completeSelfCall(jobId);`.
   Correctness must not depend on the scheduled call's sender identity (§7.3) — this only clears
   bookkeeping.
3. `deleteSchedule(addr)` does **not** clear `_schedules[jobId]`, so a cancel-then-reschedule of the
   same `couponId` hits `HSSJobAlreadyScheduled`. Use a nonce in the job id:
   `jobId = keccak256(abi.encode(couponId, scheduleNonce))`, incrementing `scheduleNonce` on cancel.
4. `scheduleSelfCall` makes the **diamond** the schedule payer, so the diamond must hold HBAR for the
   coupon payment to fire.

### 3.2 G2 gate — **PASSES.** HIP-1215 is live on Hedera testnet (verified 2026-09-12)

```console
$ cast chain-id --rpc-url https://testnet.hashio.io/api
296
$ cast call 0x000000000000000000000000000000000000016b \
    "hasScheduleCapacity(uint256,uint256)(bool)" 1789217920 200000 \
    --rpc-url https://testnet.hashio.io/api
true
```

So the Schedule Service answers at `0x16b`, the HIP-1215 `hasScheduleCapacity` signature is the
`(uint256, uint256)` one Lattice vendored, and there is capacity ~10 minutes out at a 200k gas limit.
The **primary** coupon path (`scheduleSelfCall`) is viable and SPEC §10's SDK scheduling fallback is
not needed for the capacity check. What remains unverified is the end-to-end fire: that a scheduled
`payCoupon` actually executes at expiry with the diamond as sender. That needs a funded testnet
operator and is the real G2 exit criterion.

### 3.3 G1 gate status — unresolved, needs a funded operator

`contracts/lib/lattice/script/config/hedera/ProbeHedera.s.sol` is a day-0 probe that exercises
HIP-906 `transferFrom`, the `delegatableContractId` key rule, and (probe 6) `scheduleSelfCall` ~60s
out against the probe callback. **It contains no recorded results**, and `docs/guides/hedera.md` has
none either. So HIP-1215 availability on testnet is *unverified* — treat SPEC §10's coupon-scheduling
fallback (`scripts/schedule-coupon.ts`, SDK `ScheduleCreateTransaction` + `setWaitForExpiry`) as a
live possibility, not a formality, until G2 actually passes.

---

## 4. Test doubles

**Reuse, do not rewrite:** `@lattice-test/mocks/hedera/MockHederaTokenService.sol` is a complete
`vm.etch`-able stand-in for `0x167` that returns response codes and never reverts. It already has
everything Tenor's tests need:

- `transferFrom(token, from, to, uint256)` with real allowance accounting
  (`allowances[token][from][msg.sender]`)
- `transferToken(token, sender, receiver, int64)`, `associateToken`, balances
- `seedAllowance(token, owner, spender, amount)` — stands in for the off-chain `approve`
- **`force(bytes4 selector, int64 code)`** — injects an arbitrary response code for one call. This is
  how the `CouponPaymentSkipped` per-holder-failure path gets tested.
- `MockHRC719Token` deployed per created token for the `isAssociated()` facade.

**Must be written:** there is no mock Hedera Schedule Service in Lattice. Tenor needs a
`MockHederaScheduleService` etched at `0x16b` covering `hasScheduleCapacity`, `scheduleCall`
(returning a deterministic schedule address), and `deleteSchedule`, plus a way to fire the scheduled
callback as the diamond itself so the `msg.sender == address(this)` path is exercised.

---

## 5. Diamond init pattern

From `@lattice/tokens/hedera/HTSAdapterInit.sol` — an `*Init` contract is **delegatecalled by
`Diamond.initialize` inside the initializing window**, so it must NOT open its own
`preInitializer`/`postInitializer`; it calls the module `__X_init()` helpers directly, and those call
`InitializableLib.checkInitializing(...)`.

```solidity
function init(address admin) external {
    AccessControlLib.__AccessControl_init(admin);
    AccessControlLib._grantRole(HTS_MANAGER_ROLE, admin);
    AccessControlLib._grantRole(HTS_OPERATOR_ROLE, admin);
    HTSAdapterLib.__HTSAdapter_init();
}
```

`TenorInit.init` follows exactly this shape: `__AccessControl_init(admin)`, grant
`ISSUER_ROLE`/`PAUSER_ROLE`/`HTS_MANAGER_ROLE`/`HTS_OPERATOR_ROLE`/`HSS_SCHEDULER_ROLE`, then
`__HTSAdapter_init()`, `__HSSAdapter_init()`, Pausable init, Tenor market/coupon storage writes and
ERC-165 registration. **No `associateToken` here** — see §2.2.3.

---

## 6. Build configuration

```toml
solc = "0.8.36"           # matches Lattice
evm_version = "cancun"    # Hedera consensus node v0.76 / evm v0.67; "prague" when v0.77 lands
optimizer_runs = 1_000_000
allow_paths = ["../node_modules"]   # ATS lives at the repo root
# no via_ir — SPEC §4 is wrong about this
```

Remappings (`contracts/remappings.txt`):

```
@lattice/=lib/lattice/src/
@lattice-test/=lib/lattice/test/
@diamond/=lib/lattice/lib/diamond-lib/src/
diamond-lib/=lib/lattice/lib/diamond-lib/
forge-std/=lib/lattice/lib/forge-std/src/
@ats/=../node_modules/@hashgraph/asset-tokenization-contracts/contracts/
```

`git submodule add` does **not** recurse. A fresh clone needs
`git submodule update --init --recursive` (or `--recursive` on clone) or `diamond-lib` and
`forge-std` are empty directories and nothing resolves. CI must use `submodules: recursive`.

---

## 7. ATS system deployment — SPEC §11.1.1 is out of date (no Hardhat needed)

SPEC §11.1.1 calls the ATS system deploy "the only Hardhat step in the project". That is **wrong for
the published 8.0.0 package**, which ships its deploy tooling already compiled under
`node_modules/@hashgraph/asset-tokenization-contracts/build/scripts/`:

```
build/scripts/cli/deploySystemWithNewBlr.js        # deploy Business Logic Resolver + full system
build/scripts/cli/deploySystemWithExistingBlr.js   # reuse an existing BLR
build/scripts/workflows/…                          # the same flows as importable functions
build/scripts/infrastructure/{signer,config,networkConfig}.js
```

Its runtime dependencies are `ethers ^6.15.0`, `zod`, `dotenv`, `tslib`, `@onchain-id/solidity` —
**no hardhat, and no peer dependencies**. `infrastructure/signer.js` builds a plain
`ethers.Wallet`/`JsonRpcProvider` from network config, so the whole system can be deployed with Bun +
ethers straight out of `node_modules`. No repo clone, no Hardhat install, no `npm run deploy:hardhat`.

`hedera-testnet` is a first-class known network (`infrastructure/networkConfig.js`
`KNOWN_NETWORKS.HEDERA_TESTNET`), with per-network confirmation/retry tuning already set for it.

Environment variables the tooling reads (note the prefixed, indexed shape — these are **not** the
generic `PRIVATE_KEY` / `RPC_URL` names):

```
HEDERA_TESTNET_JSON_RPC_ENDPOINT
HEDERA_TESTNET_MIRROR_NODE_ENDPOINT
HEDERA_TESTNET_PRIVATE_KEY_0
```

Consequence for the delivery plan: M1 does not concentrate as much deadline risk as SPEC §11 assumes.
`scripts/deploy-ats.ts` can call `deploySystemWithNewBlr` directly, and the `deployTokenWithExistingBlr`
path means the bond issuance can reuse whatever BLR that produces.

---

## 8. Known limitations (reviewed and accepted, not defects)

**A holder who buys more after funding can stall a coupon.** `payCoupon` reverts
`InsufficientFunding` when the register's total entitlement exceeds what was funded, and the register
is append-only, so any registered holder who acquires more of the bond between `fundCoupon` and
`payAt` pushes `required` above `funded` and blocks settlement until the issuer tops up. Adversarial
review raised this as a griefing vector, and it is one — but it is also precisely what SPEC §7.3
specifies ("Funding shortfalls (balances grew after funding) revert with `InsufficientFunding`; the
issuer tops up and re-calls"), no funds are at risk, and the issuer has a remedy. Paying
`min(entitlement, remaining)` or pro-rating instead would change the instrument's economics, which is
an issuer decision rather than an implementation one. Left as specified.

**Invariant 2 holds for unexpired active listings.** After `expiry`, the holder may reclaim the hold
on the token directly while the listing is still marked active until someone calls `expire(id)`.
During that window `remaining` is stale by design — `expire` is the state-sync call, and the listing
cannot be filled after expiry regardless.

**`quote` on an inactive listing succeeds.** It reverts only for an id that was never created, so a
client can still price and display a historical fill. Only `fill` enforces liveness.
