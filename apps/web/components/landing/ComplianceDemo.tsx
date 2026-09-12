'use client'

import { useState } from 'react'
import { Icon, type IconName, revealStyle, useReveal, useViewport } from './primitives'

/**
 * The compliance toggle demo: flip a rule and watch the buy button's LABEL change.
 *
 * This is the page's argument in interactive form — the market never decides who may trade, the bond
 * does, and the client surfaces that decision before anyone signs. The three labels here are the
 * same strings `lib/errors.ts` produces for the real `InvalidKycStatus`, frozen-account and
 * `IsPaused` reverts, so the demo is not a dramatisation: it is what the app actually shows when a
 * simulation comes back refused.
 */
type Kind = 'warning' | 'danger'

const TOGGLES = [
  { key: 'verified', label: 'Verified', sub: 'Issuer has verified this investor', on: 'var(--accent)' },
  { key: 'frozen', label: 'Frozen', sub: 'Issuer froze the account in ATS', on: 'var(--danger)' },
  { key: 'paused', label: 'Trading paused', sub: 'Issuer paused the token', on: 'var(--warning)' },
] as const

type ToggleKey = (typeof TOGGLES)[number]['key']

function Chip({ label, bg, color, icon }: { label: string; bg: string; color: string; icon: IconName }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        borderRadius: 'var(--radius-pill)',
        background: bg,
        color,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <Icon name={icon} size={12} color={icon === 'check' ? 'var(--accent)' : 'currentColor'} />
      {label}
    </span>
  )
}

export function ComplianceDemo() {
  const [ref, shown] = useReveal<HTMLElement>()
  const { isNarrow } = useViewport()
  const [state, setState] = useState<Record<ToggleKey, boolean>>({ verified: true, frozen: false, paused: false })

  // The state machine, in the design's precedence order: verification first, then freeze, then pause.
  // Precedence matters — an unverified AND frozen account is told the more fundamental thing.
  let label = 'Buy 50 TGN27'
  let banner: string | null = null
  let kind: Kind = 'warning'
  if (!state.verified) {
    label = 'Verification required'
    banner = 'Only investors verified by the issuer can buy. Ask the issuer to verify 0x1f…9c2e.'
  } else if (state.frozen) {
    label = 'Account frozen'
    banner = 'The issuer has frozen this account. Contact the issuer.'
    kind = 'danger'
  } else if (state.paused) {
    label = 'Trading paused'
    banner = 'Trading is paused by the issuer. Listings stay reserved; you can still cancel.'
  }
  const blocked = banner !== null

  const chips: React.ComponentProps<typeof Chip>[] =
    state.frozen && state.verified
      ? [{ label: 'Account frozen', bg: 'var(--danger-soft)', color: 'var(--danger)', icon: 'alert' }]
      : state.verified
        ? [{ label: 'Verified', bg: 'var(--surface-2)', color: 'var(--text)', icon: 'check' }]
        : [{ label: 'Verification pending', bg: 'var(--warning-soft)', color: 'var(--warning)', icon: 'clock' }]
  chips.push({ label: 'USDC enabled', bg: 'var(--surface-2)', color: 'var(--text)', icon: 'check' })
  chips.push({ label: 'Balance 5,000.00 USDC', bg: 'var(--surface-2)', color: 'var(--text)', icon: 'check' })

  return (
    <section
      id="compliance"
      ref={ref}
      style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
    >
      <div
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 520 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'clamp(32px, 3.2vw, 44px)',
              fontWeight: 500,
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
              textWrap: 'balance',
            }}
          >
            The market never asks permission. The bond decides.
          </h2>
          <p style={{ margin: 0, fontSize: 18, color: 'var(--text-2)' }}>
            Every rule is enforced by the token at settlement, so a rule can&rsquo;t be bypassed by a different front end.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {TOGGLES.map((t) => {
              const on = state[t.key]
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setState((s) => ({ ...s, [t.key]: !s[t.key] }))}
                  className="toggle-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    height: 48,
                    padding: '0 14px 0 16px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--bg)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 500, fontSize: 14 }}>{t.label}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.sub}</span>
                  </span>
                  <span
                    style={{
                      width: 40,
                      height: 24,
                      borderRadius: 'var(--radius-pill)',
                      background: on ? t.on : 'var(--surface-2)',
                      position: 'relative',
                      transition: 'background 160ms',
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 3,
                        left: on ? 19 : 3,
                        width: 18,
                        height: 18,
                        borderRadius: 'var(--radius-pill)',
                        background: '#fff',
                        transition: 'left 160ms',
                      }}
                    />
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* --- the buy card, driven by the toggles --------------------------------------------- */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              width: '100%',
              maxWidth: 400,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-hero)',
              boxShadow: 'var(--shadow)',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              fontSize: 14,
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
                <img src="/brand/tenor-ribbon.png" alt="Tenor" style={{ height: 18, width: 'auto', display: 'block' }} />
              </span>
              <div>
                <div style={{ fontWeight: 500 }}>Buy TGN27</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>0x8a…41d0 · 98.00 USDC per token</div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 'var(--control-h)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-input)',
                padding: '0 12px',
                gap: 8,
                background: 'var(--surface-2)',
              }}
            >
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 16, textAlign: 'right' }}>50</span>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>TGN27</span>
            </div>

            <div
              style={{
                background: 'var(--surface-2)',
                borderRadius: 'var(--radius-input)',
                padding: '12px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 500 }}>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 500 }}>4,900.00 USDC</span>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {chips.map((c) => (
                <Chip key={c.label} {...c} />
              ))}
            </div>

            {banner && (
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-input)',
                  background: `var(--${kind}-soft)`,
                  color: `var(--${kind})`,
                  fontSize: 13,
                  animation: 'fadeIn 200ms ease-out',
                }}
              >
                <span style={{ flexShrink: 0, marginTop: 2 }}>
                  <Icon name="info" size={16} strokeWidth={1.5} />
                </span>
                <span>{banner}</span>
              </div>
            )}

            {/* The blocking condition IS the label, and a blocked control is not clickable. */}
            <div
              aria-disabled={blocked}
              style={{
                height: 'var(--control-h)',
                borderRadius: 'var(--radius-pill)',
                background: blocked ? 'var(--surface-2)' : 'var(--btn)',
                color: blocked ? 'var(--text-2)' : 'var(--btn-fg)',
                fontWeight: 500,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {label}
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'center' }}>
              Label resolves from a live simulation before you sign.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
