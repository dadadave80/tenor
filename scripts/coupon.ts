/**
 * The third pillar: a coupon booked with the Hedera Schedule Service, fired by the network on its pay date.
 *
 * This is the most exotic path in the project and, until this script runs, the only one never
 * exercised against Hedera. G2 proved the diamond can ASK for capacity (`hasScheduleCapacity`
 * returned true); it did not prove a schedule can be booked, fire, and pay.
 *
 * The sequence, which is also the order the constraints force:
 *
 *   1. `registerHolders` — the register is what `payCoupon` iterates. Entitlement is read from the
 *      token's live balance at payment time, so registering never itself grants anything.
 *   2. `couponRequirement(amountPerToken)` — how much USDC the whole register is owed.
 *   3. approve the diamond for that, then `fundCoupon`.
 *   4. `scheduleCoupon` — the diamond is the schedule's payer, so it must hold HBAR.
 *   5. wait for the pay date and watch `settled`. On testnet the network fires the schedule on time but
 *      rejects the diamond as its payer (`docs/GROUND-TRUTH.md` §10), so a coupon still unsettled after
 *      the window gets the permissionless `payCoupon` call that completes it printed — or, with
 *      `--pay-as-b`, sent from investor B, who holds no issuer role.
 *
 * Usage:  bun run coupon                   # pay date ~8 minutes out, then watches
 *         bun run coupon -- 90             # ~90 seconds out
 *         bun run coupon -- --pay-as-b     # if unsettled after the pay date, investor B sends payCoupon
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, Wallet, id } from 'ethers'
import { tenorAbi } from '../apps/web/lib/abi'
import { operator, requireRecord, scan } from './lib/ats'

const INVESTORS = resolve(import.meta.dir, '../deployments/296/investors.json')

const COUPON_ID = 1n
const ZERO = '0x0000000000000000000000000000000000000000'
/** 1.50 USDC per token — a 6% annual coupon on a 100 USDC note, paid semi-annually. */
const PER_TOKEN = 1_500_000n
/** `payCoupon` iterates the register and does one HTS transfer each, so this is generous on purpose. */
const SCHEDULE_GAS = 2_000_000n
const HTS_GAS = 1_000_000n

const argv = process.argv.slice(2).filter((a) => a !== '--')
const payAsB = argv.includes('--pay-as-b')
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--pay-as-b')
if (unknownFlags.length) throw new Error(`Unknown flag(s): ${unknownFlags.join(' ')}. The only flag is --pay-as-b.`)
const leadArg = argv.find((a) => !a.startsWith('--'))
const leadSeconds = Number(leadArg ?? 480)
if (!Number.isFinite(leadSeconds) || leadSeconds <= 0) {
  throw new Error(`The lead time must be a positive number of seconds, not ${leadArg}.`)
}

const { tenor, token, usdc } = requireRecord(['tenor', 'token', 'usdc'])
const { signer, address: issuer, provider, rpc } = await operator({ minHbar: 20 })

const market = new Contract(tenor, tenorAbi as never, signer)
const usdcC = new Contract(
  usdc,
  ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
  signer,
)
const bond = new Contract(token, ['function balanceOf(address) view returns (uint256)'], provider)

const step = async (label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
  const tx = await p
  await tx.wait()
  console.log(`  ✓ ${label.padEnd(36)} ${tx.hash}`)
  return tx
}

// --- 1. the register -----------------------------------------------------------------------------
const investors = JSON.parse(readFileSync(INVESTORS, 'utf8')) as { B: { address: string; privateKey: string } }
const candidates = [issuer, investors.B.address]

const already = ((await market.couponHolders()) as string[]).map((h) => h.toLowerCase())
console.log(`\nregister currently holds ${already.length} address(es)`)

// Registration is documented as idempotent per address, but the point of this run is to find out
// what Hedera does, not to trust the docstring — so only genuinely new addresses are sent.
const missing = candidates.filter((a) => !already.includes(a.toLowerCase()))
if (missing.length === 0) {
  console.log('  – every holder already registered')
} else {
  await step(`registerHolders(${missing.length})`, market.registerHolders(missing))
}

const holders = (await market.couponHolders()) as string[]
console.log('\nregistered holders and their live balances:')
let registeredBalance = 0n
for (const h of holders) {
  const bal = (await bond.balanceOf(h)) as bigint
  registeredBalance += bal
  console.log(`  ${h}  ${Number(bal) / 1e6} TGN27`)
}
if (registeredBalance === 0n) {
  throw new Error('The register holds no tokens, so there is nothing to pay. Run `bun run integration` first.')
}

