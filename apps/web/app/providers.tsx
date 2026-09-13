'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { WagmiProvider, createConfig } from '@privy-io/wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http } from 'viem'
import { hederaTestnet } from '@/lib/chain'

/**
 * Privy owns the wallet, wagmi owns the contract calls, TanStack Query owns the cache.
 *
 * `createConfig` and `WagmiProvider` are imported from `@privy-io/wagmi`, not from `wagmi`: the
 * adapter's versions bridge Privy's embedded wallet in as a wagmi connector. Importing wagmi's own
 * would leave every write unsigned with no error to explain why.
 */
const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  transports: { [hederaTestnet.id]: http() },
})

/**
 * A read whose block has not been mined yet is not an error, so retrying is not the answer --
 * refetching is. Hedera produces blocks about every two seconds, and the mirror node lags consensus
 * by a few more, so anything faster than this is load without information.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 4_000, refetchInterval: 8_000, refetchOnWindowFocus: true },
  },
})

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID

export function Providers({ children }: { children: React.ReactNode }) {
  // Without an app id Privy throws on mount and takes the whole page with it, including the parts
  // that only read the chain. Rendering the tree without it keeps the read-only views working and
  // lets the sign-in button explain itself.
  if (!APP_ID) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    )
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Passkey first: the demo's claim is that a compliant secondary market can be opened
        // without a browser extension, so an extension must not be the first thing asked for.
        loginMethods: ['passkey', 'google', 'email', 'wallet'],
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: hederaTestnet,
        supportedChains: [hederaTestnet],
        appearance: {
          theme: '#0A0A0A',
          accentColor: '#3DD68C',
          logo: '/brand/tenor-ribbon.svg',
          walletChainType: 'ethereum-only',
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  )
}

/** True when Privy is configured. The setup card uses this to say so rather than failing silently. */
export const privyConfigured = Boolean(APP_ID)
