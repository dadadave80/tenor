/**
 * M1 step 1 — deploy the ATS system (BusinessLogicResolver + facets + Factory) to Hedera testnet.
 *
 * SPEC §11.1.1 calls this "the only Hardhat step in the project". It is not: the published 8.0.0
 * package ships this workflow compiled, with ethers v6 as its only chain dependency. See
 * `docs/GROUND-TRUTH.md` §7.
 *
 * This is the long pole of M1 — ~46 facets plus proxies and configurations. Two things make it
 * survivable on a public relay:
 *   - `deployOnlyBondConfig` skips the equity / loan / deposit configurations. Tenor's instrument is
 *     a bond, so those are dead weight.
 *   - checkpointing is left ON, so a relay hiccup half way through resumes instead of restarting.
 *     Re-running this script picks up where it stopped.
 *
 * Usage:  bun scripts/deploy-ats.ts
 */
import { deploySystemWithNewBlr } from '@hashgraph/asset-tokenization-contracts/scripts'
import { NETWORK, operator, scan, writeRecord } from './lib/ats'

const t0 = Date.now()
const { signer } = await operator()

console.log(`\ndeploying the ATS system to ${NETWORK} — this takes a while (~46 facets)\n`)

const out = await deploySystemWithNewBlr(signer, NETWORK, {
  // Only the bond configuration is needed; skipping the rest cuts a large slice of the deploy.
  deployOnlyBondConfig: true,
  // Hedera's per-transaction gas ceiling is well below "all facets in one go".
  partialBatchDeploy: true,
  batchSize: 8,
  saveOutput: true,
  enableRetry: true,
  verifyDeployment: true,
  // Auto-resume an incomplete deployment rather than starting over.
  autoResume: true,
})

const resolver = out.infrastructure.blr.proxy
const factory = out.infrastructure.factory.proxy

writeRecord({
  network: NETWORK,
  deployer: out.deployer,
  resolver,
  factory,
  proxyAdmin: out.infrastructure.proxyAdmin.address,
  bondConfigId: out.configurations.bond?.configId,
  bondConfigVersion: out.configurations.bond?.version,
})

console.log(`
ATS system deployed in ${((Date.now() - t0) / 1000).toFixed(0)}s

  BusinessLogicResolver  ${resolver}
                         ${scan('contract', resolver)}
  Factory                ${factory}
                         ${scan('contract', factory)}
  ProxyAdmin             ${out.infrastructure.proxyAdmin.address}
  bond config            ${out.configurations.bond?.configId} v${out.configurations.bond?.version}

  facets ${out.summary.totalFacets} · contracts ${out.summary.totalContracts} · gas ${out.summary.gasUsed}

next:  bun scripts/issue-bond.ts
`)

if (!out.summary.success) {
  console.error('deployment reported success: false — inspect the output file before continuing')
  process.exit(1)
}