// --- 2 & 3. fund ---------------------------------------------------------------------------------
const required = (await market.couponRequirement(PER_TOKEN)) as bigint
console.log(`\ncoupon needs ${Number(required) / 1e6} USDC for ${Number(registeredBalance) / 1e6} registered tokens`)

const existing = await market.getCoupon(COUPON_ID)
const booked = ((await market.couponScheduleAddress(COUPON_ID)) as string) !== ZERO
const now = BigInt(Math.floor(Date.now() / 1000))
const stale = existing.payAt > 0n && existing.payAt <= now

// A settled coupon needs nothing: re-funding it reverts `CouponAlreadySettled`, and `cancelSchedule` would only
// bump its nonce.
if (existing.settled) {
  console.log(`\ncoupon ${COUPON_ID} is already settled: ${Number(existing.paid) / 1e6} USDC paid. Nothing to do.`)
  process.exit(0)
}

// A funded coupon past its pay date only needs the permissionless `payCoupon`. With --pay-as-b it is paid now,
// rather than re-dated onto another schedule the network would reject (docs/GROUND-TRUTH.md §10.2).
if (payAsB && stale && existing.funded > 0n) {
  console.log(`\ncoupon ${COUPON_ID} is funded and past its pay date; --pay-as-b pays it now instead of re-dating it.`)
  await payFromB((await market.couponScheduleAddress(COUPON_ID)) as string, (await usdcC.balanceOf(holders[0])) as bigint)
}

// A pay date in the past cannot be scheduled, and `fundCoupon` rejects it outright. Re-dating is
// free: it computes `topUp = required - funded` and pulls only the shortfall, so a fully funded
// coupon can be moved to a new date without any further USDC.
const payAt =
  existing.payAt > 0n && !stale ? existing.payAt : BigInt(Math.floor(Date.now() / 1000) + leadSeconds)
if (existing.payAt > 0n) {
  console.log(
    `  – coupon ${COUPON_ID} exists, pay date ${new Date(Number(existing.payAt) * 1000).toISOString()}` +
      (stale ? ` (in the past — re-dating to ${new Date(Number(payAt) * 1000).toISOString()})` : ''),
  )
}

const shortfall = existing.funded < required ? required - existing.funded : 0n
if (shortfall > 0n || stale) {
  if (shortfall > 0n) {
    console.log(`\nfunding ${Number(shortfall) / 1e6} USDC …`)
    await step('approve USDC to the diamond', usdcC.approve(tenor, shortfall, { gasLimit: HTS_GAS }))
  }
  if (booked && stale) {
    // Terms are pinned while a booking is live, so a stale date cannot be moved under it.
    await step('cancelSchedule (to re-date)', market.cancelSchedule(COUPON_ID, { gasLimit: 1_500_000 }))
  }
  // `fundCoupon` pulls USDC through `0x167` as the diamond, so it needs real gas.
  await step(`fundCoupon(${COUPON_ID})`, market.fundCoupon(COUPON_ID, PER_TOKEN, payAt, { gasLimit: 3_000_000 }))
} else {
  console.log('  – already funded and dated')
}

// --- 4. book it ----------------------------------------------------------------------------------
let scheduleAddress = (await market.couponScheduleAddress(COUPON_ID)) as string
if (scheduleAddress !== ZERO) {
  console.log(`\n  – already scheduled at ${scheduleAddress}`)
} else {
  const capacity = (await market.hasScheduleCapacity(payAt, SCHEDULE_GAS)) as boolean
  console.log(`\nHedera reports schedule capacity at ${new Date(Number(payAt) * 1000).toISOString()}: ${capacity}`)
  if (!capacity) throw new Error('No schedule capacity at that second. Pick a different pay date.')

  const diamondHbar = await provider.getBalance(tenor)
  console.log(`diamond holds ${Number(diamondHbar) / 1e18} HBAR to pay for the call`)
  if (diamondHbar === 0n) throw new Error('The diamond holds no HBAR, so a scheduled call cannot be paid for.')

  await step(`scheduleCoupon(${COUPON_ID})`, market.scheduleCoupon(COUPON_ID, SCHEDULE_GAS, { gasLimit: 2_000_000 }))
  scheduleAddress = (await market.couponScheduleAddress(COUPON_ID)) as string
  // No `authorizeSchedule` (HIP-755) follows. `scheduleCall` already signs with the diamond's contract key, so
  // a second signature reverts `HSSCallFailed(0xf0637961, 205)` NO_NEW_VALID_SIGNATURES, which used to abort
  // this script before the watch loop. See docs/GROUND-TRUTH.md §10.2.
}

console.log(`\nschedule ${scheduleAddress}`)
console.log(`         ${scan('account', scheduleAddress)}`)
console.log(
  'note: on testnet the network fires this on time but rejects the diamond as its payer (INVALID_PAYER_SIGNATURE); ' +
    'payCoupon is permissionless — docs/GROUND-TRUTH.md §10',
)

