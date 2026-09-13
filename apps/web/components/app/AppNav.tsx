'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useAccount, useDisconnect } from 'wagmi'
import { Icon, Identicon, Wordmark, useViewport } from '@/components/landing/primitives'
import { useSignInMethods } from '@/lib/account'
import { hashscan } from '@/lib/chain'
import { useUsdcUsd } from '@/lib/oracle'
import { useActivity } from './activity'
import { Pill, SecondaryButton, Spinner } from './ui'

const ROUTES = [
  { href: '/market', label: 'Market' },
  { href: '/holdings', label: 'Holdings' },
  { href: '/coupons', label: 'Coupons' },
  { href: '/contracts', label: 'Contracts' },
]

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function AppNav({ onTray, onAccount }: { onTray: () => void; onAccount: () => void }) {
  const path = usePathname()
  const { isMobile } = useViewport()
  const { pending } = useActivity()
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { ready, authenticated, login, logout } = usePrivy()
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const { atRisk } = useSignInMethods()

  const signIn = () => {
    // Privy owns the modal. `ready` is false until its iframe has loaded, and calling `login`
    // before then is a no-op that looks to the user like a dead button.
    if (ready) login()
  }

  const signOut = async () => {
    setMenu(false)
    disconnect()
    if (authenticated) await logout()
  }

  // The menu stays open so "Copied" is visible: closing it at once would leave no sign the copy happened.
  const copyAddress = async () => {
    if (!address) return
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <nav
        style={{
          maxWidth: 1440,
          margin: '0 auto',
          padding: '0 clamp(16px, 4vw, 48px)',
          height: 64,
          display: 'flex',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <Link href="/" className="wordmark" style={{ color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
          <Wordmark height={22} fontSize={17} />
        </Link>

        {!isMobile && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            {ROUTES.map((r) => {
              const on = path === r.href
              return (
                <Link
                  key={r.href}
                  href={r.href}
                  aria-current={on ? 'page' : undefined}
                  className="nav-tab"
                  style={{
                    height: 34,
                    padding: '0 14px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderRadius: 'var(--radius-pill)',
                    fontSize: 14,
                    fontWeight: 500,
                    color: on ? 'var(--text)' : 'var(--text-2)',
                    background: on ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  {r.label}
                </Link>
              )
            })}
          </div>
        )}

        <div style={{ flex: 1 }} />

        <button
          type="button"
          onClick={onTray}
          aria-label={pending ? `Activity, ${pending} pending` : 'Activity'}
          className="pill-secondary"
          style={{
            height: 36,
            padding: '0 12px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {pending > 0 ? <Spinner size={14} color="var(--warning)" /> : <Icon name="clock" size={14} />}
          {!isMobile && 'Activity'}
        </button>

        {isConnected && address ? (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              aria-haspopup="menu"
              className="pill-secondary"
              style={{
                height: 36,
                padding: '0 12px 0 6px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Identicon addr={address} size={24} />
              {short(address)}
              {atRisk && (
                <span
                  aria-label="No backup sign-in"
                  style={{ width: 8, height: 8, borderRadius: 'var(--radius-pill)', background: 'var(--warning)' }}
                />
              )}
            </button>
            {menu && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 44,
                  minWidth: 220,
                  padding: 8,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <button
                  type="button"
                  onClick={copyAddress}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text)',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  {copied ? 'Copied' : 'Copy address'}
                </button>
                <a
                  href={hashscan('account', address)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenu(false)}
                  style={{ padding: '8px 10px', borderRadius: 8, color: 'var(--text-2)', fontSize: 13 }}
                >
                  View on HashScan
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false)
                    onAccount()
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text)',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  Account & recovery
                  {atRisk && <Pill kind="warning">Add backup</Pill>}
                </button>
                <button
                  type="button"
                  onClick={signOut}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--danger)',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : authenticated ? (
          // Privy finishes login a few seconds before wagmi sees the wallet; "Sign in" here would do nothing.
          <SecondaryButton disabled>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Spinner size={14} /> Connecting wallet…
            </span>
          </SecondaryButton>
        ) : (
          <SecondaryButton onClick={signIn} disabled={!ready}>
            {ready ? 'Sign in' : 'Loading…'}
          </SecondaryButton>
        )}
      </nav>

      {/* On a phone the tabs get their own row, so a signed-out visitor can still get around. */}
      {isMobile && (
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '0 clamp(16px, 4vw, 48px) 8px' }}>
          {ROUTES.map((r) => {
            const on = path === r.href
            return (
              <Link
                key={r.href}
                href={r.href}
                aria-current={on ? 'page' : undefined}
                className="nav-tab"
                style={{
                  height: 30,
                  padding: '0 12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  color: on ? 'var(--text)' : 'var(--text-2)',
                  background: on ? 'var(--surface-2)' : 'transparent',
                }}
              >
                {r.label}
              </Link>
            )
          })}
        </div>
      )}
    </header>
  )
}

/** Shown above every page while the market is paused, because it changes what every button will do. */
export function PausedBanner({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div
      role="status"
      style={{
        background: 'var(--warning-soft)',
        color: 'var(--warning)',
        borderBottom: '1px solid var(--border)',
        padding: '10px clamp(16px, 4vw, 48px)',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icon name="pause" size={13} />
      Trading is paused by the issuer. Listings stay reserved, and sellers can still cancel.
      <Pill kind="warning">Paused</Pill>
    </div>
  )
}

/**
 * The market prices in USDC and settles in USDC, so it is worth saying out loud when the dollar it
 * is standing on has moved. A healthy feed says nothing — this only appears when Chainlink's
 * reference has drifted off the peg, or stopped answering.
 */
export function OracleBanner() {
  const { price, isStale, offPeg } = useUsdcUsd()
  if (!isStale && !offPeg) return null
  return (
    <div
      role="status"
      style={{
        background: 'var(--warning-soft)',
        color: 'var(--warning)',
        borderBottom: '1px solid var(--border)',
        padding: '10px clamp(16px, 4vw, 48px)',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icon name="alert" size={13} />
      {isStale
        ? 'Chainlink USDC/USD reference is stale'
        : `USDC is off its Chainlink reference (${price!.toFixed(4)} USD)`}
    </div>
  )
}
