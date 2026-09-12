'use client'

import { useCallback, useMemo } from 'react'
import { maxUint256 } from 'viem'
import { useReadContract, useSimulateContract, useWriteContract } from 'wagmi'
import { tenorAbi } from './abi'
import { addresses, ASSOCIATE_GAS_LIMIT } from './chain'
import { resolve } from './errors'
import { erc20Abi, hrc719Abi, useReadiness, type Readiness } from './readiness'
import { useActivity } from '@/components/app/activity'

/**
 * The one state machine every action button in the app runs (SPEC §9.2).
 *
 * Three phases, in this order and for this reason:
 *
 * 1. **Readiness** — account facts, read from the chain (see `readiness.ts`). These are ordered the
 *    way a person needs to hear them, which is NOT the order the contract reverts in.
 * 2. **Simulation** — `eth_call` of the exact transaction, run only once readiness passes. This is
 *    the net for everything a read cannot see: a listing filled out from under you, an expiry that
 *    passed while the drawer was open, an HTS status the relay returns.
 * 3. **Label** — a simulation revert goes through `resolve()`, which turns a selector into a
 *    sentence. Nothing here invents copy; an unrecognised revert shows its own error name.
 *
 * The button is only ever enabled in the terminal state, so a user cannot sign a transaction the
 * simulation has not already run.
 */
export type ActionState = {
  /** What the button says. Always set. */
  label: string
  /** A transaction is in flight. */
  pending: boolean
  /** Shown but not clickable: the user must change something else first. */
  blocked: boolean
  /** Present exactly when the button is clickable. */
  onClick?: () => void
  /** One line under the button. */
  helper?: string
  /** A banner above the form, for conditions the user cannot fix themselves. */
  banner?: { kind: 'warning' | 'danger' | 'info'; text: string }
  /** True when only the issuer can clear the condition — the UI says so rather than offering a retry. */
  issuerOnly?: boolean
  /** Gross cost and fee in USDC base units, once an amount is entered. */
  quote?: { cost: bigint; fee: bigint }
}

/**
 * Wraps a write so it always reaches the activity tray.
 *
 * `writeContract` is fire-and-forget and never yields the hash, which means the tray cannot follow
 * the transaction to a receipt -- and the receipt is the only thing that distinguishes "the relay
 * accepted it" from "it succeeded at consensus". So every action here uses `writeContractAsync` and
 * hands the hash straight to `track`, and a refusal in the wallet is recorded by `fail` rather than
 * vanishing.
 */
function useSender() {
  const { writeContractAsync } = useWriteContract()
  const { track, fail } = useActivity()
  return useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one call shape per action site
    async (title: string, request: any) => {
      try {
        track(title, await writeContractAsync(request))
      } catch (e) {
        fail(title, e)
      }
    },
    [writeContractAsync, track, fail],
  )
}

const blocked = (label: string, extra: Partial<ActionState> = {}): ActionState => ({
  label,
  pending: false,
  blocked: true,
  ...extra,
})

const ready = (label: string, onClick: () => void, extra: Partial<ActionState> = {}): ActionState => ({
  label,
  pending: false,
  blocked: false,
  onClick,
  ...extra,
})

/** Enough HBAR to pay for one transaction, including an HTS association. 18 dp on the EVM side. */
const MIN_HBAR = 500_000_000_000_000_000n // 0.5 HBAR

function fmtUsdc(v: bigint): string {
  const whole = v / 1_000_000n
  const frac = (v % 1_000_000n).toString().padStart(6, '0').slice(0, 2)
  return `${whole.toLocaleString('en-US')}.${frac} USDC`
}

function fmtTokens(v: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals)
  return `${(v / d).toLocaleString('en-US')} TGN27`
}

/** The compliance rungs, shared by every action. Returns null when nothing blocks. */
function complianceGate(r: Readiness): ActionState | null {
  if (!r.verified) {
    return blocked('Verification required', {
      issuerOnly: true,
      banner: {
        kind: 'warning',
        text: `Only investors verified by the issuer can trade. Ask the issuer to verify ${r.address ?? 'this account'}.`,
      },
    })
  }
  if (r.frozen) {
    return blocked('Account frozen', {
      issuerOnly: true,
      banner: { kind: 'danger', text: 'The issuer has frozen this account. Contact the issuer.' },
    })
  }
  if (r.blocked) {
    return blocked('Account blocked', {
      issuerOnly: true,
      banner: { kind: 'danger', text: 'This account is on the token’s control list. Contact the issuer.' },
    })
  }
  if (r.tokenPaused || r.marketPaused) {
    return blocked('Trading paused', {
      issuerOnly: true,
      banner: {
        kind: 'warning',
        text: 'Trading is paused by the issuer. Listings stay reserved, and you can still cancel yours.',
      },
    })
  }
  return null
}

