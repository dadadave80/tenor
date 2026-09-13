/**
 * M2 — deploys the Tenor diamond, proves what landed, records it, then verifies every contract it created.
 *
 * This is a wrapper around `forge script` rather than a raw package.json line because `run()` takes
 * seven arguments and four of them live in `deployments/296/ats.json`, written by the three steps
 * before this one. Typing them by hand at 13:00 on deadline day is how the wrong token gets pinned
 * into an immutable market.
 *
 * Verification is not optional here: HashScan/Sourcify verification is a Hedera qualification
 * requirement, so the run ends with `verify-tenor.ts` and exits non-zero unless every contract the
 * broadcast created is an exact match. It is not `forge script --verify`, which posts to Sourcify's
 * removed v1 API (see verify-tenor.ts). An exact match needs the committed tree to be the one that was
 * compiled, so a deploy refuses uncommitted contract sources.
 *
 * Usage:  bun run deploy:tenor                     deploy, record, check, associate, seed, verify
 *         bun run deploy:tenor -- --dry-run        read-only: nonce, balance, plan, predicted addresses, tree state
 *         bun run deploy:tenor -- --allow-dirty    local chain only: deploy from uncommitted contract sources
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, ZeroAddress, ZeroHash, getAddress, getCreateAddress, keccak256 } from 'ethers'
import { CHAIN_ID, operator, requireRecord, scan, writeRecord } from './lib/ats'
import { startRelayShim } from './lib/relay-shim'

const ROOT = resolve(import.meta.dir, '..')
const CONTRACTS = resolve(ROOT, 'contracts')
const LATTICE = resolve(CONTRACTS, 'lib/lattice')
const BROADCAST = resolve(CONTRACTS, `broadcast/DeployTenor.s.sol/${CHAIN_ID}/run-latest.json`)
const TENOR_ARTIFACT = resolve(CONTRACTS, 'out/Tenor.sol/Tenor.json')
/** Everything forge compiles from. An uncommitted change to any of it and Sourcify's recompile differs. */
const SOURCES = ['contracts/src', 'contracts/script', 'contracts/lib', 'contracts/foundry.toml', 'contracts/remappings.txt']
/** diamond-lib `OwnableLib`'s owner slot, where Tenor's constructor records the account that created it. */
const OWNER_SLOT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff74873927'

/** SPEC §5.1: fee disabled for the demo, and a 30-day cap on how long a listing may reserve tokens. */
const FEE_BPS = 0
const MAX_DURATION = 30 * 24 * 60 * 60

/**
 * HBAR the diamond is seeded with so it can pay for the coupon calls it schedules itself.
 * 18 dp on the EVM side.
 */
const HBAR_SEED = 20n * 10n ** 18n

/** `DeployTenor.run`'s CREATEs, in broadcast order. The diamond is last, so it is the operator's 14th creation. */
const CREATES = [
  'ERC165Facet',
  'DiamondLoupeFacet',
  'AccessControlDiamondCut',
  'AccessControl',
  'Receive',
  'Pausable',
  'HTSAdapter',
  'HSSAdapter',
  'TenorMarket',
  'TenorCoupon',
  'TenorInit',
  'DiamondIntrospectionInit',
  'MultiInit',
  'Tenor',
]
const TENOR_NONCE_OFFSET = CREATES.length - 1
/** `InvalidInitialization()`, what the owner's second `initialize` must revert with. */
const INVALID_INITIALIZATION = '0xf92ee8a9'
/** `OwnableLib.Unauthorized()`, what `initialize` from anyone but the owner must revert with. */
const UNAUTHORIZED = '0x82b42900'

