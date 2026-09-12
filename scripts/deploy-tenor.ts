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
import { resolve } from 'node:path'
import { Contract } from 'ethers'
import { operator, requireRecord, scan, writeRecord } from './lib/ats'
import { startRelayShim } from './lib/relay-shim'

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
const { address: admin, signer, provider } = await operator({ minHbar: 100 })

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

// forge cannot talk to Hashio directly: it pins its nonce lookup to a block hash using EIP-1898's
// object form, which the relay rejects outright. See `lib/relay-shim.ts`. Anvil accepts the object
// form, so a local rehearsal talks to the node directly.
const shim = local ? null : startRelayShim(rpc || 'https://testnet.hashio.io/api')
if (shim) console.log(`relay shim on ${shim.url} -> ${rpc}  (rewrites EIP-1898 block params)`)

// `admin` must be the broadcaster: `associateToken` is sent as the diamond admin immediately after
// assembly, and the init delegatecall cannot grant the role to the factory's caller.
const args = [
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
  shim ? shim.url : 'hedera-testnet',
  '--private-key',
  privateKey,
  '--broadcast',
  // Hedera's relay rejects the burst a default broadcast sends; --slow waits for each receipt.
  '--slow',
  // Required, not an optimisation. forge simulates the whole script with `eth_call` first, and
  // Hedera's `eth_call` does not execute state-changing HTS precompile calls: the post-deploy
  // `associateToken` comes back `HTSCallFailed(0x49146bde, 21)` -- response code 21, UNKNOWN -- and
  // forge abandons the run before broadcasting anything. The association works in a real
  // transaction; it is only unsimulatable. The deploy is covered by 165 local tests and a full
  // rehearsal against anvil instead.
  '--skip-simulation',
  ...(local ? [] : ['--verify', '--verifier', 'sourcify', '--verifier-url', 'https://server-verify.hashscan.io']),
]

console.log(`\nforge ${args.map((a) => (a === privateKey ? '<key>' : a)).join(' ')}\n`)
if (local) console.log('local chain — skipping Sourcify verification\n')
// Spawned ASYNCHRONOUSLY, not with spawnSync: the shim is an HTTP server in this same process, and
// a synchronous spawn blocks the event loop for the whole deploy — so every request forge makes to
// the shim times out and forge reports it cannot reach the chain.
const proc = Bun.spawn(['forge', ...args], { cwd: CONTRACTS, stdout: 'pipe', stderr: 'inherit' })
const out = await new Response(proc.stdout).text()
const status = await proc.exited
process.stdout.write(out)
if (shim) {
  console.log(`\nrelay shim rewrote ${shim.rewrites()} request(s)`)
  shim.stop()
}
const forge = { status }

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

// Recorded because Hashio caps `eth_getLogs` at a 7-day window and refuses `fromBlock: "earliest"`,
// so the client cannot enumerate anything from events without a real starting block.
const deployBlock = await provider.getBlockNumber()
writeRecord({ tenor, deployBlock })

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
  console.log(`diamond already holds ${Number(seeded) / 1e18} HBAR`)
} else {
  console.log('seeding the diamond with HBAR for its scheduled calls ...')
  const tx = await signer.sendTransaction({ to: tenor, value: HBAR_SEED - seeded })
  await tx.wait()
  console.log(`  ✓ HBAR seed                          ${tx.hash}`)
}

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
console.log(`  hbar        ${Number(await provider.getBalance(tenor)) / 1e18} HBAR held for scheduled calls`)
console.log(`\nnext:  bun run sync:env  →  bun run integration`)
