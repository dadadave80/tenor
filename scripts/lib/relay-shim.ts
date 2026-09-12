/**
 * A local JSON-RPC shim that makes `forge script` work against Hedera's public relay.
 *
 * **The incompatibility.** Foundry 1.8.1 looks up the broadcaster's nonce pinned to a specific
 * block, using the EIP-1898 object form of the block parameter:
 *
 * ```
 * eth_getTransactionCount ["0x…", {"blockHash":"0x…","requireCanonical":false}]
 * ```
 *
 * Hashio (`testnet.hashio.io`) rejects that with `-32602 Invalid parameter 1: … Expected 0x prefixed
 * hexadecimal block number, or the string "latest", "earliest" or "pending"`. It accepts only the
 * string forms. Foundry has no flag to opt out — `--skip-simulation` and `--legacy` both still send
 * it — so `forge script` cannot reach the relay at all without this translation.
 *
 * **What it does.** Forwards every request untouched except for a block parameter in the EIP-1898
 * object form, which it rewrites to the string form: `blockNumber` if the object carries one, and
 * otherwise `"latest"`.
 *
 * **Why substituting `latest` for a block hash is safe here.** The pin exists so foundry reads a
 * consistent nonce while it simulates. We broadcast from a single key with `--slow`, so there is no
 * second sender to race, and `latest` is at worst a *newer* view of that same key's nonce — which is
 * the value the transaction needs anyway. The one thing this would break is replaying a script
 * against a historical block, which a deploy never does.
 */
import type { Server } from 'bun'

const EIP1898_KEYS = new Set(['blockHash', 'blockNumber', 'requireCanonical'])

/** True for `{blockHash, requireCanonical?}` or `{blockNumber}` and nothing else. */
function isBlockObject(v: unknown): v is { blockHash?: string; blockNumber?: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const keys = Object.keys(v)
  if (keys.length === 0) return false
  // A transaction object for `eth_call` also arrives as a param, so the shape must match exactly.
  return keys.every((k) => EIP1898_KEYS.has(k))
}

function rewrite(params: unknown): unknown {
  if (!Array.isArray(params)) return params
  return params.map((p) => (isBlockObject(p) ? (p.blockNumber ?? 'latest') : p))
}

export type Shim = { url: string; rewrites: () => number; stop: () => void }

export function startRelayShim(upstream: string, port = 8599): Shim {
  let rewrites = 0

  const server: Server = Bun.serve({
    port,
    idleTimeout: 120,
    async fetch(req) {
      const text = await req.text()
      let body = text
      try {
        const parsed = JSON.parse(text)
        // Batch requests are an array of call objects.
        const calls = Array.isArray(parsed) ? parsed : [parsed]
        let touched = false
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue
          const next = rewrite(call.params)
          if (JSON.stringify(next) !== JSON.stringify(call.params)) {
            call.params = next
            touched = true
          }
        }
        if (touched) {
          rewrites++
          body = JSON.stringify(parsed)
        }
      } catch {
        // Not JSON we understand — forward it exactly as it arrived.
      }

      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    rewrites: () => rewrites,
    stop: () => void server.stop(true),
  }
}
