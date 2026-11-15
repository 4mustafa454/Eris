import { useState } from 'react'
import {
  createTask, patchTask, pauseAgent, resumeAgent, steerAgent, type AgentState, type Task, type TaskStatus,
} from '../lib/harness'
import { useLive } from '../lib/store'
import { Badge, Pending, STATE_COLOR, ago, isPending } from '../lib/ui'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'queued', label: 'Queued' },
  { status: 'working', label: 'Working' },
  { status: 'stuck', label: 'Stuck' },
  { status: 'done', label: 'Done' },
]

type Note = { kind: 'pending' | 'failed' | 'ok'; text: string } | null
const failNote = (e: unknown, route: string): Note =>
  isPending(e) ? { kind: 'pending', text: route } : { kind: 'failed', text: 'That did not go through.' }

function NoteView({ n }: { n: Note }) {
  if (!n) return null
  if (n.kind === 'pending') return <div className="mt-2"><Pending what="This action" route={n.text} /></div>
  return <p className={`mt-2 text-sm ${n.kind === 'ok' ? 'text-ok' : 'text-bad'}`} role="status">{n.text}</p>
}

/** Per-agent controls: steer the live task (§5.2.1), pause/resume. */
function AgentControl({ a }: { a: AgentState }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const run = async (fn: () => Promise<unknown>, route: string, ok: string) => {
    setBusy(true); setNote(null)
    try { await fn(); setNote({ kind: 'ok', text: ok }) } catch (e) { setNote(failNote(e, route)) } finally { setBusy(false) }
  }
  const live = a.state === 'working' || a.state === 'stuck'
  return (
    <div className="rounded-xl border border-l-4 border-line bg-panel p-4" style={{ borderLeftColor: a.color }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.name}</span>
        <Badge state={a.state} />
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{a.task ?? 'No task'}</span>
        {a.state === 'paused' ? (
          <button disabled={busy} onClick={() => run(() => resumeAgent(a.id), 'POST /agents/{id}/resume', 'Resumed.')}
            className="rounded-md border border-line px-3 py-1 text-sm">Resume</button>
        ) : (
          <button disabled={busy || !live} onClick={() => run(() => pauseAgent(a.id), 'POST /agents/{id}/pause', 'Paused.')}
            className="rounded-md border border-line px-3 py-1 text-sm">Pause</button>
        )}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (t) void run(() => steerAgent(a.id, t), 'POST /agents/{id}/task', live ? 'Told it.' : 'Started a new task.').then(() => setText(''))
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label={`Instruction for ${a.name}`}
          placeholder={live ? 'Steer the current task, e.g. "use the v2 endpoint"' : 'Start a new task for this agent'}
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm" />
        <button disabled={busy || !text.trim()} className="rounded-md bg-gold px-3 py-1.5 text-sm font-medium text-black">
          {live ? 'Steer' : 'Start'}
        </button>
      </form>
      <NoteView n={note} />
    </div>
  )
}

function TaskCard({ t, agents }: { t: Task; agents: AgentState[] }) {
  const [note, setNote] = useState<Note>(null)
  const agent = agents.find((a) => a.id === t.agent_id)
  const patch = async (body: { status?: TaskStatus; agent_id?: string }, route: string) => {
    setNote(null)
    try { await patchTask(t.id, body) } catch (e) { setNote(failNote(e, route)) }
  }
  const open = t.status === 'queued' || t.status === 'working' || t.status === 'stuck'
  return (
    <div className="rounded-lg border border-line bg-panel2 p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: agent?.color ?? STATE_COLOR.idle }} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t.title}</div>
          <div className="mt-0.5 line-clamp-2 text-xs text-muted">{t.instruction}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select value={t.agent_id ?? ''} aria-label={`Assign ${t.title}`}
          onChange={(e) => e.target.value && void patch({ agent_id: e.target.value }, 'PATCH /tasks/{id}')}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs">
          <option value="">Unassigned</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {open && (
          <button onClick={() => void patch({ status: 'cancelled' }, 'PATCH /tasks/{id}')}
            className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-bad">Cancel</button>
        )}
        <span className="text-[11px] text-muted">{ago(t.updated_at)}</span>
      </div>
      <NoteView n={note} />
    </div>
  )
}

function NewTask({ agents }: { agents: AgentState[] }) {
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [agent, setAgent] = useState('')
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !instruction.trim()) return
    setBusy(true); setNote(null)
    try {
      await createTask({ title: title.trim(), instruction: instruction.trim(), agent_id: agent || undefined })
      setTitle(''); setInstruction(''); setNote({ kind: 'ok', text: 'Task created.' })
    } catch (err) { setNote(failNote(err, 'POST /tasks')) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-panel p-4">
      <h3 className="mb-3 text-sm font-medium">New task</h3>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_160px_auto]">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Task title"
          className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm" />
        <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should the agent do?" aria-label="Task instruction"
          className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm" />
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Assign to" className="rounded-lg border border-line bg-bg px-2 py-1.5 text-sm">
          <option value="">Any agent</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button disabled={busy || !title.trim() || !instruction.trim()} className="rounded-md bg-gold px-4 py-1.5 text-sm font-medium text-black">Add</button>
      </div>
      <NoteView n={note} />
    </form>
  )
}

export default function Tasks() {
  const { tasks, agents } = useLive()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Tasks</h2>
        <p className="text-sm text-muted">A busy agent queues new work. Steering a live task never replaces it.</p>
      </div>
      <section className="grid gap-3 lg:grid-cols-3" aria-label="Agents">
        {agents.map((a) => <AgentControl key={a.id} a={a} />)}
      </section>
      <NewTask agents={agents} />
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Task board">
        {COLUMNS.map((c) => {
          const items = tasks.filter((t) => t.status === c.status)
          return (
            <div key={c.status}>
              <h3 className="mb-2 flex items-center justify-between text-sm font-medium" style={{ color: STATE_COLOR[c.status] }}>
                {c.label}<span className="text-muted">{items.length}</span>
              </h3>
              <div className="space-y-2">
                {items.slice(c.status === 'done' ? -8 : 0).map((t) => <TaskCard key={t.id} t={t} agents={agents} />)}
                {!items.length && <p className="text-xs text-muted">Empty</p>}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
