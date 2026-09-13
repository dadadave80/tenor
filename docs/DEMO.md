# Demo

Everything below is live on **Hedera testnet** and every figure in the app is a chain read. A read
that fails renders `—`; nothing on any page is a sample value.

## Deployed addresses

| What | Address | |
|---|---|---|
| **Tenor diamond** (market + coupons) | `0xD81B627A11ED35110fAE3B0EdbBe475CA6454457` | [HashScan](https://hashscan.io/testnet/contract/0xD81B627A11ED35110fAE3B0EdbBe475CA6454457) |
| **TGN27** — the bond (ATS / ERC-3643) | `0x1EB9D5370382dAF0A0A116C0b7C77899799d5EAF` | [HashScan](https://hashscan.io/testnet/contract/0x1EB9D5370382dAF0A0A116C0b7C77899799d5EAF) |
| **Demo USDC** (HTS, 6 dp) | `0.0.10504590` · `0x…a0498e` | [HashScan](https://hashscan.io/testnet/token/0.0.10504590) |
| ATS BusinessLogicResolver | `0x0aFFA521E6019AAfc4A61829c1B823375E1Bf040` | [HashScan](https://hashscan.io/testnet/contract/0x0aFFA521E6019AAfc4A61829c1B823375E1Bf040) |
| ATS Factory | `0x6b48Ac8a6fb42b82Bc1e2d615503e9274Db8bA05` | [HashScan](https://hashscan.io/testnet/contract/0x6b48Ac8a6fb42b82Bc1e2d615503e9274Db8bA05) |
| Issuer / operator | `0xc46A896cBf32Ba3212ebE12108345F30AC0a0Efd` | [HashScan](https://hashscan.io/testnet/account/0xc46A896cBf32Ba3212ebE12108345F30AC0a0Efd) |

**Every contract is verified on Sourcify, `exact_match`**: the 14 this deploy created (the `Tenor`
diamond, ten facets, three initializers) and all 121 ATS contracts. Run `bun run verify:tenor` and
`bun run verify:ats` to re-check; each prints its verdicts.

The diamond presents 10 facets: ERC165, DiamondLoupe, AccessControlDiamondCut, AccessControl,
Receive, Pausable, HTSAdapter (`0x167`), HSSAdapter (`0x16b`), TenorMarket, TenorCoupon. `/contracts`
reads them from `DiamondLoupe.facets()`, so the page shows what the diamond actually routes to.

## Evidence

| Claim | Transaction |
|---|---|
| A compliant transfer is allowed | [`0x638e0e51…`](https://hashscan.io/testnet/transaction/0x638e0e517920f2c5b1e3403f8761269d6a4763800f923f553c7f0bba0db8f94a) |
| The same transfer to an unverified holder is refused **by the token** | reverted `InvalidKycStatus()` `0xfc855b1b` |
| KYC granted to A | [`0x9712e384…`](https://hashscan.io/testnet/transaction/0x9712e3844512f40666e1e756fca143cb585bd9bba0538ba685d1bd6e3e070027) |
| **G1 — atomic delivery-versus-payment**, 25 TGN27 against 2,450 USDC, buyer ≠ seller, one transaction | [`0x9553256d…`](https://hashscan.io/testnet/transaction/0x9553256de24f6be3ac9f4db343b7b0d6be0b4293acbd20b17666f48d3201ba20) |
| A listing created with its backing hold, in one transaction | [`0xcdbdeb07…`](https://hashscan.io/testnet/transaction/0xcdbdeb07c41a5c9b49edd649508f1fb03bcb9bca41dd3d2f69de816356f49469) |
| A coupon paid, 1,462.50 USDC across 2 holders, triggered by a **non-issuer** | [`0x0a377c80…`](https://hashscan.io/testnet/transaction/0x0a377c8025481788e9c2acf83c4edec56fa2b35bbd5ae2ad2798c44a90f56791) |
| A freshly generated wallet — what a passkey sign-in produces — funded and buying | [`0x1819d48c…`](https://hashscan.io/testnet/transaction/0x1819d48c1c3515fa8e6a54c25bcdc70a8f9c129a42ba23d8c8f14d37bb4c4f94) |

Reproduce the market evidence with `bun run integration`, and the coupon with `bun run coupon`.

## The click-through

1. **`/` — the landing page.** The compliance toggles are an interactive illustration, but the three
   labels they produce (`Verification required`, `Account frozen`, `Trading paused`) are the exact
   strings `lib/errors.ts` returns for the real reverts. The live figures and the facet addresses
   below are chain reads.
2. **`/market`.** The offer table, best offer and yield are read from `getListing`. Sign in with a
   passkey; the setup card appears with five rows and no wallet extension anywhere.
3. **The setup card.** "Get test HBAR" → the faucet sends HBAR, which is what *creates* the Hedera
   account. Then "Enable USDC" — signed by the user, because only an account can associate itself
   with an HTS token. Then "Get demo USDC", which also grants KYC as the issuer. The Verification row
   has no button of its own on purpose: only the issuer can verify an investor, and a button there
   would imply an authority the user does not have.
4. **Buy.** The drawer states the three account facts up front — verified, USDC enabled, balance —
   then the button runs `simulateContract` on the exact transaction and turns the result into a
   sentence. The order matters: `fill()` reverts in *contract* order, which would tell an unverified
   buyer to approve USDC first and only then that they were never eligible.
5. **The compliance beat.** Revoke KYC or freeze the buyer from the issuer account and the button
   changes to `Verification required` / `Account frozen` before anything is signed. That label comes
   from a real simulated revert, not from a flag in the UI.
6. **`/holdings`.** List tokens. The approval is what lets the market place a *hold* — the tokens
   never leave the seller's account, they move out of the sellable balance and come back on cancel.
7. **`/coupons`.** Funded amount, requirement, per-holder entitlement and the booked Hedera Schedule
   Service entity, all read from the diamond.
8. **`/contracts`.** Every address the app talks to, the fee and duration config, and the live facet
   cut. It flags a security or settlement token that disagrees with what the market has pinned.

### Filming the coupon

`bun run coupon -- 360` funds and books a coupon about six minutes out, so it can fire mid-recording.
Read **§10 of `GROUND-TRUTH.md` before claiming anything about it on camera**: the schedule is booked
and the network fires it to the second, but the scheduled call currently fails
`INVALID_PAYER_SIGNATURE`, so the transfer itself is completed by a permissionless `payCoupon`. The
app's copy says exactly that and no more.

## What is deliberately not claimed

- **Coupons do not yet pay with nobody sending a transaction.** The schedule fires on time; the
  payment needs one permissionless call. `GROUND-TRUTH.md` §10 has the evidence and the cause.
- **The compliance demo on the landing page is an illustration.** Its labels are real; its toggles
  are not chain state.
- **The yield figure is derived**, not quoted, and is labelled "est." everywhere it appears.
- **`—` means a read failed or a contract is not deployed.** It never stands in for a number.

## Running it

```bash
git submodule update --init --recursive
bun install
cd contracts && forge test          # 167 tests
cd .. && bun run gen:abi
bun run sync:env                    # writes apps/web/.env.local from the deployment record
cd apps/web && bun run dev
```

`apps/web/.env.local` also needs `NEXT_PUBLIC_PRIVY_APP_ID` for sign-in and `TENOR_OPERATOR_KEY`
(server-side, deliberately not `NEXT_PUBLIC_`) for the faucet.

To deploy from scratch, in order: `deploy:ats` → `verify:ats` → `create:usdc` → `issue:bond` →
`grant:kyc` → `deploy:tenor` (which verifies everything it creates) → `sync:env` → `integration`. §9 of
`GROUND-TRUTH.md` explains how to rehearse the whole chain against a local node first, which is how six
real breaks were found before they cost testnet HBAR.

To replace a live diamond: commit, `bun run deploy:tenor`, `bun run sync:env`, point the hosting
environment's `NEXT_PUBLIC_TENOR_DIAMOND` and `NEXT_PUBLIC_DEPLOY_BLOCK` at the new record, then
`bun run retire:diamond -- <old address> --execute` to cancel its live listings, pause it and zero the
allowance it holds.
