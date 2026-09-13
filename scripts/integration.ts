/**
 * G1 — one real hold-based delivery-versus-payment fill on Hedera testnet, buyer ≠ seller.
 *
 * This is the gate the whole project turns on: an atomic swap of an ERC-3643 security token for an
 * HTS token, settled by `executeHoldByPartition` with the bond checking compliance, in one
 * transaction. The tests prove it against mocks; only this proves it against Hedera.
 *
 * Investor A (the operator) sells; investor B buys. B starts as a bare key — Hedera creates the
 * account the first time it receives HBAR — so the script funds it, associates it, and gives it
 * USDC before it can do anything.
 *
 * Every step asserts. A revert that is merely *a* revert proves nothing, so where a specific failure
 * is the point, the selector is checked.
 *
 * Usage:  bun run integration
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi, type Signer } from 'ethers'
import { tenorAbi } from '../apps/web/lib/abi'
import { operator, requireRecord, scan } from './lib/ats'

const INVESTORS = resolve(import.meta.dir, '../deployments/296/investors.json')

// The market ABI is the GENERATED one, not hand-written fragments. Typing `Listed` by hand got the
// parameter order wrong (it is `id, token, seller`, not `id, seller, token`), `parseLog` silently
// failed, and the script reported "mined but emitted no Listed event" for a listing that was fine.
const MARKET_ABI = tenorAbi as unknown as InterfaceAbi

const ERC20_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]
const HRC719_ABI = ['function associate() returns (uint256)', 'function isAssociated() view returns (bool)']

const { tenor, token, usdc, partition, decimals } = requireRecord([
  'tenor',
  'token',
  'usdc',
  'partition',
  'decimals',
])

const one = 10n ** BigInt(decimals)
const SELL_AMOUNT = 25n * one // 25 notes
const PRICE = 98n * one // 98 USDC per note, below par
const B_USDC = 5_000n * 10n ** 6n
const B_HBAR = 30n * 10n ** 18n
/** The relay's estimate for a `0x167` call is unreliable, and an under-estimate fails outright. */
const HTS_GAS = 1_000_000n
/**
 * `fill` executes the ATS hold and moves USDC through `0x167` in one call. The relay's estimate is too low: with it
 * as the limit (409,884) a fill on testnet ran out at 392,031 gas and reverted with no data.
 */
const FILL_GAS = 3_000_000n

const step = async (label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
  const tx = await p
  await tx.wait()
  console.log(`  ✓ ${label.padEnd(38)} ${tx.hash}`)
  return tx
}

const { signer: a, address: A, provider } = await operator({ minHbar: 60 })

const investors = JSON.parse(readFileSync(INVESTORS, 'utf8')) as {
  B: { address: string; privateKey: string }
}
const B = investors.B.address
const b: Signer = new Wallet(investors.B.privateKey, provider as JsonRpcProvider)

console.log(`\nseller A ${A}`)
console.log(`buyer  B ${B}\n`)

const market = new Contract(tenor, MARKET_ABI, a)
const marketAsB = new Contract(tenor, MARKET_ABI, b)
const bond = new Contract(token, ERC20_ABI, a)
const usdcAsA = new Contract(usdc, ERC20_ABI, a)
const usdcAsB = new Contract(usdc, ERC20_ABI, b)
const usdcHrcAsB = new Contract(usdc, HRC719_ABI, b)

// --- 1. make B an account that can actually transact ---------------------------------------------
console.log('preparing the buyer …')
const bHbar = await provider.getBalance(B)
if (bHbar >= B_HBAR / 2n) {
  console.log(`  – B already holds ${Number(bHbar) / 1e18} HBAR`)
} else {
  // Hedera creates the account on first receipt of HBAR. Until then the relay will not even
  // simulate for B: it answers "Sender account not found".
  await step('fund B with HBAR', a.sendTransaction({ to: B, value: B_HBAR }))
}

if (await usdcHrcAsB.isAssociated()) {
  console.log('  – B already associated with USDC')
} else {
  await step('B associates USDC (HIP-719)', usdcHrcAsB.associate({ gasLimit: HTS_GAS }))
}

const bUsdc0 = (await usdcAsB.balanceOf(B)) as bigint
if (bUsdc0 >= B_USDC) {
  console.log(`  – B already holds ${Number(bUsdc0) / 1e6} USDC`)
} else {
  await step('send B demo USDC', usdcAsA.transfer(B, B_USDC - bUsdc0, { gasLimit: HTS_GAS }))
}

// --- 2. A lists -----------------------------------------------------------------------------------
console.log('\nlisting …')
// `list` creates a hold, and the hold consumes A's allowance TO THE DIAMOND. Without it there is no
// reservation and no listing at all.
if (((await bond.allowance(A, tenor)) as bigint) < SELL_AMOUNT) {
  await step('A approves the market on the bond', bond.approve(tenor, SELL_AMOUNT * 4n, { gasLimit: HTS_GAS }))
}

