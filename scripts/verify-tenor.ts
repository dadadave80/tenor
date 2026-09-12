/**
 * Verifies the deployed contracts on Sourcify, which is what makes them verified on HashScan.
 *
 * **Why this is not `forge script --verify`.** It cannot be, as of foundry 1.8.1:
 *
 *  - `server-verify.hashscan.io` now answers every path with a 308 redirect to `sourcify.dev/server`.
 *  - Sourcify has removed the v1 `POST /verify` endpoint that foundry posts to, so every submission
 *    comes back `404 Not Found` — five times per contract, then "Not all (0 / 15) contracts were
 *    verified". The 404 is the API being gone, not a flake, and retrying cannot fix it.
 *
 * Sourcify's v2 API is alive and lists chain 296 as supported, so this submits to it directly:
 * `POST /v2/verify/296/{address}` with the solc standard-json input (which `forge verify-contract
 * --show-standard-json-input` produces), then polls the returned job.
 *
 * Usage:  bun run verify:tenor
 */
import { JsonRpcProvider } from 'ethers'
import { resolve } from 'node:path'
import { readRecord, requireRecord, scan } from './lib/ats'

const CONTRACTS = resolve(import.meta.dir, '../contracts')
const SOURCIFY = 'https://sourcify.dev/server'
const CHAIN = 296
const COMPILER = '0.8.36+commit.8a079791'

const { tenor } = requireRecord(['tenor'])
const rpc = process.env.HEDERA_TESTNET_RPC ?? 'https://testnet.hashio.io/api'
const provider = new JsonRpcProvider(rpc, CHAIN, { staticNetwork: true })

/**
 * The cut, in the order `DeployTenor.buildCuts` assembles it, paired with the source each facet
 * comes from.
 *
 * Both halves were read out of the build rather than typed: the names are the ones `buildCuts`
 * constructs, and the paths come from each artifact's `compilationTarget`. Guessing them produced
 * six wrong paths on the first attempt — `diamond-lib` not `diamond`, `HSSAdapter` under `oracles/`
 * not `tokens/hedera/`, and four facets whose contract names are not suffixed `Facet` at all.
 *
 * Addresses are read from the loupe, not from the broadcast log, so what gets verified is what the
 * diamond actually routes to.
 */
const CUT: { name: string; path: string }[] = [
  { name: 'ERC165Facet', path: 'lib/lattice/lib/diamond-lib/src/facets/ERC165Facet.sol' },
  { name: 'DiamondLoupeFacet', path: 'lib/lattice/lib/diamond-lib/src/facets/DiamondLoupeFacet.sol' },
  { name: 'AccessControlDiamondCut', path: 'lib/lattice/src/governance/AccessControlDiamondCut.sol' },
  { name: 'AccessControl', path: 'lib/lattice/src/access/AccessControl.sol' },
  { name: 'Receive', path: 'lib/lattice/src/Receive.sol' },
  { name: 'Pausable', path: 'lib/lattice/src/security/Pausable.sol' },
  { name: 'HTSAdapter', path: 'lib/lattice/src/tokens/hedera/HTSAdapter.sol' },
  { name: 'HSSAdapter', path: 'lib/lattice/src/oracles/hedera/HSSAdapter.sol' },
  { name: 'TenorMarket', path: 'src/market/TenorMarket.sol' },
  { name: 'TenorCoupon', path: 'src/coupon/TenorCoupon.sol' },
]

