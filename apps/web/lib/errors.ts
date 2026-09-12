import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi } from 'viem'
import { atsTokenAbi, responseCodes, tenorAbi } from './abi'

/**
 * Turns a revert into something a person can act on.
 *
 * This is the load-bearing half of "no user is ever asked to sign a transaction that will fail"
 * (SPEC §9.2 / FR5). The client simulates every write; when the simulation reverts, the primary
 * button's LABEL becomes the blocking condition and a banner explains the next step. That only works
 * if a raw 4-byte selector can be turned into a sentence.
 *
 * The errors come from four layers that know nothing about each other:
 *   - Tenor's own market and coupon errors
 *   - Lattice's `IHTSAdapter` / `IHSSAdapter` typed errors (NOT the `HTS__CallFailed` the old spec
 *     named — see `docs/GROUND-TRUTH.md` §2.3)
 *   - ATS's compliance errors, which are what make the product's point: an unverified buyer, a frozen
 *     holder, a paused token
 *   - raw Hedera response codes, which arrive as an `int64` inside `TenorHTSCallFailed`
 *
 * `resolve` is deliberately exhaustive about the cases a user can actually hit and honest about the
 * rest: anything unrecognised keeps its raw name so the UI can show it verbatim rather than inventing
 * a reassuring message.
 */

/** What the UI needs to render a blocked state. */
export type DecodedError = {
  /** Button label — short, and phrased as the blocking condition. Max ~24 chars. */
  label: string
  /** One sentence explaining the state. */
  message: string
  /** What the user (or issuer) must do next, when there is something to do. */
  action?: string
  /** True when only the issuer can clear this — the UI should not offer a retry. */
  issuerOnly?: boolean
  /** The decoded error name, or a raw selector when nothing matched. Always shown behind a disclosure. */
  raw: string
  /** Decoded arguments, for the raw detail view. */
  args?: readonly unknown[]
}

/** Hedera response codes that reach the UI through `TenorHTSCallFailed(selector, code)`. */
/**
 * User-facing copy for the Hedera status codes `TenorHTSCallFailed(bytes4,int64)` can carry.
 *
 * Keyed by the CONSTANT NAME, not the number: the numbers are generated from
 * `HederaResponseCodes.sol` into `responseCodes`, so a name that does not exist there is a type
 * error here. Written by hand the first time, three of nine numbers were wrong — including both
 * beats the compliance demo turns on (frozen is 165, not 225; KYC is 176, not 226).
 */
const RESPONSE_CODE_COPY: { [K in keyof typeof responseCodes]?: Omit<DecodedError, 'raw'> } = {
  UNKNOWN: { label: 'Network call failed', message: 'The Hedera Token Service did not complete the transfer.', action: 'Try again in a moment.' },
  INSUFFICIENT_PAYER_BALANCE: { label: 'Not enough HBAR', message: 'This account cannot cover the transaction fee.', action: 'Get testnet HBAR from the setup card.' },
  ACCOUNT_FROZEN_FOR_TOKEN: { label: 'Account frozen', message: 'The issuer has frozen this account for USDC.', action: 'Contact the issuer.', issuerOnly: true },
  ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN: { label: 'Verification required', message: 'This account has not been granted KYC for USDC.', action: 'The issuer must verify you.', issuerOnly: true },
  INSUFFICIENT_TOKEN_BALANCE: { label: 'Insufficient USDC', message: 'The account does not hold enough USDC.', action: 'Get demo USDC from the setup card.' },
  TOKEN_NOT_ASSOCIATED_TO_ACCOUNT: { label: 'Enable USDC first', message: 'This account is not associated with USDC, so it cannot send or receive it.', action: 'Use \u201cEnable USDC\u201d in the setup card.' },
  TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT: { label: 'USDC already enabled', message: 'This account is already associated with USDC.' },
  TOKEN_IS_PAUSED: { label: 'Trading paused', message: 'USDC transfers are paused.', issuerOnly: true },
  SPENDER_DOES_NOT_HAVE_ALLOWANCE: { label: 'Approve USDC', message: 'The market has no USDC allowance from this account.', action: 'Approve USDC, then buy.' },
  AMOUNT_EXCEEDS_ALLOWANCE: { label: 'Approve more USDC', message: 'The approved USDC amount is less than this purchase costs.', action: 'Raise the approval.' },
}

