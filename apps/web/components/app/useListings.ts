'use client'

import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { tenorAbi } from '@/lib/abi'
import type { Listing } from '@/lib/actions'
import { addresses } from '@/lib/chain'

/**
 * Reads every listing.
 *
 * The market keeps no index of active ids — `nextListingId` is a counter and `getListing` is the
 * only read — so the whole range is fetched in one multicall and filtered here. That is fine at demo
 * scale and wrong at real scale; the fix is an indexer over `Listed`/`Filled`/`Cancelled`, not a
 * bigger multicall.
 */
export type ListingRow = Listing & { id: bigint }

export function useListings(): { rows: ListingRow[]; loading: boolean; nextId?: bigint } {
  const { tenor } = addresses

  const { data: nextId } = useReadContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'nextListingId',
    query: { enabled: Boolean(tenor) },
  })

  const ids = useMemo(() => {
    const n = nextId ? Number(nextId) : 0
    // Ids start at 1; `nextListingId` is the id the next `list` will take.
    return Array.from({ length: Math.max(0, n - 1) }, (_, i) => BigInt(i + 1))
  }, [nextId])

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: ids.map((id) => ({ address: tenor, abi: tenorAbi, functionName: 'getListing', args: [id] }) as const),
    query: { enabled: Boolean(tenor) && ids.length > 0 },
  })

  const rows = useMemo<ListingRow[]>(() => {
    if (!data) return []
    return data
      .map((res, i) => (res.status === 'success' ? { ...(res.result as Listing), id: ids[i] } : null))
      .filter((l): l is ListingRow => l !== null)
  }, [data, ids])

  return { rows, loading: isLoading, nextId }
}

/** Active, unexpired, still has tokens. Sorted cheapest first, which is also highest yield first. */
export function liveListings(rows: ListingRow[]): ListingRow[] {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return rows
    .filter((l) => l.active && l.remaining > 0n && l.expiry > now)
    .sort((a, b) => (a.pricePerToken < b.pricePerToken ? -1 : a.pricePerToken > b.pricePerToken ? 1 : 0))
}
