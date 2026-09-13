/**
 * Verifies on Sourcify every contract a Tenor deployment created, and proves none was missed.
 *
 * **What gets verified is discovered, not listed.**
 *
 *  1. The forge broadcast record names every transaction the deploy sent, and the address of each CREATE.
 *  2. The diamond is not one of those CREATEs. The factory's `deploy` CREATE2s it inside a CALL, and forge's record
 *     does not list it (`additionalContracts` stays empty). The factory's `DiamondDeployed` event in that call's
 *     receipt names it instead.
 *  3. For each transaction, the mirror node's `created_contract_ids` lists every contract it created, including
 *     contracts created inside a call. The record's account must equal the mirror node's in both directions. An
 *     address only one side knows is a blind spot, and the run stops before submitting anything.
 *
 * **An address Sourcify already holds as `exact_match` is skipped before anything else.** It is not compared with
 * the local build at all. A comment edited after the deploy (the banners on TenorMarket and TenorCoupon, say) moves
 * the local metadata hash, and a rerun must not fail over contracts that were verified before the edit.
 *
 * **Every other address is identified by its code.** Its on-chain runtime is compared, metadata hash included, with
 * every artifact in `contracts/out`. A full match names the source file and contract (`compilationTarget`) and the
 * compiler, and is what Sourcify reports as `exact_match`. A match that differs only in the metadata hash means this
 * tree is not the one that was deployed. That address is reported and not submitted, because the best Sourcify could
 * return is a partial match.
 *
 * **Why not `forge script --verify`.** It cannot be, as of foundry 1.8.1:
 *
 *  - `server-verify.hashscan.io` now answers every path with a 308 redirect to `sourcify.dev/server`.
 *  - Sourcify has removed the v1 `POST /verify` endpoint that foundry posts to, so every submission comes back
 *    `404 Not Found`. The 404 is the API being gone, and retrying cannot fix it.
 *
 * Sourcify's v2 API supports chain 296, so this submits `POST /v2/verify/296/{address}` with the solc standard-json
 * input (which `forge verify-contract --show-standard-json-input` produces), then polls the job.
 *
 * Usage:  bun run verify:tenor [--dry-run] [--broadcast <run.json>]
 *         --dry-run    discover, identify and report; submit nothing
 *         --broadcast  a record other than DeployTenor's run-latest.json
 *
 * Exits 0 only when Sourcify, re-read at the end, holds every discovered contract as `exact_match`. A dry run exits 0
 * when every one is either `exact_match` already or would be submitted as an exact match.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Contract, JsonRpcProvider, getAddress, id } from 'ethers'
import { CHAIN_ID, DEFAULT_MIRROR, DEFAULT_RPC, readRecord, scan } from './lib/ats'

const ROOT = resolve(import.meta.dir, '..')
const CONTRACTS = join(ROOT, 'contracts')
const SOURCIFY = 'https://sourcify.dev/server'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const at = args.indexOf('--broadcast')
if (at >= 0 && !args[at + 1]) throw new Error('--broadcast needs the path of a run-*.json record.')
const BROADCAST =
  at >= 0 ? resolve(args[at + 1]) : join(CONTRACTS, `broadcast/DeployTenor.s.sol/${CHAIN_ID}/run-latest.json`)

const provider = new JsonRpcProvider(process.env.HEDERA_TESTNET_RPC ?? DEFAULT_RPC, CHAIN_ID, { staticNetwork: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const short = (path: string) => path.replace(`${ROOT}/`, '')

/**
 * Emitted by the factory in the call that creates the diamond, with the diamond as the first indexed argument.
 * LatticeFactory emits it for the nested diamond; a Tenor deployment's diamond is a top-level CREATE the record lists.
 */
const DIAMOND_DEPLOYED = id('DiamondDeployed(address,address,bytes32)')

// --- 1. the broadcast record's account ---------------------------------------------------------------------------
type BroadcastTx = { hash: string; transactionType: string; contractAddress: string | null }
type Receipt = { transactionHash: string; status: string; logs: { address: string; topics: string[] }[] }
const record = JSON.parse(readFileSync(BROADCAST, 'utf8')) as {
  chain: number
  commit?: string
  transactions: BroadcastTx[]
  receipts: Receipt[]
}
if (record.chain !== CHAIN_ID) throw new Error(`${short(BROADCAST)} is a chain ${record.chain} record, not ${CHAIN_ID}.`)

const fromRecord = new Map<string, string>() // address -> hash of the transaction that created it
for (const tx of record.transactions) {
  const receipt = record.receipts.find((r) => r.transactionHash === tx.hash)
  if (!receipt) throw new Error(`No receipt for ${tx.hash}: the broadcast did not finish.`)
  if (receipt.status !== '0x1') throw new Error(`${tx.hash} reverted on chain.`)
  if (!tx.contractAddress) continue
  const target = getAddress(tx.contractAddress)
  if (tx.transactionType.startsWith('CREATE')) fromRecord.set(target, tx.hash)
  for (const log of receipt.logs) {
    // Only the called contract's own event counts. The diamond's facets emit from the diamond's address, so nothing
    // they log can add an address here.
    if (log.topics[0] === DIAMOND_DEPLOYED && getAddress(log.address) === target) {
      fromRecord.set(getAddress(`0x${log.topics[1].slice(26)}`), tx.hash)
    }
  }
}