/** The same copy indexed by the number that actually arrives on the wire. */
const RESPONSE_CODES: Record<number, Omit<DecodedError, 'raw'>> = Object.fromEntries(
  Object.entries(RESPONSE_CODE_COPY).map(([name, copy]) => [responseCodes[name as keyof typeof responseCodes], copy]),
)

/** Error name → copy. Ordered by the flow the user is in, not alphabetically. */
const BY_NAME: Record<string, Omit<DecodedError, 'raw'>> = {
  // --- ATS compliance: the reason the product exists ------------------------------------------
  InvalidKycStatus: { label: 'Verification required', message: 'The issuer has not verified this account, so it cannot hold this bond.', action: 'Verification is granted by the issuer in ATS.', issuerOnly: true },
  KycIsNotGranted: { label: 'Verification required', message: 'The issuer has not verified this account, so it cannot hold this bond.', action: 'Verification is granted by the issuer in ATS.', issuerOnly: true },
  AddressNotVerified: { label: 'Verification required', message: 'This address is not in the issuer’s identity registry.', action: 'Verification is granted by the issuer in ATS.', issuerOnly: true },
  AccountIsBlocked: { label: 'Account blocked', message: 'The issuer has blocked this account from holding the bond.', action: 'Contact the issuer.', issuerOnly: true },
  IsPaused: { label: 'Trading paused', message: 'The issuer has paused all transfers of this bond.', action: 'Trading resumes when the issuer unpauses.', issuerOnly: true },
  InsufficientFrozenBalance: { label: 'Account frozen', message: 'Enough of this balance is frozen by the issuer that the transfer cannot settle.', action: 'Contact the issuer.', issuerOnly: true },
  InvalidFreezeAmount: { label: 'Account frozen', message: 'The issuer has frozen part of this balance.', action: 'Contact the issuer.', issuerOnly: true },
  ComplianceNotAllowed: { label: 'Not permitted', message: 'The issuer’s compliance rules refused this transfer.', action: 'Contact the issuer.', issuerOnly: true },
  UnlistedAccount: { label: 'Not on the allow list', message: 'This account is not on the issuer’s allow list.', issuerOnly: true },
  ListedAccount: { label: 'Account blocked', message: 'This account is on the issuer’s block list.', issuerOnly: true },

  // --- ATS holds ------------------------------------------------------------------------------
  IsNotEscrow: { label: 'Cannot settle', message: 'Only the market can execute this reservation, and the token did not recognise it as the escrow.', action: 'Report this — the listing may have been created against a different market.' },
  HoldExpirationReached: { label: 'Listing expired', message: 'The reservation behind this listing has expired.', action: 'The seller can reclaim the tokens and relist.' },
  HoldExpirationNotReached: { label: 'Not yet reclaimable', message: 'The reservation has not expired, so it cannot be reclaimed yet.', action: 'Cancel the listing instead.' },
  InsufficientHoldBalance: { label: 'Amount unavailable', message: 'The reservation no longer covers this amount.', action: 'Refresh and try a smaller amount.' },
  WrongHoldId: { label: 'Reservation not found', message: 'The token has no reservation with this id.' },

  // --- Tenor market ---------------------------------------------------------------------------
  ListingNotActive: { label: 'Listing unavailable', message: 'This listing has been filled, cancelled or expired.', action: 'Pick another listing.' },
  ListingExpired: { label: 'Listing expired', message: 'This listing passed its expiry and can no longer be filled.', action: 'Pick another listing.' },
  ListingNotExpired: { label: 'Not expired yet', message: 'This listing has not reached its expiry.', action: 'Cancel it instead.' },
  NotSeller: { label: 'Not your listing', message: 'Only the seller who created a listing can cancel it.' },
  InvalidAmount: { label: 'Enter a valid amount', message: 'The amount must be above zero and no more than the listing has left.' },
  InvalidPrice: { label: 'Enter a price', message: 'The price per token must be above zero.' },
  InvalidExpiry: { label: 'Pick a shorter expiry', message: 'The expiry must be in the future and within the market’s maximum listing duration.' },
  ZeroCost: { label: 'Amount too small', message: 'This amount rounds to zero USDC, so it would hand over tokens for nothing.', action: 'Raise the amount.' },
  FeeTooHigh: { label: 'Fee too high', message: 'The protocol fee cannot exceed 1%.' },
  TokenNotListable: { label: 'Unsupported token', message: 'This market trades a single bond and that is not it.' },
  UnsupportedDecimals: { label: 'Unsupported token', message: 'This token reports more decimals than the market can price against.' },
  HoldCreationFailed: { label: 'Could not reserve', message: 'The token refused to reserve these tokens.', action: 'Check your balance and that selling is enabled.' },
  HoldCallFailed: { label: 'Settlement failed', message: 'The token reported a failure while settling, so the whole transaction was undone.' },

  // --- Tenor coupons --------------------------------------------------------------------------
  CouponAlreadySettled: { label: 'Already paid', message: 'This coupon has already been settled.' },
  CouponNotDue: { label: 'Not due yet', message: 'This coupon cannot be paid until its payment date.' },
  CouponNotFunded: { label: 'Not funded', message: 'The issuer has not funded this coupon yet.', issuerOnly: true },
  CouponNotSettled: { label: 'Not settled', message: 'Surplus can only be withdrawn after the coupon has paid out.' },
  CouponNotScheduled: { label: 'Not scheduled', message: 'This coupon has no scheduled payment booked.' },
  InsufficientFunding: { label: 'Needs topping up', message: 'Holder balances grew since funding, so the coupon no longer covers everyone.', action: 'The issuer tops up, then it settles.', issuerOnly: true },
  CouponTermsLocked: { label: 'Cancel schedule first', message: 'A payment is already booked, so the date and rate are locked.', action: 'Cancel the schedule to change them.', issuerOnly: true },
  CouponInvalidPayAt: { label: 'Pick a future date', message: 'The payment date must be in the future.' },
  CouponInvalidAmount: { label: 'Enter a rate', message: 'The amount per token must be above zero.' },
  NoScheduleCapacity: { label: 'No network capacity', message: 'The Hedera Schedule Service has no room at that second for this gas limit.', action: 'Try a slightly different time.' },

  // --- Lattice HTS / HSS typed errors ---------------------------------------------------------
  HTSTokenNotAssociated: { label: 'Enable USDC first', message: 'This account is not associated with USDC.', action: 'Use “Enable USDC” in the setup card.' },
  HTSTokenAlreadyAssociated: { label: 'USDC already enabled', message: 'This account is already associated with USDC.' },
  HTSInsufficientBalance: { label: 'Insufficient USDC', message: 'The account does not hold enough USDC.', action: 'Get demo USDC from the setup card.' },
  HTSAllowanceExceeded: { label: 'Approve more USDC', message: 'The approved USDC amount does not cover this.', action: 'Raise the approval.' },
  HTSKycNotGranted: { label: 'Verification required', message: 'This account has not been granted KYC for USDC.', issuerOnly: true },
  HTSAccountFrozen: { label: 'Account frozen', message: 'This account is frozen for USDC.', issuerOnly: true },
  HTSTokenPaused: { label: 'Trading paused', message: 'USDC transfers are paused.', issuerOnly: true },
  HTSInsufficientGas: { label: 'Raise the gas limit', message: 'The Hedera Token Service needed more gas than was provided.' },
  HTSNotAToken: { label: 'Not a token', message: 'That address is not a Hedera token.' },
  HSSExpiryBusy: { label: 'No network capacity', message: 'That second is already fully booked on the Schedule Service.', action: 'Try a slightly different time.' },
  HSSJobAlreadyScheduled: { label: 'Already scheduled', message: 'A payment is already booked for this coupon.', action: 'Cancel it first.' },
  HSSInvalidExpiry: { label: 'Pick a future time', message: 'A scheduled call must be in the future.' },
  HSSNotScheduledSelfCall: { label: 'Not callable', message: 'Only the network’s scheduled call can do this.' },

  // --- roles and pause ------------------------------------------------------------------------
  AccessControlUnauthorizedAccount: { label: 'Not permitted', message: 'This account does not hold the role this action needs.', issuerOnly: true },
  EnforcedPause: { label: 'Trading paused', message: 'The market is paused. Existing listings can still be cancelled.', issuerOnly: true },
  ExpectedPause: { label: 'Not paused', message: 'The market is not paused.' },
}

