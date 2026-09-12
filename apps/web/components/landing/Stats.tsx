'use client'

import { useEffect, useState } from 'react'
import { createPublicClient, http } from 'viem'
import { tenorAbi } from '@/lib/abi'
import { addresses, hederaTestnet } from '@/lib/chain'
import { fmt, useCountUp, useReveal } from './primitives'

/**
 * The live stats strip.
 *
 * SPEC §9.3 is explicit that these are read from the chain without a wallet, and that **a failed
 * read renders `—`, never a placeholder number**. So this deliberately does NOT ship the design's
 * sample figures: an undeployed or unreachable contract shows a dash. A landing page that invents
 * "1,248,500 USDC settled" is the one kind of dishonesty a demo cannot afford.
 *
 * Reads go through a plain viem public client rather than wagmi — the landing page must work for a
 * visitor with no wallet, so there is no provider to depend on.
 */
const client = createPublicClient({ chain: hederaTestnet, transport: http() })

type Stat = { label: string; value: string | undefined }

function useLandingStats(): { stats: Stat[]; loaded: boolean } {
  const [listed, setListed] = useState<number>()
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const tenor = addresses.tenor
    if (!tenor) {
      // Nothing deployed yet — leave every value undefined so the row renders dashes.
      setLoaded(true)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const next = await client.readContract({ address: tenor, abi: tenorAbi, functionName: 'nextListingId' })
        if (alive) setListed(Number(next))
      } catch {
        // Swallowed on purpose: the catch IS the `—` state. Never substitute a number.
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return {
    loaded,
    stats: [
      { label: 'Notes listed', value: listed === undefined ? undefined : String(listed) },
      { label: 'Volume settled', value: undefined },
      { label: 'Holders', value: undefined },
      { label: 'Next coupon in', value: undefined },
      { label: 'Verified contracts', value: undefined },
    ],
  }
}

export function Stats() {
  const [ref, shown] = useReveal<HTMLElement>()
  const { stats, loaded } = useLandingStats()
  const k = useCountUp(shown && loaded)

  return (
    <section ref={ref} style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div
        style={{
          maxWidth: 1440,
          margin: '0 auto',
          padding: '24px clamp(16px, 4vw, 48px)',
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(16px, 3vw, 48px)',
          flexWrap: 'wrap',
        }}
      >
        {stats.map((s) => (
          <div key={s.label} style={{ display: 'flex', flexDirection: 'column', minWidth: 120 }}>
            <span style={{ fontSize: 24, fontWeight: 500, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
              {s.value === undefined ? '—' : countUpText(s.value, k)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * Scales a rendered value by the count-up ramp, preserving its shape.
 *
 * Only the leading number is scaled so a suffix like " USDC" or " d" survives, and a decimal value
 * keeps two places throughout the animation rather than gaining and losing digits as it counts.
 */
function countUpText(value: string, k: number): string {
  const m = /^([\d,]+(?:\.\d+)?)(.*)$/.exec(value)
  if (!m) return value
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return value
  const scaled = n * k
  const rendered = m[1].includes('.') ? fmt(scaled) : String(Math.round(scaled))
  return rendered + m[2]
}
