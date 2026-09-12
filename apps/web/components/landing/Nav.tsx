'use client'

import { useScrolled, useViewport, Wordmark } from './primitives'

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#compliance', label: 'Compliance' },
  { href: '#contracts', label: 'Contracts' },
  { href: '#demo', label: 'Demo' },
]

/**
 * Sticky nav: transparent over the hero, then a blurred translucent bar with a hairline once the
 * page moves. The blur is what keeps the wordmark legible over the hero's settlement card.
 */
export function Nav() {
  const scrolled = useScrolled()
  const { isMobile } = useViewport()

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        height: 64,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 clamp(16px, 4vw, 48px)',
        background: scrolled ? 'rgba(11, 15, 13, .72)' : 'transparent',
        backdropFilter: scrolled ? 'blur(12px)' : undefined,
        WebkitBackdropFilter: scrolled ? 'blur(12px)' : undefined,
        borderBottom: `1px solid ${scrolled ? 'var(--border)' : 'transparent'}`,
        transition: 'background 180ms ease-out, border-color 180ms ease-out',
      }}
    >
      <a href="#top" className="wordmark" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}>
        <Wordmark />
      </a>

      {!isMobile && (
        <div style={{ display: 'flex', gap: 28, fontSize: 14, fontWeight: 500 }}>
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="link-muted">
              {l.label}
            </a>
          ))}
        </div>
      )}

      <a
        href="/market"
        className="pill-primary"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 38,
          padding: '0 16px',
          borderRadius: 'var(--radius-pill)',
          background: 'var(--btn)',
          color: 'var(--btn-fg)',
          fontWeight: 500,
          fontSize: 14,
        }}
      >
        Open the market
      </a>
    </nav>
  )
}