/** Balance/allowance failures on the bond's own ERC-20 surface, which arrive as plain strings. */
const BY_SUBSTRING: [RegExp, Omit<DecodedError, 'raw'>][] = [
  [/insufficient allowance|InsufficientAllowance/i, { label: 'Enable selling', message: 'The market has no allowance to reserve your bonds.', action: 'Approve the market once, then list.' }],
  [/insufficient balance|InsufficientBalance/i, { label: 'Insufficient balance', message: 'The account does not hold enough of this bond.' }],
  [/insufficient funds/i, { label: 'Need test HBAR', message: 'This account has no HBAR to pay the network fee.', action: 'Use “Get test HBAR” in the setup card.' }],
  [/user rejected|denied transaction/i, { label: 'Cancelled', message: 'You dismissed the signing prompt.' }],
]

const ABIS: Abi[] = [tenorAbi as unknown as Abi, atsTokenAbi as unknown as Abi]

/** Pulls `(selector, responseCode)` out of a `TenorHTSCallFailed` and maps the code. */
function fromResponseCode(args: readonly unknown[] | undefined): Omit<DecodedError, 'raw'> | undefined {
  const code = args?.[1]
  if (typeof code !== 'bigint' && typeof code !== 'number') return undefined
  return RESPONSE_CODES[Number(code)]
}

