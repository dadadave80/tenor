'use client'

import { useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { Icon, Identicon, useViewport } from '@/components/landing/primitives'
import { FillDrawer } from '@/components/app/FillDrawer'
import { SetupCard } from '@/components/app/SetupCard'
import { liveListings, useListings, type ListingRow } from '@/components/app/useListings'
import { Card, Pill, SecondaryButton, Spinner } from '@/components/app/ui'
import { addresses, hashscan } from '@/lib/chain'
import { useReadiness } from '@/lib/readiness'

/** Maturity of the demo instrument. Used only for the yield figure, which is labelled as derived. */
const MATURITY = Date.UTC(2027, 8, 15)
const COUPON_RATE = 6

/**
 * Yield to maturity, the same approximation the design canvas uses.
 *
 * Shown because price alone does not tell an investor whether a listing is good, but it is a
 * DERIVED number, not a chain read — so it is labelled "est." and never dressed up as a quote.
 */
function ytm(price: number): number {
  const years = Math.max(0.05, (MATURITY - Date.now()) / (365 * 864e5))
  return ((COUPON_RATE + (100 - price) / years) / ((100 + price) / 2)) * 100
}

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

export default function MarketPage() {
  const { rows, loading } = useListings()
  const r = useReadiness()
  const { isNarrow } = useViewport()
  const [picked, setPicked] = useState<ListingRow | null>(null)
  const [hideMine, setHideMine] = useState(false)
  const [setupHidden, setSetupHidden] = useState(false)

  const live = useMemo(() => liveListings(rows), [rows])
  const visible = useMemo(
    () => (hideMine && r.address ? live.filter((l) => l.seller.toLowerCase() !== r.address!.toLowerCase()) : live),
    [live, hideMine, r.address],
  )

  const best = live.length ? Number(formatUnits(live[0].pricePerToken, 6)) : undefined
  const depth = live.reduce((a, l) => a + l.remaining, 0n)
  const maxSize = live.reduce((a, l) => (l.remaining > a ? l.remaining : a), 1n)

  const setupReady = !r.disconnected && r.hbar > 0n && r.usdcAssociated && r.usdc > 0n && r.verified

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: 'clamp(28px, 3vw, 36px)', fontWeight: 500, letterSpacing: '-0.02em' }}>
            Tenor Green Note 2027
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
            TGN27 · 6.00% semi-annual · matures 15 Sep 2027 ·{' '}
            {addresses.token ? (
              <a href={hashscan('contract', addresses.token)} target="_blank" rel="noreferrer">
                on HashScan
              </a>
            ) : (
              '—'
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <Stat label="Best offer" value={best !== undefined ? `${best.toFixed(2)} USDC` : '—'} />
          <Stat label="Est. yield" value={best !== undefined ? `${ytm(best).toFixed(2)}%` : '—'} accent />
          <Stat label="Offered" value={depth > 0n ? `${Number(formatUnits(depth, 6)).toLocaleString('en-US')}` : '—'} />
          <Stat label="Open listings" value={live.length ? String(live.length) : '—'} />
        </div>
      </header>

      {!setupReady && !setupHidden && <SetupCard onDismiss={() => setSetupHidden(true)} />}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Offers</h2>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
            <input type="checkbox" checked={hideMine} onChange={(e) => setHideMine(e.target.checked)} />
            Hide mine
          </label>
        </div>

        {loading && (
          <div style={{ padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-2)' }}>
            <Spinner size={16} /> Reading the market…
          </div>
        )}

        {!loading && !addresses.tenor && (
          <Empty>
            The market contract is not configured in this build. Deploy it, then run{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>bun run sync:env</code>.
          </Empty>
        )}

        {!loading && addresses.tenor && visible.length === 0 && (
          <Empty>
            No open offers. A verified holder can list tokens from{' '}
            <a href="/holdings">Holdings</a>.
          </Empty>
        )}

        {visible.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: isNarrow ? 640 : undefined }}>
              <thead>
                <tr style={{ color: 'var(--text-2)', fontSize: 12, textAlign: 'left' }}>
                  <Th>Size</Th>
                  <Th align="right">Price</Th>
                  <Th align="right">Est. yield</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Expires</Th>
                  <Th>Seller</Th>
                  <Th align="right"> </Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const price = Number(formatUnits(l.pricePerToken, 6))
                  const size = Number(formatUnits(l.remaining, l.tokenDecimals))
                  const total = (size * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  const isBest = l.pricePerToken === live[0].pricePerToken
                  const mine = r.address && l.seller.toLowerCase() === r.address.toLowerCase()
                  const soon = Number(l.expiry) * 1000 - Date.now() < 3600_000
                  return (
                    <tr
                      key={String(l.id)}
                      style={{
                        borderTop: '1px solid var(--border)',
                        background: isBest ? 'var(--surface-tint)' : undefined,
                      }}
                    >
                      <Td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontFamily: 'var(--font-mono)' }}>{size.toLocaleString('en-US')}</span>
                          <span
                            aria-hidden
                            style={{
                              height: 3,
                              width: `${(Number(l.remaining) / Number(maxSize)) * 100}%`,
                              minWidth: 4,
                              background: 'var(--border)',
                              borderRadius: 'var(--radius-pill)',
                            }}
                          />
                        </div>
                      </Td>
                      <Td align="right" mono>
                        {price.toFixed(2)}
                      </Td>
                      <Td align="right" mono style={{ color: 'var(--accent)' }}>
                        {ytm(price).toFixed(2)}%
                      </Td>
                      <Td align="right" mono>
                        {total}
                      </Td>
                      <Td align="right" mono style={{ color: soon ? 'var(--warning)' : undefined }}>
                        {relative(l.expiry)}
                      </Td>
                      <Td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          <Identicon addr={l.seller} size={20} />
                          {mine ? 'You' : `${l.seller.slice(0, 6)}…${l.seller.slice(-4)}`}
                        </span>
                      </Td>
                      <Td align="right">
                        {mine ? (
                          <Pill kind="neutral">Yours</Pill>
                        ) : r.marketPaused || r.tokenPaused ? (
                          <Pill kind="warning" icon="pause">
                            Paused
                          </Pill>
                        ) : (
                          <SecondaryButton onClick={() => setPicked(l)}>Buy</SecondaryButton>
                        )}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="shield" size={12} />
        Every fill is checked by the bond contract itself. Tenor cannot move tokens the bond would refuse to move.
      </p>

      <FillDrawer listing={picked} onClose={() => setPicked(null)} />
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-2)', fontSize: 14 }}>{children}</div>
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '10px 20px', textAlign: align, fontWeight: 500 }}>{children}</th>
}

function Td({
  children,
  align = 'left',
  mono,
  style,
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  mono?: boolean
  style?: React.CSSProperties
}) {
  return (
    <td style={{ padding: '12px 20px', textAlign: align, fontFamily: mono ? 'var(--font-mono)' : undefined, ...style }}>
      {children}
    </td>
  )
}
