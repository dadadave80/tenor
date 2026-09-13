import type { Metadata } from 'next'
import { Geist_Mono, Inter } from 'next/font/google'
import './globals.css'

/**
 * The design project loads Inter and Geist Mono from Google Fonts in its `<helmet>`. Here they go
 * through `next/font` instead: same faces, but self-hosted at build time, so there is no
 * render-blocking request to fonts.googleapis.com and no flash of fallback text on first paint.
 * The variables are wired to the same token names the design uses.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  // The design uses 400/500/600 only, and 500 for every heading.
  weight: ['400', '500', '600'],
  display: 'swap',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  weight: ['400', '500'],
  display: 'swap',
})

const title = 'Tenor — bonds that enforce their own rules'
const description =
  'A secondary market for regulated bond tokens on Hedera. Verified investors trade peer-to-peer, the bond checks every trade, and coupons pay themselves.'

// `opengraph-image.png` next to this file becomes og:image and twitter:image; metadataBase makes
// those URLs absolute, which link previews require.
export const metadata: Metadata = {
  metadataBase: new URL('https://tenor-markets.vercel.app'),
  title,
  description,
  openGraph: { title, description, siteName: 'Tenor', type: 'website', url: '/' },
  twitter: { card: 'summary_large_image' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-theme="dark"` is the design's `:root`. The light palette is defined and ready behind
    // [data-theme="light"], so a toggle is a one-attribute change rather than a restyle.
    <html lang="en" data-theme="dark" className={`${inter.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
