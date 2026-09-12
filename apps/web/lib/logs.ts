'use client'

import type { AbiEvent } from 'viem'
import { getLogs } from 'viem/actions'
import type { Client } from 'viem'

/**
 * Reads an event's whole history, in windows the relay will accept.
 *
 * Hashio caps `eth_getLogs` to a **seven day** span and rejects `fromBlock: "earliest"` outright:
 *
 * ```
 * -32004  The provided fromBlock and toBlock contain timestamps that exceed the
 *         maximum allowed duration of 7 days (604800 seconds)
 * ```
 *
 * So there is no single query that reads a contract's history, and anything enumerated from events
 * needs both a real starting block (`NEXT_PUBLIC_DEPLOY_BLOCK`, written by `bun run sync:env`) and
 * chunking. Hedera produces a block roughly every two seconds, which puts seven days at about
 * 300,000 blocks; the window here is deliberately well under that so a faster stretch of blocks
 * cannot push a chunk over the limit.
 */
const WINDOW = 200_000n

/** Where the diamond starts. Without it there is nothing to count back from but `earliest`. */
export const DEPLOY_BLOCK = process.env.NEXT_PUBLIC_DEPLOY_BLOCK
  ? BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK)
  : undefined

export async function getAllLogs<E extends AbiEvent>(
  client: Client,
  { address, event, latest }: { address: `0x${string}`; event: E; latest: bigint },
) {
  // No recorded deploy block means guessing, and guessing `earliest` is the one thing that is
  // certain to fail. One window back from the head is the honest fallback, and it is stated as a
  // limit rather than presented as a full history.
  const start = DEPLOY_BLOCK ?? (latest > WINDOW ? latest - WINDOW : 0n)

  const out: Awaited<ReturnType<typeof getLogs>> = []
  for (let from = start; from <= latest; from += WINDOW + 1n) {
    const to = from + WINDOW > latest ? latest : from + WINDOW
    out.push(...(await getLogs(client, { address, event, fromBlock: from, toBlock: to })))
  }
  return out
}
