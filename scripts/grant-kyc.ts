/**
 * M1 step 3 — the eligibility evidence run: KYC grants, mint, and the two transfer proofs.
 *
 * M1's definition of done is "KYC granted to A and B, not C; mint; one successful transfer; one
 * blocked transfer; transaction ids recorded". This script produces all of it in one pass and prints
 * the HashScan links for the README.
 *
 * Investor A is the operator itself. That is deliberate: A has to SIGN the transfer proof, so A needs
 * HBAR for gas, and the operator is the only funded account at this stage. B and C never sign here —
 * they only receive — so they can be unfunded addresses. B and C get real keys anyway (persisted, so
 * reruns are stable) because the web demo later signs as them from Privy wallets.
 *
 * Note the security token is a plain Solidity diamond, not an HTS token, so B and C need no HTS
 * association to hold it. Only USDC does.
 *
 * Usage:  bun run grant:kyc
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Wallet } from 'ethers'
import {
  IERC20__factory,
  IKyc__factory,
  ISsiManagement__factory,
  IMint__factory,
  ITransferByPartition__factory,
} from '@hashgraph/asset-tokenization-contracts/typechain-types'
import { operator, requireRecord, scan } from './lib/ats'

const INVESTORS = resolve(import.meta.dir, '../deployments/296/investors.json')

const { token, partition, decimals } = requireRecord(['token', 'partition', 'decimals'])
const { signer, address: investorA } = await operator()

// --- B and C: generated once, then stable across reruns -----------------------------------------
type Investors = { B: { address: string; privateKey: string }; C: { address: string; privateKey: string } }
let investors: Investors
// Shape-checked, not just existence-checked: the reason is that a file which parses but is not this
// shape produced `undefined is not an object` three lines later, with a log line above it claiming
// the investors had been reused.
const saved = existsSync(INVESTORS) ? (JSON.parse(readFileSync(INVESTORS, 'utf8')) as Partial<Investors>) : null
if (saved?.B?.address && saved?.C?.address) {
  investors = saved as Investors
  console.log('reusing investors from deployments/296/investors.json')
} else {
  if (saved) console.log('deployments/296/investors.json is not an investor file — regenerating')
  const b = Wallet.createRandom()
  const c = Wallet.createRandom()
  investors = {
    B: { address: b.address, privateKey: b.privateKey },
    C: { address: c.address, privateKey: c.privateKey },
  }
  mkdirSync(dirname(INVESTORS), { recursive: true })
  writeFileSync(INVESTORS, `${JSON.stringify(investors, null, 2)}\n`)
  console.log('generated investors B and C → deployments/296/investors.json (gitignored, testnet only)')
}
const investorB = investors.B.address
const investorC = investors.C.address

const one = 10n ** BigInt(decimals)
const MINT = 1_000n * one // 1,000 notes to A
const MOVE = 10n * one // the transfer proof size

const kyc = IKyc__factory.connect(token, signer)
const mint = IMint__factory.connect(token, signer)
// `transferByPartition` takes an IERC1410Types.BasicTransferInfo struct, not flat (to, value) args.
const erc1410 = ITransferByPartition__factory.connect(token, signer)
const erc20 = IERC20__factory.connect(token, signer)

const txids: Array<[string, string]> = []
const record = async (label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
  const tx = await p
  await tx.wait()
  txids.push([label, tx.hash])
  console.log(`  ✓ ${label.padEnd(34)} ${tx.hash}`)
  return tx
}

// --- KYC: A and B verified, C deliberately not --------------------------------------------------
const validFrom = Math.floor(Date.now() / 1000)
const validTo = validFrom + 5 * 365 * 24 * 60 * 60

// `grantKyc`'s last argument is the KYC issuer, and ATS checks it against the token's SSI issuer
// registry rather than against a role: an unregistered address reverts `AccountIsNotIssuer(address)`
// even when it holds every KYC role. Registering is idempotent-by-check because `addIssuer` reverts
// `ListedIssuer` on a second call, so this is guarded rather than retried.
const ssi = ISsiManagement__factory.connect(token, signer)
if (await ssi.isIssuer(investorA)) {
  console.log(`\nSSI issuer registry already lists ${investorA}`)
} else {
  console.log('\nregistering the operator as a KYC issuer …')
  await record('addIssuer(A)', ssi.addIssuer(investorA))
}

// `grantKyc` on an already-granted account reverts `InvalidKycStatus()` -- the SAME error a transfer
// to an unverified holder produces. So a rerun after any partial failure would die here, and the
// message would point at the opposite problem. Checked first instead.
const GRANTED = 1n
const grant = async (label: string, who: string, vc: string) => {
  if ((await kyc.getKycStatusFor(who)) === GRANTED) {
    console.log(`  – ${label.padEnd(34)} already granted`)
    return
  }
  await record(label, kyc.grantKyc(who, vc, validFrom, validTo, investorA))
}

console.log('\ngranting KYC …')
await grant('grantKyc(A)', investorA, 'tenor-demo-A')
await grant('grantKyc(B)', investorB, 'tenor-demo-B')
console.log(`  – investor C (${investorC}) is left UNVERIFIED on purpose`)

// --- mint to A -----------------------------------------------------------------------------------
console.log('\nminting …')
// `>= MINT` would be wrong: the A->B proof below moves 10 notes out, so a rerun would see 990,
// decide nothing had been minted, and mint another 1,000 every time.
if ((await erc20.balanceOf(investorA)) > 0n) {
  console.log(`  – issue(A, 1000 TGN27)               already holds ${(await erc20.balanceOf(investorA)).toString()}`)
} else {
  await record('issue(A, 1000 TGN27)', mint.issue(investorA, MINT, '0x'))
}

// --- proof 1: a compliant transfer succeeds ------------------------------------------------------
console.log('\ntransfer proofs …')
await record(
  'transfer A→B (verified, allowed)',
  erc1410.transferByPartition(partition, { to: investorB, value: MOVE }, '0x'),
)

// --- proof 2: the same transfer to an unverified holder is refused BY THE TOKEN ------------------
// This is the compliance guarantee the whole product rests on, so the SELECTOR is checked. Any
// revert would otherwise read as proof: a paused token, a missing role, a bad partition and a
// genuine KYC refusal all surface as "execution reverted (unknown custom error)" through ethers,
// and only one of them is evidence of anything.
const KYC_REFUSAL = IKyc__factory.createInterface().getError('InvalidKycStatus')!.selector
let blockedWith = ''
try {
  const tx = await erc1410.transferByPartition(partition, { to: investorC, value: MOVE }, '0x')
  await tx.wait()
  console.error('  ✗ transfer A→C SUCCEEDED — it must not. Is internalKycActivated set on the token?')
  process.exit(1)
} catch (e: unknown) {
  const err = e as { shortMessage?: string; message?: string; data?: string; info?: { error?: { data?: string } } }
  const data = err.data ?? err.info?.error?.data ?? ''
  if (!data.startsWith(KYC_REFUSAL)) {
    console.error(
      `  ✗ transfer A→C reverted, but NOT with InvalidKycStatus (${KYC_REFUSAL}).\n` +
        `    revert data: ${data || '(none returned)'}\n` +
        `    ${err.shortMessage ?? err.message ?? ''}\n` +
        `    The transfer failing is not by itself evidence that KYC is what stopped it.`,
    )
    process.exit(1)
  }
  blockedWith = `InvalidKycStatus() ${KYC_REFUSAL}`
  console.log(`  ✓ transfer A→C refused by the token with ${blockedWith}`)
}

const bal = async (who: string) => (await erc20.balanceOf(who)).toString()

console.log(`
M1 eligibility evidence complete

  token      ${token}
             ${scan('contract', token)}
  investor A ${investorA}   (verified · ${await bal(investorA)})
  investor B ${investorB}   (verified · ${await bal(investorB)})
  investor C ${investorC}   (UNVERIFIED · ${await bal(investorC)})

  transaction ids — paste into the README:
${txids.map(([l, h]) => `    ${l.padEnd(34)} ${scan('transaction', h)}`).join('\n')}
    transfer A→C                       refused by the token, ${blockedWith}

next:  deploy the Tenor diamond, then bun scripts/integration.ts
`)
