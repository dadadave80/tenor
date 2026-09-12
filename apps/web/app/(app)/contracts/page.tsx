'use client'

import { useReadContract, useReadContracts } from 'wagmi'
import { Card, Pill, Spinner, Value } from '@/components/app/ui'
import { tenorAbi } from '@/lib/abi'
import { addresses, hashscan, HTS_SYSTEM_CONTRACT } from '@/lib/chain'

/**
 * Every address this app talks to, read from the chain rather than listed from memory.
 *
 * The facet table comes from `DiamondLoupe.facets()`, so it is what the diamond will actually route
 * to — not what a deploy script intended to cut. The names are matched by selector count and order
 * from `DeployTenor.buildCuts`, and a facet the loupe returns that the list does not name is still
 * shown, unnamed: an extra facet is exactly the thing worth seeing.
 */
const CUT = [
  { name: 'ERC165Facet', note: 'interface discovery' },
  { name: 'DiamondLoupeFacet', note: 'facet enumeration' },
  { name: 'AccessControlDiamondCut', note: 'governed upgrades' },
  { name: 'AccessControl', note: 'roles' },
  { name: 'Receive', note: 'holds HBAR for scheduled calls' },
  { name: 'Pausable', note: 'issuer pause' },
  { name: 'HTSAdapter', note: 'Hedera Token Service · 0x167' },
  { name: 'HSSAdapter', note: 'Hedera Schedule Service · 0x16b' },
  { name: 'TenorMarket', note: 'listings and fills' },
  { name: 'TenorCoupon', note: 'coupon funding and payment' },
]

export default function ContractsPage() {
  const { tenor, token, usdc, partition } = addresses

  const { data: facets, isLoading } = useReadContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'facets',
    query: { enabled: Boolean(tenor) },
  })

  const { data: config } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: tenor, abi: tenorAbi, functionName: 'feeBps' },
      { address: tenor, abi: tenorAbi, functionName: 'maxDuration' },
      { address: tenor, abi: tenorAbi, functionName: 'securityToken' },
      { address: tenor, abi: tenorAbi, functionName: 'usdc' },
      { address: tenor, abi: tenorAbi, functionName: 'paused' },
      { address: tenor, abi: tenorAbi, functionName: 'isAssociated', args: [usdc!] },
    ],
    query: { enabled: Boolean(tenor && usdc) },
  })

  const at = <T,>(i: number): T | undefined => (config?.[i]?.status === 'success' ? (config[i].result as T) : undefined)

  const feeBps = at<number>(0)
  const maxDuration = at<bigint>(1)
  const securityToken = at<`0x${string}`>(2)
  const settlement = at<`0x${string}`>(3)
  const paused = at<boolean>(4)
  const associated = at<boolean>(5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header>
        <h1 style={{ margin: '0 0 6px', fontSize: 'clamp(28px, 3vw, 36px)', fontWeight: 500, letterSpacing: '-0.02em' }}>
          Contracts
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
          Everything this app talks to. Read live from the diamond, so what is listed is what is routed to.
        </p>
      </header>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Addresses</h2>
        <AddressRow label="Tenor diamond" address={tenor} note="market and coupons, one address" />
        <AddressRow
          label="Security token"
          address={token}
          note={
            securityToken && token && securityToken.toLowerCase() !== token.toLowerCase()
              ? '⚠ does not match the market’s pinned token'
              : 'ATS bond — enforces every transfer'
          }
          warn={Boolean(securityToken && token && securityToken.toLowerCase() !== token.toLowerCase())}
        />
        <AddressRow
          label="Settlement token"
          address={usdc}
          note={
            settlement && usdc && settlement.toLowerCase() !== usdc.toLowerCase()
              ? '⚠ does not match the market’s pinned USDC'
              : associated === false
                ? '⚠ the diamond is not associated with this token'
                : 'HTS token, 6 dp'
          }
          warn={
            Boolean(settlement && usdc && settlement.toLowerCase() !== usdc.toLowerCase()) || associated === false
          }
        />
        <AddressRow label="Hedera Token Service" address={HTS_SYSTEM_CONTRACT} note="system contract 0x167" />
        <AddressRow label="Hedera Schedule Service" address="0x000000000000000000000000000000000000016b" note="system contract 0x16b" />
      </Card>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Market configuration</h2>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, fontSize: 13 }}>
          <Item label="Protocol fee">
            <Value>{feeBps !== undefined ? `${feeBps} bps` : undefined}</Value>
          </Item>
          <Item label="Max listing life">
            <Value>{maxDuration !== undefined ? `${Number(maxDuration) / 86400} days` : undefined}</Value>
          </Item>
          <Item label="Partition">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{partition.slice(0, 12)}…</span>
          </Item>
          <Item label="Status">
            {paused === undefined ? <Value>{undefined}</Value> : paused ? <Pill kind="warning" icon="pause">Paused</Pill> : <Pill kind="accent" icon="check">Live</Pill>}
          </Item>
        </dl>
      </Card>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Facets</h2>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {facets ? `${facets.length} cut in` : '—'} · from DiamondLoupe.facets()
          </span>
        </div>

        {isLoading && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-2)', fontSize: 14 }}>
            <Spinner size={16} /> Reading the cut…
          </div>
        )}

        {!isLoading && !facets && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)' }}>
            {tenor ? 'Could not read the diamond.' : 'The diamond address is not configured in this build.'}
          </p>
        )}

        {facets && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            {facets.map((f, i) => {
              const named = CUT[i]
              return (
                <a
                  key={f.facetAddress}
                  href={hashscan('contract', f.facetAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="card-link"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '12px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--bg)',
                    color: 'var(--text)',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{named?.name ?? `Facet ${i + 1}`}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
                    {f.facetAddress.slice(0, 8)}…{f.facetAddress.slice(-4)} · {f.functionSelectors.length} selectors
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                    {named?.note ?? 'not in the expected cut — worth checking'}
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 4 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 15 }}>{children}</dd>
    </div>
  )
}

function AddressRow({
  label,
  address,
  note,
  warn,
}: {
  label: string
  address?: string
  note: string
  warn?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 12,
        borderTop: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, color: warn ? 'var(--warning)' : 'var(--text-2)' }}>{note}</div>
      </div>
      {address ? (
        <a
          href={hashscan('contract', address)}
          target="_blank"
          rel="noreferrer"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        >
          {address.slice(0, 10)}…{address.slice(-6)}
        </a>
      ) : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>—</span>
      )}
    </div>
  )
}
