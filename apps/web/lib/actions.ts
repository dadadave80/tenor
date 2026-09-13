'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { maxUint256 } from 'viem'
import { useReadContract, useSimulateContract, useWriteContract } from 'wagmi'
import { tenorAbi } from './abi'
import { addresses, ASSOCIATE_GAS_LIMIT, WRITE_GAS_LIMIT } from './chain'
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
  /** The transactions this takes, in order, when there is more than one, so a second signature is expected. */
  steps?: { label: string; done: boolean }[]
}

/**
 * Wraps a write so it always reaches the activity tray.
 *
 * `writeContract` is fire-and-forget and never yields the hash, which means the tray cannot follow
 * the transaction to a receipt -- and the receipt is the only thing that distinguishes "the relay
 * accepted it" from "it succeeded at consensus". So every action here uses `writeContractAsync` and
 * hands the hash straight to `track`, and a refusal in the wallet is recorded by `fail` rather than
 * vanishing.
 *
 * Every write also carries an explicit gas limit. The relay's estimate for calls that reach the ATS token or
 * `0x167` is too low — a fill sent with it reverted out of gas — so a request without its own `gas` gets
 * {WRITE_GAS_LIMIT}.
 */
function useSender() {
  const { writeContractAsync } = useWriteContract()
  const { track, fail } = useActivity()
  // Where the write is: waiting on the wallet, or sent and waiting on consensus and the refetch after it.
  // The button follows this, so it never looks idle while a transaction is still out.
  const [phase, setPhase] = useState<'sign' | 'settle' | null>(null)
  const send = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one call shape per action site
    async (title: string, request: any): Promise<`0x${string}` | undefined> => {
      setPhase('sign')
      try {
        const hash = await writeContractAsync({ ...request, gas: request.gas ?? WRITE_GAS_LIMIT })
        setPhase('settle')
        return (await track(title, hash)) ? hash : undefined
      } catch (e) {
        fail(title, e)
        return undefined
      } finally {
        setPhase(null)
      }
    },
    [writeContractAsync, track, fail],
  )
  return { send, phase }
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

/** A write in flight: the button says where it is, spins, and cannot be pressed a second time. */
const inFlight = (phase: 'sign' | 'settle'): ActionState =>
  blocked(phase === 'sign' ? 'Confirm in your wallet…' : 'Settling on Hedera…', { pending: true })

/**
 * Enough HBAR to send one transaction at {WRITE_GAS_LIMIT}. Hedera reserves limit × gas price up front (1.19 HBAR
 * at 1,190 gwei) and charges at least 80% of it, so with less the wallet refuses before the chain sees anything.
 * 18 dp on the EVM side.
 */
const MIN_HBAR = 1_500_000_000_000_000_000n // 1.5 HBAR

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
export function useFillAction(
  id: bigint | undefined,
  listing: Listing | undefined,
  amount: bigint,
  onFilled?: (fill: { id: bigint; hash: `0x${string}`; amount: bigint; cost: bigint }) => void,
): ActionState {
  const r = useReadiness()
  const { tenor } = addresses
  const { send, phase } = useSender()
  // An approval this drawer just saw confirmed. The allowance read normally catches up in the refetch after the
  // receipt; if the relay lags, this still stops the button asking for the same approval twice.
  const [approved, setApproved] = useState(0n)
  const allowance = r.usdcAllowance > approved ? r.usdcAllowance : approved
  // A fresh allowance read supersedes the override, including after a fill whose receipt wait failed.
  useEffect(() => setApproved(0n), [r.usdcAllowance])

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
      return blocked('Get test HBAR', { helper: 'You need HBAR for the network fee. Hedera’s faucet gives 100 free at portal.hedera.com/faucet.' })
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
    if (allowance < quote.cost) {
      const cost = quote.cost
      return ready(
        `Approve ${fmtUsdc(cost)}`,
        async () => {
          const hash = await send('Approve USDC', {
            address: addresses.usdc!,
            abi: erc20Abi,
            functionName: 'approve',
            args: [tenor, cost],
          })
          if (hash) setApproved(cost)
        },
        { helper: 'Step 1 of 2. Lets the market pay the seller this USDC in the same transaction that delivers your tokens.' },
      )
    }
    return null
  }, [gate, quote, r, tenor, send, allowance])

  // Only now is simulating worth a round trip — and only now would its revert be informative.
  const canSimulate = !gate && !fixup && !phase && id !== undefined && amount > 0n && Boolean(tenor)
  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'fill',
    args: id !== undefined ? [id, amount] : undefined,
    account: r.address,
    query: { enabled: canSimulate },
  })

  // Approve then buy is two signatures. Saying so up front is what stops the second one feeling like a repeat.
  const steps =
    !gate && quote && r.usdcAssociated && listing
      ? [
          { label: `Approve ${fmtUsdc(quote.cost)}`, done: allowance >= quote.cost },
          { label: `Buy ${fmtTokens(amount, listing.tokenDecimals)}`, done: false },
        ]
      : undefined

  // Held from before the write: the refetch after the receipt can flip the gate (the listing has less left) while
  // the button is still settling, and the steps must not vanish or un-tick mid-flight.
  const heldSteps = useRef(steps)
  if (!phase) heldSteps.current = steps

  if (phase) return { ...inFlight(phase), quote, steps: heldSteps.current }
  if (gate) return { ...gate, quote }
  if (fixup) return { ...fixup, quote, steps }
  if (sim.isLoading) return { ...blocked('Checking…'), quote, steps }
  if (sim.error) {
    const d = resolve(sim.error)
    return {
      ...blocked(d.label),
      quote,
      steps,
      helper: d.action ?? d.message,
      issuerOnly: d.issuerOnly,
      banner: d.issuerOnly ? { kind: 'warning', text: d.message } : undefined,
    }
  }
  if (!sim.data) return { ...blocked('Checking…'), quote, steps }

  const title = `Buy ${fmtTokens(amount, listing!.tokenDecimals)}`
  return {
    ...ready(title, async () => {
      const cost = quote?.cost ?? (amount * listing!.pricePerToken) / 10n ** BigInt(listing!.tokenDecimals)
      const hash = await send(title, sim.data!.request)
      if (!hash) return
      setApproved(0n)
      onFilled?.({ id: id!, hash, amount, cost })
    }),
    quote,
    steps,
    helper: quote ? `Step 2 of 2. ${fmtUsdc(quote.cost)} to the seller, settled in one transaction.` : undefined,
  }
}

