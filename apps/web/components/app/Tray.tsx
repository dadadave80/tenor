'use client'

import { Icon } from '@/components/landing/primitives'
import { hashscan } from '@/lib/chain'
import { useActivity, type Activity } from './activity'
import { Drawer, Pill, Spinner } from './ui'

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  return d ? `${d} d ago` : h ? `${h} h ago` : `${m} m ago`
}

function statusPill(a: Activity) {
  if (a.status === 'Pending') return <Pill kind="warning">Pending</Pill>
  if (a.status === 'Failed') return <Pill kind="danger">Failed</Pill>
  return (
    <Pill kind="accent" icon="check">
      Confirmed
    </Pill>
  )
}

export function Tray({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activity } = useActivity()

  return (
    <Drawer open={open} onClose={onClose} title="Activity" subtitle="Every transaction this browser sent">
      {activity.length === 0 && (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
          Nothing yet. Transactions appear here with a HashScan link as soon as they are submitted.
        </p>
      )}

      {activity.map((a) => (
        <article
          key={a.id}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--bg)',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <strong style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</strong>
            {statusPill(a)}
          </div>

          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {a.steps.map((s, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)' }}>
                {s.failed ? (
                  <Icon name="alert" size={12} color="var(--danger)" />
                ) : s.done ? (
                  <Icon name="check" size={12} color="var(--accent)" />
                ) : (
                  <Spinner size={12} color="var(--warning)" />
                )}
                <span style={{ color: s.failed ? 'var(--danger)' : s.done ? 'var(--text)' : 'var(--text-2)' }}>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>

          {a.error && <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>{a.error}</p>}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              fontSize: 11,
              color: 'var(--text-2)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span>{ago(Date.now() - a.time)}</span>
            {a.hash && (
              <a href={hashscan('transaction', a.hash)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                HashScan
              </a>
            )}
          </div>
        </article>
      ))}
    </Drawer>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useActivity()
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 'min(360px, calc(100vw - 40px))',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 'var(--radius-card)',
            background: 'var(--surface)',
            border: `1px solid var(--${t.kind === 'accent' ? 'border' : t.kind})`,
            boxShadow: 'var(--shadow)',
            fontSize: 13,
            animation: 'slideIn 220ms cubic-bezier(.2,.8,.2,1)',
          }}
        >
          <Icon
            name={t.kind === 'danger' ? 'alert' : t.kind === 'warning' ? 'clock' : 'check'}
            size={14}
            color={`var(--${t.kind === 'accent' ? 'accent' : t.kind})`}
          />
          <span style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
          {t.href && (
            <a href={t.href} target="_blank" rel="noreferrer" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              View
            </a>
          )}
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            style={{ border: 'none', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', padding: 2, lineHeight: 0 }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
