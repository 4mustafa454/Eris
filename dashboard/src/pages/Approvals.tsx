import { useEffect, useState } from 'react'
import { decideApproval, listApprovals, type Approval } from '../lib/harness'
import { useLive } from '../lib/store'
import { Card, Pending, ago, isPending } from '../lib/ui'

/** Pending approvals (AGENTS.md §8: git_push and deploys). Approve/Deny goes to POST /approvals/{id}. */
export function ApprovalRow({ a, onDone }: { a: Approval; onDone?: () => void }) {
  const { agents } = useLive()
  const agent = agents.find((x) => x.id === a.agent_id)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<'pending' | 'failed' | null>(null)
  const decide = async (d: 'approved' | 'denied') => {
    setBusy(true)
    setErr(null)
    try {
      await decideApproval(a.id, d)
      onDone?.()
    } catch (e) {
      setErr(isPending(e) ? 'pending' : 'failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <span className="size-3 rounded-full" style={{ background: agent?.color ?? 'var(--color-muted)' }} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {agent?.name ?? a.agent_id} wants to <code className="text-gold">{a.action}</code>
          </div>
          {a.detail && <div className="mt-0.5 break-words text-sm text-muted">{a.detail}</div>}
          <div className="mt-1 text-xs text-muted">asked {ago(a.created_at)}</div>
        </div>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={() => decide('denied')}
            className="rounded-md border border-line px-4 py-1.5 text-sm text-muted hover:text-fg"
          >
            Deny
          </button>
          <button
            disabled={busy}
            onClick={() => decide('approved')}
            className="rounded-md bg-ok px-4 py-1.5 text-sm font-medium text-black hover:opacity-90"
          >
            Approve
          </button>
        </div>
      </div>
      {err === 'pending' && (
        <div className="mt-3"><Pending what="Approve and Deny" route="POST /approvals/{id}" /></div>
      )}
      {err === 'failed' && <p className="mt-3 text-sm text-bad" role="alert">That did not go through. Try again.</p>}
    </Card>
  )
}

export default function Approvals() {
  const { approvals } = useLive()
  const [routeMissing, setRouteMissing] = useState(false)
  useEffect(() => {
    listApprovals('pending').then(() => setRouteMissing(false)).catch((e) => setRouteMissing(isPending(e)))
  }, [])
  const pending = approvals.filter((a) => a.status === 'pending')
  const decided = approvals.filter((a) => a.status !== 'pending').slice(0, 10)
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Approvals</h2>
        <p className="text-sm text-muted">Workers commit locally only. A push waits here until you say yes.</p>
      </div>
      {routeMissing && <Pending what="The approvals list and decisions" route="GET/POST /approvals" />}
      {pending.length ? (
        <div className="space-y-3">{pending.map((a) => <ApprovalRow key={a.id} a={a} />)}</div>
      ) : (
        <p className="text-muted">Nothing is waiting for you.</p>
      )}
      {decided.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted">Recently decided</h3>
          <ul className="divide-y divide-line rounded-xl border border-line bg-panel text-sm">
            {decided.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-4 py-2">
                <span><code>{a.action}</code> <span className="text-muted">{a.detail}</span></span>
                <span className={a.status === 'approved' ? 'text-ok' : 'text-bad'}>{a.status} {ago(a.decided_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
