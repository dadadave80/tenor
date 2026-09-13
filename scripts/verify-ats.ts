/**
 * Verifies on Sourcify every contract the ATS deployment in `deployments/296/ats.json` put on chain.
 *
 * **What gets verified is discovered from the chain, starting at the record.**
 *
 *  1. `ats.json` names the BusinessLogicResolver proxy (`resolver`), the ProxyAdmin, the Factory proxy and the bond
 *     token. The resolver proxy's ERC-1967 slots name its implementation, and must name the recorded ProxyAdmin.
 *  2. The resolver lists every facet: `getBusinessLogicKeys`, each key resolved with `resolveLatestBusinessLogic`. The
 *     Factory proxy's logic, FactoryFacet, is one of them.
 *  3. Libraries are read out of the code that calls them. Hardhat links after compiling, so a linked library's address
 *     sits in its caller's runtime at the artifact's `deployedLinkReferences` offsets. Libraries link libraries, so
 *     this repeats until nothing new turns up.
 *  4. The ATS tooling's own output (`deployments/hedera-testnet/newBlr-*.json`, `deployments/.checkpoints/*.json`) is
 *     gitignored, so it cannot be the source of truth. When it is on disk it is compared with the chain both ways, and
 *     an address only the record knows is identified and verified as well.
 *
 * **Every address is identified by its code.** Its runtime is compared, metadata hash included, with every artifact
 * the installed @hashgraph/asset-tokenization-contracts ships. Only two kinds of byte are masked: link references,
 * and a library's call-protection address (bytes 1-20, which the chain fills with the library's own address). Both
 * are filled in at deployment, and Sourcify accounts for both. An address no artifact matches is reported and not
 * submitted.
 *
 * **The standard JSON is rebuilt, because the package does not ship its build-info** (its `files` excludes
 * `artifacts/build-info/`). For each contract, the import closure of its source is collected under Hardhat's source
 * unit names: `contracts/...` from the package, `@scope/pkg/...` from that dependency at the version upstream pinned.
 * OpenZeppelin is only a devDependency of the package, so it is never installed and comes from its npm tarballs,
 * checked against the registry's integrity hashes and cached in a gitignored directory. T-REX and ONCHAINID are pinned
 * the same way, though nothing deployed imports them. The settings are upstream's
 * `hardhat.config.ts`: solc 0.8.28, optimizer 100 runs, `cancun`. There are no `libraries`, because Hardhat links
 * after compiling, and adding them would move the metadata hash. A local solc run over these inputs reproduced the
 * on-chain metadata hash of every deployed contract, so each one should come back `exact_match`.
 *
 * **An address Sourcify already holds as `exact_match` is skipped.** Everything else is submitted to
 * `POST /v2/verify/296/{address}`, and each job is polled to a verdict.
 *
 * Usage:  bun run verify:ats [--dry-run] [--only <Name|address>[,...]] [--dump <dir>] [--cache <dir>]
 *         --dry-run  discover, identify and build every input; submit nothing
 *         --only     restrict to these contract names or addresses (repeatable, comma-separated)
 *         --dump     write each standard JSON input it builds to <dir>/<ContractName>.json
 *         --cache    where npm tarballs are kept (default node_modules/.cache/verify-ats)
 *
 * Exits 0 only when Sourcify, re-read at the end, holds every selected contract as `exact_match`. A dry run exits 0
 * when every selected contract is either `exact_match` already or identified with its input built.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { Contract, JsonRpcProvider, dataSlice, getAddress } from 'ethers'
import { CHAIN_ID, DEFAULT_RPC, readRecord } from './lib/ats'

const ROOT = resolve(import.meta.dir, '..')
const SOURCIFY = 'https://sourcify.dev/server'
const REGISTRY = 'https://registry.npmjs.org'

/** The ATS release that was deployed. Its sources, with the settings below, reproduce the deployed code. */
const ATS_VERSION = '8.0.0'
/** Upstream `packages/ats/contracts/hardhat.config.ts`, the compiler entry that built everything deployed. */
const COMPILER = '0.8.28+commit.7893614a'
const SETTINGS = { optimizer: { enabled: true, runs: 100 }, evmVersion: 'cancun' }

