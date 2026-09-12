'use client'

import { hashscan } from '@/lib/chain'
import { Icon, Identicon, useLoop, useViewport } from './primitives'

/**
 * The hero, including the settlement card that loops the product's core claim: one transaction in
 * which the bond checks the buyer, USDC goes one way, the bond goes the other.
 *
 * The loop is 9s, and the beats are the design's: compliance checks tick green at 0.9/1.7/2.5s, the
 * two flows run 3.2–6.0s, the receipt fades in at 6.2s, and the card fades out at 8.4s to restart.
 */
const CHECKS: [label: string, atMs: number][] = [
  ['Verified investor', 900],
  ['Account not frozen', 1700],
  ['Trading open', 2500],
]

const BUYER = '0x1f…9c2e'
const SELLER = '0x8a…41d0'

export function Hero() {
  const t = useLoop(9000)
  const { isNarrow } = useViewport()

  // Before the timer starts (SSR and first paint) the card sits fully drawn rather than mid-fade.
  const started = t > 0
  const flowing = started && t >= 3200 && t < 6000
  const receipt = !started || t >= 6200 ? 1 : 0
  const cardOpacity = started && (t >= 8400 || t < 300) ? 0 : 1

  return (
    <section
      id="top"
      style={{
        position: 'relative',
        minHeight: 'calc(100vh - 64px)',
        display: 'grid',
        gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1.1fr) minmax(0, 1fr)',
        gap: 'clamp(32px, 5vw, 80px)',
        alignItems: 'center',
        padding: 'clamp(48px, 8vh, 96px) clamp(16px, 4vw, 48px)',
        maxWidth: 1440,
        margin: '0 auto',
      }}
    >
      {/* The yield curve, drawn faintly behind the hero — the one piece of ornament on the page. */}
      <svg
        viewBox="0 0 1440 700"
        preserveAspectRatio="none"
        style={{ position: 'absolute', left: 0, right: 0, top: 0, width: '100%', height: '100%', opacity: 0.06, pointerEvents: 'none', zIndex: 0 }}
        aria-hidden
      >
        <path
          d="M0 640 C 320 600, 520 380, 780 330 S 1220 290, 1440 160"
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 640 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(44px, 6.4vw, 92px)',
            lineHeight: 1.02,
            fontWeight: 500,
            letterSpacing: '-0.03em',
            textWrap: 'balance',
          }}
        >
          Bonds that enforce their own rules.
        </h1>
        <p style={{ margin: 0, fontSize: 'clamp(17px, 1.5vw, 20px)', color: 'var(--text-2)', maxWidth: 540, textWrap: 'pretty' }}>
          Tenor is a secondary market for regulated bond tokens. Verified investors trade peer-to-peer, the bond checks every
          trade, and coupons pay themselves.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <a
            href="/market"
            className="pill-primary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 48,
              padding: '0 22px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--btn)',
              color: 'var(--btn-fg)',
              fontWeight: 500,
              fontSize: 15,
            }}
          >
            Open the market
          </a>
          <a
            href="#demo"
            className="pill-ghost"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 48,
              padding: '0 20px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontWeight: 500,
              fontSize: 15,
            }}
          >
            <Icon name="play" size={14} />
            Watch the 3-minute demo
          </a>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
            fontSize: 13,
            color: 'var(--text-2)',
            fontWeight: 500,
            letterSpacing: '0.02em',
            paddingTop: 8,
          }}
        >
          <span>Hedera ATS</span>
          <span>Hedera Token Service</span>
          <span>Privy</span>
        </div>
      </div>

      {/* --- the settlement card ------------------------------------------------------------- */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'center' }}>
        <div
          style={{
            width: '100%',
            maxWidth: 440,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-hero)',
            boxShadow: 'var(--shadow)',
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            fontSize: 14,
            opacity: cardOpacity,
            transition: 'opacity 500ms ease-out',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                background: 'var(--surface-tint)',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/tenor-ribbon.svg" alt="Tenor" style={{ height: 18, width: 'auto', display: 'block' }} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>Buy 50 TGN27</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Tenor Green Note 2027 · from {SELLER}</div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.01em' }}>
              4,900.00 <span style={{ fontSize: 12, color: 'var(--text-2)' }}>USDC</span>
            </div>
          </div>

          {/* The compliance checks the TOKEN performs — not the market. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-input)',
              padding: '12px 14px',
            }}
          >
            {CHECKS.map(([label, at]) => {
              const done = !started || t >= at
              return (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 13,
                    color: done ? 'var(--text)' : 'var(--text-2)',
                    transition: 'color 200ms',
                  }}
                >
                  {done ? (
                    <Icon name="check" size={14} color="var(--accent)" />
                  ) : (
                    <span
                      style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--border)', display: 'inline-block', margin: 4 }}
                    />
                  )}
                  {label}
                </div>
              )
            })}
          </div>

          {/* Delivery versus payment, drawn as two opposing flows. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'center', padding: '4px 0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-2)' }}>
              <Identicon addr={BUYER} size={28} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{BUYER}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
                <span style={{ position: 'absolute', left: 0, right: 0, height: 1, background: 'var(--border)' }} />
                <span
                  style={{ position: 'absolute', left: '50%', top: -8, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}
                >
                  USDC
                </span>
                {flowing && (
                  <span
                    style={{
                      position: 'absolute',
                      width: 10,
                      height: 10,
                      marginLeft: -5,
                      borderRadius: 999,
                      background: 'var(--info)',
                      animation: 'flowR 2.2s ease-in-out infinite',
                    }}
                  />
                )}
              </div>
              <div style={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
                <span style={{ position: 'absolute', left: 0, right: 0, height: 1, background: 'var(--border)' }} />
                <span
                  style={{ position: 'absolute', left: '50%', bottom: -8, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}
                >
                  TGN27
                </span>
                {flowing && (
                  <span
                    style={{
                      position: 'absolute',
                      width: 10,
                      height: 10,
                      marginLeft: -5,
                      borderRadius: 999,
                      background: 'var(--accent)',
                      animation: 'flowL 2.2s ease-in-out infinite',
                    }}
                  />
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-2)' }}>
              <Identicon addr={SELLER} size={28} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{SELLER}</span>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              borderTop: '1px solid var(--border)',
              paddingTop: 12,
              fontSize: 13,
              minHeight: 34,
              opacity: receipt,
              transition: 'opacity 300ms ease-out',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontWeight: 500 }}>
              <Icon name="check" size={14} />
              Settled in one transaction · <span style={{ fontFamily: 'var(--font-mono)' }}>2.1 s</span>
            </span>
            <a href={hashscan('transaction', '')} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              HashScan
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
