'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useClient, useReadContract, useReadContracts } from 'wagmi'
import { parseAbiItem } from 'viem'
import { getBlockNumber } from 'viem/actions'
import { getAllLogs } from '@/lib/logs'
import { Icon } from '@/components/landing/primitives'
import { Card, Pill, Spinner, Value } from '@/components/app/ui'
import { tenorAbi } from '@/lib/abi'
import { fmtUsdc } from '@/lib/actions'
import { addresses, hashscan } from '@/lib/chain'

/**
 * Coupons.
 *
 * Everything on this page is a chain read, including the schedule address — `couponScheduleAddress`
 * returns the Hedera Schedule Service entity the diamond booked, and that address on HashScan is the
 * proof that nobody has to click to be paid. A coupon with no booking reads `—` rather than
 * inventing a schedule id.
 */
type Coupon = {
  payAt: bigint
  amountPerToken: bigint
  funded: bigint
  paid: bigint
  scheduleNonce: bigint
  settled: boolean
}

function whenText(payAt: bigint): string {
  const ms = Number(payAt) * 1000 - Date.now()
  const abs = new Date(Number(payAt) * 1000).toUTCString().slice(5, 16)
  if (ms <= 0) return abs
  const d = Math.floor(ms / 864e5)
  const h = Math.floor(ms / 3600_000) % 24
  return d > 0 ? `${abs} · in ${d} d` : `${abs} · in ${h} h`
}