/** Solidity dependencies at the versions upstream's lockfile pins, with the registry's `dist.integrity`. */
const DEPENDENCIES: Record<string, { version: string; integrity: string }> = {
  '@openzeppelin/contracts': {
    version: '4.9.6',
    integrity: 'sha512-xSmezSupL+y9VkHZJGDoCBpmnB2ogM13ccaYDWqJTfS3dbuHkgjuwDFUmaFauBCboQMGB/S5UqUl2y54X99BmA==',
  },
  '@openzeppelin/contracts-upgradeable': {
    version: '4.9.6',
    integrity: 'sha512-m4iHazOsOCv1DgM7eD7GupTJ+NFVujRZt1wzddDPSVGpWdKq1SKkla5htKG7+IS4d2XOCtzkUNwRZ7Vq5aEUMA==',
  },
  '@tokenysolutions/t-rex': {
    version: '4.1.6',
    integrity: 'sha512-GNmVAC11cqwF6bmVCl0yhaVfPLBptF4K0vmepghTPbSogky1WG+38h7RR/p7909Si2JgswreeeLZZyBLN0KZrg==',
  },
  '@onchain-id/solidity': {
    version: '2.2.1',
    integrity: 'sha512-B54InT8yi89qlh9UVCARcfdQLVDP7Lef87B/Ww2Wn19oyEbPmlWho2EK1sgnrt/8Q0fGX/7y5rDnx3HPy28NTA==',
  },
}

// --- arguments ---------------------------------------------------------------------------------------------------
const args = process.argv.slice(2)
const FLAGS = new Set(['--dry-run', '--only', '--dump', '--cache'])
function values(flag: string): string[] {
  const found: string[] = []
  args.forEach((arg, i) => {
    if (arg !== flag) return
    const value = args[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`)
    found.push(value)
  })
  return found
}
const unknown = args.filter((arg) => arg.startsWith('--') && !FLAGS.has(arg))
if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}.`)
const dryRun = args.includes('--dry-run')
const only = values('--only')
  .flatMap((v) => v.split(','))
  .map((v) => v.trim())
  .filter(Boolean)
const DUMP = values('--dump').at(-1)
const CACHE = resolve(values('--cache').at(-1) ?? join(ROOT, 'node_modules/.cache/verify-ats'))

const provider = new JsonRpcProvider(process.env.HEDERA_TESTNET_RPC ?? DEFAULT_RPC, CHAIN_ID, {
  staticNetwork: true,
  batchMaxCount: 1,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs `fn` over `items` with at most `width` in flight, keeping the order of `items` in the result. */
async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}

/** Hashio drops the odd request under load; a read that fails is retried before it counts. */
async function rpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === 5) throw new Error(`${label} failed ${attempt} times: ${(error as Error).message}`)
      await sleep(1000 * 2 ** attempt)
    }
  }
}

/** `fetch`, retried on network errors, 429 and 5xx, honouring `Retry-After`. */
async function http(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined
    let failure: unknown
    try {
      res = await fetch(url, init)
    } catch (error) {
      failure = error
    }
    if (res && res.status !== 429 && res.status < 500) return res
    if (attempt === 6) {
      if (res) return res
      throw failure
    }
    const after = Number(res?.headers.get('retry-after'))
    await sleep(after > 0 ? after * 1000 : Math.min(60_000, 2000 * 2 ** (attempt - 1)))
  }
}

// --- 1. the record and the package -------------------------------------------------------------------------------
const record = readRecord()
const absent = (['resolver', 'factory', 'proxyAdmin', 'token'] as const).filter((k) => !record[k])
if (absent.length) throw new Error(`deployments/296/ats.json is missing ${absent.join(', ')}.`)
const genesis = (await rpc('eth_getBlockByNumber 0', () => provider.getBlock(0)))?.hash
if (record.genesis && genesis !== record.genesis) {
  throw new Error(`deployments/296/ats.json belongs to another chain (genesis ${record.genesis}, RPC ${genesis}).`)
}

