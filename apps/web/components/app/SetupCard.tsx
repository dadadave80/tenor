'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { useWriteContract } from 'wagmi'
import { Icon, type IconName } from '@/components/landing/primitives'
import { fmtUsdc, MIN_HBAR } from '@/lib/actions'
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
  const [faucet, setFaucet] = useState<boolean | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Whether the faucet is configured at all decides between offering a button and explaining why
  // there isn't one. Guessing wrong in either direction wastes the visitor's time.
  useEffect(() => {
    fetch('/api/faucet')
      .then((r) => r.json())
      .then((j) => setFaucet(Boolean(j.configured)))
      .catch(() => setFaucet(false))
  }, [])

  /**
   * The faucet is two calls with a user-signed transaction between them: an HTS transfer to an
   * account that has not associated with the token fails, and only the account itself can associate.
   */
  const drip = useCallback(
    async (stage: 'hbar' | 'fund', key: string, title: string) => {
      if (!r.address) return
      setBusy(key)
      setNote(null)
      try {
        const res = await fetch('/api/faucet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: r.address, stage }),
        })
        const json = (await res.json()) as { ok: boolean; error?: string; hash?: string; usdc?: string; kyc?: string }
        if (!json.ok) {
          setNote(json.error ?? 'The faucet refused.')
          return
        }
        // Stage 'fund' can send TWO transactions -- the USDC transfer and the KYC grant -- so each
        // gets its own tray entry under its own name. Taking the first would silently hide a
        // transaction the user paid nothing for but should still be able to open on HashScan.
        const sent = ([
          [title, json.hash],
          ['Demo USDC', json.usdc],
          ['Verification', json.kyc],
        ] as const).filter(([, h]) => h)
        if (sent.length === 0) setNote('Already done — nothing to send.')
        // Awaited, so the row keeps its spinner until the drip has landed and the card has re-read the account.
        else await Promise.all(sent.map(([label, h]) => track(label, h as `0x${string}`)))
      } catch (e) {
        fail(title, e)
      } finally {
        setBusy(null)
      }
    },
    [r.address, track, fail],
  )

  const send = async (key: string, title: string, run: () => Promise<`0x${string}`>) => {
    setBusy(key)
    try {
      await track(title, await run())
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

  // Ready means enough to send a transaction, the same bar the actions hold: a few cents of HBAR is not ready.
  const hbarReady = r.hbar >= MIN_HBAR
  const hbar = Number(formatUnits(r.hbar, 18)).toFixed(2)

  const rows: Row[] = [
    {
      key: 'wallet',
      label: 'Wallet',
      done: !r.disconnected,
      detail: r.address ? `Ready · ${r.address.slice(0, 6)}…${r.address.slice(-4)}` : 'Sign in with a passkey or Google to begin',
      icon: r.disconnected ? 'clock' : 'check',
    },
    {
      key: 'hbar',
      label: 'Test HBAR',
      done: hbarReady,
      detail: hbarReady
        ? `${hbar} HBAR available`
        : r.hbar > 0n
          ? `${hbar} HBAR · each transaction needs ${formatUnits(MIN_HBAR, 18)} on hand`
          : 'Needed for transaction fees',
      icon: hbarReady ? 'check' : 'clock',
      action:
        hbarReady || !faucet ? undefined : { label: 'Get test HBAR', onClick: () => drip('hbar', 'hbar', 'Get test HBAR') },
      // Hedera's own faucet gives 100 HBAR, twenty times our drip, so it is offered alongside ours rather than instead of it.
      link: hbarReady ? undefined : { href: 'https://portal.hedera.com/faucet', label: 'Get 100 HBAR from Hedera’s faucet' },
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
      action:
        r.usdc > 0n || !faucet
          ? undefined
          : {
              label: r.usdcAssociated ? 'Get demo USDC' : 'Enable USDC first',
              onClick: () => drip('fund', 'balance', 'Get demo USDC'),
              disabled: !r.usdcAssociated,
            },
    },
    {
      key: 'verified',
      label: 'Verification',
      done: r.verified,
      detail: r.verified
        ? 'Verified by the issuer'
        : faucet
          ? 'Only the issuer can verify an investor. On testnet the demo issuer does it with the same button as the USDC drip.'
          : 'The issuer verifies investors. You can browse listings now, and buy once verified.',
      icon: r.verified ? 'check' : 'clock',
      // Still no button of its own: KYC is granted by the issuer, and the drip above is the issuer
      // acting. Offering the user a "verify me" button would imply an authority they do not have.
      pill: r.verified ? undefined : 'Issuer',
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

      {note && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--warning)' }}>{note}</p>
      )}

      {faucet === false && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)' }}>
          The demo faucet is not configured in this build, so HBAR, USDC and verification have to come
          from the issuer directly.
        </p>
      )}

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
