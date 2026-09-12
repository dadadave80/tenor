/**
 * M1 step 2 — issue "Tenor Green Note 2027" through the ATS Factory.
 *
 * The three flags at the top of `security` are not cosmetic: they are exactly what makes Tenor's
 * hold-based DVP possible at all. `createHoldFromByPartition` — the call `TenorMarket.list()` makes —
 * is guarded by `onlyClearingDisabled`, `onlyUnProtectedPartitionsOrWildCardRole` and
 * `requireDefaultPartitionWithSinglePartition`. Get any of them wrong at issuance and every listing
 * reverts, with no way to fix it short of re-issuing. Read `docs/GROUND-TRUTH.md` §1 before changing them.
 *
 * Usage:  bun run issue:bond
 */
import { IFactory__factory } from '@hashgraph/asset-tokenization-contracts/typechain-types'
import {
  DEFAULT_PARTITION,
  RegulationSubType,
  RegulationType,
  ROLES,
  deployBondFromFactory,
} from '@hashgraph/asset-tokenization-contracts/scripts'
import { operator, scan, writeRecord, requireRecord } from './lib/ats'

const { resolver, factory: factoryAddress, bondConfigId, bondConfigVersion } = requireRecord([
  'resolver',
  'factory',
  'bondConfigId',
  'bondConfigVersion',
])
const { signer, address: issuer } = await operator()

// --- the instrument (SPEC §11.1.4) -------------------------------------------------------------
const DECIMALS = 6 // matches USDC, so price and coupon math share one scale
const SUPPLY = 10_000n * 10n ** BigInt(DECIMALS) // 10,000 notes
const NOMINAL = 100n * 10n ** BigInt(DECIMALS) // 100 USDC face per note
const now = Math.floor(Date.now() / 1000)
const MATURITY = now + 365 * 24 * 60 * 60 // ~12 months

const factory = IFactory__factory.connect(factoryAddress, signer)

// Every role the issuer needs for the demo's lifecycle operations, in one grant.
const issuerRoles = [
  ROLES.ROLE_ISSUER, // mint / issue
  ROLES.ROLE_KYC, // grant + revoke KYC
  ROLES.ROLE_KYC_MANAGER,
  ROLES.ROLE_INTERNAL_KYC_MANAGER,
  ROLES.ROLE_PAUSER, // pause trading (demo beat 5)
  ROLES.ROLE_PAUSE_MANAGER,
  ROLES.ROLE_CONTROL_LIST, // block an address
  ROLES.ROLE_CONTROL_LIST_MANAGER,
  ROLES.ROLE_FREEZE_MANAGER, // freeze a holder (demo beat 5)
  ROLES.ROLE_CONTROLLER,
  ROLES.ROLE_CAP,
  ROLES.ROLE_CORPORATE_ACTION,
]

console.log('\nissuing Tenor Green Note 2027 …\n')

const bond = await deployBondFromFactory(
  {
    adminAccount: issuer,
    factory,
    securityData: {
      // ---- the three flags Tenor's DVP depends on -------------------------------------------
      // `onlyUnProtectedPartitionsOrWildCardRole`: protected partitions would force every hold
      // through an EIP-712 signature from the holder, defeating the one-transaction listing.
      arePartitionsProtected: false,
      // `requireDefaultPartitionWithSinglePartition`: third-party holds are only valid on a single
      // default partition.
      isMultiPartition: false,
      // `onlyClearingDisabled`: with clearing on, transfers queue for a validator instead of
      // settling, so a fill could not be atomic.
      clearingActive: false,
      // --------------------------------------------------------------------------------------

      // KYC is the verification gate the market surfaces as "Verification required".
      internalKycActivated: true,
      // Blocklist mode, not allowlist: KYC decides who may hold, and blocking stays an explicit,
      // separate issuer action. With an allowlist, an unverified investor would be refused on the
      // control list and the KYC story would never surface.
      isWhiteList: false,
      // Lets the issuer force-transfer and freeze — the compliance controls the demo exercises.
      isControllable: true,

      resolver,
      maxSupply: SUPPLY,
      erc20MetadataInfo: {
        name: 'Tenor Green Note 2027',
        symbol: 'TGN27',
        decimals: DECIMALS,
        isin: 'US0000000TGN',
      },
      erc20VotesActivated: false,
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      compliance: '0x0000000000000000000000000000000000000000',
      identityRegistry: '0x0000000000000000000000000000000000000000',
      resolverProxyConfiguration: { key: bondConfigId, version: bondConfigVersion },
      rbacs: [{ role: ROLES.DEFAULT_ADMIN_ROLE, members: [issuer] }, ...issuerRoles.map((role) => ({ role, members: [issuer] }))],
    },
    bondDetails: {
      currency: '0x555344', // "USD"
      nominalValue: NOMINAL,
      nominalValueDecimals: DECIMALS,
      startingDate: now,
      maturityDate: MATURITY,
    },
    proceedRecipients: [],
    proceedRecipientsData: [],
  },
  {
    regulationType: RegulationType.REG_S,
    regulationSubType: RegulationSubType.NONE,
    additionalSecurityData: {
      countriesControlListType: false,
      listOfCountries: '',
      info: 'Tenor demo instrument — ETHOnline 2026, Hedera testnet only.',
    },
  },
)

const token = await bond.getAddress()

writeRecord({ token, partition: DEFAULT_PARTITION, decimals: DECIMALS })

console.log(`
Tenor Green Note 2027 issued

  token       ${token}
              ${scan('contract', token)}
  partition   ${DEFAULT_PARTITION}   (ATS DEFAULT_PARTITION, read from the package — never hardcoded)
  decimals    ${DECIMALS}
  max supply  ${SUPPLY} (10,000 notes)
  nominal     100.000000 USD per note
  matures     ${new Date(MATURITY * 1000).toISOString().slice(0, 10)}

  clearing disabled · partitions unprotected · single partition  → third-party holds will work

next:  bun run grant:kyc
`)
