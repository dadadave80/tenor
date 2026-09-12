/**
 * M2 — deploys the Tenor diamond, then records it.
 *
 * This is a wrapper around `forge script` rather than a raw package.json line because `run()` takes
 * seven arguments and four of them live in `deployments/296/ats.json`, written by the three steps
 * before this one. Typing them by hand at 13:00 on deadline day is how the wrong token gets pinned
 * into an immutable market.
 *
 * Verification is not optional here: HashScan/Sourcify verification is a Hedera qualification
 * requirement, so `--verify` is part of the command rather than a follow-up someone remembers.
 *
 * Usage:  bun run deploy:tenor
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { operator, requireRecord, scan, writeRecord } from './lib/ats'

const CONTRACTS = resolve(import.meta.dir, '../contracts')

/** SPEC §5.1: fee disabled for the demo, and a 30-day cap on how long a listing may reserve tokens. */
const FEE_BPS = 0
const MAX_DURATION = 30 * 24 * 60 * 60

/**
 * HBAR the diamond is seeded with so it can pay for the coupon calls it schedules itself.
 * 18 dp on the EVM side.
 */
const HBAR_SEED = 20n * 10n ** 18n

const { usdc, token } = requireRecord(['usdc', 'token'])
// `operator()` also guards the genesis hash, which is what stops a record left over from a local
// rehearsal being deployed against.
const { address: admin } = await operator({ minHbar: 40 })

// forge has no env var for the signing key, so it goes in argv. That makes it visible in this
// machine's process list for the length of the deploy; acceptable only because this is a disposable
// testnet key, as contracts/.env says. Without it forge broadcasts from its own default sender and
// `associateToken` reverts `AccessControlUnauthorizedAccount` after the diamond is already deployed.
const rawKey = process.env.PRIVATE_KEY ?? process.env.HEDERA_TESTNET_PRIVATE_KEY_0!
const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`

// Sourcify cannot see a chain it cannot reach, so a local rehearsal skips verification rather than
// failing after a successful deploy.
const rpc = process.env.HEDERA_TESTNET_RPC ?? ''
const local = /127\.0\.0\.1|localhost/.test(rpc)

// `admin` must be the broadcaster: `associateToken` is sent as the diamond admin immediately after
// assembly, and the init delegatecall cannot grant the role to the factory's caller.
const args = [
  'script',
  'script/DeployTenor.s.sol:DeployTenor',
  '--sig',
  'run(address,address,address,address,uint16,uint64,uint256)',
  admin,
  admin,
  usdc,
  token,
  String(FEE_BPS),
  String(MAX_DURATION),
  HBAR_SEED.toString(),
  '--rpc-url',
  'hedera-testnet',
  '--private-key',
  privateKey,
  '--broadcast',
  // Hedera's relay rejects the burst a default broadcast sends; --slow waits for each receipt.
  '--slow',
  ...(local ? [] : ['--verify', '--verifier', 'sourcify', '--verifier-url', 'https://server-verify.hashscan.io']),
]

console.log(`\nforge ${args.map((a) => (a === privateKey ? '<key>' : a)).join(' ')}\n`)
if (local) console.log('local chain — skipping Sourcify verification\n')
const forge = spawnSync('forge', args, { cwd: CONTRACTS, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
process.stdout.write(forge.stdout ?? '')
if (forge.status !== 0) {
  throw new Error(`forge script exited ${forge.status}`)
}

// `run()` returns the diamond, and forge prints it in the `== Return ==` block keyed by the
// return parameter's NAME, not by index.
const tenor = /^tenor:\s*address\s+(0x[0-9a-fA-F]{40})/m.exec(forge.stdout ?? '')?.[1]
if (!tenor) {
  throw new Error(
    'Could not find the diamond address in the forge output. It deployed — read it from the ' +
      'broadcast log at contracts/broadcast/ and add it to deployments/296/ats.json by hand.',
  )
}

writeRecord({ tenor })
console.log(`\nTenor deployed`)
console.log(`  tenor       ${tenor}`)
console.log(`              ${scan('contract', tenor)}`)
console.log(`  usdc        ${usdc}`)
console.log(`  security    ${token}`)
console.log(`  fee         ${FEE_BPS} bps · max listing ${MAX_DURATION / 86400} days`)
console.log(`\nnext:  put NEXT_PUBLIC_TENOR_ADDRESS=${tenor} in apps/web/.env.local, then bun run integration`)