const ATS = realpathSync(join(ROOT, 'node_modules/@hashgraph/asset-tokenization-contracts'))
const installedAts = JSON.parse(readFileSync(join(ATS, 'package.json'), 'utf8')).version
if (installedAts !== ATS_VERSION) {
  throw new Error(`@hashgraph/asset-tokenization-contracts is ${installedAts}; the deployment is ${ATS_VERSION}.`)
}

// --- 2. the artifacts --------------------------------------------------------------------------------------------
type Link = { identifier: string; start: number }
type Artifact = { identifier: string; sourceName: string; contractName: string; runtime: Buffer; links: Link[] }
type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>

const byLength = new Map<number, Artifact[]>()
const ARTIFACTS = join(ATS, 'artifacts')
for (const file of readdirSync(ARTIFACTS, { recursive: true }) as string[]) {
  if (!file.endsWith('.json') || file.endsWith('.dbg.json')) continue
  if (file.startsWith('build-info/') || file.startsWith('contracts/test/')) continue
  const a = JSON.parse(readFileSync(join(ARTIFACTS, file), 'utf8'))
  if (!a.deployedBytecode || a.deployedBytecode === '0x') continue
  // Unlinked code carries `__$<hash>$__` placeholders, which are not hex. They become zeros, as the chain side will.
  const hex = (a.deployedBytecode as string).slice(2).replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40))
  const runtime = Buffer.from(hex, 'hex')
  if (runtime.length * 2 !== hex.length) throw new Error(`${file} has a malformed deployedBytecode.`)
  const links = Object.entries((a.deployedLinkReferences ?? {}) as LinkReferences).flatMap(([source, libraries]) =>
    Object.entries(libraries).flatMap(([name, refs]) =>
      refs.map((r) => ({ identifier: `${source}:${name}`, start: r.start })),
    ),
  )
  const artifact = {
    identifier: `${a.sourceName}:${a.contractName}`,
    sourceName: a.sourceName,
    contractName: a.contractName,
    runtime,
    links,
  }
  byLength.set(runtime.length, [...(byLength.get(runtime.length) ?? []), artifact])
}

/** A library's unlinked runtime opens `PUSH20 0x00…00`, the slot the chain fills with its own address. */
const isLibrary = (runtime: Buffer) => runtime[0] === 0x73 && runtime.subarray(1, 21).every((b) => b === 0)

function identify(address: string, code: Buffer): Artifact[] {
  return (byLength.get(code.length) ?? []).filter((a) => {
    const chain = Buffer.from(code)
    for (const link of a.links) chain.fill(0, link.start, link.start + 20)
    if (isLibrary(a.runtime)) {
      if (!code.subarray(1, 21).equals(Buffer.from(address.slice(2), 'hex'))) return false
      chain.fill(0, 1, 21)
    }
    return chain.equals(a.runtime)
  })
}

// --- 3. discovery ------------------------------------------------------------------------------------------------
type Entry = { address: string; role: string; artifact?: Artifact; problem?: string }
const entries = new Map<string, Entry>()
/** Library address -> the identifier its callers link it as. */
const linkedAs = new Map<string, string>()