// --- 2. the chain's account --------------------------------------------------------------------------------------
async function mirror<T>(path: string): Promise<T> {
  // The mirror node trails consensus by a few seconds, so a transaction that has just landed can 404 briefly.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${DEFAULT_MIRROR}${path}`)
    if (res.ok) return (await res.json()) as T
    if (attempt === 10) throw new Error(`The mirror node answered ${res.status} for ${path}.`)
    await sleep(3000)
  }
}

const fromChain = new Map<string, string>()
for (const tx of record.transactions) {
  const result = await mirror<{ created_contract_ids?: string[] }>(`/contracts/results/${tx.hash}`)
  for (const contractId of result.created_contract_ids ?? []) {
    const contract = await mirror<{ evm_address: string }>(`/contracts/${contractId}`)
    fromChain.set(getAddress(contract.evm_address), tx.hash)
  }
}

const unrecorded = [...fromChain.keys()].filter((a) => !fromRecord.has(a))
const unconfirmed = [...fromRecord.keys()].filter((a) => !fromChain.has(a))
if (unrecorded.length || unconfirmed.length) {
  if (unrecorded.length) console.error(`Created on chain but not accounted for by the record: ${unrecorded.join(', ')}`)
  if (unconfirmed.length) console.error(`In the record but not created on chain: ${unconfirmed.join(', ')}`)
  process.exit(1)
}
const sent = record.transactions.length
console.log(`\n${fromChain.size} contracts created by the ${sent} transactions in ${short(BROADCAST)}`)

// The diamond must route only to facets this deployment created, or verifying the set would leave live code out.
const { tenor } = readRecord()
if (tenor && fromChain.has(getAddress(tenor))) {
  const loupe = new Contract(tenor, ['function facetAddresses() view returns (address[])'], provider)
  const stray = ((await loupe.facetAddresses()) as string[]).filter((f) => !fromChain.has(getAddress(f)))
  if (stray.length) {
    console.error(`The diamond routes to facets this deployment did not create: ${stray.join(', ')}`)
    process.exit(1)
  }
} else if (tenor) {
  console.log(`note: deployments/296/ats.json names ${tenor}, which ${short(BROADCAST)} did not create`)
}

const head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT })
const checkedOut = head.stdout.toString().trim()
if (record.commit && head.exitCode === 0 && !checkedOut.startsWith(record.commit)) {
  console.log(`deployed from commit ${record.commit}, checked out ${checkedOut}; code identity is checked per address`)
}

// --- 3. what Sourcify already holds ------------------------------------------------------------------------------
type Status = { match: string | null; name?: string }

async function sourcify(address: string): Promise<Status> {
  const res = await fetch(`${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}?fields=compilation.fullyQualifiedName`)
  // An address Sourcify does not hold answers 404. Any other failure is Sourcify's, and reading it as "unverified"
  // would send a submission nobody needs.
  if (res.status === 404) return { match: null }
  if (!res.ok) throw new Error(`Sourcify answered ${res.status} for ${address}.`)
  const body = (await res.json()) as { match: string | null; compilation?: { fullyQualifiedName?: string } }
  return { match: body.match, name: body.compilation?.fullyQualifiedName }
}

const before = new Map<string, Status>()
for (const address of fromChain.keys()) before.set(address, await sourcify(address))
const pending = [...fromChain.keys()].filter((a) => before.get(a)?.match !== 'exact_match')

// --- 4. identify each remaining address by its code --------------------------------------------------------------
type Range = { start: number; length: number }
type Artifact = { identifier: string; compiler: string; runtime: string; immutables: Range[] }

