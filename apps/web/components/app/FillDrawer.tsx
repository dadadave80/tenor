'use client'

import { useEffect, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { Icon, Identicon } from '@/components/landing/primitives'
import { fmtUsdc, useFillAction } from '@/lib/actions'
import { useReadiness } from '@/lib/readiness'
import type { ListingRow } from './useListings'
import { Banner, Drawer, Field, Pill, PrimaryButton } from './ui'

/**
 * Buying from one listing.
 *
 * The readiness strip is the honest part of this panel: it shows the three account facts the trade
 * depends on BEFORE the button says anything, so a blocked button is never a surprise. `useFillAction`
 * decides the label; this component only draws it.
 */
export function FillDrawer({ listing, onClose }: { listing: ListingRow | null; onClose: () => void }) {
  const r = useReadiness()
  const [raw, setRaw] = useState('')

  const decimals = listing?.tokenDecimals ?? 6
  const amount = raw ? parseUnits(raw, decimals) : 0n

  // A fresh listing means a fresh form; otherwise the previous amount silently applies to a
  // different listing's remaining balance.
  useEffect(() => {
    setRaw('')
  }, [listing?.id])

  const action = useFillAction(listing?.id, listing ?? undefined, amount)

  if (!listing) return null

  const price = Number(formatUnits(listing.pricePerToken, 6))
  const remaining = Number(formatUnits(listing.remaining, decimals))
  const affordable = price > 0 ? Math.floor(Number(formatUnits(r.usdc, 6)) / price) : 0

  return (
    <Drawer
      open
      onClose={onClose}
      title="Buy TGN27"
      subtitle={
        <>
          <Identicon addr={listing.seller} size={16} />
          {listing.seller.slice(0, 6)}…{listing.seller.slice(-4)} · {price.toFixed(2)} USDC per token
        </>
      }
    >
      {action.banner && <Banner kind={action.banner.kind}>{action.banner.text}</Banner>}

      {/* The three facts the trade depends on, stated before the button is read. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {r.frozen ? (
          <Pill kind="danger" icon="snow">
            Account frozen
          </Pill>
        ) : r.verified ? (
          <Pill kind="accent" icon="check">
            Verified
          </Pill>
        ) : (
          <Pill kind="warning" icon="clock">
            Verification pending
          </Pill>
        )}
        {r.usdcAssociated ? (
          <Pill kind="accent" icon="check">
            USDC enabled
          </Pill>
        ) : (
          <Pill kind="warning" icon="clock">
            USDC not enabled
          </Pill>
        )}
        <Pill kind={r.usdc > 0n ? 'neutral' : 'warning'}>Balance {fmtUsdc(r.usdc)}</Pill>
      </div>

      <Field
        label="Amount"
        value={raw}
        onChange={setRaw}
        suffix="TGN27"
        placeholder="0"
        onMax={() => setRaw(String(Math.max(0, Math.min(remaining, affordable))))}
        helper={`${remaining.toLocaleString('en-US')} available at this price`}
      />

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
        <dt style={{ color: 'var(--text-2)' }}>You pay</dt>
        <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
          {action.quote ? fmtUsdc(action.quote.cost) : '—'}
        </dd>
        <dt style={{ color: 'var(--text-2)' }}>Protocol fee</dt>
        <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
          {action.quote ? fmtUsdc(action.quote.fee) : '—'}
        </dd>
        <dt style={{ color: 'var(--text-2)' }}>Settles</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>Tokens and USDC in one transaction</dd>
      </dl>

      {action.issuerOnly && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
          <Icon name="shield" size={12} /> This is enforced by the bond contract, not by Tenor. Only the issuer can
          change it.
        </p>
      )}

      {/* Every action in `actions.ts` reports itself to the activity tray, so there is nothing to
          wire here: the tray shows the hash and follows it to a receipt. */}
      <div style={{ marginTop: 'auto' }}>
        <PrimaryButton action={action} />
      </div>
    </Drawer>
  )
}