/** Identifies every address in `start`, then every library they link, until nothing new turns up. */
async function discover(start: Map<string, string>) {
  let frontier = [...start].filter(([address]) => !entries.has(address))
  while (frontier.length) {
    const codes = await pool(frontier, 6, ([address]) => rpc(`eth_getCode ${address}`, () => provider.getCode(address)))
    const next = new Map<string, string>()
    frontier.forEach(([address, role], i) => {
      const entry: Entry = { address, role }
      entries.set(address, entry)
      const code = Buffer.from(codes[i].slice(2), 'hex')
      if (!code.length) return void (entry.problem = 'no code at this address')
      const hits = identify(address, code)
      if (hits.length !== 1) {
        entry.problem = hits.length
          ? `ambiguous: ${hits.map((h) => h.identifier).join(', ')}`
          : 'unidentified: no artifact in the package has this code'
        return
      }
      const artifact = hits[0]
      entry.artifact = artifact
      const within = new Map<string, string>()
      for (const link of artifact.links) {
        const library = getAddress(`0x${code.subarray(link.start, link.start + 20).toString('hex')}`)
        if ((within.get(link.identifier) ?? library) !== library) {
          throw new Error(`${address} links ${link.identifier} at two addresses.`)
        }
        within.set(link.identifier, library)
        if ((linkedAs.get(library) ?? link.identifier) !== link.identifier) {
          throw new Error(`${library} is linked as both ${linkedAs.get(library)} and ${link.identifier}.`)
        }
        linkedAs.set(library, link.identifier)
        if (!entries.has(library) && !next.has(library)) next.set(library, `library linked by ${artifact.contractName}`)
      }
    })
    frontier = [...next]
  }
}

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const slot = async (address: string, key: string) =>
  getAddress(dataSlice(await rpc(`eth_getStorageAt ${address}`, () => provider.getStorage(address, key)), 12))

const resolverProxy = getAddress(record.resolver as string)
const admin = await slot(resolverProxy, ADMIN_SLOT)
if (admin !== getAddress(record.proxyAdmin as string)) {
  throw new Error(`The resolver proxy's ERC-1967 admin is ${admin}; ats.json records ${record.proxyAdmin}.`)
}
const seeds = new Map<string, string>([
  [admin, 'ats.json proxyAdmin'],
  [resolverProxy, 'ats.json resolver'],
  [await slot(resolverProxy, IMPLEMENTATION_SLOT), 'ERC-1967 implementation of the resolver'],
  [getAddress(record.factory as string), 'ats.json factory'],
  [getAddress(record.token as string), 'ats.json token'],
])

const resolver = new Contract(
  resolverProxy,
  [
    'function getBusinessLogicCount() view returns (uint256)',
    'function getBusinessLogicKeys(uint256 pageIndex, uint256 pageLength) view returns (bytes32[])',
    'function resolveLatestBusinessLogic(bytes32 key) view returns (address)',
  ],
  provider,
)
const count = Number(await rpc('getBusinessLogicCount', () => resolver.getBusinessLogicCount()))
const keys = [...((await rpc('getBusinessLogicKeys', () => resolver.getBusinessLogicKeys(0, count))) as string[])]
if (keys.length !== count) throw new Error(`The resolver counts ${count} business logics but lists ${keys.length}.`)
const facets = await pool(keys, 4, (key) =>
  rpc(`resolveLatestBusinessLogic ${key}`, async () => getAddress(await resolver.resolveLatestBusinessLogic(key))),
)
for (const facet of facets) if (!seeds.has(facet)) seeds.set(facet, 'resolver business logic')

await discover(seeds)
const fromChain = new Set(entries.keys())
const libraries = [...entries.values()].filter((e) => e.role.startsWith('library')).length
console.log(
  `\n${fromChain.size} contracts on chain: ${seeds.size - facets.length} from ats.json and ERC-1967 slots, ` +
    `${facets.length} resolver business logics, ${libraries} linked libraries`,
)

// --- 4. the ATS tooling's records, when they are on disk ---------------------------------------------------------
type Recorded = Map<string, string | undefined> // address -> the name the record gives it, when it gives one
const records: { file: string; addresses: Recorded }[] = []
const lower = (a?: string) => a?.toLowerCase()

function readJsons(dir: string, prefix: string): { file: string; json: any }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: join(dir, f), json: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
}

