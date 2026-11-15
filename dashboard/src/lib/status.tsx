import { useAsk } from './ask'
import { useLive } from './store'
import { STATE_COLOR } from './ui'

/** One pill per agent, in the agent's own colour. Driven by the SSE store, so it updates the moment a state changes. */
export function AgentPills() {
  const { agents } = useLive()
  if (!agents.length) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Agent status">
      {agents.map((a) => {
        const bad = a.state === 'stuck' || a.state === 'error'
        return (
          <span
            key={a.id}
            title={a.task ?? undefined}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${bad ? 'bg-bad/10' : 'bg-panel/60'}`}
            style={{ borderColor: a.color }}
          >
            <span className={`size-2 rounded-full ${a.state === 'working' ? 'animate-pulse' : ''}`} style={{ background: a.color }} />
            <span className="font-medium">{a.name}</span>
            <span style={{ color: STATE_COLOR[a.state] ?? STATE_COLOR.idle }}>{a.state}</span>
          </span>
        )
      })}
    </div>
  )
}

/** Red strip for the first stuck or errored agent, with its reason and a one-click question to Eris. */
export function StuckBanner() {
  const { agents } = useLive()
  const { askEris } = useAsk()
  const a = agents.find((x) => x.state === 'stuck' || x.state === 'error')
  if (!a) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b border-bad/30 bg-bad/10 px-5 py-2 text-sm">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-bad" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-red-200">
        <strong className="font-medium">{a.name} is {a.state}.</strong> {a.stuck_reason ?? a.summary ?? ''}
      </span>
      <button
        onClick={() => askEris(`What is ${a.name} ${a.state === 'error' ? 'failing on' : 'stuck on'}?`)}
        className="rounded-full border border-bad/50 px-3 py-1 text-xs text-red-100 hover:bg-bad/20"
      >
        Ask Eris
      </button>
    </div>
  )
}
