import type { ReactNode } from 'react'
import { HarnessError } from './harness'

export const STATE_COLOR: Record<string, string> = {
  idle: 'var(--color-muted)',
  working: 'var(--color-info)',
  stuck: 'var(--color-bad)',
  error: 'var(--color-bad)',
  done: 'var(--color-ok)',
  paused: 'var(--color-warn)',
  queued: 'var(--color-muted)',
  cancelled: 'var(--color-muted)',
}

export function Badge({ state }: { state: string }) {
  const c = STATE_COLOR[state] ?? 'var(--color-muted)'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: c, color: c }}>
      <span className="size-1.5 rounded-full" style={{ background: c }} />
      {state}
    </span>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-panel p-4 shadow-md shadow-black/20 ${className}`}>{children}</div>
}

/** Shown where a §5 route is not built in the harness yet. */
export function Pending({ what, route }: { what: string; route: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel/60 p-5 text-sm">
      <div className="font-medium text-warn">Backend pending</div>
      <p className="mt-1 text-muted">
        {what} uses <code className="text-fg">{route}</code> from AGENTS.md §5.2. The harness does not serve it yet, so
        this panel is built against the spec and will start working when the route lands.
      </p>
    </div>
  )
}

export const isPending = (e: unknown) => e instanceof HarnessError && e.pending
export function ago(iso: string | null | undefined) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
