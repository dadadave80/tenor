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
const { address: admin } = await operator({ minHbar: 100 })

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
const out = forge.stdout ?? ''
process.stdout.write(out)

// Order matters here. `forge script --verify` exits NON-ZERO when any contract fails to verify --
// which happens after the broadcast has already succeeded. Throwing on the exit code first would
// discard the address of a diamond that exists on chain, which is unrecoverable-looking for what is
// really a Sourcify hiccup. Ten facets from a submodule with remappings plus a nested CREATE2
// diamond is exactly where that goes wrong. So: read the address, record it, and only then complain.
//
// The `== Return ==` block is printed from the simulation, so the address is there either way, and
// it is keyed by the return parameter's NAME rather than by index.
const landed = /ONCHAIN EXECUTION COMPLETE & SUCCESSFUL/.test(out)
const tenor = /^tenor:\s*address\s+(0x[0-9a-fA-F]{40})/m.exec(out)?.[1]

if (!landed) {
  throw new Error(
    `The broadcast did not complete (forge exited ${forge.status}).` +
      (tenor ? ` A diamond may exist at ${tenor} — check contracts/broadcast/ before rerunning.` : ''),
  )
}
if (!tenor) {
  throw new Error(
    'The broadcast completed but the diamond address was not in the output. Read it from ' +
      'contracts/broadcast/DeployTenor.s.sol/296/run-latest.json and add it to ' +
      'deployments/296/ats.json by hand.',
  )
}

writeRecord({ tenor })

if (forge.status !== 0) {
  console.warn(
    `\n⚠ The deploy succeeded and is recorded, but forge exited ${forge.status} — almost certainly ` +
      `verification.\n  Retry just the verification with:\n` +
      `  cd contracts && forge script script/DeployTenor.s.sol:DeployTenor --rpc-url hedera-testnet --resume --verify \\\n` +
      `    --verifier sourcify --verifier-url https://server-verify.hashscan.io`,
  )
}
console.log(`\nTenor deployed`)
console.log(`  tenor       ${tenor}`)
console.log(`              ${scan('contract', tenor)}`)
console.log(`  usdc        ${usdc}`)
console.log(`  security    ${token}`)
console.log(`  fee         ${FEE_BPS} bps · max listing ${MAX_DURATION / 86400} days`)
console.log(`\nnext:  bun run sync:env  →  bun run integration`)
