'use client'

import { useState } from 'react'
import { useExportWallet, useLinkAccount, useUnlinkEmail, useUnlinkOAuth, useUnlinkPasskey, useUser } from '@privy-io/react-auth'
import { useAccount } from 'wagmi'
import { Icon } from '@/components/landing/primitives'
import { useSignInMethods, type SignInMethod } from '@/lib/account'
import { hashscan } from '@/lib/chain'
import { Banner, Drawer, SecondaryButton, Spinner } from './ui'

/**
 * Account management: the ways in, and the key backup.
 *
 * Linking and unlinking produce no transaction, so nothing here goes through the activity tray; the
 * outcome is reported inline. Privy owns every flow that touches a credential or the key -- the link
 * modals, and the export modal, which renders the private key in an iframe on Privy's own domain so
 * this app never sees it.
 */
export function AccountDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { methods, atRisk, embeddedAddress, hasGoogle, hasEmail } = useSignInMethods()
  const { address } = useAccount()
  const { refreshUser } = useUser()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { linkGoogle, linkEmail, linkPasskey } = useLinkAccount({
    onSuccess: () => setNote({ ok: true, text: 'Sign-in method added. It opens this same wallet on any device.' }),
    onError: (error) => {
      // Closing the modal is a choice, not a failure.
      if (String(error) !== 'exited_link_flow') setNote({ ok: false, text: `That sign-in method was not added (${String(error)}).` })
    },
  })
  const { unlink: unlinkOAuth } = useUnlinkOAuth()
  const { unlink: unlinkPasskey } = useUnlinkPasskey()
  const { unlink: unlinkEmail } = useUnlinkEmail()
  const { exportWallet } = useExportWallet()

  const remove = async (m: SignInMethod) => {
    setBusy(m.id)
    setNote(null)
    try {
      if (m.kind === 'passkey') await unlinkPasskey({ credentialId: m.id })
      else if (m.kind === 'google') await unlinkOAuth({ provider: 'google', subject: m.id })
      else await unlinkEmail({ address: m.id })
      await refreshUser()
      setNote({ ok: true, text: `${m.label} removed.` })
    } catch (e) {
      setNote({ ok: false, text: `${m.label} was not removed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  const backup = async () => {
    if (!embeddedAddress) return
    setNote(null)
    try {
      await exportWallet({ address: embeddedAddress })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!/exit|clos|cancel/i.test(message)) setNote({ ok: false, text: `The export did not open: ${message}` })
    }
  }

  const wallet = embeddedAddress ?? address
  const copy = async () => {
    if (!wallet) return
    await navigator.clipboard.writeText(wallet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Drawer open={open} onClose={onClose} title="Account & recovery" subtitle="Sign-in methods and key backup">
      {atRisk ? (
        <Banner kind="warning">
          This passkey is your only way in. If you lose the device it lives on, you lose this wallet and what it holds.
          Add Google or an email below so you can sign back in from anywhere.
        </Banner>
      ) : methods.length > 1 ? (
        <Banner kind="info">
          You have {methods.length} ways to sign in. Any one of them opens the same wallet.
        </Banner>
      ) : null}

      {note && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: note.ok ? 'var(--accent)' : 'var(--danger)' }}>
          {note.text}
        </p>
      )}

      <Section title="Sign-in methods" hint="Each one opens the same wallet. Keep at least two, on different devices or accounts.">
        {methods.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)' }}>
            You signed in with an external wallet, so that wallet is your way in. Add a passkey, Google or email to also
            reach this account without it.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
            {methods.map((m) => (
              <li
                key={m.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}
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
                    background: 'var(--surface-2)',
                    color: 'var(--text-2)',
                  }}
                >
                  <Icon name={m.kind === 'passkey' ? 'shield' : 'check'} size={14} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{m.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{m.detail}</div>
                </div>
                {busy === m.id ? (
                  <Spinner size={16} color="var(--warning)" />
                ) : confirming === m.id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <SecondaryButton tone="danger" onClick={() => remove(m)}>
                      Remove
                    </SecondaryButton>
                    <SecondaryButton onClick={() => setConfirming(null)}>Keep</SecondaryButton>
                  </div>
                ) : (
                  // The last way in cannot be removed: Privy refuses it too, but a button that can only
                  // fail should not be offered.
                  <SecondaryButton onClick={() => setConfirming(m.id)} disabled={methods.length < 2}>
                    Remove
                  </SecondaryButton>
                )}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!hasGoogle && <SecondaryButton onClick={linkGoogle}>Add Google</SecondaryButton>}
          {!hasEmail && <SecondaryButton onClick={linkEmail}>Add email</SecondaryButton>}
          <SecondaryButton onClick={() => linkPasskey()}>Add a passkey</SecondaryButton>
        </div>
      </Section>

      <Section
        title="Back up your key"
        hint="A second sign-in method recovers the account. An exported key recovers the wallet even without Tenor."
      >
        {embeddedAddress ? (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Privy shows your private key in its own secure window, so Tenor never sees it. Store it offline. Anyone who has
              it controls this wallet; it can be imported into MetaMask or HashPack.
            </p>
            <div>
              <SecondaryButton onClick={backup}>Export private key</SecondaryButton>
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)' }}>
            This account uses an external wallet. Its key is backed up in that wallet&apos;s own app, not here.
          </p>
        )}
      </Section>

      {wallet && (
        <Section title="Wallet">
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: '10px 12px',
              borderRadius: 'var(--radius-input)',
              background: 'var(--surface-2)',
              overflowWrap: 'anywhere',
            }}
          >
            {wallet}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SecondaryButton onClick={copy}>{copied ? 'Copied' : 'Copy address'}</SecondaryButton>
            <a href={hashscan('account', wallet)} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
              View on HashScan
            </a>
          </div>
        </Section>
      )}
    </Drawer>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{title}</h3>
        {hint && <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-2)' }}>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** Shown under the nav on every app page while a passkey is the account's only way in. */
export function RecoveryBanner({ show, onOpen }: { show: boolean; onOpen: () => void }) {
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
        flexWrap: 'wrap',
      }}
    >
      <Icon name="shield" size={13} />
      <span style={{ flex: 1, minWidth: 200 }}>
        Your passkey is the only way into this wallet. Add a backup sign-in so a lost device does not lose it.
      </span>
      <button
        type="button"
        onClick={onOpen}
        style={{
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          fontSize: 13,
          fontWeight: 500,
          textDecoration: 'underline',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        Add a backup
      </button>
    </div>
  )
}