export type Listing = {
  token: `0x${string}`
  partition: `0x${string}`
  seller: `0x${string}`
  holdId: bigint
  remaining: bigint
  pricePerToken: bigint
  expiry: bigint
  tokenDecimals: number
  active: boolean
}

/**
 * Buying from a listing.
 *
 * `amount` is in token base units. `0n` means the field is empty, which is a different state from
 * "too much" and gets its own label.
 */
export function useFillAction(id: bigint | undefined, listing: Listing | undefined, amount: bigint): ActionState {
  const r = useReadiness()
  const { tenor } = addresses
  const send = useSender()
  const { isPending } = useWriteContract()

  const { data: quoted } = useReadContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'quote',
    args: id !== undefined && amount > 0n ? [id, amount] : undefined,
    query: { enabled: Boolean(tenor && id !== undefined && amount > 0n) },
  })
  const quote = quoted ? { cost: quoted[0], fee: quoted[1] } : undefined

  // Everything up to here is cheap. The ladder decides whether simulating is even worth a request.
  const gate = useMemo(() => {
    if (!tenor || !addresses.usdc) return blocked('Not deployed yet', { helper: 'Waiting for contract addresses.' })
    if (r.disconnected) return blocked('Connect wallet')
    if (r.loading) {
      return r.unreadable
        ? blocked('Checking…', { helper: 'Could not read your account from the network — retrying.' })
        : blocked('Checking…')
    }
    if (!listing || id === undefined) return blocked('Select a listing')
    if (amount <= 0n) return blocked('Enter an amount')
    if (amount > listing.remaining) {
      return blocked(`Only ${fmtTokens(listing.remaining, listing.tokenDecimals)} available`)
    }
    if (r.hbar < MIN_HBAR) {
      return blocked('Get test HBAR', { helper: 'You need a little HBAR to pay the network fee.' })
    }
    const compliance = complianceGate(r)
    if (compliance) return compliance
    if (!listing.active) return blocked('Listing no longer active', { helper: 'Choose another listing.' })
    if (listing.expiry * 1000n <= BigInt(Date.now())) {
      return blocked('Listing expired', { helper: 'This listing expired. Choose another.' })
    }
    return null
  }, [tenor, r, listing, id, amount])

  // Association and allowance are fixable by the user, so they are actions rather than blocks.
  const fixup = useMemo(() => {
    if (gate || !quote || !addresses.usdc || !tenor) return null
    if (!r.usdcAssociated) {
      return ready(
        'Enable USDC',
        () =>
          send('Enable USDC', {
            address: addresses.usdc!,
            abi: hrc719Abi,
            functionName: 'associate',
            gas: ASSOCIATE_GAS_LIMIT,
          }),
        { helper: 'One-time: lets this account hold USDC.' },
      )
    }
    if (r.usdc < quote.cost) {
      return blocked('Insufficient USDC', { helper: `This costs ${fmtUsdc(quote.cost)}. Get demo USDC to continue.` })
    }
    if (r.usdcAllowance < quote.cost) {
      return ready(
        `Approve ${fmtUsdc(quote.cost)}`,
        () =>
          send('Approve USDC', {
            address: addresses.usdc!,
            abi: erc20Abi,
            functionName: 'approve',
            args: [tenor, quote.cost],
          }),
        { helper: 'The market moves your USDC to the seller in the same transaction as the tokens.' },
      )
    }
    return null
  }, [gate, quote, r, tenor, send])

  // Only now is simulating worth a round trip — and only now would its revert be informative.
  const canSimulate = !gate && !fixup && id !== undefined && amount > 0n && Boolean(tenor)
  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'fill',
    args: id !== undefined ? [id, amount] : undefined,
    account: r.address,
    query: { enabled: canSimulate },
  })

  if (gate) return { ...gate, quote }
  if (fixup) return { ...fixup, quote, pending: isPending }
  if (sim.isLoading) return { ...blocked('Checking…'), quote }
  if (sim.error) {
    const d = resolve(sim.error)
    return {
      ...blocked(d.label),
      quote,
      helper: d.action ?? d.message,
      issuerOnly: d.issuerOnly,
      banner: d.issuerOnly ? { kind: 'warning', text: d.message } : undefined,
    }
  }
  if (!sim.data) return { ...blocked('Checking…'), quote }

  return {
    ...ready(`Buy ${fmtTokens(amount, listing!.tokenDecimals)}`, () =>
      send(`Buy ${fmtTokens(amount, listing!.tokenDecimals)}`, sim.data!.request),
    ),
    quote,
    pending: isPending,
    helper: quote ? `${fmtUsdc(quote.cost)} to the seller, settled in one transaction.` : undefined,
  }
}

