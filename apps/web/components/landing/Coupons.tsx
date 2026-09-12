'use client'

import { useEffect, useState } from 'react'
import { hashscan } from '@/lib/chain'
import { Icon, revealStyle, useLoop, useReveal, useViewport } from './primitives'

/**
 * Coupons pay themselves — the Hedera Schedule Service section.
 *
 * A 14s loop: an 8s countdown to the pay date, 5s showing it paid, 1s before it resets. The point
 * of animating it is that nothing in the sequence is a click: the network fires the call.
 */
const ISSUED = Date.UTC(2025, 8, 15)
const MATURITY = Date.UTC(2027, 8, 15)
const NEXT_COUPON = Date.UTC(2026, 11, 15)

const NODES = ['15 Mar', '15 Jun', '15 Sep', '15 Dec']

export function Coupons() {
  const [ref, shown] = useReveal<HTMLElement>()
  const { isNarrow } = useViewport()
  const ap = useLoop(14000)

  // Anything derived from `Date.now()` must not render on the server, or the markup the client
  // produces on hydration differs from it. Held back until mounted, and rendered as `—` until then.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const secs = Math.max(0, Math.ceil((8000 - ap) / 1000))
  const paid = ap >= 8000 && ap < 13000

  const matPct = now === null ? 0 : Math.min(100, Math.max(0, ((now - ISSUED) / (MATURITY - ISSUED)) * 100))
  const maturityDays = now === null ? null : Math.ceil((MATURITY - now) / 864e5)
  const nextCouponDays = now === null ? null : Math.ceil((NEXT_COUPON - now) / 864e5)

  return (
    <section
      id="demo"
      ref={ref}
      style={{
        maxWidth: 1440,
        margin: '0 auto',
        padding: 'clamp(80px, 10vw, 160px) clamp(16px, 4vw, 48px)',
        display: 'grid',
        gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 'clamp(32px, 5vw, 80px)',
        alignItems: 'center',
        ...revealStyle(shown),
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-hero)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          order: isNarrow ? 2 : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Coupons 2026 · 1.50 USDC per token</div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 10px',
              borderRadius: 'var(--radius-pill)',
              background: paid ? 'var(--surface-tint)' : 'var(--info-soft)',
              color: paid ? 'var(--accent)' : 'var(--info)',
              fontSize: 12,
              fontWeight: 500,
              transition: 'all 300ms',
            }}
          >
            <Icon name={paid ? 'check' : 'clock'} size={12} />
            {paid ? 'Paid' : 'Scheduled'}
          </span>
        </div>

        {/* The coupon rail: three paid, the fourth pulsing until the network fires it. */}
        <div style={{ position: 'relative', height: 12, display: 'flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 6, right: 6, height: 2, background: 'var(--border)' }} />
          <span
            style={{
              position: 'absolute',
              left: 6,
              width: paid ? 'calc(100% - 12px)' : 'calc((100% - 12px) * 0.6667)',
              height: 2,
              background: 'var(--accent)',
              transition: 'width 600ms ease-out',
            }}
          />
          {NODES.map((_, i) => {
            const done = i < 3 || paid
            return (
              <span
                key={i}
                style={{
                  position: 'absolute',
                  left: `${(i / 3) * 100}%`,
                  transform: 'translateX(-50%)',
                  width: 12,
                  height: 12,
                  borderRadius: 'var(--radius-pill)',
                  background: done ? 'var(--accent)' : 'var(--surface)',
                  border: '2px solid var(--accent)',
                  animation: done ? 'none' : 'pulse 1.2s ease-out infinite',
                  transition: 'background 300ms',
                }}
              />
            )
          })}
        </div>

        <div style={{ position: 'relative', height: 36 }}>
          {NODES.map((label, i) => (
            <span
              key={label}
              style={{
                position: 'absolute',
                left: `${(i / 3) * 100}%`,
                transform: `translateX(${i === 0 ? '0' : i === 3 ? '-100%' : '-50%'})`,
                fontSize: 12,
                whiteSpace: 'nowrap',
                textAlign: i === 0 ? 'left' : i === 3 ? 'right' : 'center',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)' }}>{label}</span>
              <br />
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                {i < 3 ? 'Paid' : paid ? 'Paid' : `in ${secs} s`}
              </span>
            </span>
          ))}
        </div>

        <div
          style={{
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-input)',
            padding: '10px 14px',
            fontSize: 13,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {paid ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Icon name="check" size={14} color="var(--accent)" />
              Paid · 3 holders · 225.00 USDC
              <a href={hashscan('transaction', '')} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                HashScan
              </a>
            </span>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>
              Schedule 0.0.5123388 executes in <span style={{ color: 'var(--text)' }}>{secs} s</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)' }}>
            <span>Matures 15 Sep 2027</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
              {maturityDays === null ? '—' : `${maturityDays} days`}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${matPct.toFixed(1)}%`, background: 'var(--accent)', borderRadius: 'var(--radius-pill)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
            <span>Issued 15 Sep 2025</span>
            <span>{now === null ? '—' : `${Math.round(matPct)}% elapsed`}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 520 }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(32px, 3.2vw, 44px)', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          Coupons pay themselves.
        </h2>
        <p style={{ margin: 0, fontSize: 18, color: 'var(--text-2)' }}>
          Scheduled on Hedera, executed by the network. Nobody clicks.
        </p>
        <p style={{ margin: 0, fontSize: 15, color: 'var(--text-2)' }}>
          The issuer funds a coupon once and schedules it with the Hedera Schedule Service. At the pay date every registered
          holder receives their share in the same transaction, and the receipt is on HashScan before anyone opens the app.
          {nextCouponDays !== null && nextCouponDays > 0 ? ` The next one is ${nextCouponDays} days away.` : ''}
        </p>
      </div>
    </section>
  )
}