/**
 * Decodes any thrown value into something renderable.
 *
 * Never throws, and never claims more than it knows: an unrecognised revert keeps its raw selector or
 * name so the UI shows the truth rather than a comforting guess.
 */
export function resolve(err: unknown): DecodedError {
  // 1. viem's structured revert — the common case for a failed simulation.
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | undefined
    const name = reverted?.data?.errorName
    const args = reverted?.data?.args

    if (name) {
      if (name === 'TenorHTSCallFailed' || name === 'HTSCallFailed' || name === 'HSSCallFailed') {
        const byCode = fromResponseCode(args)
        if (byCode) return { ...byCode, raw: name, args }
        return {
          label: 'Network call failed',
          message: 'A Hedera system contract refused the call.',
          raw: name,
          args,
        }
      }
      const hit = BY_NAME[name]
      if (hit) return { ...hit, raw: name, args }
      // Decoded but unmapped: show the real name rather than inventing copy for it.
      return {
        label: 'Transaction would fail',
        message: `The contract reverted with ${name}.`,
        raw: name,
        args,
      }
    }
  }

  // 2. A bare 4-byte selector with data we can still match against our ABIs.
  const data = (err as { data?: `0x${string}` })?.data
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    for (const abi of ABIS) {
      try {
        const d = decodeErrorResult({ abi, data })
        const hit = BY_NAME[d.errorName]
        if (hit) return { ...hit, raw: d.errorName, args: d.args }
        return { label: 'Transaction would fail', message: `The contract reverted with ${d.errorName}.`, raw: d.errorName, args: d.args }
      } catch {
        // try the next ABI
      }
    }
  }

  // 3. String matching, for wallet- and node-level failures that carry no custom error.
  const text = err instanceof Error ? `${err.message}` : String(err ?? '')
  for (const [re, copy] of BY_SUBSTRING) {
    if (re.test(text)) return { ...copy, raw: text.slice(0, 200) }
  }

  return {
    label: 'Transaction would fail',
    message: 'The network refused this transaction and did not say why in a way we recognise.',
    action: 'The raw error is below.',
    raw: text.slice(0, 400) || 'unknown error',
  }
}
