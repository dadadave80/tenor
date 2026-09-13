/**
 * Winds down a Tenor diamond a redeploy has replaced, so nothing stays live on an address the app no longer
 * points at.
 *
 * By default it only reads and reports:
 *   - every active listing, the ATS hold behind it, and whether it has expired
 *   - whether the market is paused, and the diamond's HBAR and USDC balances
 *   - the operator's TGN27 allowance to the diamond, which a listing's hold draws on
 *   - coupon 1, the only coupon `scripts/coupon.ts` books
 *   - the roles the operator holds on the diamond
 *
 * With `--execute` it sends, from the operator, each confirmed before the next:
 *   1. `cancel(id)` for each of the operator's active, unexpired listings. Releasing a hold restores the
 *      allowance it consumed, so this goes before the allowance is zeroed.
 *   2. `pause()`, which stops new listings and fills. Sellers can still cancel while paused.
 *   3. `approve(diamond, 0)` on TGN27.
 * It refuses the diamond `deployments/296/ats.json` currently records.
 *
 * Usage:  bun run retire:diamond -- <diamond>              report only
 *         bun run retire:diamond -- <diamond> --execute    wind it down
 */
import { Contract, ZeroHash, getAddress, id, isAddress } from 'ethers'
import { atsTokenAbi, tenorAbi } from '../apps/web/lib/abi'
import { operator, readRecord, scan } from './lib/ats'

const ZERO = '0x0000000000000000000000000000000000000000'
/** `scripts/coupon.ts` books coupon 1 and nothing else, and the diamond has no coupon counter to enumerate. */
const COUPON_ID = 1n
const ROLES: [string, string][] = [
  ['DEFAULT_ADMIN_ROLE', ZeroHash],
  ['HTS_MANAGER_ROLE', id('HTS_MANAGER_ROLE')],
  ['HTS_OPERATOR_ROLE', id('HTS_OPERATOR_ROLE')],
  ['ISSUER_ROLE', id('ISSUER_ROLE')],
  ['HSS_SCHEDULER_ROLE', id('HSS_SCHEDULER_ROLE')],
]

/** Gas limits with headroom over the relay's estimates, which are too low for calls that reach the ATS token. */
const CANCEL_GAS = 1_500_000n
const PAUSE_GAS = 300_000n
const APPROVE_GAS = 1_000_000n

const args = process.argv.slice(2).filter((a) => a !== '--')
const execute = args.includes('--execute')
const positional = args.filter((a) => !a.startsWith('--'))
const unknown = args.filter((a) => a.startsWith('--') && a !== '--execute')
if (unknown.length || positional.length !== 1 || !isAddress(positional[0])) {
  throw new Error('Usage: bun run retire:diamond -- <old diamond address> [--execute]')
}
const diamond = getAddress(positional[0])

const record = readRecord()
const current = record.tenor ? getAddress(record.tenor) : undefined
if (execute && diamond === current) {
  throw new Error(`${diamond} is the diamond deployments/296/ats.json records as current. Refusing to retire it.`)
}
if (!record.token) throw new Error('deployments/296/ats.json has no token, so there is no TGN27 allowance to read.')

const { signer, address: op, provider } = await operator({ minHbar: execute ? 5 : 0 })
if ((await provider.getCode(diamond)) === '0x') throw new Error(`No code at ${diamond}.`)

const market = new Contract(diamond, tenorAbi as never, signer)
const tgn = new Contract(record.token, atsTokenAbi as never, signer)
const usdc = record.usdc ? new Contract(record.usdc, ['function balanceOf(address) view returns (uint256)'], provider) : undefined
const [symbol, tokenDecimals] = await Promise.all([
  tgn.symbol().catch(() => 'TGN27') as Promise<string>,
  record.decimals ?? (tgn.decimals().then(Number) as Promise<number>),
])
const chainNow = BigInt((await provider.getBlock('latest'))!.timestamp)

const units = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals })
const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

console.log(`\ndiamond  ${diamond}${diamond === current ? '  (the CURRENT diamond in deployments/296/ats.json)' : ''}`)
console.log(`         ${scan('contract', diamond)}`)
console.log(`chain time ${when(chainNow)}`)

// --- listings ------------------------------------------------------------------------------------
type Listing = {
  id: bigint
  token: string
  partition: string
  seller: string
  holdId: bigint
  remaining: bigint
  pricePerToken: bigint
  expiry: bigint
  active: boolean
}
const nextId = (await market.nextListingId()) as bigint
const active: Listing[] = []
for (let i = 0n; i < nextId; i++) {
  const l = await market.getListing(i)
  if (!l.active) continue
  active.push({
    id: i,
    token: l.token,
    partition: l.partition,
    seller: getAddress(l.seller),
    holdId: l.holdId,
    remaining: l.remaining,
    pricePerToken: l.pricePerToken,
    expiry: l.expiry,
    active: l.active,
  })
}

console.log(`\nlistings  ${active.length} active of ${nextId} ever created`)
for (const l of active) {
  const expired = l.expiry <= chainNow
  const hold = await new Contract(l.token, atsTokenAbi as never, provider)
    .getHoldForByPartition({ partition: l.partition, tokenHolder: l.seller, holdId: l.holdId })
    .then(
      (h: bigint[] & string[]) =>
        `hold #${l.holdId}: ${units(h[0] as unknown as bigint, tokenDecimals)} ${symbol} held, expires ${when(h[1] as unknown as bigint)}, escrow ${h[2]}`,
      (e: { shortMessage?: string; message: string }) => `hold #${l.holdId}: unreadable (${e.shortMessage ?? e.message})`,
    )
  console.log(
    `  #${l.id}  seller ${l.seller}${l.seller === getAddress(op) ? ' (operator)' : ''}  ` +
      `${units(l.remaining, tokenDecimals)} ${symbol} @ ${units(l.pricePerToken, 6)} USDC  ` +
      `expiry ${when(l.expiry)} ${expired ? '(EXPIRED)' : '(live)'}`,
  )
  console.log(`        ${hold}`)
}