for (const { file, json } of readJsons(join(ROOT, 'deployments/hedera-testnet'), 'newBlr-')) {
  const infra = json.infrastructure
  if (lower(infra?.blr?.proxy) !== lower(resolverProxy)) continue
  const addresses: Recorded = new Map()
  for (const a of [infra.proxyAdmin?.address, infra.blr?.proxy, infra.blr?.implementation]) {
    if (a) addresses.set(getAddress(a), undefined)
  }
  for (const a of [infra.factory?.proxy, infra.factory?.implementation]) if (a) addresses.set(getAddress(a), undefined)
  for (const f of json.facets ?? []) addresses.set(getAddress(f.address), f.name)
  records.push({ file, addresses })
}
for (const { file, json } of readJsons(join(ROOT, 'deployments/.checkpoints'), '')) {
  const steps = json.steps
  if (lower(steps?.blr?.proxy) !== lower(resolverProxy)) continue
  const addresses: Recorded = new Map()
  for (const a of [steps.proxyAdmin?.address, steps.blr?.proxy, steps.blr?.implementation, steps.factory?.proxy]) {
    if (a) addresses.set(getAddress(a), undefined)
  }
  if (steps.factory?.implementation) addresses.set(getAddress(steps.factory.implementation), undefined)
  for (const [name, a] of Object.entries(steps.libraries ?? {})) {
    if (name !== 'deployedAt') addresses.set(getAddress(a as string), name)
  }
  for (const [name, f] of (steps.facets?.__value ?? []) as [string, { address: string }][]) {
    addresses.set(getAddress(f.address), name)
  }
  records.push({ file, addresses })
}

const recordOnly = new Map<string, string>()
for (const { file, addresses } of records) {
  const short = file.replace(`${ROOT}/`, '')
  const missing = [...addresses.keys()].filter((a) => !fromChain.has(a))
  const renamed = [...addresses].filter(([a, name]) => {
    const artifact = entries.get(a)?.artifact
    return name && artifact && name.toLowerCase() !== artifact.contractName.toLowerCase()
  })
  const parts = [`${addresses.size} addresses`]
  if (missing.length) parts.push(`${missing.length} the chain walk did not reach: ${missing.join(', ')}`)
  if (renamed.length) {
    parts.push(`${renamed.length} named differently: ${renamed.map(([a, n]) => `${a} ${n}`).join(', ')}`)
  }
  console.log(`  ${short}: ${missing.length || renamed.length ? parts.join('; ') : `agrees (${parts[0]})`}`)
  for (const a of missing) recordOnly.set(a, `only in ${short}`)
}
if (!records.length) console.log('  no newBlr record or checkpoint for this resolver on disk; the chain walk stands')
if (recordOnly.size) await discover(recordOnly)
for (const [library, identifier] of linkedAs) {
  const entry = entries.get(library) as Entry
  if (entry.artifact && entry.artifact.identifier !== identifier) {
    entry.problem = `its code is ${entry.artifact.identifier}, but callers link it as ${identifier}`
  }
}

// --- 5. the selection --------------------------------------------------------------------------------------------
const everything = [...entries.values()]
const matches = (e: Entry, token: string) =>
  token.toLowerCase() === e.address.toLowerCase() || token.toLowerCase() === lower(e.artifact?.contractName)
const unmatched = only.filter((t) => !everything.some((e) => matches(e, t)))
if (unmatched.length) throw new Error(`--only names nothing discovered: ${unmatched.join(', ')}.`)
const selected = only.length ? everything.filter((e) => only.some((t) => matches(e, t))) : everything
if (only.length) console.log(`--only selects ${selected.length} of ${everything.length}`)

async function sourcify(address: string): Promise<string | null> {
  const res = await http(`${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}`)
  // An address Sourcify does not hold answers 404. Any other failure is Sourcify's, not a verdict.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Sourcify answered ${res.status} for ${address}.`)
  return ((await res.json()) as { match: string | null }).match
}
const before = await pool(selected, 4, (e) => sourcify(e.address))

// --- 6. standard JSON --------------------------------------------------------------------------------------------
type Reader = (path: string) => string
const readers = new Map<string, Promise<Reader>>()

/** Integrity string in the registry's format. */
const sri = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