const args = process.argv.slice(2).filter((a) => a !== '--')
const unknown = args.filter((a) => a !== '--dry-run' && a !== '--allow-dirty')
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Flags: --dry-run, --allow-dirty.`)
const dryRun = args.includes('--dry-run')
const allowDirty = args.includes('--allow-dirty')

const { usdc, token } = requireRecord(['usdc', 'token'])
// `operator()` also guards the genesis hash, which is what stops a record left over from a local
// rehearsal being deployed against.
const { address: admin, signer, provider, rpc } = await operator({ minHbar: dryRun ? 0 : 100 })

// Sourcify cannot see a chain it cannot reach, so a local rehearsal skips verification rather than
// failing after a successful deploy. The hostname is parsed, so `localhost.example.com` is not local.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(URL.canParse(rpc) ? new URL(rpc).hostname : '')

// --- the tree the deploy compiles from -------------------------------------------------------------
// Sourcify returns exact_match only when the sources recompile to the deployed bytes, metadata hash
// included, so a changed comment is enough to lose it. `--allow-dirty` exists for local rehearsals and
// is refused against anything else.
if (allowDirty && !local && !dryRun) {
  throw new Error('--allow-dirty is honoured only against a local chain (HEDERA_TESTNET_RPC on localhost or 127.0.0.1).')
}
const tree = git(['status', '--porcelain', '--', ...SOURCES])
if (tree.code !== 0) throw new Error(`git status failed: ${tree.err}`)
const dirty = tree.out
if (dirty && !dryRun && !allowDirty) {
  throw new Error(
    `Commit these before deploying; Sourcify recompiles the committed tree, so uncommitted sources cannot ` +
      `verify as exact_match${local ? ' (a local rehearsal may pass --allow-dirty)' : ''}:\n${dirty}`,
  )
}

// --- the plan, before anything is sent ---------------------------------------------------------------
// The diamond is a plain CREATE from `admin`, so its address follows from the current nonce. Printed for
// inspection only: the post-deploy gate checks the Tenor CREATE forge actually recorded.
if (!dryRun) {
  const build = Bun.spawnSync(['forge', 'build'], { cwd: CONTRACTS, stdout: 'ignore', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`forge build failed:\n${build.stderr.toString().slice(-800)}`)
}
if (!existsSync(TENOR_ARTIFACT)) throw new Error('contracts/out/Tenor.sol/Tenor.json is missing — run `forge build` in contracts/.')
const stale = staleSources(TENOR_ARTIFACT)
if (stale.length) {
  throw new Error(
    `contracts/out/Tenor.sol/Tenor.json was compiled from other bytes than these files, so the post-deploy ` +
      `runtime check would compare against the wrong code — run \`forge build\` in contracts/:\n  ${stale.join('\n  ')}`,
  )
}

const [nonce, balance] = await Promise.all([provider.getTransactionCount(admin, 'latest'), provider.getBalance(admin)])
const plannedTenor = getCreateAddress({ from: admin, nonce: nonce + TENOR_NONCE_OFFSET })
const pin = local ? undefined : await latticePin()

console.log(`\nplan  (${local ? 'local chain' : 'live chain'} ${rpc})`)
console.log(`  operator     ${admin}  nonce ${nonce}  balance ${hbar(balance)} HBAR`)
console.log(`  ${CREATES.length} CREATE    nonces ${nonce}..${nonce + TENOR_NONCE_OFFSET}: ${CREATES.join(', ')}`)
console.log(`  1 CALL       nonce ${nonce + CREATES.length}: Tenor.initialize, accepted only from its owner ${admin}`)
console.log(`  tenor        ${plannedTenor}  (owner ${admin})`)
console.log(`  then         associateToken(${usdc}), ${hbar(HBAR_SEED)} HBAR seed, verify:tenor`)
console.log(`  tree         ${dirty ? `uncommitted changes to the contract sources:\n${indent(dirty)}` : 'clean'}`)
if (pin) console.log(`  lattice pin  ${pin.commit.slice(0, 12)} ${pin.reachable === 'yes' ? 'on its remote' : pin.reachable === 'no' ? 'NOT on its remote' : 'unchecked'} (${pin.detail})`)

if (pin?.reachable === 'no') {
  console.warn(
    `\n⚠ contracts/lib/lattice is pinned to ${pin.commit}, which no branch or tag on its remote contains. A fresh ` +
      `clone cannot fetch it, so nobody else can rebuild or re-verify this deploy. Push or tag it upstream first.`,
  )
}

