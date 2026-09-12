import { ComplianceDemo } from '@/components/landing/ComplianceDemo'
import { Contracts } from '@/components/landing/Contracts'
import { Coupons } from '@/components/landing/Coupons'
import { Hero } from '@/components/landing/Hero'
import { HowItWorks } from '@/components/landing/HowItWorks'
import { Nav } from '@/components/landing/Nav'
import { SiteFooter } from '@/components/landing/SiteFooter'
import { Stats } from '@/components/landing/Stats'
import { GRAIN_URL } from '@/components/landing/primitives'

/**
 * The landing page, implemented from the Claude Design canvas
 * (project 692ca674-6c56-4e88-829c-6d6375f084f5, `Tenor Landing.dc.html`).
 *
 * The sections are client components because each is animated or interactive; this shell stays a
 * server component so the first paint is static HTML.
 */
export default function Page() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', position: 'relative', overflowX: 'clip' }}>
      {/* Film grain over the whole page — 2.5%, non-interactive. */}
      <div
        aria-hidden
        style={{ position: 'fixed', inset: 0, pointerEvents: 'none', opacity: 0.025, backgroundImage: GRAIN_URL, zIndex: 0 }}
      />
      <Nav />
      <Hero />
      <Stats />
      <HowItWorks />
      <ComplianceDemo />
      <Coupons />
      <Contracts />
      <SiteFooter />
    </div>
  )
}