/** `forge verify-contract --show-standard-json-input` is the only thing that knows our remappings. */
async function standardJson(identifier: string): Promise<unknown> {
  const proc = Bun.spawn(
    ['forge', 'verify-contract', '0x0000000000000000000000000000000000000001', identifier, '--show-standard-json-input'],
    { cwd: CONTRACTS, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if ((await proc.exited) !== 0) throw new Error(`forge could not build standard json for ${identifier}: ${err.trim()}`)
  return JSON.parse(out)
}

type Outcome = { name: string; address: string; status: string; detail?: string }

async function verify(name: string, path: string, address: string): Promise<Outcome> {
  const identifier = `${path}:${name}`

  // Already verified is a pass, and asking first avoids a pointless submission per rerun.
  const existing = await fetch(`${SOURCIFY}/v2/contract/${CHAIN}/${address}`).then((r) => (r.ok ? r.json() : null))
  if (existing && (existing as { match?: string }).match) {
    return { name, address, status: 'already', detail: (existing as { match: string }).match }
  }

  let stdJsonInput: unknown
  try {
    stdJsonInput = await standardJson(identifier)
  } catch (e) {
    return { name, address, status: 'no-source', detail: e instanceof Error ? e.message.slice(0, 160) : 'unknown' }
  }

  const res = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stdJsonInput, compilerVersion: COMPILER, contractIdentifier: identifier }),
  })
  const body = (await res.json()) as { verificationId?: string; message?: string; customCode?: string }
  if (!res.ok || !body.verificationId) {
    return { name, address, status: 'rejected', detail: `${res.status} ${body.customCode ?? ''} ${body.message ?? ''}`.trim().slice(0, 200) }
  }

  // The job is asynchronous. Poll until it resolves rather than reporting a submission as a success.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const job = (await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`).then((r) => r.json())) as {
      isJobCompleted?: boolean
      contract?: { match?: string | null }
      error?: { message?: string; customCode?: string }
    }
    if (!job.isJobCompleted) continue
    if (job.contract?.match) return { name, address, status: job.contract.match }
    return {
      name,
      address,
      status: 'failed',
      detail: `${job.error?.customCode ?? ''} ${job.error?.message ?? 'no match'}`.trim().slice(0, 200),
    }
  }
  return { name, address, status: 'timeout' }
}

// --- what to verify ------------------------------------------------------------------------------
const loupe = new (await import('ethers')).Contract(
  tenor,
  ['function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])'],
  provider,
)
const facets = (await loupe.facets()) as { facetAddress: string }[]
console.log(`\n${facets.length} facets cut into ${tenor}\n`)

const targets: { name: string; path: string; address: string }[] = facets.map((f, i) => ({
  ...(CUT[i] ?? { name: `Facet${i + 1}`, path: '' }),
  address: f.facetAddress,
}))
// The diamond itself is a nested CREATE2 inside LatticeFactory, which is exactly the case a
// broadcast-log walk misses — so it is verified explicitly rather than hoped for.
targets.unshift({ name: 'Lattice', path: 'lib/lattice/src/Lattice.sol', address: tenor })

const results: Outcome[] = []
for (const t of targets) {
  if (!t.path) {
    results.push({ name: t.name, address: t.address, status: 'unmapped', detail: 'not in the expected cut' })
    console.log(`  ? ${t.name.padEnd(30)} ${t.address}  not in the expected cut`)
    continue
  }
  const out = await verify(t.name, t.path, t.address)
  results.push(out)
  const mark = out.status === 'exact_match' || out.status === 'match' || out.status === 'already' ? '✓' : '✗'
  console.log(`  ${mark} ${t.name.padEnd(30)} ${t.address}  ${out.status}${out.detail ? ` — ${out.detail}` : ''}`)
}

const ok = results.filter((r) => ['exact_match', 'match', 'already'].includes(r.status))
console.log(`\n${ok.length}/${results.length} verified on Sourcify`)
console.log(`  diamond  ${scan('contract', tenor)}`)
const rec = readRecord()
if (rec.token) console.log(`  bond     ${scan('contract', rec.token)}`)
if (ok.length !== results.length) {
  console.log('\nNot everything verified. The ones that matter for judging are the diamond and the two')
  console.log('Tenor facets; a Lattice facet that will not match is a library-side metadata mismatch, not a')
  console.log('blocker for the market being readable.')
  process.exit(1)
}