/**
 * Listing tokens for sale.
 *
 * `list` creates the hold, and the hold consumes the seller's allowance TO THE DIAMOND — so the
 * approval is not a nicety, it is what makes the reservation possible (SPEC §5.2).
 */
export function useListAction(
  amount: bigint,
  pricePerToken: bigint,
  expiry: bigint,
  unlimited = false,
  onListed?: (listed: { hash: `0x${string}`; amount: bigint; pricePerToken: bigint }) => void,
): ActionState {
  const r = useReadiness()
  const { tenor, token, partition } = addresses
  const { send, phase } = useSender()
  // Same guard as buying: an approval just confirmed counts even before the allowance read catches up.
  const [approved, setApproved] = useState(0n)
  const tokenAllowance = r.tokenAllowance > approved ? r.tokenAllowance : approved
  useEffect(() => setApproved(0n), [r.tokenAllowance])

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
      return blocked('Get test HBAR', { helper: 'You need HBAR for the network fee. Hedera’s faucet gives 100 free at portal.hedera.com/faucet.' })
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
    if (tokenAllowance < amount) {
      const limit = unlimited ? maxUint256 : amount
      return ready(
        'Enable selling',
        async () => {
          const hash = await send('Enable selling', {
            address: token,
            abi: erc20Abi,
            functionName: 'approve',
            args: [tenor, limit],
          })
          if (hash) setApproved(limit)
        },
        { helper: 'Step 1 of 2. Lets the market reserve your tokens while they are listed.' },
      )
    }
    return null
  }, [gate, token, tenor, tokenAllowance, amount, unlimited, send])

  const canSimulate = !gate && !fixup && !phase && Boolean(tenor && token)
  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'list',
    args: token ? [token, partition, amount, pricePerToken, expiry] : undefined,
    account: r.address,
    query: { enabled: canSimulate },
  })

  const steps =
    !gate && amount > 0n
      ? [
          { label: 'Enable selling', done: tokenAllowance >= amount },
          { label: `List ${fmtTokens(amount, 6)}`, done: false },
        ]
      : undefined

  const heldSteps = useRef(steps)
  if (!phase) heldSteps.current = steps

  if (phase) return { ...inFlight(phase), steps: heldSteps.current }
  if (gate) return gate
  if (fixup) return { ...fixup, steps }
  if (sim.isLoading) return { ...blocked('Checking…'), steps }
  if (sim.error) {
    const d = resolve(sim.error)
    return { ...blocked(d.label), steps, helper: d.action ?? d.message, issuerOnly: d.issuerOnly }
  }
  if (!sim.data) return { ...blocked('Checking…'), steps }

  const title = `List ${fmtTokens(amount, 6)}`
  return {
    ...ready(title, async () => {
      const hash = await send(title, sim.data!.request)
      if (!hash) return
      setApproved(0n)
      onListed?.({ hash, amount, pricePerToken })
    }),
    steps,
  }
}

/** Cancelling your own listing. Allowed while the market is paused, which is why it skips the gate. */
export function useCancelAction(id: bigint | undefined): ActionState {
  const r = useReadiness()
  const { tenor } = addresses
  const { send, phase } = useSender()

  const sim = useSimulateContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'cancel',
    args: id !== undefined ? [id] : undefined,
    account: r.address,
    query: { enabled: Boolean(tenor && id !== undefined && r.address) },
  })

  if (phase) return inFlight(phase)
  if (r.disconnected) return blocked('Connect wallet')
  if (sim.isLoading) return blocked('Checking…')
  if (sim.error) {
    const d = resolve(sim.error)
    return { ...blocked(d.label), helper: d.action ?? d.message, issuerOnly: d.issuerOnly }
  }
  if (!sim.data) return blocked('Cancel listing')
  return ready('Cancel listing', () => send('Cancel listing', sim.data!.request))
}

export { fmtUsdc, fmtTokens, MIN_HBAR }
