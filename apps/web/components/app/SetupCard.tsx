'use client'

import { useState } from 'react'
import { formatUnits } from 'viem'
import { useWriteContract } from 'wagmi'
import { Icon, type IconName } from '@/components/landing/primitives'
import { fmtUsdc } from '@/lib/actions'
import { addresses, ASSOCIATE_GAS_LIMIT, hashscan } from '@/lib/chain'
import { hrc719Abi, useReadiness } from '@/lib/readiness'
import { useActivity } from './activity'
import { Pill, SecondaryButton, Spinner } from './ui'

/**
 * The setup card: the five things that must be true before anyone can buy, in the order they must
 * become true, each with the one action that makes it so.
 *
 * Verification is the row with no button, on purpose. Only the issuer can grant KYC, so offering the
 * user a button would be offering them something that cannot work — the row says who has to act
 * instead. That honesty is the whole point of the card; the rest of the app depends on the same
 * distinction (`issuerOnly` in `ActionState`).
 */

type Row = {
  key: string
  label: string
  done: boolean
  detail: string
  icon: IconName
  action?: { label: string; onClick: () => void; disabled?: boolean }
  /** Shown instead of an action when the user cannot do anything about it. */
  pill?: string
  link?: { href: string; label: string }
}

export function SetupCard({ onDismiss }: { onDismiss?: () => void }) {
  const r = useReadiness()
  const { track, fail } = useActivity()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState<string | null>(null)

  const send = async (key: string, title: string, run: () => Promise<`0x${string}`>) => {
    setBusy(key)
    try {
      track(title, await run())
    } catch (e) {
      fail(title, e)
    } finally {
      setBusy(null)
    }
  }

  const enableUsdc = () =>
    send('usdc', 'Enable USDC', () =>
      writeContractAsync({
        address: addresses.usdc!,
        abi: hrc719Abi,
        functionName: 'associate',
        // The relay's estimate for a `0x167` call is unreliable, and an under-estimated association
        // fails with INSUFFICIENT_GAS after the user has already signed.
        gas: ASSOCIATE_GAS_LIMIT,
      }),
    )

  const rows: Row[] = [
    {
      key: 'wallet',
      label: 'Wallet',
      done: !r.disconnected,
      detail: r.address ? `Ready · ${r.address.slice(0, 6)}…${r.address.slice(-4)}` : 'Sign in with a passkey to begin',
      icon: r.disconnected ? 'clock' : 'check',
    },
    {
      key: 'hbar',
      label: 'Test HBAR',
      done: r.hbar > 0n,
      detail: r.hbar > 0n ? `${Number(formatUnits(r.hbar, 18)).toFixed(2)} HBAR available` : 'Needed for transaction fees',
      icon: r.hbar > 0n ? 'check' : 'clock',
      link: r.hbar > 0n ? undefined : { href: 'https://portal.hedera.com/faucet', label: 'Hedera faucet' },
    },
    {
      key: 'usdc',
      label: 'USDC',
      done: r.usdcAssociated,
      detail: r.usdcAssociated ? 'Enabled on this account' : 'Required to buy and to receive coupons',
      icon: r.usdcAssociated ? 'check' : 'clock',
      action: r.usdcAssociated || !addresses.usdc ? undefined : { label: 'Enable USDC', onClick: enableUsdc },
    },
    {
      key: 'balance',
      label: 'Demo USDC',
      done: r.usdc > 0n,
      detail: r.usdc > 0n ? fmtUsdc(r.usdc) : 'For buying on testnet',
      icon: r.usdc > 0n ? 'check' : 'clock',
      // Deliberately a link, not a button: the drip is an issuer transfer, not something this
      // account can do for itself.
      link: r.usdc > 0n ? undefined : { href: '#faucet', label: 'Ask the issuer for demo USDC' },
    },
    {
      key: 'verified',
      label: 'Verification',
      done: r.verified,
      detail: r.verified
        ? 'Verified by the issuer'
        : 'The issuer verifies investors. You can browse listings now, and buy once verified.',
      icon: r.verified ? 'check' : 'clock',
      pill: r.verified ? undefined : 'Pending',
    },
  ]

  const done = rows.filter((x) => x.done).length

  return (
    <section
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 500 }}>Get set up</h2>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)' }}>
            {done} of {rows.length} ready
          </p>
        </div>
        {done === rows.length && onDismiss && (
          <SecondaryButton onClick={onDismiss}>Hide</SecondaryButton>
        )}
      </div>

      <div style={{ height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${(done / rows.length) * 100}%`,
            background: 'var(--accent)',
            transition: 'width 400ms ease-out',
          }}
        />
      </div>

      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((row) => (
          <li
            key={row.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 0',
              borderTop: '1px solid var(--border)',
              flexWrap: 'wrap',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-pill)',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
                background: row.done ? 'var(--surface-tint)' : 'var(--surface-2)',
                color: row.done ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              <Icon name={row.icon} size={14} />
            </span>

            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{row.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>{row.detail}</div>
            </div>

            {busy === row.key ? (
              <Spinner size={16} color="var(--warning)" />
            ) : (
              <>
                {row.pill && <Pill kind="warning" icon="clock">{row.pill}</Pill>}
                {row.action && (
                  <SecondaryButton onClick={row.action.onClick} disabled={row.action.disabled}>
                    {row.action.label}
                  </SecondaryButton>
                )}
                {row.link && (
                  <a
                    href={row.link.href}
                    {...(row.link.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
                    style={{ fontSize: 13 }}
                  >
                    {row.link.label}
                  </a>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      {!addresses.tenor && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)' }}>
          The contracts are not configured in this build, so balances read as{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>—</span>. Run{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>bun run sync:env</span> after deploying.
        </p>
      )}

      {r.address && (
        <a href={hashscan('account', r.address)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          View this account on HashScan
        </a>
      )}
    </section>
  )
}