function loadArtifacts(): Artifact[] {
  const build = Bun.spawnSync(['forge', 'build'], { cwd: CONTRACTS, stdout: 'ignore', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`forge build failed:\n${build.stderr.toString().slice(-800)}`)

  const out = join(CONTRACTS, 'out')
  const found: Artifact[] = []
  for (const dir of readdirSync(out)) {
    if (dir === 'build-info' || !statSync(join(out, dir)).isDirectory()) continue
    for (const file of readdirSync(join(out, dir))) {
      if (!file.endsWith('.json')) continue
      const a = JSON.parse(readFileSync(join(out, dir, file), 'utf8'))
      const runtime: string | undefined = a.deployedBytecode?.object
      const target: Record<string, string> | undefined = a.metadata?.settings?.compilationTarget
      if (!runtime || runtime === '0x' || !target) continue
      const [path, name] = Object.entries(target)[0]
      found.push({
        identifier: `${path}:${name}`,
        compiler: a.metadata.compiler.version,
        runtime: runtime.slice(2).toLowerCase(),
        immutables: Object.values(a.deployedBytecode.immutableReferences ?? {}).flat() as Range[],
      })
    }
  }
  return found
}

/** Immutables are written at deployment, so both sides are compared with those ranges zeroed. */
function blank(hex: string, ranges: Range[]): string {
  if (!ranges.length) return hex
  const bytes = Buffer.from(hex, 'hex')
  for (const r of ranges) bytes.fill(0, r.start, r.start + r.length)
  return bytes.toString('hex')
}

/** Drops the CBOR metadata trailer; its length is the last two bytes. */
const executable = (hex: string) => hex.slice(0, hex.length - (Number.parseInt(hex.slice(-4), 16) + 2) * 2)

function identify(runtime: string, artifacts: Artifact[]): { artifact: Artifact; exact: boolean } | undefined {
  let sameCode: Artifact | undefined
  for (const a of artifacts) {
    if (a.runtime.length !== runtime.length) continue
    const chain = blank(runtime, a.immutables)
    const built = blank(a.runtime, a.immutables)
    if (chain === built) return { artifact: a, exact: true }
    if (!sameCode && executable(chain) === executable(built)) sameCode = a
  }
  return sameCode && { artifact: sameCode, exact: false }
}

// --- 5. submit ---------------------------------------------------------------------------------------------------
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

async function submit(address: string, artifact: Artifact): Promise<string> {
  const res = await fetch(`${SOURCIFY}/v2/verify/${CHAIN_ID}/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: await standardJson(artifact.identifier),
      compilerVersion: artifact.compiler,
      contractIdentifier: artifact.identifier,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { verificationId?: string; message?: string; customCode?: string }
  if (!res.ok || !body.verificationId) {
    return `rejected ${res.status} ${body.customCode ?? ''} ${body.message ?? ''}`.trim()
  }

  // The job is asynchronous. Poll until it resolves rather than reporting a submission as a success.
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const poll = await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`)
    if (!poll.ok) continue
    const job = (await poll.json()) as {
      isJobCompleted?: boolean
      contract?: { match?: string | null }
      error?: { message?: string; customCode?: string }
    }
    if (!job.isJobCompleted) continue
    return job.contract?.match ?? `failed ${job.error?.customCode ?? ''} ${job.error?.message ?? ''}`.trim()
  }
  return 'timeout'
}

const artifacts = pending.length ? loadArtifacts() : []
const rows: { address: string; name: string; outcome: string }[] = []
for (const address of fromChain.keys()) {
  const status = before.get(address) as Status
  let name = status.name ?? '?'
  let outcome: string
  if (status.match === 'exact_match') outcome = 'exact_match (already)'
  else {
    const runtime = (await provider.getCode(address)).slice(2).toLowerCase()
    const hit = runtime ? identify(runtime, artifacts) : undefined
    if (hit) name = hit.artifact.identifier
    if (!hit) outcome = 'unidentified: no artifact in contracts/out has this code'
    else if (!hit.exact) outcome = 'not submitted: this tree differs from the deployed source (metadata hash only)'
    else if (dryRun) outcome = `would submit (now ${status.match ?? 'unverified'})`
    else outcome = await submit(address, hit.artifact)
  }
  rows.push({ address, name, outcome })
  console.log(`  ${outcome.startsWith('exact_match') ? '✓' : '·'} ${address}  ${name.padEnd(80)} ${outcome}`)
}

// --- 6. verdict --------------------------------------------------------------------------------------------------
function table(entries: { address: string; name: string; verdict: string }[]) {
  const names = entries.map((e) => e.name.split(':').pop() as string)
  const width = Math.max(...names.map((n) => n.length))
  console.log()
  entries.forEach((e, i) => {
    const mark = e.verdict.startsWith('exact_match') ? '✓' : e.verdict.startsWith('would submit') ? '·' : '✗'
    console.log(`  ${mark} ${names[i].padEnd(width)}  ${e.address}  ${e.verdict}`)
  })
}

if (dryRun) {
  table(rows.map((r) => ({ ...r, verdict: r.outcome })))
  const blocked = rows.filter((r) => r.outcome.startsWith('unidentified') || r.outcome.startsWith('not submitted'))
  console.log(`\ndry run: ${rows.length - blocked.length}/${rows.length} are exact_match or would be submitted as exact`)
  process.exit(blocked.length ? 1 : 0)
}

// The verdict is Sourcify's own record, re-read, not what the jobs said.
const after: { address: string; name: string; verdict: string }[] = []
for (const r of rows) after.push({ ...r, verdict: (await sourcify(r.address)).match ?? 'unverified' })
table(after)
const exact = after.filter((a) => a.verdict === 'exact_match').length
console.log(`\n${exact}/${after.length} exact_match on Sourcify`)
if (tenor) console.log(`  diamond  ${scan('contract', tenor)}`)
process.exit(exact === after.length ? 0 : 1)
