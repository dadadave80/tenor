import { defineChain } from 'viem'

/**
 * Hedera testnet.
 *
 * Note the decimals: HBAR is 8 dp natively but **18 dp on the EVM side**, and the JSON-RPC relay
 * reports balances in the 18-dp form. Using 8 here would overstate every balance by 10^10.
 */
export const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.hashio.io/api'] } },
  blockExplorers: { default: { name: 'HashScan', url: 'https://hashscan.io/testnet' } },
  contracts: {
    /**
     * Multicall3 sits at its canonical address on Hedera testnet, but viem's chain list does not
     * carry it — and `useReadContracts` responds to that by silently falling back to one request per
     * call. Nine requests per keystroke through the fill drawer is how a relay starts rate-limiting,
     * so this is not a micro-optimisation. Verified against the live relay: all nine readiness
     * reads, both HTS facade reads included, answer in a single round trip.
     */
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
})

/** The Hedera Token Service system contract. A wallet associates ITSELF with a token by calling it. */
export const HTS_SYSTEM_CONTRACT = '0x0000000000000000000000000000000000000167' as const

/**
 * Association needs a generous explicit limit. Hedera's system contracts charge in HBAR converted
 * from gas, and the relay's estimate for a `0x167` call is unreliable — an unestimated
 * `associateToken` commonly fails with INSUFFICIENT_GAS.
 */
export const ASSOCIATE_GAS_LIMIT = 1_000_000n

/**
 * The gas limit every other write carries. The relay under-estimates calls that reach the ATS token or `0x167`:
 * a fill sent with its estimate ran out at 392,031 of 409,884 gas, a cancel at 244,993 of 256,391, and a fill has
 * used up to 553,904. Hedera charges at least 80% of the limit, so this is not free — about 0.95 HBAR per write.
 */
export const WRITE_GAS_LIMIT = 1_000_000n

/** USDC is 6 dp; the bond is issued at 6 dp too, so price and coupon maths share one scale. */
export const USDC_DECIMALS = 6

/** Mirror-node REST base. Lags consensus by a few seconds — never poll it faster than that. */
export const MIRROR_NODE = 'https://testnet.mirrornode.hedera.com/api/v1'

export function hashscan(kind: 'contract' | 'transaction' | 'account' | 'token', id: string): string {
  return `${hederaTestnet.blockExplorers.default.url}/${kind}/${id}`
}

/** Addresses come from the deploy scripts via env; a missing one renders as `—`, never a placeholder. */
export const addresses = {
  tenor: process.env.NEXT_PUBLIC_TENOR_DIAMOND as `0x${string}` | undefined,
  token: process.env.NEXT_PUBLIC_ATS_TOKEN as `0x${string}` | undefined,
  usdc: process.env.NEXT_PUBLIC_USDC as `0x${string}` | undefined,
  partition: (process.env.NEXT_PUBLIC_PARTITION ??
    '0x0000000000000000000000000000000000000000000000000000000000000001') as `0x${string}`,
}
