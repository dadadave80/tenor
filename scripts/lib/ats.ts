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
  notes?: Record<string, string>
}

export function readRecord(): AtsRecord {
  if (!existsSync(RECORD)) return {}
  return JSON.parse(readFileSync(RECORD, 'utf8')) as AtsRecord
}

/** Merges `patch` into the record on disk. Never drops keys written by an earlier step. */
export function writeRecord(patch: AtsRecord): AtsRecord {
  const merged = { ...readRecord(), ...patch }
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
export async function operator(): Promise<{ signer: Signer; address: string; provider: JsonRpcProvider }> {
  const pk = process.env.PRIVATE_KEY ?? process.env.HEDERA_TESTNET_PRIVATE_KEY_0
  if (!pk) throw new Error('Set PRIVATE_KEY in contracts/.env (a funded Hedera testnet ECDSA key).')

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

  const balance = await provider.getBalance(address)
  console.log(`operator ${address}`)
  console.log(`balance  ${(Number(balance) / 1e18).toFixed(4)} HBAR`)
  if (balance === 0n) {
    throw new Error(
      `${address} has no HBAR. Fund it at https://portal.hedera.com (or send HBAR to that address ` +
        `from an existing testnet account — a transfer to a fresh EVM address creates the account).`,
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