/**
 * Listing tokens for sale.
 *
 * `list` creates the hold, and the hold consumes the seller's allowance TO THE DIAMOND — so the
 * approval is not a nicety, it is what makes the reservation possible (SPEC §5.2).
 */
export function useListAction(amount: bigint, pricePerToken: bigint, expiry: bigint, unlimited = false): ActionState {
  const r = useReadiness()
  const { tenor, token, partition } = addresses
  const send = useSender()
  const { isPending } = useWriteContract()

  const { data: maxDuration } = useReadContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'maxDuration',
    query: { enabled: Boolean(tenor) },
  })

  const gate = useMemo(() => {
    if (!tenor || !token) return blocked('Not deployed yet', { helper: 'Waiting for contract addresses.' })
    if (r.disconnected) return blocked('Connect wallet')
    if (r.loading) {
      return r.unreadable
        ? blocked('Checking…', { helper: 'Could not read your account from the network — retrying.' })
        : blocked('Checking…')
    }
    if (amount <= 0n) return blocked('Enter an amount')
    if (amount > r.tokens) return blocked('More than you hold', { helper: 'Reduce the amount.' })
    if (pricePerToken <= 0n) return blocked('Enter a price')
    if (r.hbar < MIN_HBAR) {
      return blocked('Get test HBAR', { helper: 'You need a little HBAR to pay the network fee.' })
    }
    const compliance = complianceGate(r)
    if (compliance) return compliance
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (expiry <= now) return blocked('Pick a future expiry')
    if (maxDuration !== undefined && expiry > now + BigInt(maxDuration)) {
      return blocked(`Expiry beyond the ${Number(maxDuration) / 86400}-day cap`)
    }
    return null
  }, [tenor, token, r, amount, pricePerToken, expiry, maxDuration])

  const fixup = useMemo(() => {
    if (gate || !token || !tenor) return null
    if (r.tokenAllowance < amount) {
      return ready(
        'Enable selling',
        () =>
          send('Enable selling', {
            address: token,
            abi: erc20Abi,
            functionName: 'approve',
            args: [tenor, unlimited ? maxUint256 : amount],
          }),
        { helper: 'One-time approval so the market can reserve your tokens while they are listed.' },
      )
    }
    return null
  }, [gate, token, tenor, r.tokenAllowance, amount, unlimited, send])

  const canSimulate = !gate && !fixup && Boolean(tenor && token)
  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'list',
    args: token ? [token, partition, amount, pricePerToken, expiry] : undefined,
    account: r.address,
    query: { enabled: canSimulate },
  })

  if (gate) return gate
  if (fixup) return { ...fixup, pending: isPending }
  if (sim.isLoading) return blocked('Checking…')
  if (sim.error) {
    const d = resolve(sim.error)
    return { ...blocked(d.label), helper: d.action ?? d.message, issuerOnly: d.issuerOnly }
  }
  if (!sim.data) return blocked('Checking…')

  return {
    ...ready(`List ${fmtTokens(amount, 6)}`, () => send(`List ${fmtTokens(amount, 6)}`, sim.data!.request)),
    pending: isPending,
  }
}

/** Cancelling your own listing. Allowed while the market is paused, which is why it skips the gate. */
export function useCancelAction(id: bigint | undefined): ActionState {
  const r = useReadiness()
  const { tenor } = addresses
  const send = useSender()
  const { isPending } = useWriteContract()

  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'cancel',
    args: id !== undefined ? [id] : undefined,
    account: r.address,
    query: { enabled: Boolean(tenor && id !== undefined && r.address) },
  })

  if (r.disconnected) return blocked('Connect wallet')
  if (sim.isLoading) return blocked('Checking…')
  if (sim.error) {
    const d = resolve(sim.error)
    return { ...blocked(d.label), helper: d.action ?? d.message, issuerOnly: d.issuerOnly }
  }
  if (!sim.data) return blocked('Cancel listing')
  return { ...ready('Cancel listing', () => send('Cancel listing', sim.data!.request)), pending: isPending }
}

export { fmtUsdc, fmtTokens }
