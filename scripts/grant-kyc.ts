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
 * Usage:  bun scripts/grant-kyc.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Wallet } from 'ethers'
import {
  IERC20__factory,
  IKyc__factory,
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
if (existsSync(INVESTORS)) {
  investors = JSON.parse(readFileSync(INVESTORS, 'utf8')) as Investors
  console.log('reusing investors from deployments/296/investors.json')
} else {
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

console.log('\ngranting KYC …')
await record('grantKyc(A)', kyc.grantKyc(investorA, 'tenor-demo-A', validFrom, validTo, investorA))
await record('grantKyc(B)', kyc.grantKyc(investorB, 'tenor-demo-B', validFrom, validTo, investorA))
console.log(`  – investor C (${investorC}) is left UNVERIFIED on purpose`)

// --- mint to A -----------------------------------------------------------------------------------
console.log('\nminting …')
await record('issue(A, 1000 TGN27)', mint.issue(investorA, MINT, '0x'))

// --- proof 1: a compliant transfer succeeds ------------------------------------------------------
console.log('\ntransfer proofs …')
await record(
  'transfer A→B (verified, allowed)',
  erc1410.transferByPartition(partition, { to: investorB, value: MOVE }, '0x'),
)

// --- proof 2: the same transfer to an unverified holder is refused BY THE TOKEN ------------------
let blockedWith = ''
try {
  const tx = await erc1410.transferByPartition(partition, { to: investorC, value: MOVE }, '0x')
  await tx.wait()
  console.error('  ✗ transfer A→C SUCCEEDED — it must not. Is internalKycActivated set on the token?')
  process.exit(1)
} catch (e: unknown) {
  // Expected. ATS refuses the transfer because C has no KYC — this is the compliance guarantee the
  // whole product rests on, so it is asserted rather than assumed.
  const err = e as { shortMessage?: string; message?: string; data?: string }
  blockedWith = err.shortMessage ?? err.message ?? 'reverted'
  console.log(`  ✓ transfer A→C blocked by the token: ${blockedWith.slice(0, 120)}`)
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
    transfer A→C                       reverted (no KYC): ${blockedWith.slice(0, 60)}

next:  deploy the Tenor diamond, then bun scripts/integration.ts
`)
