import { useEffect, useRef, useState } from 'react'
import { FRAME_URL, getLog, stopAll, type AgentState } from '../lib/harness'
import { useLive } from '../lib/store'
import { Badge, ago } from '../lib/ui'

/** Mirror of the supervisor's frame.jpg (~1 fps). Falls back to a message when the renderer is not running. */
function Frame() {
  const [tick, setTick] = useState(() => Date.now())
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-panel">
        <img
          src={`${FRAME_URL}?t=${tick}`}
          alt="What the PM is showing on the call"
          className={`size-full object-cover ${ok ? '' : 'hidden'}`}
          onLoad={() => setOk(true)}
          onError={() => setOk(false)}
        />
        {!ok && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
            <p>
              No video frame. The call renderer runs inside the supervisor (<code>npm start</code>) and serves{' '}
              <code>{FRAME_URL.replace('http://', '')}</code>.
            </p>
          </div>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-muted">What the caller sees on FaceTime</p>
    </div>
  )
}

function useLog(a: AgentState) {
  const [lines, setLines] = useState<string[]>([])
  const last = useRef('')
  useEffect(() => {
    const key = `${a.updated_at}|${a.summary}|${a.state}`
    if (key === last.current) return
    last.current = key
    getLog(a.id, 5).then((r) => setLines(r.lines)).catch(() => {})
  }, [a.id, a.updated_at, a.summary, a.state])
  return lines
}

function AgentCard({ a }: { a: AgentState }) {
  const lines = useLog(a)
  return (
    <div className="rounded-xl border border-l-4 border-line bg-panel p-4" style={{ borderLeftColor: a.color }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full" style={{ background: a.color }} />
          <h3 className="font-medium">{a.name}</h3>
          <span className="text-xs text-muted">{a.engine}</span>
        </div>
        <Badge state={a.state} />
      </div>
      <p className="mt-2 text-sm">{a.task ?? <span className="text-muted">No task</span>}</p>
      {a.stuck_reason && (
        <p className="mt-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{a.stuck_reason}</p>
      )}
      <ul className="mt-3 space-y-0.5 font-mono text-xs text-muted" aria-label={`${a.name} recent activity`}>
        {lines.length ? lines.map((l, i) => <li key={i} className="truncate">{l}</li>) : <li>No activity yet</li>}
      </ul>
      <p className="mt-2 text-right text-[11px] text-muted">updated {ago(a.updated_at)}</p>
    </div>
  )
}

export default function Live() {
  const { agents, online } = useLive()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const stop = async () => {
    if (!window.confirm('Stop every agent now?')) return
    setBusy(true)
    try {
      await stopAll()
      setMsg('Stopped all agents.')
    } catch {
      setMsg('Stop all failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
      <Frame />
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Agents</h2>
          <div className="flex items-center gap-3">
            {msg && <span className="text-sm text-muted" role="status">{msg}</span>}
            <button
              onClick={stop}
              disabled={busy || !online}
              className="rounded-md border border-bad px-3 py-1.5 text-sm text-bad hover:bg-bad/10"
            >
              Stop all
            </button>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
          {agents.map((a) => <AgentCard key={a.id} a={a} />)}
          {!agents.length && <p className="text-muted">{online ? 'No agents yet.' : 'Waiting for the harness.'}</p>}
        </div>
      </section>
    </div>
  )
}
