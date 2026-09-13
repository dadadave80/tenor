'use client'

import { usePrivy, type LinkedAccountWithMetadata } from '@privy-io/react-auth'

/**
 * The ways a user can sign back in to the same wallet, read from Privy.
 *
 * Tenor's embedded wallets run in Privy's TEE mode (`user-controlled-server-wallets-only`): the key is
 * never stored on the device, and the wallet belongs to the Privy USER rather than to any one
 * credential. So recovery here is not a password or a cloud backup -- Privy's runtime refuses
 * user-owned recovery in this mode -- it is having more than one way to prove you are that user. The
 * only way to lose a wallet is to lose the single credential that opens it, which is what `atRisk`
 * detects: one sign-in method, and it is a passkey bound to a device.
 */
export type SignInMethod = {
  kind: 'passkey' | 'google' | 'email'
  /** What unlinking needs: the passkey credential id, the Google subject, or the email address. */
  id: string
  label: string
  detail: string
}

type EmbeddedWallet = Extract<LinkedAccountWithMetadata, { type: 'wallet' }>

function lastUsed(at: Date | null): string | null {
  return at ? `last used ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : null
}

function describe(a: LinkedAccountWithMetadata): SignInMethod | null {
  const used = lastUsed(a.latestVerifiedAt)
  switch (a.type) {
    case 'passkey': {
      // Several passkeys look identical in a list, so say where each one was made.
      const where = [a.authenticatorName, a.createdWithOs, a.createdWithBrowser].filter(Boolean).join(' · ')
      return { kind: 'passkey', id: a.credentialId, label: 'Passkey', detail: [where || 'Device passkey', used].filter(Boolean).join(' · ') }
    }
    case 'google_oauth':
      return { kind: 'google', id: a.subject, label: 'Google', detail: [a.email, used].filter(Boolean).join(' · ') }
    case 'email':
      return { kind: 'email', id: a.address, label: 'Email', detail: [a.address, used].filter(Boolean).join(' · ') }
    default:
      // The embedded wallet itself is also a linked account, but it is what gets recovered, not a way in.
      return null
  }
}

export function useSignInMethods() {
  const { user, authenticated } = usePrivy()
  const accounts = user?.linkedAccounts ?? []
  const methods = accounts.map(describe).filter((m): m is SignInMethod => m !== null)
  const embedded = accounts.find(
    (a): a is EmbeddedWallet => a.type === 'wallet' && (a.walletClientType === 'privy' || a.walletClientType === 'privy-v2'),
  )

  return {
    authenticated,
    methods,
    atRisk: authenticated && methods.length === 1 && methods[0].kind === 'passkey',
    embeddedAddress: embedded?.address as `0x${string}` | undefined,
    hasGoogle: methods.some((m) => m.kind === 'google'),
    hasEmail: methods.some((m) => m.kind === 'email'),
  }
}