if (dryRun) {
  console.log('\n--dry-run: nothing sent, nothing written. The addresses hold only if the operator sends no other transaction first.')
  if (dirty) console.log(local ? 'a real run needs --allow-dirty with this tree' : 'a real run would refuse this tree: commit the sources above first')
  if (!dirty && balance < 100n * 10n ** 18n) console.log('a real run would refuse: it wants at least 100 HBAR')
  process.exit(0)
}

// forge has no env var for the signing key, so it goes in argv. That makes it visible in this
// machine's process list for the length of the deploy; acceptable only because this is a disposable
// testnet key, as contracts/.env says. Without it forge broadcasts from its own default sender and
// `associateToken` reverts `AccessControlUnauthorizedAccount` after the diamond is already deployed.
const rawKey = process.env.PRIVATE_KEY ?? process.env.HEDERA_TESTNET_PRIVATE_KEY_0!
const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`

// forge cannot talk to Hashio directly: it pins its nonce lookup to a block hash using EIP-1898's
// object form, which the relay rejects outright. See `lib/relay-shim.ts`. Anvil accepts the object
// form, so a local rehearsal talks to the node directly.
const shim = local ? null : startRelayShim(rpc)
if (shim) console.log(`relay shim on ${shim.url} -> ${rpc}  (rewrites EIP-1898 block params)`)

// `admin` must be the broadcaster: `associateToken` is sent as the diamond admin right after the deploy,
// and {Tenor} records whoever sends its CREATE as the only account allowed to initialize it.
const forgeArgs = [
  'script',
  'script/DeployTenor.s.sol:DeployTenor',
  '--sig',
  'run(address,address,address,address,uint16,uint64)',
  admin,
  admin,
  usdc,
  token,
  String(FEE_BPS),
  String(MAX_DURATION),
  '--rpc-url',
  shim ? shim.url : rpc,
  '--private-key',
  privateKey,
  '--broadcast',
  // Hedera's relay rejects the burst a default broadcast sends; --slow waits for each receipt.
  '--slow',
  // Kept from the first deploy. Its original reason, forge's simulation of `associateToken` failing on
  // Hashio, no longer applies: association moved out of `run()` into this script. Whether forge's
  // pre-broadcast simulation of the deploy itself works against Hashio is untested.
  '--skip-simulation',
]

console.log(`\nforge ${forgeArgs.map((a) => (a === privateKey ? '<key>' : a)).join(' ')}\n`)
// Spawned ASYNCHRONOUSLY, not with spawnSync: the shim is an HTTP server in this same process, and
// a synchronous spawn blocks the event loop for the whole deploy — so every request forge makes to
// the shim times out and forge reports it cannot reach the chain.
const startedAt = Date.now()
const proc = Bun.spawn(['forge', ...forgeArgs], { cwd: CONTRACTS, stdout: 'pipe', stderr: 'inherit' })
const out = await new Response(proc.stdout).text()
const status = await proc.exited
process.stdout.write(out)
if (shim) {
  console.log(`\nrelay shim rewrote ${shim.rewrites()} request(s)`)
  shim.stop()
}

if (!/ONCHAIN EXECUTION COMPLETE & SUCCESSFUL/.test(out)) {
  throw new Error(
    `The broadcast did not complete (forge exited ${status}). Transactions may already have landed: check ` +
      `${short(BROADCAST)} and the operator's account on HashScan before rerunning.`,
  )
}

// --- what landed, from the chain's receipts --------------------------------------------------------
// The diamond's address is read from its CREATE receipt, not from forge's printed return value: that value
// comes from forge's local execution, and `--skip-simulation` means nothing re-checks it against the chain.
type Tx = {
  hash: string
  transactionType: string
  contractName: string | null
  contractAddress: string | null
  function: string | null
}
type Receipt = { transactionHash: string; status: string; blockNumber: string; contractAddress?: string | null }
const record = JSON.parse(readFileSync(BROADCAST, 'utf8')) as { timestamp: number; transactions: Tx[]; receipts: Receipt[] }
// forge stamps the record in milliseconds.
if (record.timestamp < startedAt) throw new Error(`${short(BROADCAST)} predates this run: forge did not write a record.`)

