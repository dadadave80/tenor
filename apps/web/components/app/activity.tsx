'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useConfig } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { hashscan } from '@/lib/chain'
import { resolve } from '@/lib/errors'

/**
 * The activity tray and the toasts.
 *
 * The design canvas animates four steps per transaction on a timer. Here the steps are the real
 * lifecycle, and the one that matters is the difference between "submitted" and "confirmed": on
 * Hedera a transaction can be accepted by the relay and still fail at consensus, so a card only
 * turns green once `waitForTransactionReceipt` says `status === 'success'`. A receipt that comes back
 * reverted is a failure, and the card says so rather than quietly staying optimistic.
 */

export type Step = { label: string; done: boolean; failed?: boolean }

export type Activity = {
  id: string
  title: string
  steps: Step[]
  status: 'Pending' | 'Confirmed' | 'Failed'
  time: number
  hash?: `0x${string}`
  /** Set when the receipt reverted or the wallet refused, already put through `resolve()`. */
  error?: string
}

export type Toast = { id: string; title: string; kind: 'accent' | 'warning' | 'danger'; href?: string }

type Ctx = {
  activity: Activity[]
  toasts: Toast[]
  dismissToast: (id: string) => void
  /** Announces a transaction and follows it to a receipt. Returns the card's id. */
  track: (title: string, hash: `0x${string}`) => string
  /** Records something that failed before it ever became a transaction (a refused signature). */
  fail: (title: string, err: unknown) => void
  toast: (title: string, kind?: Toast['kind'], href?: string) => void
  pending: number
}

const ActivityContext = createContext<Ctx | null>(null)

const KEY = 'tenor.activity'

export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const config = useConfig()
  const [activity, setActivity] = useState<Activity[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  // Ids have to be stable across renders and must not come from Math.random during SSR.
  const seq = useRef(0)
  const nextId = useCallback(() => `a${++seq.current}-${Date.now()}`, [])

  // Restored after mount, never during render: reading localStorage while rendering would make the
  // server's HTML and the client's first paint disagree.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Activity[]
      // Anything still "Pending" from a previous visit has no watcher any more, so it is unknown
      // rather than pending -- claiming it is still in flight would be a lie about live state.
      setActivity(
        saved.map((a) => (a.status === 'Pending' ? { ...a, status: 'Failed', error: 'Left unresolved — check HashScan.' } : a)),
      )
    } catch {
      // A private window or blocked site data: start empty rather than break the tray.
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(activity.slice(0, 30)))
    } catch {
      // Nothing to do; the tray is still correct for this session.
    }
  }, [activity])

  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const toast = useCallback(
    (title: string, kind: Toast['kind'] = 'accent', href?: string) => {
      const id = nextId()
      setToasts((t) => [...t, { id, title, kind, href }])
      // Failures stay until dismissed: a message you have to read should not time out.
      if (kind !== 'danger') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
    },
    [nextId],
  )

  const patch = useCallback((id: string, fn: (a: Activity) => Activity) => {
    setActivity((list) => list.map((a) => (a.id === id ? fn(a) : a)))
  }, [])

  const track = useCallback(
    (title: string, hash: `0x${string}`) => {
      const id = nextId()
      setActivity((list) => [
        {
          id,
          title,
          hash,
          time: Date.now(),
          status: 'Pending',
          steps: [
            { label: 'Simulated', done: true },
            { label: 'Signed', done: true },
            { label: 'Submitted to Hedera', done: true },
            { label: 'Confirmed', done: false },
          ],
        },
        ...list,
      ])
      toast(`${title} · submitted`, 'accent', hashscan('transaction', hash))
      ;(async () => {
        try {
          const receipt = await waitForTransactionReceipt(config, { hash, confirmations: 1 })
          if (receipt.status === 'success') {
            patch(id, (a) => ({ ...a, status: 'Confirmed', steps: a.steps.map((s) => ({ ...s, done: true })) }))
            toast(`${title} · confirmed`, 'accent', hashscan('transaction', hash))
          } else {
            // Accepted by the relay, reverted at consensus. This is the case a timer would miss.
            patch(id, (a) => ({
              ...a,
              status: 'Failed',
              error: 'Reverted on chain.',
              steps: a.steps.map((s, i) => (i === 3 ? { label: 'Reverted', done: true, failed: true } : s)),
            }))
            toast(`${title} · reverted`, 'danger', hashscan('transaction', hash))
          }
        } catch (e) {
          const d = resolve(e)
          patch(id, (a) => ({ ...a, status: 'Failed', error: d.message }))
          toast(`${title} · ${d.label}`, 'danger', hashscan('transaction', hash))
        }
      })()
      return id
    },
    [config, nextId, patch, toast],
  )

  const fail = useCallback(
    (title: string, err: unknown) => {
      const d = resolve(err)
      setActivity((list) => [
        {
          id: nextId(),
          title,
          time: Date.now(),
          status: 'Failed',
          error: d.message,
          steps: [
            { label: 'Simulated', done: true },
            { label: d.label, done: true, failed: true },
          ],
        },
        ...list,
      ])
      toast(`${title} · ${d.label}`, 'danger')
    },
    [nextId, toast],
  )

  const value = useMemo<Ctx>(
    () => ({
      activity,
      toasts,
      dismissToast,
      track,
      fail,
      toast,
      pending: activity.filter((a) => a.status === 'Pending').length,
    }),
    [activity, toasts, dismissToast, track, fail, toast],
  )

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>
}

export function useActivity(): Ctx {
  const ctx = useContext(ActivityContext)
  if (!ctx) throw new Error('useActivity outside ActivityProvider')
  return ctx
}
