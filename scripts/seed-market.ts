/**
 * Seeds the live market with a price ladder from two sellers.
 *
 * A venue with one offer in it looks like a venue nobody uses. This puts a real ladder on the book —
 * five listings across two sellers, either side of the single 98.00 offer already there — so the
 * market page shows depth and a best bid that means something.
 *
 * Every listing is a REAL `list()`: an ATS hold against the seller's own balance, created in the same
 * transaction as the listing. Nothing here is display-only.
 *
 * Idempotent in both directions. It stops before spending anything when the book already has
 * `OPEN_TARGET` live listings, and within a run it skips any ladder entry the same seller already has
 * open at the same size and price — so a half-finished run can simply be re-run.
 *
 * The second seller is investor B, the account `grant-kyc.ts` created and KYC-ed and `integration.ts`
 * bought with. It is reused rather than replaced: it already holds the bond, is verified, and is
 * funded for gas. Its key comes from `SELLER_B_KEY` (contracts/.env) or, in a checkout that has one,
 * `deployments/296/investors.json`. Neither key is ever printed.
 *
 * Usage:  bun run seed:market
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi, type Signer } from 'ethers'
import { tenorAbi } from '../apps/web/lib/abi'
import { operator, requireRecord, scan } from './lib/ats'

const INVESTORS = resolve(import.meta.dir, '../deployments/296/investors.json')

// The GENERATED market ABI, never hand-written fragments: `Listed` is `(id, token, seller, …)`, and
// getting that order wrong makes `parseLog` fail silently rather than loudly (see integration.ts).
const MARKET_ABI = tenorAbi as unknown as InterfaceAbi

const TOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function paused() view returns (bool)',
  'function getKycStatusFor(address account) view returns (uint8)',
  'function getHeldAmountForByPartition(bytes32 partition, address tokenHolder) view returns (uint256)',
]
const USDC_ABI = ['function balanceOf(address account) view returns (uint256)']

/** The relay's estimate for a call that touches ATS storage is unreliable, and an under-estimate reverts. */
const HTS_GAS = 1_000_000n
/** `IKyc.KycStatus`: 0 = NOT_GRANTED, 1 = GRANTED. */
const KYC_GRANTED = 1n
/** Enough offers for the book to read as a market. Reached, the script does nothing. */
const OPEN_TARGET = 6
/** Well inside the diamond's 30-day `maxDuration`, and long enough to outlive the demo. */
const LIFETIME = 14 * 24 * 60 * 60

/**
 * The ladder, cheapest first. Prices are USDC atomic units (6 dp) per WHOLE token, against a 100
 * nominal — so this is a book that trades at a discount to par, which is what a bond above its coupon
 * yield should do. Sizes are whole tokens.
 */
const LADDER = [
  { seller: 'A', tokens: 15n, price: 97_750_000n },
  { seller: 'B', tokens: 10n, price: 98_000_000n },
  { seller: 'A', tokens: 40n, price: 98_250_000n },
  { seller: 'B', tokens: 5n, price: 98_500_000n },
  { seller: 'A', tokens: 30n, price: 99_000_000n },
] as const

const { tenor, token, usdc, partition, decimals } = requireRecord([
  'tenor',
  'token',
  'usdc',
  'partition',
  'decimals',
])

const one = 10n ** BigInt(decimals)
const units = (v: bigint) => (Number(v) / Number(one)).toString()
const money = (v: bigint) => (Number(v) / 1e6).toFixed(2)
const now = () => BigInt(Math.floor(Date.now() / 1000))

/**
 * Investor B's key, without ever logging it.
 *
 * `SELLER_B_KEY` first because this also runs from a worktree, where `deployments/296/investors.json`
 * — gitignored, so never copied — does not exist.
 */
function sellerBKey(): string {
  const raw = process.env.SELLER_B_KEY
  if (raw) return raw.startsWith('0x') ? raw : `0x${raw}`
  if (existsSync(INVESTORS)) {
    const saved = JSON.parse(readFileSync(INVESTORS, 'utf8')) as { B?: { privateKey?: string } }
    if (saved.B?.privateKey) return saved.B.privateKey
  }
  throw new Error(
    'No second seller. Put investor B\'s key in contracts/.env as SELLER_B_KEY — it is the account ' +
      'grant-kyc.ts generated and KYC-ed — or run from a checkout that still has ' +
      'deployments/296/investors.json.',
  )
}

const step = async (label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
  const tx = await p
  await tx.wait()
  console.log(`  ✓ ${label.padEnd(40)} ${tx.hash}`)
  return tx
}

const { signer: a, address: A, provider } = await operator({ minHbar: 10 })
const b: Signer = new Wallet(sellerBKey(), provider as JsonRpcProvider)
const B = await b.getAddress()