const tenorCreate = record.transactions.find((t) => t.transactionType === 'CREATE' && t.contractName === 'Tenor')
const createReceipt = tenorCreate && record.receipts.find((r) => r.transactionHash === tenorCreate.hash)
const created = createReceipt?.contractAddress ?? tenorCreate?.contractAddress
if (!tenorCreate || !createReceipt || createReceipt.status !== '0x1' || !created) {
  throw new Error(`${short(BROADCAST)} has no successful Tenor CREATE. Nothing recorded.`)
}
const tenor = getAddress(created)
const initCall = record.transactions.find(
  (t) =>
    t.transactionType === 'CALL' &&
    !!t.contractAddress &&
    getAddress(t.contractAddress) === tenor &&
    !!t.function?.startsWith('initialize('),
)
const initReceipt = initCall && record.receipts.find((r) => r.transactionHash === initCall.hash)
if (!initCall || !initReceipt || initReceipt.status !== '0x1') {
  throw new Error(`${short(BROADCAST)} has no successful Tenor.initialize to ${tenor}. Nothing recorded; nothing sent to it.`)
}
if ((await provider.getCode(tenor)) === '0x') {
  throw new Error(`No code at ${tenor}, the address the Tenor CREATE receipt names. Nothing recorded.`)
}

const printed = /^tenor:\s*address\s+(0x[0-9a-fA-F]{40})/m.exec(out)?.[1]
if (printed && getAddress(printed) !== tenor) {
  console.warn(`\n⚠ forge printed tenor ${printed}; the CREATE receipt says ${tenor}. Recording the receipt's.`)
}

// Recorded because Hashio caps `eth_getLogs` at a 7-day window and refuses `fromBlock: "earliest"`,
// so the client cannot enumerate anything from events without a real starting block. It is the CREATE
// receipt's own block, so no event the diamond emitted — its ownership event included — can sit before it.
const deployBlock = Number(BigInt(createReceipt.blockNumber))
writeRecord({ tenor, deployBlock })

// --- prove what landed before sending it anything -------------------------------------------------
// Association makes the diamond a USDC holder and the seed sends it value, so neither goes out until the
// address is shown to run this tree's Tenor, owned by `admin`, with `admin` holding the admin role, all ten
// facets routed, and `initialize` closed to everyone.
await assertDeployedTenor(tenor)

// --- the two post-deploy steps forge cannot do -------------------------------------------------
// `associateToken` reaches the Hedera Token Service at `0x167`, which has no EVM bytecode for forge
// to execute, so both of these are sent here as ordinary transactions. See DeployTenor.s.sol.
const htsAdapter = new Contract(
  tenor,
  ['function associateToken(address token) external', 'function isAssociated(address token) view returns (bool)'],
  signer,
)

if (await htsAdapter.isAssociated(usdc)) {
  console.log(`\nalready associated with ${usdc}`)
} else {
  console.log(`\nassociating the diamond with USDC ...`)
  // The relay's estimate for a `0x167` call is unreliable and an under-estimate fails with
  // INSUFFICIENT_GAS, so the limit is explicit.
  const tx = await htsAdapter.associateToken(usdc, { gasLimit: 1_000_000 })
  await tx.wait()
  console.log(`  ✓ associateToken                     ${tx.hash}`)
  if (!(await htsAdapter.isAssociated(usdc))) {
    throw new Error('associateToken was mined but isAssociated is still false — check HashScan.')
  }
}

const seeded = await provider.getBalance(tenor)
if (seeded >= HBAR_SEED) {
  console.log(`diamond already holds ${hbar(seeded)} HBAR`)
} else {
  console.log('seeding the diamond with HBAR for its scheduled calls ...')
  const tx = await signer.sendTransaction({ to: tenor, value: HBAR_SEED - seeded })
  await tx.wait()
  console.log(`  ✓ HBAR seed                          ${tx.hash}`)
}