// --- 5. wait for the network to do it ------------------------------------------------------------
const before = (await usdcC.balanceOf(holders[0])) as bigint
const waitFor = Number(payAt) * 1000 - Date.now()
console.log(
  `\nwaiting for the network to fire it — ${Math.max(0, Math.round(waitFor / 1000))}s away. ` +
    `Nothing below sends a transaction${payAsB ? ' until the window closes' : ''}.`,
)

const deadline = Date.now() + Math.max(waitFor, 0) + 4 * 60_000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000))
  const c = await market.getCoupon(COUPON_ID)
  const left = Math.round((Number(payAt) * 1000 - Date.now()) / 1000)
  console.log(`  settled=${c.settled}  paid=${Number(c.paid) / 1e6} USDC  ${left > 0 ? `${left}s to go` : 'due'}`)
  if (c.settled) {
    const after = (await usdcC.balanceOf(holders[0])) as bigint
    console.log(`\nCOUPON PAID ITSELF — no transaction was sent to make this happen.`)
    console.log(`  coupon      ${COUPON_ID}`)
    console.log(`  total paid  ${Number(c.paid) / 1e6} USDC across ${holders.length} holder(s)`)
    console.log(`  holder[0]   ${Number(before) / 1e6} -> ${Number(after) / 1e6} USDC`)
    console.log(`  schedule    ${scan('account', scheduleAddress)}`)
    console.log(`  diamond     ${scan('contract', tenor)}`)
    process.exit(0)
  }
}

// --- 6. past the pay date and unsettled: payCoupon is permissionless ------------------------------
console.log(`
The schedule did not settle coupon ${COUPON_ID} within the window.

  schedule  ${scan('account', scheduleAddress)}

On testnet that is the known payer-signature failure (docs/GROUND-TRUTH.md §10.2). \`payCoupon\` is
permissionless, so any funded account can settle it now:

  to        ${tenor}
  data      ${market.interface.encodeFunctionData('payCoupon', [COUPON_ID])}   payCoupon(${COUPON_ID})
  gas       ${SCHEDULE_GAS}

  cast send ${tenor} "payCoupon(uint256)" ${COUPON_ID} --gas-limit ${SCHEDULE_GAS} --rpc-url ${rpc} --private-key <any funded key>`)

if (!payAsB) {
  console.log('\nor rerun with --pay-as-b to send it from investor B.')
  process.exit(1)
}

await payFromB(scheduleAddress, before)

/** Sends the permissionless `payCoupon` from investor B, who holds no role on the diamond: the non-issuer evidence §10.3 records. */
async function payFromB(schedule: string, holderBefore: bigint): Promise<never> {
  const b = new Wallet(investors.B.privateKey, provider)
  const marketAsB = new Contract(tenor, tenorAbi as never, b)
  const bIsIssuer = (await market.hasRole(id('ISSUER_ROLE'), b.address)) as boolean
  console.log(
    `\ninvestor B ${b.address}  ISSUER_ROLE ${bIsIssuer}  balance ${Number(await provider.getBalance(b.address)) / 1e18} HBAR`,
  )
  // Simulated first, so a revert surfaces as a decoded error instead of a failed transaction B pays for.
  await marketAsB.payCoupon.staticCall(COUPON_ID, { gasLimit: SCHEDULE_GAS })
  const payTx = await step(`payCoupon(${COUPON_ID}) from investor B`, marketAsB.payCoupon(COUPON_ID, { gasLimit: SCHEDULE_GAS }))

  const settled = await market.getCoupon(COUPON_ID)
  if (!settled.settled) throw new Error(`payCoupon from investor B was mined (${payTx.hash}) but coupon ${COUPON_ID} is still unsettled.`)
  const holderAfter = (await usdcC.balanceOf(holders[0])) as bigint
  console.log(`\nCOUPON SETTLED BY A NON-ISSUER — investor B sent the permissionless payCoupon.`)
  console.log(`  coupon      ${COUPON_ID}`)
  console.log(`  total paid  ${Number(settled.paid) / 1e6} USDC across ${holders.length} holder(s)`)
  console.log(`  holder[0]   ${Number(holderBefore) / 1e6} -> ${Number(holderAfter) / 1e6} USDC`)
  console.log(`  sent by     ${b.address} (ISSUER_ROLE ${bIsIssuer})`)
  console.log(`  payCoupon   ${scan('transaction', payTx.hash)}`)
  if (schedule !== ZERO) console.log(`  schedule    ${scan('account', schedule)}  (whether it executed is on HashScan; not checked here)`)
  console.log(`  diamond     ${scan('contract', tenor)}`)
  process.exit(0)
}