async function load(pkg: string): Promise<Reader> {
  const pin = DEPENDENCIES[pkg]
  if (!pin) throw new Error(`An import reaches ${pkg}, which has no pinned version in DEPENDENCIES.`)

  // Installed at the pinned version (resolved from the ATS package, as its own imports would be): read it in place.
  try {
    const manifest = realpathSync(Bun.resolveSync(`${pkg}/package.json`, ATS))
    if (JSON.parse(readFileSync(manifest, 'utf8')).version === pin.version) {
      return (path) => readFileSync(join(dirname(manifest), path), 'utf8')
    }
  } catch {}

  const file = join(CACHE, `${pkg.replace('/', '+')}-${pin.version}.tgz`)
  let bytes: Uint8Array | undefined = existsSync(file) ? readFileSync(file) : undefined
  if (!bytes || sri(bytes) !== pin.integrity) {
    const url = `${REGISTRY}/${pkg}/-/${pkg.split('/')[1]}-${pin.version}.tgz`
    const res = await http(url)
    if (!res.ok) throw new Error(`The npm registry answered ${res.status} for ${url}.`)
    bytes = new Uint8Array(await res.arrayBuffer())
    if (sri(bytes) !== pin.integrity) throw new Error(`${url} does not match its pinned integrity.`)
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(file, bytes)
  }
  const files = new Map<string, string>()
  for (const [path, blob] of await new Bun.Archive(bytes).files()) {
    // Buffer decoding keeps a byte-order mark, as reading the file from disk would; Blob.text() would drop it.
    if (path.startsWith('package/')) files.set(path.slice(8), Buffer.from(await blob.arrayBuffer()).toString('utf8'))
  }
  return (path) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`${pkg}@${pin.version} has no ${path}.`)
    return content
  }
}

async function read(unit: string): Promise<string> {
  if (unit.split('/').includes('..')) throw new Error(`Import ${unit} climbs out of its package.`)
  if (unit.startsWith('contracts/')) return readFileSync(join(ATS, unit), 'utf8')
  const scoped = /^(@[^/]+\/[^/]+)\/(.+)$/.exec(unit)
  if (!scoped) throw new Error(`Cannot place import ${unit}.`)
  if (!readers.has(scoped[1])) readers.set(scoped[1], load(scoped[1]))
  return ((await readers.get(scoped[1])) as Reader)(scoped[2])
}

const IMPORT = /^\s*import\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["']\s*;/gm
/** Comments go before imports are matched, keeping line count so nothing else shifts. */
const uncommented = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1)).replace(/\/\/[^\n]*/g, '')

/** The import closure of the artifact's source, under Hardhat's source unit names, with upstream's settings. */
async function standardJson(artifact: Artifact) {
  const sources: Record<string, { content: string }> = {}
  const todo = [artifact.sourceName]
  while (todo.length) {
    const unit = todo.pop() as string
    if (sources[unit]) continue
    const content = await read(unit)
    sources[unit] = { content }
    for (const [, target] of uncommented(content).matchAll(IMPORT)) {
      todo.push(target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(unit), target)) : target)
    }
  }
  const outputs = ['evm.deployedBytecode.object', 'metadata']
  const outputSelection = { [artifact.sourceName]: { [artifact.contractName]: outputs } }
  const input = { language: 'Solidity', sources, settings: { ...SETTINGS, outputSelection } }
  if (DUMP) {
    mkdirSync(DUMP, { recursive: true })
    writeFileSync(join(DUMP, `${artifact.contractName}.json`), JSON.stringify(input))
  }
  return input
}

// --- 7. submit ---------------------------------------------------------------------------------------------------
type JobError = { customCode?: string; message?: string; recompiledRuntimeCode?: string; onchainRuntimeCode?: string }
type Job = { isJobCompleted?: boolean; contract?: { match?: string | null }; error?: JobError }

/** Sourcify keeps the two runtimes on a `no_match`; where they part is the first thing to look at. */
function diagnose(error?: JobError): string {
  const built = error?.recompiledRuntimeCode
  const chain = error?.onchainRuntimeCode
  if (!built || !chain) return ''
  let i = 2
  while (i < Math.min(built.length, chain.length) && built[i] === chain[i]) i++
  const bytes = (hex: string) => (hex.length - 2) / 2
  return ` (runtime: ${bytes(chain)} bytes on chain, ${bytes(built)} recompiled, first differs at byte ${(i - 2) >> 1})`
}

