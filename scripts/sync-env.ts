/**
 * Writes the deployed addresses from `deployments/296/ats.json` into `apps/web/.env.local`.
 *
 * The client reads four `NEXT_PUBLIC_*` names and renders `—` for any it cannot find (SPEC §9.3).
 * That is the right failure mode, but it also means a typo in an env name looks exactly like "not
 * deployed yet" -- so the names are written from the record rather than typed. Everything else
 * already in the file (the Privy app id) is preserved.
 *
 * Usage:  bun run sync:env
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRecord } from './lib/ats'

const ENV = resolve(import.meta.dir, '../apps/web/.env.local')
const rec = readRecord()

// Keys mirror `apps/web/lib/chain.ts`'s `addresses`.
const managed: Record<string, string | undefined> = {
  NEXT_PUBLIC_TENOR_DIAMOND: rec.tenor,
  NEXT_PUBLIC_ATS_TOKEN: rec.token,
  NEXT_PUBLIC_USDC: rec.usdc,
  NEXT_PUBLIC_PARTITION: rec.partition,
  // Hashio caps `eth_getLogs` at a 7-day window, so anything read from events needs a real starting
  // block rather than `earliest`.
  NEXT_PUBLIC_DEPLOY_BLOCK: rec.deployBlock ? String(rec.deployBlock) : undefined,
}

const lines = (existsSync(ENV) ? readFileSync(ENV, 'utf8').split('\n') : []).filter(
  (l) => !Object.keys(managed).some((k) => l.startsWith(`${k}=`)),
)
while (lines.length && lines[lines.length - 1] === '') lines.pop()

for (const [k, v] of Object.entries(managed)) {
  if (v) lines.push(`${k}=${v}`)
  else console.log(`  – ${k} not in the record yet`)
}

writeFileSync(ENV, `${lines.join('\n')}\n`)
console.log(`wrote apps/web/.env.local`)
for (const [k, v] of Object.entries(managed)) if (v) console.log(`  ${k}=${v}`)
