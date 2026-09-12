/**
 * Shared plumbing for the ATS scripts: env, signer, and the deployment record.
 *
 * ATS 8.0.0 ships its deploy tooling already compiled under `build/scripts/`, exposed through the
 * package's `./scripts` export. Its only runtime dependencies are ethers v6, zod and dotenv — there
 * is no Hardhat anywhere in the path, so everything here runs under Bun directly.
 * See `docs/GROUND-TRUTH.md` §7.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { JsonRpcProvider, Wallet, type Signer } from 'ethers'

/** Hedera testnet. HBAR is 18 dp on the EVM side, 8 dp natively. */
export const CHAIN_ID = 296
/** The network name ATS's own tooling keys its per-network tuning off. */
export const NETWORK = 'hedera-testnet'
export const DEFAULT_RPC = 'https://testnet.hashio.io/api'
export const DEFAULT_MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1'

/** Where deployed addresses are recorded, per chain. */
const RECORD = resolve(import.meta.dir, '../../deployments/296/ats.json')

/** Everything M1 produces. Written incrementally so a failed step never loses what came before. */
export type AtsRecord = {
  network?: string
  /**
   * Hash of block 0 — the identity of the chain INSTANCE, not just its id.
   *
   * A local chain can serve id 296 (`anvil --chain-id 296` is how the deploy scripts get rehearsed
   * without spending testnet HBAR), and then this record holds addresses that mean nothing on the
   * real network while still claiming `network: "hedera-testnet"`. Every later step reads those
   * addresses. The genesis hash is what makes that mistake loud instead of silent.
   */
  genesis?: string
  deployer?: string
  /** BusinessLogicResolver proxy — this is what `SecurityDataParams.resolver` wants. */
  resolver?: string
  /** Factory proxy — the contract that deploys token diamonds. */
  factory?: string
  proxyAdmin?: string
  /** Bond configuration id + version, for `resolverProxyConfiguration`. */
  bondConfigId?: string
  bondConfigVersion?: number
  /** The issued bond token (itself a diamond). */
  token?: string
  partition?: string
  decimals?: number
  /** Test USDC, once created. */
  usdc?: string
  /** The Tenor diamond, once deployed. */
  tenor?: string
  /**
   * Block the diamond was deployed in.
   *
   * The client needs it because Hashio caps `eth_getLogs` at a SEVEN DAY window and rejects
   * `fromBlock: "earliest"` outright (`-32004 ... exceed the maximum allowed duration of 7 days`).
   * Enumerating anything from events therefore needs a real starting block, not a tag.
   */
  deployBlock?: number
  notes?: Record<string, string>
}

/** Set by `operator()` once the chain has been identified, so `writeRecord` can stamp it. */
let chainKey: string | undefined

export function readRecord(): AtsRecord {
  if (!existsSync(RECORD)) return {}
  return JSON.parse(readFileSync(RECORD, 'utf8')) as AtsRecord
}

/** Merges `patch` into the record on disk. Never drops keys written by an earlier step. */
export function writeRecord(patch: AtsRecord): AtsRecord {
  const merged = { ...readRecord(), ...(chainKey ? { genesis: chainKey } : {}), ...patch }
  mkdirSync(dirname(RECORD), { recursive: true })
  writeFileSync(RECORD, `${JSON.stringify(merged, null, 2)}\n`)
  console.log(`  ↳ recorded in deployments/296/ats.json`)
  return merged
}

/**
 * Builds the operator signer.
 *
 * ATS's own `infrastructure/signer` is not in the package's export map, so we construct the signer
 * ourselves. That is also what we want: full control over the provider, and no dependence on a
 * non-exported internal.
 */
