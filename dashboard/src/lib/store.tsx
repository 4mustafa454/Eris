import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HARNESS, listAgents, type AgentState, type Approval, type Session, type Task } from './harness'

/** Live harness state from GET /events (SSE, AGENTS.md §5.2). Each event carries one full changed record. */
export interface Live {
  online: boolean
  agents: AgentState[]
  tasks: Task[]
  approvals: Approval[]
  sessions: Session[]
}
const Ctx = createContext<Live>({ online: false, agents: [], tasks: [], approvals: [], sessions: [] })
export const useLive = () => useContext(Ctx)

type Rec = { id: string }
function upsert<T extends Rec>(m: Map<string, T>, r: T) {
  m.set(r.id, r)
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(false)
  const [ver, bump] = useState(0)
  const store = useRef({
    agents: new Map<string, AgentState>(),
    tasks: new Map<string, Task>(),
    approvals: new Map<string, Approval>(),
    sessions: new Map<string, Session>(),
  })

  useEffect(() => {
    const s = store.current
    let dead = false
    listAgents()
      .then((a) => {
        if (dead) return
        a.forEach((x) => upsert(s.agents, x))
        bump((n) => n + 1)
      })
      .catch(() => {})
    const es = new EventSource(`${HARNESS}/events`)
    es.onopen = () => setOnline(true)
    es.onerror = () => setOnline(false) // EventSource reconnects by itself
    es.onmessage = (e) => {
      try {
        const { type, data } = JSON.parse(e.data) as { type: string; data: Rec }
        const map = { agent: s.agents, task: s.tasks, approval: s.approvals, session: s.sessions }[type] as
          | Map<string, Rec>
          | undefined
        if (map) {
          upsert(map, data)
          bump((n) => n + 1)
        }
      } catch {
        /* ignore malformed frame */
      }
    }
    return () => {
      dead = true
      es.close()
    }
  }, [])

  const s = store.current
  const value = useMemo<Live>(
    () => ({
      online,
      agents: [...s.agents.values()].sort((a, b) => a.id.localeCompare(b.id)),
      tasks: [...s.tasks.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      approvals: [...s.approvals.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      sessions: [...s.sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [online, ver],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
