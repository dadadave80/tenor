'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { fmtTokens, fmtUsdc, useListAction } from '@/lib/actions'
import { useReadiness } from '@/lib/readiness'
import { Banner, Drawer, Field, PrimaryButton } from './ui'

const DURATIONS = [
  { label: '24h', seconds: 86_400 },
  { label: '3d', seconds: 3 * 86_400 },
  { label: '7d', seconds: 7 * 86_400 },
] as const

/**
 * Listing tokens for sale.
 *
 * The approval here is not a formality: `list` creates a hold, and the hold consumes the seller's
 * allowance TO THE DIAMOND, so without it there is no reservation and no listing (SPEC §5.2). The
 * panel says "Enable selling" rather than "Approve" because what the user is enabling is the
 * market's ability to reserve — an approval they can revoke, not a transfer.
 */
export function SellDrawer({
  open,
  onClose,
  available,
}: {
  open: boolean
  onClose: () => void
  /** Balance minus what is already reserved by live listings, in token base units. */
  available: bigint
}) {
  const r = useReadiness()
  const [amountRaw, setAmountRaw] = useState('')
  const [priceRaw, setPriceRaw] = useState('')
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]>(DURATIONS[1])
  const [unlimited, setUnlimited] = useState(false)

  useEffect(() => {
    if (!open) {
      setAmountRaw('')
      setPriceRaw('')
    }
  }, [open])

  const amount = amountRaw ? parseUnits(amountRaw, 6) : 0n
  const price = priceRaw ? parseUnits(priceRaw, 6) : 0n
  // Recomputed on each render on purpose: an expiry pinned at mount would drift past the cap the
  // longer the drawer stays open, and `list` validates it against `block.timestamp`.
  const expiry = useMemo(
    () => BigInt(Math.floor(Date.now() / 1000) + duration.seconds),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally refreshed per render
    [duration, amountRaw, priceRaw],
  )

  const action = useListAction(amount, price, expiry, unlimited)

  const proceeds = amount > 0n && price > 0n ? (amount * price) / 1_000_000n : 0n

  return (
    <Drawer open={open} onClose={onClose} title="Sell TGN27" subtitle={`Available ${fmtTokens(available, 6)}`}>
      {action.banner && <Banner kind={action.banner.kind}>{action.banner.text}</Banner>}

      <Field
        label="Amount"
        value={amountRaw}
        onChange={setAmountRaw}
        suffix="TGN27"
        placeholder="0"
        onMax={() => setAmountRaw(String(Math.floor(Number(formatUnits(available, 6)))))}
        helper={`Reserved on the bond while listed. You keep custody until someone fills.`}
      />

      <Field
        label="Price per token"
        value={priceRaw}
        onChange={setPriceRaw}
        inputMode="decimal"
        suffix="USDC"
        placeholder="100.00"
        helper="Par is 100.00 USDC."
      />

      <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend style={{ fontSize: 13, color: 'var(--text-2)', padding: 0 }}>Expires in</legend>
        <div style={{ display: 'flex', gap: 8 }}>
          {DURATIONS.map((d) => {
            const on = d.label === duration.label
            return (
              <button
                key={d.label}
                type="button"
                onClick={() => setDuration(d)}
                aria-pressed={on}
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 'var(--radius-pill)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'var(--surface-tint)' : 'transparent',
                  color: on ? 'var(--accent)' : 'var(--text)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {d.label}
              </button>
            )
          })}
        </div>
      </fieldset>

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '8px 16px',
          padding: 14,
          borderRadius: 'var(--radius-card)',
          background: 'var(--surface-2)',
          fontSize: 13,
        }}
      >
        <dt style={{ color: 'var(--text-2)' }}>You receive</dt>
        <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
          {proceeds > 0n ? fmtUsdc(proceeds) : '—'}
        </dd>
        <dt style={{ color: 'var(--text-2)' }}>Reserved until</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>
          {new Date(Number(expiry) * 1000).toUTCString().slice(5, 22)} UTC
        </dd>
      </dl>

      {r.tokenAllowance < amount && amount > 0n && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, color: 'var(--text-2)' }}>
          <input
            type="checkbox"
            checked={unlimited}
            onChange={(e) => setUnlimited(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            Approve an unlimited selling limit, so later listings need no second approval. You can revoke it at any
            time.
          </span>
        </label>
      )}

      <div style={{ marginTop: 'auto' }}>
        <PrimaryButton action={action} />
      </div>
    </Drawer>
  )
}