const POST_GAP_MS = 3000
let nextPost = 0

async function submit(artifact: Artifact, address: string): Promise<string> {
  const body = JSON.stringify({
    stdJsonInput: await standardJson(artifact),
    compilerVersion: COMPILER,
    contractIdentifier: artifact.identifier,
  })
  const at = Math.max(Date.now(), nextPost)
  nextPost = at + POST_GAP_MS
  await sleep(at - Date.now())

  const res = await http(`${SOURCIFY}/v2/verify/${CHAIN_ID}/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  type Reply = { verificationId?: string; customCode?: string; message?: string }
  const reply = (await res.json().catch(() => ({}))) as Reply
  if (res.status === 409 && reply.customCode === 'already_verified') return 'already_verified'
  if (!res.ok || !reply.verificationId) {
    return `rejected ${res.status} ${reply.customCode ?? ''} ${reply.message ?? ''}`.trim()
  }

  // The job is asynchronous. A 200-source input can take minutes to compile, so it is polled to a verdict.
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    await sleep(5000)
    const poll = await http(`${SOURCIFY}/v2/verify/${reply.verificationId}`)
    if (!poll.ok) continue
    const job = (await poll.json()) as Job
    if (!job.isJobCompleted) continue
    if (job.contract?.match) return job.contract.match
    return `failed ${job.error?.customCode ?? ''} ${job.error?.message ?? ''}${diagnose(job.error)}`.trim()
  }
  return `timeout: job ${reply.verificationId} still running`
}

type Row = Entry & { before: string | null; outcome: string }
const rows: Row[] = selected.map((e, i) => ({ ...e, before: before[i], outcome: '' }))
const label = (r: Row) => r.artifact?.contractName ?? '?'
const log = (r: Row) => console.log(`  ${r.address}  ${label(r).padEnd(44)} ${r.outcome}`)

console.log()
for (const r of rows) {
  if (r.problem) r.outcome = `not submitted: ${r.problem} (${r.role})`
  else if (r.before === 'exact_match') r.outcome = 'exact_match (already)'
  else continue
  log(r)
}
const work = rows.filter((r) => !r.outcome)
await pool(work, dryRun ? 4 : 3, async (r) => {
  const artifact = r.artifact as Artifact
  if (dryRun) {
    const input = await standardJson(artifact)
    const kb = Math.round(JSON.stringify(input).length / 1024)
    r.outcome = `would submit (now ${r.before ?? 'unverified'}; ${Object.keys(input.sources).length} sources, ${kb} KB)`
  } else {
    r.outcome = await submit(artifact, r.address)
  }
  log(r)
})

// --- 8. verdict --------------------------------------------------------------------------------------------------
function table(verdicts: string[]) {
  const width = Math.max(...rows.map((r) => label(r).length))
  console.log()
  rows.forEach((r, i) => {
    const v = verdicts[i]
    const mark = v.startsWith('exact_match') ? '✓' : v.startsWith('would submit') ? '·' : '✗'
    console.log(`  ${mark} ${label(r).padEnd(width)}  ${r.address}  ${v}`)
  })
}

if (dryRun) {
  table(rows.map((r) => r.outcome))
  const blocked = rows.filter((r) => r.problem).length
  console.log(`\ndry run: ${rows.length - blocked}/${rows.length} are exact_match or would be submitted`)
  process.exit(blocked ? 1 : 0)
}

// The verdict is Sourcify's own record, re-read, not what the jobs said.
const after = await pool(rows, 4, (r) => sourcify(r.address))
table(after.map((match, i) => (match === 'exact_match' ? match : `${match ?? 'unverified'} (${rows[i].outcome})`)))
const exact = after.filter((m) => m === 'exact_match').length
console.log(`\n${exact}/${rows.length} exact_match on Sourcify`)
process.exit(exact === rows.length ? 0 : 1)
