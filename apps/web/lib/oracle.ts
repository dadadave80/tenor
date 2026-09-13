'use client'

import { formatUnits } from 'viem'
import { useReadContract } from 'wagmi'

/**
 * The Chainlink USDC/USD reference, read straight from the aggregator proxy on Hedera testnet.
 *
 * Tenor prices and settles in USDC, so every figure on the market is only worth a dollar as long as
 * USDC is worth a dollar. That is an assumption, not a fact, and this is the feed that checks it:
 * the price is shown next to the book, the USD equivalent is shown where a number is committed to,
 * and the banner says so when the reference drifts or goes quiet.
 *
 * Verified live before it was pinned — `description()` answers "USDC / USD", `decimals()` answers 8.
 */
export const USDC_USD_FEED = '0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5' as const

/** Read from the proxy, not assumed: `decimals()` is 8. Hardcoded so the price costs one call, not two. */
const FEED_DECIMALS = 8

/**
 * Chainlink publishes this feed with an 86,400 s heartbeat and a 0.5% deviation trigger, so a round
 * up to a day old is the feed working as specified, not a fault. Anything past the heartbeat plus an
 * hour of slack has actually stopped, and that is worth a banner.
 */
const STALE_AFTER_S = 86_400 + 3_600

/** The deviation that makes USDC's peg worth mentioning — the feed's own trigger, 0.5%. */
const OFF_PEG = 0.005

/** Only the three functions this app reads. `abi.ts` is generated, so the fragment lives here. */
export const aggregatorV3Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

export type UsdcUsd = {
  /** USD per USDC. `undefined` when the read failed — which renders as `—`, never as 1.00. */
  price?: number
  /** Unix seconds of the round that produced `price`. */
  updatedAt?: number
  isStale: boolean
  offPeg: boolean
  isLoading: boolean
  error: Error | null
  /** True only when there is a price and it is neither stale nor off peg. Gates the USD equivalents. */
  healthy: boolean
}

/**
 * The feed, on the app's own polling cadence.
 *
 * No `query` override on purpose: the shared QueryClient already refetches every 8 s, and a price
 * that refreshes with the order book is the point.
 */
export function useUsdcUsd(): UsdcUsd {
  const { data, isLoading, error } = useReadContract({
    address: USDC_USD_FEED,
    abi: aggregatorV3Abi,
    functionName: 'latestRoundData',
  })

  if (!data) return { isStale: false, offPeg: false, isLoading, error, healthy: false }

  const [, answer, , updatedAtRaw] = data
  const price = Number(formatUnits(answer, FEED_DECIMALS))
  const updatedAt = Number(updatedAtRaw)

  // A stale price's deviation means nothing, so staleness wins where both would be true.
  const isStale = Date.now() / 1000 - updatedAt > STALE_AFTER_S
  const offPeg = !isStale && Math.abs(price - 1) > OFF_PEG

  return { price, updatedAt, isStale, offPeg, isLoading, error, healthy: !isStale && !offPeg }
}

/** The USD equivalent of a USDC figure. Always approximate — it came from an oracle, not the trade. */
export function fmtUsd(value: number): string {
  return `≈ $${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
