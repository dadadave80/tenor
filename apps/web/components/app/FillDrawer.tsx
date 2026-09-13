'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { Icon, Identicon } from '@/components/landing/primitives'
import { fmtTokens, fmtUsdc, useFillAction } from '@/lib/actions'
import { hashscan } from '@/lib/chain'
import { fmtUsd, useUsdcUsd } from '@/lib/oracle'
import { useReadiness } from '@/lib/readiness'
import type { ListingRow } from './useListings'
import { Banner, Drawer, Field, Pill, PrimaryButton, SecondaryButton } from './ui'

const summary: React.CSSProperties = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '8px 16px',
  padding: 14,
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-2)',
  fontSize: 13,
}

type Bought = { id: bigint; hash: `0x${string}`; amount: bigint; cost: bigint }

/**
 * Buying from one listing.
 *
 * The readiness strip is the honest part of this panel: it shows the three account facts the trade
 * depends on BEFORE the button says anything, so a blocked button is never a surprise. `useFillAction`
 * decides the label; this component only draws it.
 *
 * Once the fill confirms, the drawer stops being a form. The listing it was opened on may now be empty or
 * gone, so recomputing the button against it would only offer steps that no longer apply.
 */
export function FillDrawer({ listing, onClose }: { listing: ListingRow | null; onClose: () => void }) {
  const r = useReadiness()
  const oracle = useUsdcUsd()
  const router = useRouter()
  const [raw, setRaw] = useState('')
  const [bought, setBought] = useState<Bought | null>(null)

  const decimals = listing?.tokenDecimals ?? 6
  const amount = raw ? parseUnits(raw, decimals) : 0n

  // A fresh listing means a fresh form; otherwise the previous amount silently applies to a
  // different listing's remaining balance.
  useEffect(() => {
    setRaw('')
    setBought(null)
  }, [listing?.id])

  const action = useFillAction(listing?.id, listing ?? undefined, amount, setBought)

  if (!listing) return null

  const price = Number(formatUnits(listing.pricePerToken, 6))
  const remaining = Number(formatUnits(listing.remaining, decimals))
  const affordable = price > 0 ? Math.floor(Number(formatUnits(r.usdc, 6)) / price) : 0
  const seller = `${listing.seller.slice(0, 6)}…${listing.seller.slice(-4)}`
  const subtitle = (
    <>
      <Identicon addr={listing.seller} size={16} />
      {seller} · {price.toFixed(2)} USDC per token
    </>
  )

  // Only for the listing it was bought from: a fill that lands after the drawer moved on must not claim another listing.
  if (bought && bought.id === listing.id) {
    return (
      <Drawer open onClose={onClose} title="Purchase complete" subtitle={subtitle}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 12,
            padding: '28px 0 8px',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: 'var(--radius-pill)',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--surface-tint)',
              color: 'var(--accent)',
            }}
          >
            <Icon name="check" size={26} />
          </span>
          <h3 style={{ margin: 0, fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em' }}>
            You bought {fmtTokens(bought.amount, decimals)}
          </h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, maxWidth: 320 }}>
            The bond and the USDC changed hands in one Hedera transaction, after the bond itself checked that you are
            verified.
          </p>
        </div>

        <dl style={summary}>
          <dt style={{ color: 'var(--text-2)' }}>Paid</dt>
          <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsdc(bought.cost)}</dd>
          <dt style={{ color: 'var(--text-2)' }}>Price</dt>
          <dd style={{ margin: 0, textAlign: 'right' }}>{price.toFixed(2)} USDC per token</dd>
          <dt style={{ color: 'var(--text-2)' }}>Seller</dt>
          <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{seller}</dd>
          <dt style={{ color: 'var(--text-2)' }}>Transaction</dt>
          <dd style={{ margin: 0, textAlign: 'right' }}>
            <a href={hashscan('transaction', bought.hash)} target="_blank" rel="noreferrer">
              View on HashScan
            </a>
          </dd>
        </dl>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <PrimaryButton
            action={{
              label: 'View in Holdings',
              pending: false,
              blocked: false,
              onClick: () => {
                onClose()
                router.push('/holdings')
              },
            }}
          />
          <SecondaryButton onClick={onClose}>Back to the market</SecondaryButton>
        </div>
      </Drawer>
    )
  }

  return (
    <Drawer open onClose={onClose} title="Buy TGN27" subtitle={subtitle}>
      {action.banner && <Banner kind={action.banner.kind}>{action.banner.text}</Banner>}

      {/* The three facts the trade depends on, stated before the button is read. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {r.unreadable ? (
          <Pill kind="neutral" icon="clock">
            Checking your account…
          </Pill>
        ) : r.frozen ? (
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

      <dl style={summary}>
        <dt style={{ color: 'var(--text-2)' }}>You pay</dt>
        <dd style={{ margin: 0, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
          {action.quote ? fmtUsdc(action.quote.cost) : '—'}
          {/* What that costs in dollars, but only while the reference says a USDC is a dollar. */}
          {action.quote && oracle.healthy && (
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              {fmtUsd(Number(formatUnits(action.quote.cost, 6)) * oracle.price!)}
            </div>
          )}
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
