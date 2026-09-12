'use client'

import { useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { Icon } from '@/components/landing/primitives'
import { SellDrawer } from '@/components/app/SellDrawer'
import { useListings, type ListingRow } from '@/components/app/useListings'
import { Card, Pill, PrimaryButton, SecondaryButton, Spinner } from '@/components/app/ui'
import { fmtTokens, fmtUsdc, useCancelAction } from '@/lib/actions'
import { addresses, hashscan } from '@/lib/chain'
import { useReadiness } from '@/lib/readiness'

function relative(seconds: bigint): string {
  const ms = Number(seconds) * 1000 - Date.now()
  if (ms <= 0) return 'expired'
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d} d ${h % 24} h`
  if (h > 0) return `${h} h ${m % 60} m`
  return `${m} m`
}

export default function HoldingsPage() {
  const r = useReadiness()
  const { rows, loading } = useListings()
  const [selling, setSelling] = useState(false)

  const mine = useMemo(
    () => (r.address ? rows.filter((l) => l.seller.toLowerCase() === r.address!.toLowerCase()) : []),
    [rows, r.address],
  )
  const now = BigInt(Math.floor(Date.now() / 1000))
  const reserved = mine.filter((l) => l.active && l.expiry > now).reduce((a, l) => a + l.remaining, 0n)

  // The balance already counts held tokens, so what is free to list is balance minus reservations.
  const available = r.tokens > reserved ? r.tokens - reserved : 0n

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: 'clamp(28px, 3vw, 36px)', fontWeight: 500, letterSpacing: '-0.02em' }}>
            Holdings
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
            What you hold, what is reserved by your listings, and what you can sell.
          </p>
        </div>
        <SecondaryButton onClick={() => setSelling(true)} disabled={available === 0n}>
          Sell tokens
        </SecondaryButton>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>TGN27 balance</div>
          <div style={{ fontSize: 26, fontWeight: 500 }}>
            {addresses.token ? Number(formatUnits(r.tokens, 6)).toLocaleString('en-US') : '—'}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Reserved by your listings</div>
          <div style={{ fontSize: 26, fontWeight: 500 }}>
            {addresses.tenor ? Number(formatUnits(reserved, 6)).toLocaleString('en-US') : '—'}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Free to sell</div>
          <div style={{ fontSize: 26, fontWeight: 500, color: 'var(--accent)' }}>
            {addresses.tenor ? Number(formatUnits(available, 6)).toLocaleString('en-US') : '—'}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>USDC</div>
          <div style={{ fontSize: 26, fontWeight: 500 }}>{addresses.usdc ? fmtUsdc(r.usdc) : '—'}</div>
        </Card>
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Your listings</h2>
        </div>

        {loading && (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center', gap: 10, color: 'var(--text-2)' }}>
            <Spinner size={16} /> Reading your listings…
          </div>
        )}

        {!loading && mine.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-2)', fontSize: 14 }}>
            {r.disconnected
              ? 'Sign in to see your listings.'
              : available > 0n
                ? 'No listings yet. Sell tokens to open one.'
                : 'No listings, and no tokens free to sell.'}
          </div>
        )}

        {mine.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 620 }}>
              <thead>
                <tr style={{ color: 'var(--text-2)', fontSize: 12, textAlign: 'left' }}>
                  <th style={{ padding: '10px 20px', fontWeight: 500 }}>Remaining</th>
                  <th style={{ padding: '10px 20px', fontWeight: 500, textAlign: 'right' }}>Price</th>
                  <th style={{ padding: '10px 20px', fontWeight: 500, textAlign: 'right' }}>Expires</th>
                  <th style={{ padding: '10px 20px', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '10px 20px', fontWeight: 500, textAlign: 'right' }}> </th>
                </tr>
              </thead>
              <tbody>
                {mine.map((l) => (
                  <MyListingRow key={String(l.id)} listing={l} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="shield" size={12} />
        Listed tokens never leave your account. They are held on the bond, and released to you if you cancel or the
        listing expires.
      </p>

      <SellDrawer open={selling} onClose={() => setSelling(false)} available={available} />
    </div>
  )
}

/** One row, with its own cancel action so the simulation is scoped to that listing. */
function MyListingRow({ listing }: { listing: ListingRow }) {
  const cancel = useCancelAction(listing.id)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const expired = listing.expiry <= now
  const soon = !expired && Number(listing.expiry) * 1000 - Date.now() < 3600_000

  const status = !listing.active ? (
    <Pill kind="neutral">Closed</Pill>
  ) : expired ? (
    <Pill kind="warning" icon="clock">
      Expired
    </Pill>
  ) : soon ? (
    <Pill kind="warning" icon="clock">
      Expiring
    </Pill>
  ) : (
    <Pill kind="accent" icon="check">
      Active
    </Pill>
  )

  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '12px 20px', fontFamily: 'var(--font-mono)' }}>
        {fmtTokens(listing.remaining, listing.tokenDecimals)}
      </td>
      <td style={{ padding: '12px 20px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
        {Number(formatUnits(listing.pricePerToken, 6)).toFixed(2)}
      </td>
      <td
        style={{
          padding: '12px 20px',
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          color: soon || expired ? 'var(--warning)' : undefined,
        }}
      >
        {relative(listing.expiry)}
      </td>
      <td style={{ padding: '12px 20px' }}>{status}</td>
      <td style={{ padding: '12px 20px', textAlign: 'right' }}>
        {listing.active ? (
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: 220 }}>
            <PrimaryButton action={cancel} full={false} />
          </div>
        ) : (
          <a href={addresses.tenor ? hashscan('contract', addresses.tenor) : '#'} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            HashScan
          </a>
        )}
      </td>
    </tr>
  )
}