export async function operator(opts: { minHbar?: number } = {}): Promise<{
  signer: Signer
  address: string
  provider: JsonRpcProvider
}> {
  const raw = process.env.PRIVATE_KEY ?? process.env.HEDERA_TESTNET_PRIVATE_KEY_0
  if (!raw) {
    throw new Error(
      'Set PRIVATE_KEY in contracts/.env (a funded Hedera testnet ECDSA key), and run these ' +
        'scripts via `bun run <script>` so the env file is loaded.',
    )
  }
  // portal.hedera.com shows the key without the 0x prefix; ethers requires it.
  const pk = raw.startsWith('0x') ? raw : `0x${raw}`

  const rpc = process.env.HEDERA_TESTNET_RPC ?? process.env.HEDERA_TESTNET_JSON_RPC_ENDPOINT ?? DEFAULT_RPC

  // ATS's tooling reads these prefixed names internally for its own config validation, so mirror
  // whatever we resolved into them before any ATS import runs its module-level config parse.
  process.env.HEDERA_TESTNET_JSON_RPC_ENDPOINT ??= rpc
  process.env.HEDERA_TESTNET_MIRROR_NODE_ENDPOINT ??= process.env.HEDERA_TESTNET_MIRROR ?? DEFAULT_MIRROR
  process.env.HEDERA_TESTNET_PRIVATE_KEY_0 ??= pk

  const provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true })
  const signer = new Wallet(pk, provider)
  const address = await signer.getAddress()

  const net = await provider.getNetwork()
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC is chain ${net.chainId}, expected ${CHAIN_ID} (Hedera testnet).`)
  }

  // Block 0 pins which chain this record belongs to. Checked before the balance so a record from a
  // local rehearsal is rejected up front rather than after a step has spent HBAR.
  const genesis = (await provider.getBlock(0))?.hash ?? undefined
  const existing = readRecord()
  if (genesis && existing.genesis && existing.genesis !== genesis) {
    throw new Error(
      `deployments/296/ats.json was written against a different chain (genesis ` +
        `${existing.genesis.slice(0, 10)}…, this RPC is ${genesis.slice(0, 10)}…). It is almost ` +
        `certainly left over from a local rehearsal. Move it aside — ` +
        `\`git checkout deployments/296/ats.json\` — before deploying for real.`,
    )
  }
  chainKey = genesis

  // HBAR is 18 dp on the EVM side (8 dp natively).
  const balance = await provider.getBalance(address)
  const hbar = Number(balance) / 1e18
  console.log(`operator ${address}`)
  console.log(`balance  ${hbar.toFixed(4)} HBAR`)

  // Checked up front on purpose: the ATS system deploy is ~46 facets plus proxies, and running dry
  // at facet 30 wastes both the HBAR already spent and the wall-clock.
  const min = opts.minHbar ?? 0
  if (balance === 0n) {
    throw new Error(
      `${address} has no HBAR, so it is not even a Hedera account yet.\n` +
        `Create a testnet account at https://portal.hedera.com — choose an ECDSA key — and put that ` +
        `key in contracts/.env as PRIVATE_KEY and HEDERA_TESTNET_PRIVATE_KEY_0. The portal issues its ` +
        `own keyed account; it does not send HBAR to an address you supply. Alternatively, transfer ` +
        `HBAR to ${address} from an existing testnet account, which creates the account for that key.`,
    )
  }
  if (hbar < min) {
    throw new Error(
      `${address} holds ${hbar.toFixed(2)} HBAR; this step wants at least ${min}. ` +
        `Top it up before continuing rather than failing part-way through.`,
    )
  }
  return { signer, address, provider }
}

/** `hashscan` link for anything with an id or address. */
export function scan(kind: 'contract' | 'transaction' | 'account' | 'token', id: string): string {
  return `https://hashscan.io/testnet/${kind}/${id}`
}

export function requireRecord<K extends keyof AtsRecord>(keys: K[]): Required<Pick<AtsRecord, K>> {
  const rec = readRecord()
  const missing = keys.filter((k) => rec[k] === undefined)
  if (missing.length) {
    throw new Error(`deployments/296/ats.json is missing ${missing.join(', ')} — run the earlier script first.`)
  }
  return rec as Required<Pick<AtsRecord, K>>
}