console.log(`\nTenor deployed`)
console.log(`  tenor       ${tenor}`)
console.log(`              ${scan('contract', tenor)}`)
console.log(`  block       ${deployBlock}`)
console.log(`  usdc        ${usdc}`)
console.log(`  security    ${token}`)
console.log(`  fee         ${FEE_BPS} bps · max listing ${MAX_DURATION / 86400} days`)
console.log(`  hbar        ${hbar(await provider.getBalance(tenor))} HBAR held for scheduled calls`)

let verified = 0
if (local) {
  console.log('\nlocal chain — skipping Sourcify verification')
} else {
  console.log('\nverifying every contract this broadcast created ...\n')
  verified = await Bun.spawn(['bun', 'scripts/verify-tenor.ts'], {
    cwd: ROOT,
    env: { ...process.env, HEDERA_TESTNET_RPC: rpc },
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited
}

console.log(`\nnext:  git add -f contracts/broadcast/DeployTenor.s.sol/296/run-latest.json deployments/296/ats.json`)
console.log(`       bun run sync:env  →  bun run integration`)
if (status !== 0) console.warn(`\n⚠ forge exited ${status} after a completed broadcast; read its output above.`)
if (verified !== 0) console.warn('\n⚠ not every contract is exact_match yet; rerun `bun run verify:tenor`.')
process.exit(status !== 0 || verified !== 0 ? 1 : 0)

// --- helpers ---------------------------------------------------------------------------------------

function git(argv: string[], cwd = ROOT): { code: number; out: string; err: string } {
  // --no-optional-locks: a read-only status must not take .git/index.lock and trip a concurrent git command.
  const r = Bun.spawnSync(['git', '--no-optional-locks', ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString().trimEnd(), err: r.stderr.toString().trim() }
}

function hbar(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(4)
}

function indent(lines: string): string {
  return lines
    .split('\n')
    .map((l) => `               ${l}`)
    .join('\n')
}

function short(path: string): string {
  return path.replace(`${ROOT}/`, '')
}

/** Sources whose bytes on disk are not the ones `artifact` was compiled from; the metadata records each keccak256. */
function staleSources(artifact: string): string[] {
  const sources = JSON.parse(readFileSync(artifact, 'utf8')).metadata.sources as Record<string, { keccak256: string }>
  return Object.entries(sources)
    .filter(([path, source]) => {
      const file = resolve(CONTRACTS, path)
      return !existsSync(file) || keccak256(readFileSync(file)) !== source.keccak256
    })
    .map(([path]) => path)
}

/**
 * Whether a fresh `git submodule update` can fetch the lattice commit this repo pins: some branch or tag on
 * the remote must contain it. Tips whose objects are local are checked with git; the rest are asked of
 * GitHub's compare API.
 */
async function latticePin(): Promise<{ commit: string; reachable: 'yes' | 'no' | 'unknown'; detail: string }> {
  const commit = git(['rev-parse', 'HEAD'], LATTICE).out
  const refs = git(['ls-remote', '--heads', '--tags', 'origin'], LATTICE)
  if (refs.code !== 0) return { commit, reachable: 'unknown', detail: `git ls-remote failed: ${refs.err}` }

  const unresolved = new Set<string>()
  for (const line of refs.out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t')
    const name = ref.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, '')
    if (sha === commit) return { commit, reachable: 'yes', detail: name }
    if (git(['cat-file', '-e', `${sha}^{commit}`], LATTICE).code !== 0) unresolved.add(name)
    else if (git(['merge-base', '--is-ancestor', commit, sha], LATTICE).code === 0) {
      return { commit, reachable: 'yes', detail: `in ${name}` }
    }
  }

  const url = git(['remote', 'get-url', 'origin'], LATTICE).out
  const gh = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (unresolved.size && !gh) return { commit, reachable: 'unknown', detail: `cannot ask ${url} about ${unresolved.size} ref(s)` }
  for (const name of unresolved) {
    const res = await fetch(`https://api.github.com/repos/${gh![1]}/${gh![2]}/compare/${name}...${commit}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    }).catch(() => undefined)
    if (res?.status === 404) return { commit, reachable: 'no', detail: 'GitHub does not have the commit' }
    if (!res?.ok) return { commit, reachable: 'unknown', detail: `GitHub answered ${res?.status ?? 'nothing'} for ${name}` }
    const { status: relation } = (await res.json()) as { status?: string }
    if (relation === 'identical' || relation === 'behind') return { commit, reachable: 'yes', detail: `in ${name}` }
  }
  return { commit, reachable: 'no', detail: `none of the remote's branches or tags contains it` }
}

/** Throws unless `diamond` runs this tree's Tenor, is owned by `admin`, grants `admin` the admin role, routes 10 facets, and refuses `initialize`. */
async function assertDeployedTenor(diamond: string): Promise<void> {
  if (diamond !== plannedTenor) {
    console.log(`note: the operator's nonce moved after the plan was printed; the diamond is ${diamond}, not ${plannedTenor}`)
  }
  const runtime = JSON.parse(readFileSync(TENOR_ARTIFACT, 'utf8')).deployedBytecode.object as string
  if ((await provider.getCode(diamond)).toLowerCase() !== runtime.toLowerCase()) {
    throw new Error(`${diamond} does not run contracts/out/Tenor.sol/Tenor.json. Recorded; nothing sent to it.`)
  }
  const owner = getAddress(`0x${(await provider.getStorage(diamond, OWNER_SLOT)).slice(26)}`)
  if (owner !== getAddress(admin)) {
    throw new Error(`${diamond} is owned by ${owner}, not ${admin}. Recorded; nothing sent to it.`)
  }
  const d = new Contract(
    diamond,
    [
      'function initialize((address,uint8,bytes4[])[],address,bytes)',
      'function hasRole(bytes32,address) view returns (bool)',
      'function facetAddresses() view returns (address[])',
    ],
    provider,
  )
  if (!(await d.hasRole(ZeroHash, admin))) throw new Error(`${admin} does not hold DEFAULT_ADMIN_ROLE on ${diamond}. Recorded; nothing sent to it.`)
  const facets = (await d.facetAddresses()) as string[]
  if (facets.length !== 10) throw new Error(`${diamond} routes ${facets.length} facets, expected 10. Recorded; nothing sent to it.`)

  // `initialize` must refuse a stranger with `Unauthorized()` and the owner with `InvalidInitialization()`.
  // Hashio returns the revert data as the JSON-RPC error's `data`.
  const calldata = d.interface.encodeFunctionData('initialize', [[], ZeroAddress, '0x'])
  const revertOf = async (from: string): Promise<string> => {
    // A relay hiccup must not read as "the wrong revert", so an answer without revert data is retried.
    for (let attempt = 1; ; attempt++) {
      const outcome = await provider.call({ from, to: diamond, data: calldata }).then(
        () => 'success',
        (e: { data?: string; info?: { error?: { data?: string } } }) => e.data ?? e.info?.error?.data ?? 'unknown revert',
      )
      if (outcome !== 'unknown revert' || attempt === 3) return outcome
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  const [stranger, fromOwner] = await Promise.all([revertOf('0x000000000000000000000000000000000000dEaD'), revertOf(admin)])
  if (stranger !== UNAUTHORIZED) {
    throw new Error(`initialize from a stranger on ${diamond} answered ${stranger}, not Unauthorized. Recorded; nothing sent to it.`)
  }
  if (fromOwner !== INVALID_INITIALIZATION) {
    throw new Error(`initialize from the owner on ${diamond} answered ${fromOwner}, not InvalidInitialization. Recorded; nothing sent to it.`)
  }
  console.log(`\n✓ ${diamond} is this tree's Tenor: owner ${admin}, admin role, 10 facets, initialize closed`)
}
