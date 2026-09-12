'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Shared primitives for the landing page, ported from the design project's `DCLogic` helpers
 * (`icon`, `identicon`, `fmt`, the IntersectionObserver reveal and the count-up).
 *
 * Source of truth: Claude Design project `692ca674-6c56-4e88-829c-6d6375f084f5`,
 * `Tenor Landing.dc.html`. See `docs/design/README.md`.
 */

export type IconName = 'check' | 'clock' | 'alert' | 'pause' | 'snow' | 'play' | 'info'

const PATHS: Record<IconName, string> = {
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 7v5l3 2',
  alert: 'M12 8v4M12 16h.01',
  pause: 'M9 5v14M15 5v14',
  snow: 'M12 2v20M2 12h20M5 5l14 14M19 5 5 19',
  play: 'M8 5v14l11-7z',
  info: 'M12 8v4M12 16h.01',
}

/** Icons that are drawn inside a ring. */
const RINGED = new Set<IconName>(['clock', 'alert', 'info'])

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