const market = new Contract(tenor, MARKET_ABI, a)
const marketAsB = new Contract(tenor, MARKET_ABI, b)
const bond = new Contract(token, TOKEN_ABI, a)
const bondAsB = new Contract(token, TOKEN_ABI, b)

const sellers = {
  A: { address: A, label: 'operator', contract: market, bond },
  B: { address: B, label: 'investor B', contract: marketAsB, bond: bondAsB },
} as const

type Row = {
  id: bigint
  seller: string
  remaining: bigint
  price: bigint
  expiry: bigint
  active: boolean
}

/**
 * Every listing the market has ever made.
 *
 * There is no index of open ids — `nextListingId` is a counter and `getListing` the only read — so the
 * whole range is walked, exactly as the client does. Ids start at ZERO.
 */
async function readRows(): Promise<Row[]> {
  const next = (await market.nextListingId()) as bigint
  const rows: Row[] = []
  for (let id = 0n; id < next; id++) {
    const l = await market.getListing(id)
    rows.push({
      id,
      seller: l.seller as string,
      remaining: l.remaining as bigint,
      price: l.pricePerToken as bigint,
      expiry: l.expiry as bigint,
      active: l.active as boolean,
    })
  }
  return rows
}

/** Fillable right now: what the market page counts, and the only definition of "open" that matters. */
const open = (rows: Row[]) => rows.filter((r) => r.active && r.remaining > 0n && r.expiry > now())

function table(rows: Row[]) {
  const t = now()
  console.log('   id  seller                                       size      price    expires in')
  for (const r of [...rows].sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0))) {
    const who = r.seller.toLowerCase() === A.toLowerCase() ? 'A' : r.seller.toLowerCase() === B.toLowerCase() ? 'B' : '?'
    const days = Number(r.expiry - t) / 86_400
    console.log(
      `  ${String(r.id).padStart(3)}  ${r.seller} ${who}  ${units(r.remaining).padStart(6)}  ` +
        `${money(r.price).padStart(8)}  ${days.toFixed(1).padStart(6)} d`,
    )
  }
}

// --- preflight ------------------------------------------------------------------------------------
// Read, assert, and stop — never repair. A paused token or a missing KYC grant is an issuer decision,
// and seeding a demo book is not the place to reverse one.
console.log(`\nseller A ${A}  (operator/issuer)`)
console.log(`seller B ${B}  (investor B)\n`)

const usdcOfA = (await new Contract(usdc, USDC_ABI, a).balanceOf(A)) as bigint
const [bondOfA, bondOfB] = [(await bond.balanceOf(A)) as bigint, (await bond.balanceOf(B)) as bigint]
const [heldOfA, heldOfB] = [
  (await bond.getHeldAmountForByPartition(partition, A)) as bigint,
  (await bond.getHeldAmountForByPartition(partition, B)) as bigint,
]
const hbarOfA = await provider.getBalance(A)
const hbarOfB = await provider.getBalance(B)

// `balanceOf` on an ATS token reports the UNHELD balance — a hold moves tokens out of it rather than
// flagging them in place. Read on testnet before this ran: A 915 free with 15 held; after listing 85
// more, 830 free with 100 held. So the two numbers are added, never subtracted.
console.log('balances …')
console.log(
  `  A  ${units(bondOfA)} TGN27 free + ${units(heldOfA)} held, ${money(usdcOfA)} USDC, ` +
    `${(Number(hbarOfA) / 1e18).toFixed(2)} HBAR`,
)
console.log(`  B  ${units(bondOfB)} TGN27 free + ${units(heldOfB)} held, ${(Number(hbarOfB) / 1e18).toFixed(2)} HBAR`)

if ((await bond.paused()) as boolean) throw new Error('the security token is paused — no hold can be created')
if ((await market.paused()) as boolean) throw new Error('the Tenor diamond is paused — listing is blocked')
for (const [tag, s] of Object.entries(sellers)) {
  const status = (await bond.getKycStatusFor(s.address)) as bigint
  if (status !== KYC_GRANTED) {
    throw new Error(`seller ${tag} (${s.address}) is not KYC-verified (status ${status}) — run bun run grant:kyc`)
  }
}
console.log('  ✓ token and market unpaused, both sellers verified')

// --- what the book already has --------------------------------------------------------------------
const before = await readRows()
const openBefore = open(before)
console.log(`\nthe book has ${openBefore.length} open listing(s):`)
table(openBefore)

if (openBefore.length >= OPEN_TARGET) {
  console.log(`\nalready ${openBefore.length} open listings (target ${OPEN_TARGET}) — nothing to seed.\n`)
  process.exit(0)
}

