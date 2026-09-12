'use client'

import { hashscan } from '@/lib/chain'
import { Icon, Identicon, revealStyle, useReveal, useViewport } from './primitives'

/** The three KYC rows in step 01 — two verified, one pending, mirroring the demo's A/B/C. */
const KYC_ROWS: [addr: string, verified: boolean][] = [
  ['0x1f…9c2e', true],
  ['0x8a…41d0', true],
  ['0x3c…77be', false],
]

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-hero)',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
}

const mockStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  fontSize: 13,
  minHeight: 160,
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>{n}</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>{title}</h3>
      <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 15 }}>{body}</p>
    </div>
  )
}

/** Small ribbon badge used inside the step mockups. */
function Badge({ size = 20, img = 12 }: { size?: number; img?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 6, background: 'var(--surface-tint)', display: 'grid', placeItems: 'center' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/tenor-ribbon.png" alt="Tenor" style={{ height: img, width: 'auto', display: 'block' }} />
    </span>
  )
}

export function HowItWorks() {
  const [ref, shown] = useReveal<HTMLElement>()
  const { isNarrow } = useViewport()

  return (
    <section
      id="how"
      ref={ref}
      style={{
        maxWidth: 1440,
        margin: '0 auto',
        padding: 'clamp(80px, 10vw, 160px) clamp(16px, 4vw, 48px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 48,
        ...revealStyle(shown),
      }}
    >
      <div style={{ maxWidth: 640 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 'clamp(32px, 3.2vw, 44px)', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          How it works
        </h2>
        <p style={{ margin: 0, fontSize: 18, color: 'var(--text-2)' }}>
          Three steps, three transactions, no intermediary holding anything.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 24 }}>
        {/* --- 01 issue on ATS ---------------------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={mockStyle}>
            <div style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>Investors · ATS</div>
            {KYC_ROWS.map(([addr, verified]) => (
              <div key={addr} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Identicon addr={addr} size={18} />
                <span style={{ fontFamily: 'var(--font-mono)', flex: 1 }}>{addr}</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 'var(--radius-pill)',
                    background: verified ? 'var(--surface-tint)' : 'var(--warning-soft)',
                    color: verified ? 'var(--accent)' : 'var(--warning)',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  <Icon name={verified ? 'check' : 'clock'} size={11} />
                  {verified ? 'Verified' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
          <Step
            n="01"
            title="Issue on ATS."
            body="The issuer creates the bond, verifies investors, and sets the rules. Tenor changes nothing here."
          />
        </div>

        {/* --- 02 list without leaving your wallet -------------------------------------------- */}
        <div style={cardStyle}>
          <div style={mockStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
              <Badge />
              Sell TGN27
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-input)', padding: '8px 10px', background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Amount</div>
                <div style={{ fontFamily: 'var(--font-mono)' }}>
                  200 <span style={{ fontSize: 11, color: 'var(--text-2)' }}>TGN27</span>
                </div>
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-input)', padding: '8px 10px', background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Price</div>
                <div style={{ fontFamily: 'var(--font-mono)' }}>
                  98.00 <span style={{ fontSize: 11, color: 'var(--text-2)' }}>USDC</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)' }}>
              <span>You receive</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>19,600.00 USDC</span>
            </div>
            <div
              style={{
                height: 36,
                borderRadius: 'var(--radius-pill)',
                background: 'var(--btn)',
                color: 'var(--btn-fg)',
                fontWeight: 500,
                display: 'grid',
                placeItems: 'center',
                fontSize: 13,
              }}
            >
              List 200 TGN27
            </div>
          </div>
          <Step
            n="02"
            title="List without leaving your wallet."
            body="Tokens stay in your wallet, reserved for the listing. One transaction."
          />
        </div>

        {/* --- 03 settle in one transaction --------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={mockStyle}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 'var(--radius-pill)',
                background: 'var(--surface-tint)',
                color: 'var(--accent)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="check" size={16} />
            </span>
            <div style={{ fontSize: 16, fontWeight: 500 }}>You bought 50 TGN27</div>
            <div style={{ color: 'var(--text-2)' }}>4,900.00 USDC paid to 0x8a…41d0</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
              <a href={hashscan('transaction', '')} target="_blank" rel="noreferrer">
                Hedera transaction <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>0.0.4821@1757…</span>
              </a>
              <a href={hashscan('transaction', '')} target="_blank" rel="noreferrer">
                EVM hash <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>0x9c4e…f21a</span>
              </a>
            </div>
          </div>
          <Step
            n="03"
            title="Settle in one transaction."
            body="USDC to the seller, tokens to the buyer, and the bond checks the buyer first."
          />
        </div>
      </div>
    </section>
  )
}
