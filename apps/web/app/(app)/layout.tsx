'use client'

import { useState } from 'react'
import { AppNav, PausedBanner } from '@/components/app/AppNav'
import { ActivityProvider } from '@/components/app/activity'
import { Toasts, Tray } from '@/components/app/Tray'
import { useReadiness } from '@/lib/readiness'
import { Providers } from '../providers'

/**
 * The app shell.
 *
 * A route group, so `/market`, `/holdings`, `/coupons` and `/contracts` share the nav, the activity
 * tray and the toasts while the landing page at `/` stays a static server component with none of
 * the wallet machinery in its bundle.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const [tray, setTray] = useState(false)
  const r = useReadiness()

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <AppNav onTray={() => setTray(true)} />
      <PausedBanner show={r.marketPaused || r.tokenPaused} />
      <main style={{ maxWidth: 1440, margin: '0 auto', padding: 'clamp(20px, 3vw, 40px) clamp(16px, 4vw, 48px) 96px' }}>
        {children}
      </main>
      <Tray open={tray} onClose={() => setTray(false)} />
      <Toasts />
    </div>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <ActivityProvider>
        <Shell>{children}</Shell>
      </ActivityProvider>
    </Providers>
  )
}