// A ladder entry the same seller already has open at the same size and price is the entry, not a
// second one. This is what makes a re-run after a failure at listing 3 add exactly listings 4 and 5.
const pending = LADDER.filter((entry) => {
  const who = sellers[entry.seller].address.toLowerCase()
  const amount = entry.tokens * one
  const dup = openBefore.find(
    (r) => r.seller.toLowerCase() === who && r.remaining === amount && r.price === entry.price,
  )
  if (dup) console.log(`  – ${entry.seller} already lists ${entry.tokens} @ ${money(entry.price)} as id ${dup.id}`)
  return !dup
})

// The hold consumes the seller's ERC-20 allowance TO THE DIAMOND (GROUND-TRUTH §1), and the balance
// behind it must be unheld. Checked per seller, up front: running dry at listing 4 would leave the
// book lopsided and the report wrong.
for (const [tag, s] of Object.entries(sellers)) {
  const need = pending.filter((e) => e.seller === tag).reduce((sum, e) => sum + e.tokens * one, 0n)
  if (need === 0n) continue
  const free = (await s.bond.balanceOf(s.address)) as bigint
  if (free < need) {
    throw new Error(
      `seller ${tag} has ${units(free)} unheld TGN27 but the ladder wants ${units(need)}. ` +
        'Lower the sizes in LADDER rather than part-seeding.',
    )
  }
  if (((await s.bond.allowance(s.address, tenor)) as bigint) < need) {
    await step(`${tag} approves the market for ${units(need)}`, s.bond.approve(tenor, need, { gasLimit: HTS_GAS }))
  } else {
    console.log(`  – ${tag} already allows the market ${units(need)} or more`)
  }
}

// --- list -------------------------------------------------------------------------------------------
const expiry = now() + BigInt(LIFETIME)
console.log(`\nlisting ${pending.length} offer(s), all expiring in ${LIFETIME / 86_400} days …`)

const made: Array<{ id: bigint; seller: string; tokens: bigint; price: bigint; hash: string }> = []
for (const entry of pending) {
  const s = sellers[entry.seller]
  const amount = entry.tokens * one
  const tx = await step(
    `${entry.seller} lists ${entry.tokens} @ ${money(entry.price)}`,
    s.contract.list(token, partition, amount, entry.price, expiry, { gasLimit: HTS_GAS }),
  )
  const receipt = await provider.getTransactionReceipt(tx.hash)
  const listed = receipt!.logs
    .map((l) => {
      try {
        return market.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .find((e) => e?.name === 'Listed')
  if (!listed) throw new Error(`list() for ${entry.seller} ${entry.tokens} @ ${money(entry.price)} emitted no Listed event`)
  const id = listed.args.id as bigint
  console.log(`     listing ${id} · seller ${s.address} (${entry.seller}) · ${entry.tokens} TGN27 @ ${money(entry.price)} USDC · hold ${listed.args.holdId}`)
  console.log(`     ${scan('transaction', tx.hash)}`)
  made.push({ id, seller: s.address, tokens: entry.tokens, price: entry.price, hash: tx.hash })
}

// --- verify against the chain, not against what we just sent ----------------------------------------
const after = await readRows()
const openAfter = open(after)

console.log(`\nthe book now has ${openAfter.length} open listing(s):`)
table(openAfter)

// Invariant 2, seller by seller: a listing without its hold, or a hold left behind without a listing,
// both show up here. `list` makes the pair in one transaction, so a mismatch means something else
// moved — an expired listing not yet swept, or a hold created outside Tenor.
for (const [tag, s] of Object.entries(sellers)) {
  const held = (await s.bond.getHeldAmountForByPartition(partition, s.address)) as bigint
  const reserved = openAfter
    .filter((r) => r.seller.toLowerCase() === s.address.toLowerCase())
    .reduce((sum, r) => sum + r.remaining, 0n)
  const mark = held === reserved ? '✓' : '✗'
  console.log(`  ${mark} ${tag} holds ${units(held)} reserved against ${units(reserved)} listed`)
}

if (openAfter.length < OPEN_TARGET) {
  throw new Error(`only ${openAfter.length} open listings after seeding, wanted ${OPEN_TARGET}`)
}

console.log(`
market seeded — ${openAfter.length} open listings from ${new Set(openAfter.map((r) => r.seller.toLowerCase())).size} sellers

  market   ${tenor}
           ${scan('contract', tenor)}
  token    ${token}

${made.map((m) => `  listing ${String(m.id).padStart(2)}  ${m.seller}  ${String(m.tokens).padStart(3)} @ ${money(m.price)}  ${scan('transaction', m.hash)}`).join('\n')}

  https://tenor-markets.vercel.app/market
`)