export default function CouponsPage() {
  const { tenor } = addresses
  const { address } = useAccount()

  // Coupon ids are chosen by the issuer -- `fundCoupon(couponId, ...)` -- so there is no counter to
  // walk the way `nextListingId` lets the market be walked. `CouponFunded` is the only record that a
  // given id exists, so the ids come from the log.
  const client = useClient()
  const { data: ids = [] } = useQuery({
    queryKey: ['couponIds', tenor],
    enabled: Boolean(tenor && client),
    queryFn: async () => {
      // Not `fromBlock: 'earliest'`: Hashio rejects it outright, because it caps the span at seven
      // days. `getAllLogs` starts from the recorded deploy block and walks in windows.
      const latest = await getBlockNumber(client!)
      const logs = await getAllLogs(client!, {
        address: tenor!,
        event: parseAbiItem(
          'event CouponFunded(uint256 indexed couponId, uint256 amount, uint256 amountPerToken, uint64 payAt)',
        ),
        latest,
      })
      const ids = logs.map((l) => (l as unknown as { args: { couponId: bigint } }).args.couponId)
      return [...new Set(ids)].sort((a, b) => (a < b ? -1 : 1))
    },
  })

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: ids.flatMap(
      (id) =>
        [
          { address: tenor, abi: tenorAbi, functionName: 'getCoupon', args: [id] },
          { address: tenor, abi: tenorAbi, functionName: 'couponScheduleAddress', args: [id] },
          ...(address
            ? [{ address: tenor, abi: tenorAbi, functionName: 'couponEntitlement', args: [id, address] } as const]
            : []),
        ] as const,
    ),
    query: { enabled: Boolean(tenor) && ids.length > 0 },
  })

  const stride = address ? 3 : 2
  const coupons = ids.map((id, i) => {
    const get = <T,>(k: number): T | undefined => {
      const cell = data?.[i * stride + k]
      return cell?.status === 'success' ? (cell.result as T) : undefined
    }
    const coupon = get<Coupon>(0)
    return {
      id,
      coupon,
      schedule: get<`0x${string}`>(1),
      entitlement: address ? get<bigint>(2) : undefined,
    }
  })

  // `couponRequirement` takes the PER-TOKEN amount, not a coupon id -- passing the id would silently
  // price a different coupon. So it is asked once per coupon, keyed on that coupon's own terms.
  const { data: requirements } = useReadContracts({
    allowFailure: true,
    contracts: coupons.map(
      (c) =>
        ({
          address: tenor,
          abi: tenorAbi,
          functionName: 'couponRequirement',
          args: [c.coupon?.amountPerToken ?? 0n],
        }) as const,
    ),
    query: { enabled: Boolean(tenor) && coupons.some((c) => c.coupon) },
  })

  const { data: holders } = useReadContract({
    address: tenor,
    abi: tenorAbi,
    functionName: 'couponHolders',
    query: { enabled: Boolean(tenor) },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header>
        <h1 style={{ margin: '0 0 6px', fontSize: 'clamp(28px, 3vw, 36px)', fontWeight: 500, letterSpacing: '-0.02em' }}>
          Coupons
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
          The issuer funds a coupon and books it with the Hedera Schedule Service. The network fires it at the pay
          date, and the payment itself is permissionless — any holder can complete it, so nobody controls whether
          holders get paid.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Registered holders</div>
          <div style={{ fontSize: 26, fontWeight: 500 }}>
            <Value>{holders ? holders.length : undefined}</Value>
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Coupons created</div>
          <div style={{ fontSize: 26, fontWeight: 500 }}>
            <Value>{ids.length || undefined}</Value>
          </div>
        </Card>
      </div>

      {isLoading && (
        <Card>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-2)', fontSize: 14 }}>
            <Spinner size={16} /> Reading coupons…
          </div>
        </Card>
      )}

      {!isLoading && ids.length === 0 && (
        <Card>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
            {tenor
              ? 'No coupons created yet. The issuer funds the first one with fundCoupon, then schedules it.'
              : 'The contracts are not configured in this build.'}
          </p>
        </Card>
      )}

      {coupons.map(({ id, coupon, schedule, entitlement }, ci) => {
        if (!coupon) return null
        const rc = requirements?.[ci]
        const requirement = rc?.status === 'success' ? (rc.result as bigint) : undefined
        const shortfall = requirement !== undefined && coupon.funded < requirement
        const booked = schedule && schedule !== '0x0000000000000000000000000000000000000000'
        return (
          <Card key={String(id)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>Coupon #{String(id)}</div>
                <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  {whenText(coupon.payAt)} · {fmtUsdc(coupon.amountPerToken)} per token
                </div>
              </div>
              {coupon.settled ? (
                <Pill kind="accent" icon="check">
                  Paid
                </Pill>
              ) : booked ? (
                <Pill kind="info" icon="clock">
                  Scheduled
                </Pill>
              ) : shortfall ? (
                <Pill kind="warning" icon="alert">
                  Underfunded
                </Pill>
              ) : (
                <Pill kind="neutral">Draft</Pill>
              )}
            </div>

            <dl
              style={{
                margin: 0,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
                fontSize: 13,
              }}
            >
              <div>
                <dt style={{ color: 'var(--text-2)', fontSize: 12 }}>Funded</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{fmtUsdc(coupon.funded)}</dd>
              </div>
              <div>
                <dt style={{ color: 'var(--text-2)', fontSize: 12 }}>Needed</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>
                  <Value>{requirement !== undefined ? fmtUsdc(requirement) : undefined}</Value>
                </dd>
              </div>
              <div>
                <dt style={{ color: 'var(--text-2)', fontSize: 12 }}>Paid out</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{fmtUsdc(coupon.paid)}</dd>
              </div>
              {entitlement !== undefined && (
                <div>
                  <dt style={{ color: 'var(--text-2)', fontSize: 12 }}>Your share</dt>
                  <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                    {fmtUsdc(entitlement)}
                  </dd>
                </div>
              )}
            </dl>

            {requirement !== undefined && requirement > 0n && (
              <div style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, Number((coupon.funded * 100n) / requirement))}%`,
                    background: shortfall ? 'var(--warning)' : 'var(--accent)',
                  }}
                />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
              <Icon name="cal" size={12} />
              {booked ? (
                <>
                  Booked with the Hedera Schedule Service at{' '}
                  <a href={hashscan('account', schedule!)} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)' }}>
                    {schedule!.slice(0, 10)}…
                  </a>
                </>
              ) : (
                <>Not scheduled yet — the issuer books this with the Schedule Service after funding.</>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
