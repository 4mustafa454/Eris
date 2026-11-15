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