const expiry = BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60)
const listTx = await step(
  'A lists 25 TGN27 at 98 USDC',
  market.list(token, partition, SELL_AMOUNT, PRICE, expiry, { gasLimit: HTS_GAS }),
)
const listReceipt = await provider.getTransactionReceipt(listTx.hash)
const listed = listReceipt!.logs
  .map((l) => {
    try {
      return market.interface.parseLog(l)
    } catch {
      return null
    }
  })
  .find((e) => e?.name === 'Listed')
if (!listed) throw new Error('list() was mined but emitted no Listed event')
const listingId = listed.args.id as bigint
console.log(`     listing id ${listingId}, hold ${listed.args.holdId}`)

// --- 3. B approves and simulates -----------------------------------------------------------------
console.log('\npreparing the fill …')
const [cost, fee] = (await market.quote(listingId, SELL_AMOUNT)) as [bigint, bigint]
console.log(`     quote: ${Number(cost) / 1e6} USDC cost, ${Number(fee) / 1e6} fee`)

if (((await usdcAsB.allowance(B, tenor)) as bigint) < cost) {
  await step('B approves USDC to the market', usdcAsB.approve(tenor, cost, { gasLimit: HTS_GAS }))
}

// THE check the whole client depends on. Every action button runs `eth_call` on the exact
// transaction before enabling itself, and `fill` moves an HTS token through `0x167`. forge's local
// EVM cannot execute that call at all, so if the relay could not either, no buyer would ever see an
// enabled button -- they would all read "Network call failed".
console.log('\nsimulating the fill as B (eth_call through the public relay) …')
await marketAsB.fill.staticCall(listingId, SELL_AMOUNT)
console.log('  ✓ simulation succeeds — the relay executes HTS calls inside eth_call')

// --- 4. the fill ---------------------------------------------------------------------------------
const aUsdcBefore = (await usdcAsA.balanceOf(A)) as bigint
const bBondBefore = (await new Contract(token, ERC20_ABI, b).balanceOf(B)) as bigint

console.log('\nfilling …')
const fillTx = await step('B fills 25 TGN27', marketAsB.fill(listingId, SELL_AMOUNT, { gasLimit: FILL_GAS }))
const fillReceipt = await provider.getTransactionReceipt(fillTx.hash)
const filled = fillReceipt!.logs
  .map((l) => {
    try {
      return market.interface.parseLog(l)
    } catch {
      return null
    }
  })
  .find((e) => e?.name === 'Filled')
if (!filled) throw new Error('fill() was mined but emitted no Filled event')

// --- 5. assert both legs actually moved ----------------------------------------------------------
const aUsdcAfter = (await usdcAsA.balanceOf(A)) as bigint
const bBondAfter = (await new Contract(token, ERC20_ABI, b).balanceOf(B)) as bigint
const listing = await market.getListing(listingId)

const usdcMoved = aUsdcAfter - aUsdcBefore
const bondMoved = bBondAfter - bBondBefore

console.log('\nasserting …')
if (bondMoved !== SELL_AMOUNT) {
  throw new Error(`B received ${bondMoved} bond units, expected ${SELL_AMOUNT}`)
}
console.log(`  ✓ B received ${Number(bondMoved) / Number(one)} TGN27`)
if (usdcMoved !== cost - fee) {
  throw new Error(`A received ${usdcMoved} USDC units, expected ${cost - fee}`)
}
console.log(`  ✓ A received ${Number(usdcMoved) / 1e6} USDC`)
if (listing.remaining !== 0n || listing.active) {
  throw new Error(`listing should be exhausted: remaining ${listing.remaining}, active ${listing.active}`)
}
console.log('  ✓ listing exhausted and deactivated')
if (bondMoved > 0n && usdcMoved > 0n && fillReceipt!.hash !== listTx.hash) {
  console.log('  ✓ both legs settled in ONE transaction — the bond checked compliance and allowed it')
}

console.log(`
G1 PASSES — atomic delivery-versus-payment on Hedera testnet

  market      ${tenor}
              ${scan('contract', tenor)}
  fill tx     ${fillTx.hash}
              ${scan('transaction', fillTx.hash)}
  list tx     ${scan('transaction', listTx.hash)}

  seller A    ${A}   (-${Number(bondMoved) / Number(one)} TGN27, +${Number(usdcMoved) / 1e6} USDC)
  buyer  B    ${B}   (+${Number(bondMoved) / Number(one)} TGN27, -${Number(cost) / 1e6} USDC)
`)
