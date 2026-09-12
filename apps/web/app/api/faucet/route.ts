import { createWalletClient, createPublicClient, http, isAddress, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hederaTestnet } from '@/lib/chain'

/**
 * The testnet faucet: HBAR, demo USDC, and KYC.
 *
 * Without this the demo has a dead end. A visitor signs in with a passkey, gets an embedded wallet
 * with no HBAR — so on Hedera it is not an account at all yet — and every action is blocked by
 * something only the issuer can fix. The setup card would honestly tell them to go away.
 *
 * Two stages, because one HTTP call cannot do it. USDC is an HTS token, and an HTS transfer to an
 * account that has not ASSOCIATED with the token fails. Association can only be done by the account
 * itself, from the browser. So:
 *
 *   1. `POST {address, stage: 'hbar'}` — sends HBAR, which is what creates the Hedera account.
 *   2. the client calls `associate()` on the USDC token address, signed by the user.
 *   3. `POST {address, stage: 'fund'}` — sends USDC and grants KYC on the bond.
 *
 * The operator key is read from `TENOR_OPERATOR_KEY`, deliberately NOT a `NEXT_PUBLIC_` name: those
 * are inlined into the browser bundle at build time, which would publish the issuer's key.
 */

const OPERATOR_KEY = process.env.TENOR_OPERATOR_KEY
const USDC = process.env.NEXT_PUBLIC_USDC as `0x${string}` | undefined
const TOKEN = process.env.NEXT_PUBLIC_ATS_TOKEN as `0x${string}` | undefined

/** Testnet amounts. Generous enough to trade with, small enough that draining it is pointless. */
const HBAR_DRIP = 25n * 10n ** 18n
const USDC_DRIP = 5_000n * 10n ** 6n
/** Same explicit limit the client uses: the relay under-estimates `0x167` calls. */
const HTS_GAS = 1_000_000n

const ERC20 = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])
const KYC = parseAbi([
  'function grantKyc(address account, string vcId, uint256 validFrom, uint256 validTo, address issuer) returns (bool)',
  'function getKycStatusFor(address account) view returns (uint8)',
])
const HRC719 = parseAbi(['function isAssociated() view returns (bool)'])

/**
 * One drip per address per stage per ten minutes.
 *
 * In-memory, so it resets when the server restarts and is per-instance. That is the right size of
 * defence for a testnet faucet holding play money: it stops a loop, and a determined abuser costs
 * the operator nothing that matters. A real faucet would need shared state and a captcha.
 */
const LAST = new Map<string, number>()
const COOLDOWN = 10 * 60 * 1000

function tooSoon(key: string): boolean {
  const last = LAST.get(key)
  if (last && Date.now() - last < COOLDOWN) return true
  LAST.set(key, Date.now())
  return false
}

const bad = (message: string, status = 400) => Response.json({ ok: false, error: message }, { status })

export async function POST(req: Request) {
  if (!OPERATOR_KEY) return bad('The faucet is not configured: TENOR_OPERATOR_KEY is unset.', 503)
  if (!USDC || !TOKEN) return bad('The faucet is not configured: contract addresses are unset.', 503)

  let body: { address?: string; stage?: string }
  try {
    body = await req.json()
  } catch {
    return bad('Expected a JSON body.')
  }

  const { address, stage } = body
  // Validated rather than trusted: this value is interpolated into a transfer and a KYC grant.
  if (!address || !isAddress(address)) return bad('A valid EVM address is required.')
  if (stage !== 'hbar' && stage !== 'fund') return bad('stage must be "hbar" or "fund".')

  const account = privateKeyToAccount(
    (OPERATOR_KEY.startsWith('0x') ? OPERATOR_KEY : `0x${OPERATOR_KEY}`) as `0x${string}`,
  )
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http() })
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http() })
  const to = address as `0x${string}`

  try {
    if (stage === 'hbar') {
      const held = await publicClient.getBalance({ address: to })
      if (held >= HBAR_DRIP / 2n) {
        return Response.json({ ok: true, skipped: 'already funded', hbar: held.toString() })
      }
      if (tooSoon(`hbar:${to}`)) return bad('Already dripped recently. Try again in a few minutes.', 429)

      // This transfer is also what CREATES the Hedera account for a fresh key.
      const hash = await wallet.sendTransaction({ to, value: HBAR_DRIP })
      await publicClient.waitForTransactionReceipt({ hash })
      return Response.json({ ok: true, hash, next: 'associate USDC, then POST stage "fund"' })
    }

    // stage === 'fund'
    const associated = await publicClient.readContract({
      address: USDC,
      abi: HRC719,
      functionName: 'isAssociated',
      account: to,
    })
    if (!associated) {
      return bad('This account has not associated with USDC yet. Call associate() from the wallet first.', 409)
    }
    if (tooSoon(`fund:${to}`)) return bad('Already dripped recently. Try again in a few minutes.', 429)

    const done: Record<string, string> = {}

    const usdcHeld = await publicClient.readContract({
      address: USDC,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [to],
    })
    if (usdcHeld < USDC_DRIP) {
      const hash = await wallet.writeContract({
        address: USDC,
        abi: ERC20,
        functionName: 'transfer',
        args: [to, USDC_DRIP - usdcHeld],
        gas: HTS_GAS,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      done.usdc = hash
    }

    // `grantKyc` on an already-granted account reverts `InvalidKycStatus()` -- the same error a
    // transfer to an unverified holder gives -- so it is checked first rather than retried.
    const status = await publicClient.readContract({
      address: TOKEN,
      abi: KYC,
      functionName: 'getKycStatusFor',
      args: [to],
    })
    if (Number(status) !== 1) {
      const now = BigInt(Math.floor(Date.now() / 1000))
      const hash = await wallet.writeContract({
        address: TOKEN,
        abi: KYC,
        functionName: 'grantKyc',
        // The last argument is the KYC ISSUER, checked against the token's SSI issuer registry
        // rather than against a role. The operator was registered by `bun run grant:kyc`.
        args: [to, `tenor-demo-${to.slice(2, 10)}`, now, now + 5n * 365n * 24n * 60n * 60n, account.address],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      done.kyc = hash
    }

    return Response.json({ ok: true, ...done, skipped: Object.keys(done).length === 0 ? 'nothing to do' : undefined })
  } catch (e) {
    // The message can carry a revert reason worth seeing, but never the key.
    const message = e instanceof Error ? e.message.slice(0, 400) : 'unknown error'
    console.error('[faucet]', stage, to, message)
    return bad(message, 500)
  }
}

/** Lets the setup card tell the difference between "not configured" and "ready". */
export async function GET() {
  return Response.json({
    configured: Boolean(OPERATOR_KEY && USDC && TOKEN),
    usdc: USDC ?? null,
    token: TOKEN ?? null,
  })
}