// --- market, balances, allowance -----------------------------------------------------------------
const paused = (await market.paused()) as boolean
const allowance = (await tgn.allowance(op, diamond)) as bigint
console.log(`\nmarket    ${paused ? 'PAUSED' : 'not paused'}`)
console.log(`hbar      ${Number(await provider.getBalance(diamond)) / 1e18} HBAR held by the diamond`)
if (usdc) console.log(`usdc      ${units((await usdc.balanceOf(diamond)) as bigint, 6)} USDC held by the diamond`)
console.log(`allowance operator ${op} -> diamond: ${units(allowance, tokenDecimals)} ${symbol}`)

// --- coupon --------------------------------------------------------------------------------------
const c = await market.getCoupon(COUPON_ID)
const scheduleAddress = (await market.couponScheduleAddress(COUPON_ID)) as string
const holderCount = ((await market.couponHolders()) as string[]).length
console.log(`\ncoupon ${COUPON_ID}  ${c.payAt === 0n ? 'never funded' : `pay date ${when(c.payAt)}`}`)
console.log(`          funded ${units(c.funded, 6)} USDC · paid ${units(c.paid, 6)} USDC · ${units(c.amountPerToken, 6)} USDC/token`)
console.log(`          settled ${c.settled} · schedule ${scheduleAddress === ZERO ? 'none' : scheduleAddress} · ${holderCount} registered holder(s)`)

// --- roles ---------------------------------------------------------------------------------------
console.log(`\nroles held by the operator ${op}`)
for (const [name, role] of ROLES) console.log(`  ${(await market.hasRole(role, op)) ? '✓' : '·'} ${name}`)

// --- what --execute does -------------------------------------------------------------------------
const mine = active.filter((l) => l.seller === getAddress(op))
const cancellable = mine.filter((l) => l.expiry > chainNow)
const expiredMine = mine.filter((l) => l.expiry <= chainNow)
const others = active.filter((l) => l.seller !== getAddress(op))

console.log(`\n--execute ${execute ? 'sends' : 'would send'}, from ${op}:`)
console.log(`  cancel       ${cancellable.length ? cancellable.map((l) => `#${l.id}`).join(', ') : 'nothing: no live listing of the operator'}`)
console.log(`  pause()      ${paused ? 'nothing: already paused' : 'yes'}`)
console.log(`  approve(0)   ${allowance === 0n ? `nothing: the allowance is already 0` : 'yes'}${cancellable.length ? ' (after the cancels, which restore allowance)' : ''}`)
for (const l of expiredMine) {
  console.log(`  not sent     #${l.id} has expired: cancel reverts ListingExpired; reclaim it on the token with reclaimHoldByPartition`)
}
for (const l of others) console.log(`  not sent     #${l.id} belongs to ${l.seller}; only its seller can cancel it`)

if (!execute) {
  console.log(`\nreport only: nothing sent.${diamond === current ? ' --execute is refused for this address.' : ''}`)
  process.exit(0)
}

// --- --execute -----------------------------------------------------------------------------------
async function confirm(label: string, sent: Promise<{ hash: string; wait: () => Promise<{ status: number | null } | null> }>) {
  const tx = await sent
  const receipt = await tx.wait()
  if (receipt?.status !== 1) throw new Error(`${label} did not succeed on chain: ${tx.hash}`)
  console.log(`  ✓ ${label.padEnd(28)} ${scan('transaction', tx.hash)}`)
}

console.log('\nretiring ...')
for (const l of cancellable) {
  // Simulated first, so a revert is decoded before any HBAR is spent on it.
  await market.cancel.staticCall(l.id)
  // Explicit gas: `cancel` releases the ATS hold through the token's resolver, and the relay under-estimates that
  // hop. With its estimate (256,391) as the limit, cancel(0) ran out at 244,993 gas and reverted with no data.
  await confirm(`cancel(${l.id})`, market.cancel(l.id, { gasLimit: CANCEL_GAS }))
  if ((await market.getListing(l.id)).active) throw new Error(`cancel(${l.id}) was mined but listing #${l.id} is still active.`)
}

if (!paused) {
  if (!(await market.hasRole(ZeroHash, op))) throw new Error(`${op} lacks DEFAULT_ADMIN_ROLE on ${diamond}, which pause() requires.`)
  await market.pause.staticCall()
  await confirm('pause()', market.pause({ gasLimit: PAUSE_GAS }))
  if (!(await market.paused())) throw new Error('pause() was mined but paused() is still false.')
}

const allowanceNow = (await tgn.allowance(op, diamond)) as bigint
if (allowanceNow > 0n) {
  await confirm(`approve(diamond, 0) on ${symbol}`, tgn.approve(diamond, 0n, { gasLimit: APPROVE_GAS }))
  const left = (await tgn.allowance(op, diamond)) as bigint
  if (left !== 0n) throw new Error(`approve(0) was mined but the allowance is still ${left}.`)
}

console.log(`\n${diamond} retired: paused, ${symbol} allowance 0, ${cancellable.length} listing(s) cancelled`)
if (expiredMine.length || others.length) console.log(`still active on it: ${[...expiredMine, ...others].map((l) => `#${l.id}`).join(', ')} (see above)`)
