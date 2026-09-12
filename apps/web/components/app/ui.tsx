'use client'

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { ActionState } from '@/lib/actions'
import { Icon, type IconName } from '@/components/landing/primitives'

/**
 * The controls the app shell shares, with the canvas's shapes and tokens.
 *
 * `--radius-control: 999px` means every button and chip is a pill, and the primary button is a
 * NEUTRAL pill (white fill, near-black text) so `--accent` keeps meaning yield and positive status.
 * A control that cannot be clicked goes grey rather than tinted, which is why `PrimaryButton`
 * distinguishes "blocked" from "clickable" instead of only using `disabled`.
 */

export function Pill({
  kind = 'neutral',
  icon,
  children,
}: {
  kind?: 'neutral' | 'accent' | 'warning' | 'danger' | 'info'
  icon?: IconName
  children: ReactNode
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text-2)' },
    accent: { bg: 'var(--surface-tint)', fg: 'var(--accent)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
    info: { bg: 'var(--info-soft)', fg: 'var(--info)' },
  }
  const { bg, fg } = palette[kind]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        borderRadius: 'var(--radius-pill)',
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}

export function Banner({ kind, children }: { kind: 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return (
    <div
      role={kind === 'danger' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 'var(--radius-card)',
        background: `var(--${kind}-soft)`,
        color: `var(--${kind})`,
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <Icon name={kind === 'danger' ? 'alert' : 'info'} size={14} />
      <span>{children}</span>
    </div>
  )
}

/**
 * The action button.
 *
 * Three visual states because there are three meanings: clickable, pending, and blocked. A blocked
 * button still shows its label — the label IS the explanation ("Verification required"), so hiding
 * it would remove the only thing telling the user what to do.
 */
export function PrimaryButton({ action, full = true }: { action: ActionState; full?: boolean }) {
  const clickable = Boolean(action.onClick) && !action.pending
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: full ? '100%' : undefined }}>
      <button
        type="button"
        onClick={action.onClick}
        disabled={!clickable}
        aria-busy={action.pending || undefined}
        className={clickable ? 'pill-primary' : undefined}
        style={{
          height: 'var(--control-h)',
          padding: '0 20px',
          borderRadius: 'var(--radius-pill)',
          border: 'none',
          width: full ? '100%' : undefined,
          fontWeight: 500,
          fontSize: 15,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          cursor: clickable ? 'pointer' : 'not-allowed',
          background: clickable ? 'var(--btn)' : 'var(--surface-2)',
          color: clickable ? 'var(--btn-fg)' : 'var(--text-2)',
          transition: 'background 160ms, color 160ms',
        }}
      >
        {action.pending && <Spinner />}
        {action.label}
      </button>
      {action.helper && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>{action.helper}</p>
      )}
    </div>
  )
}

export function SecondaryButton({
  onClick,
  children,
  disabled,
  tone = 'neutral',
}: {
  onClick?: () => void
  children: ReactNode
  disabled?: boolean
  tone?: 'neutral' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={!disabled ? 'pill-secondary' : undefined}
      style={{
        height: 36,
        padding: '0 14px',
        borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--border)',
        background: 'transparent',
        color: disabled ? 'var(--text-2)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}`,
        borderRightColor: 'transparent',
        borderRadius: 'var(--radius-pill)',
        animation: 'spin .8s linear infinite',
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  )
}

/** A labelled numeric input with an optional MAX affordance, as the canvas draws it. */
export function Field({
  label,
  value,
  onChange,
  suffix,
  helper,
  onMax,
  placeholder,
  inputMode = 'numeric',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  suffix?: string
  helper?: ReactNode
  onMax?: () => void
  placeholder?: string
  inputMode?: 'numeric' | 'decimal'
}) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={id} style={{ fontSize: 13, color: 'var(--text-2)' }}>
        {label}
      </label>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 'var(--control-h)',
          padding: '0 12px',
          borderRadius: 'var(--radius-input)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}
      >
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          onChange={(e) =>
            onChange(inputMode === 'decimal' ? e.target.value.replace(/[^0-9.]/g, '') : e.target.value.replace(/[^0-9]/g, ''))
          }
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontSize: 15 }}
        />
        {suffix && <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{suffix}</span>}
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--accent)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            MAX
          </button>
        )}
      </div>
      {helper && <p style={{ margin: 0, fontSize: 12, color: 'var(--text-2)' }}>{helper}</p>}
    </div>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        padding: 20,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/**
 * The right-hand drawer. Escape closes it and focus moves inside on open, because a panel that traps
 * a keyboard user is worse than no panel.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!mounted || !open) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60, animation: 'fadeIn 160ms ease-out' }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(440px, 100vw)',
          zIndex: 61,
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideIn 220ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '20px 20px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: '-0.01em' }}>{title}</h2>
            {subtitle && (
              <div style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-2)',
              cursor: 'pointer',
              padding: 4,
              lineHeight: 0,
            }}
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {children}
        </div>
      </aside>
    </>
  )
}

/** An em dash is the honest rendering of a value that could not be read (SPEC §9.3). */
export function Value({ children }: { children: ReactNode }) {
  return <>{children === undefined || children === null || children === '' ? '—' : children}</>
}
