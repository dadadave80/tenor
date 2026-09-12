'use client'

import { useEffect, useState } from 'react'
import { createPublicClient, http } from 'viem'
import { tenorAbi } from '@/lib/abi'
import { addresses, hashscan, hederaTestnet } from '@/lib/chain'
import { Icon, revealStyle, useReveal, useViewport } from './primitives'

/**
 * The verified-contracts strip (FR7).
 *
 * Two deliberate departures from the design canvas, both in the direction of truth:
 *
 * 1. **The facet names are the real cut.** The canvas listed plausible placeholders
 *    (`MarketFacet`, `OwnershipFacet`, …). These are the ten facets `DeployTenor` actually cuts, so
 *    what a visitor reads matches what the loupe returns.
 * 2. **Addresses come from `DiamondLoupe.facets()`**, and render `—` until the diamond is deployed.
 *    SPEC §9.3 forbids placeholder numbers on this page, and a fabricated contract address on a page
 *    headed "Built in the open" would be the worst possible place to invent one.
 */
const client = createPublicClient({ chain: hederaTestnet, transport: http() })

/** The cut, in the order `DeployTenor.buildCuts` assembles it. */
const FACETS = [
  { name: 'ERC165Facet', note: 'interface discovery' },
  { name: 'DiamondLoupeFacet', note: 'facet enumeration' },
  { name: 'AccessControlDiamondCut', note: 'governed upgrades' },
  { name: 'AccessControl', note: 'roles' },
  { name: 'Receive', note: 'holds HBAR for scheduled calls' },
  { name: 'Pausable', note: 'issuer pause' },
  { name: 'HTSAdapter', note: 'Hedera Token Service · 0x167' },
  { name: 'HSSAdapter', note: 'Hedera Schedule Service · 0x16b' },
  { name: 'TenorMarket', note: 'listings and fills' },
  { name: 'TenorCoupon', note: 'coupon funding and payment' },
]

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function Contracts() {
  const [ref, shown] = useReveal<HTMLElement>()
  const { isMobile, isNarrow } = useViewport()
  const [live, setLive] = useState<{ address: string; selectors: number }[] | null>(null)

  useEffect(() => {
    const tenor = addresses.tenor
    if (!tenor) return
    let alive = true
    ;(async () => {
      try {
        const facets = (await client.readContract({ address: tenor, abi: tenorAbi, functionName: 'facets' })) as {
          facetAddress: string
          functionSelectors: readonly string[]
        }[]
        if (alive) {
          setLive(facets.map((f) => ({ address: f.facetAddress, selectors: f.functionSelectors.length })))
        }
      } catch {
        // Leave `live` null — the cards keep their `—` address rather than showing a guess.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <section
      id="contracts"
      ref={ref}
      style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
    >
      <div
        style={{
          maxWidth: 1440,
          margin: '0 auto',
          padding: 'clamp(80px, 10vw, 160px) clamp(16px, 4vw, 48px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 40,
          ...revealStyle(shown),
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ maxWidth: 640 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 'clamp(32px, 3.2vw, 44px)', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              Built in the open.
            </h2>
            <p style={{ margin: 0, fontSize: 18, color: 'var(--text-2)' }}>
              An EIP-2535 diamond composed with Lattice, including reusable Hedera Token Service and Schedule Service facets.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 14, fontWeight: 500 }}>
            <a href={addresses.tenor ? hashscan('contract', addresses.tenor) : 'https://hashscan.io/testnet'} target="_blank" rel="noreferrer">
              HashScan
            </a>
            <a href="https://github.com/dadadave80/lattice" target="_blank" rel="noreferrer">
              Repository
            </a>
            <a href="/contracts">All contracts</a>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : isNarrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
            gap: 12,
          }}
        >
          {FACETS.map((f, i) => {
            const found = live?.[i]
            const href = found ? hashscan('contract', found.address) : undefined
            const Card = href ? 'a' : 'div'
            return (
              <Card
                key={f.name}
                {...(href ? { href, target: '_blank', rel: 'noreferrer' } : {})}
                className={href ? 'card-link' : undefined}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '14px 16px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{f.name}</span>
                  {found && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--accent)', fontWeight: 500 }}>
                      <Icon name="check" size={11} strokeWidth={2.5} />
                      Verified
                    </span>
                  )}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
                  {found ? `${short(found.address)} · ${found.selectors} selectors` : '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{f.note}</span>
              </Card>
            )
          })}
        </div>
      </div>
    </section>
  )
}
