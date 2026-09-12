'use client'

import { Wordmark } from './primitives'

const LINKS = [
  { href: 'https://github.com/dadadave80/lattice', label: 'GitHub', external: true },
  { href: 'https://hashscan.io/testnet', label: 'HashScan', external: true },
  { href: '#demo', label: 'Demo video', external: false },
  { href: 'https://hedera.com', label: 'Hedera', external: true },
  { href: 'https://privy.io', label: 'Privy', external: true },
]

/** Closing call to action plus the footer. */
export function SiteFooter() {
  return (
    <section
      style={{
        maxWidth: 1440,
        margin: '0 auto',
        padding: 'clamp(96px, 12vw, 180px) clamp(16px, 4vw, 48px) 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(64px, 8vw, 120px)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 20, maxWidth: 640 }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(40px, 5vw, 64px)', fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1.02 }}>
          Open the market.
        </h2>
        <p style={{ margin: 0, fontSize: 18, color: 'var(--text-2)' }}>
          Testnet — sign in with a passkey, fund a wallet in-app, and trade in under two minutes.
        </p>
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
      </div>

      <footer
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 24,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
          fontSize: 13,
          color: 'var(--text-2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wordmark height={20} fontSize={16} />
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontWeight: 500 }}>
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="link-muted"
              {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}
            >
              {l.label}
            </a>
          ))}
        </div>
      </footer>
    </section>
  )
}
