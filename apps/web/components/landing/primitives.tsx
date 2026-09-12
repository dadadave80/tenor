'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Shared primitives for the landing page, ported from the design project's `DCLogic` helpers
 * (`icon`, `identicon`, `fmt`, the IntersectionObserver reveal and the count-up).
 *
 * Source of truth: Claude Design project `692ca674-6c56-4e88-829c-6d6375f084f5`,
 * `Tenor Landing.dc.html`. See `docs/design/README.md`.
 */

export type IconName =
  | 'check'
  | 'clock'
  | 'alert'
  | 'pause'
  | 'snow'
  | 'play'
  | 'info'
  // Added for the app shell. Paths are the canvas's own (`Tenor v2.dc.html`, `icon()`).
  | 'x'
  | 'sun'
  | 'moon'
  | 'trend'
  | 'wallet'
  | 'cal'
  | 'shield'

const PATHS: Record<IconName, string> = {
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 7v5l3 2',
  alert: 'M12 8v4M12 16h.01',
  pause: 'M9 5v14M15 5v14',
  snow: 'M12 2v20M2 12h20M5 5l14 14M19 5 5 19',
  play: 'M8 5v14l11-7z',
  info: 'M12 8v4M12 16h.01',
  x: 'M18 6 6 18M6 6l12 12',
  sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  trend: 'M22 7 13.5 15.5 8.5 10.5 2 17M16 7h6v6',
  wallet: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z',
  cal: 'M16 2v4M8 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  shield:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zm-11-1 2 2 4-4',
}

/** Icons that are drawn inside a ring. */
const RINGED = new Set<IconName>(['clock', 'alert', 'info', 'sun'])

export function Icon({
  name,
  size = 12,
  color = 'currentColor',
  strokeWidth = 2,
}: {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}) {
  if (name === 'play') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
        <path d={PATHS.play} />
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden
    >
      {RINGED.has(name) ? <circle cx={12} cy={12} r={9} /> : null}
      <path d={PATHS[name]} />
    </svg>
  )
}

/**
 * A deterministic avatar for an address.
 *
 * Same hash and geometry as the design: a rotated bar plus a circle over a hue derived from the
 * address, so a given address always draws the same mark. Deterministic matters here — an investor
 * should recognise their own counterparty across the market, holdings and activity views.
 */
export function Identicon({ addr, size = 20 }: { addr: string; size?: number }) {
  let h = 0
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  const hue = h % 360
  const hue2 = (hue + 120 + ((h >> 8) % 60)) % 360
  const hue3 = (hue + 240) % 360
  const rot = (h >> 4) % 360
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ borderRadius: 999, flexShrink: 0, background: `hsl(${hue} 45% 40%)` }}
      aria-hidden
    >
      <g transform={`rotate(${rot} 12 12)`}>
        <rect x={4} y={10} width={22} height={12} rx={2} fill={`hsl(${hue2} 55% 55%)`} />
        <circle cx={8} cy={8} r={6} fill={`hsl(${hue3} 60% 65%)`} />
      </g>
    </svg>
  )
}

/** Two-decimal thousands formatting, as the design's `fmt`. */
export function fmt(n: number): string {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Reveals a section the first time it scrolls into view, then stops observing it.
 *
 * The design's observer unobserves on first hit so a section never re-animates on scroll-back —
 * re-triggering reads as jitter rather than polish.
 */
export function useReveal<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Respect reduced motion by showing immediately rather than animating in.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          setShown(true)
          io.unobserve(e.target)
        }
      },
      { threshold: 0.2 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return [ref, shown]
}

/** The reveal transition, applied to a section wrapper. */
export function revealStyle(shown: boolean): React.CSSProperties {
  return {
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : 'translateY(12px)',
    transition: 'opacity 400ms ease-out, transform 400ms ease-out',
  }
}

/**
 * Eased 0→1 ramp, started once `run` becomes true. Drives the stats count-up.
 *
 * Cubic ease-out over 800ms, matching the design.
 */
export function useCountUp(run: boolean): number {
  const [k, setK] = useState(0)
  useEffect(() => {
    if (!run) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setK(1)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 800)
      setK(1 - Math.pow(1 - p, 3))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [run])
  return k
}

/**
 * A looping clock in milliseconds, wrapping at `period`.
 *
 * The hero and the coupon timeline are both time-driven loops in the design (9s and 14s). Ticking
 * at 100ms is enough for both and cheap. Returns 0 until mounted so server and client agree on the
 * first render.
 */
export function useLoop(period: number, tick = 100): number {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t0 = Date.now()
    const id = setInterval(() => setMs((Date.now() - t0) % period), tick)
    return () => clearInterval(id)
  }, [period, tick])
  return ms
}

/** Viewport width, for the design's breakpoint switches (768 / 1024). */
export function useViewport(): { isMobile: boolean; isNarrow: boolean } {
  // Start at the design's desktop default so SSR and the first client render match.
  const [w, setW] = useState(1440)
  useEffect(() => {
    const onResize = () => setW(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return { isMobile: w < 768, isNarrow: w < 1024 }
}

/** True once the page has scrolled past the nav's transparent state. */
export function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])
  return scrolled
}

/** The brand wordmark: ribbon plus lowercase type, as in the nav, hero card and footer. */
export function Wordmark({ height = 26, fontSize = 21 }: { height?: number; fontSize?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/tenor-ribbon.png" alt="" style={{ height, width: 'auto', display: 'block' }} />
      <span style={{ fontWeight: 600, fontSize, letterSpacing: '-0.03em', lineHeight: 1 }}>tenor</span>
    </span>
  )
}

/** The film-grain overlay the design lays over the whole page at 2.5% opacity. */
export const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")"
