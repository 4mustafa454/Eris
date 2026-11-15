/**
 * Client for the Eris harness. Routes follow /AGENTS.md §5.2 exactly; the dashboard only talks to the harness.
 * Default http://localhost:8787; override with VITE_HARNESS_URL.
 */
export const HARNESS: string = (import.meta.env.VITE_HARNESS_URL as string | undefined) ?? 'http://localhost:8787'
export const FRAME_URL: string = (import.meta.env.VITE_FRAME_URL as string | undefined) ?? 'http://localhost:8788/frame.jpg'

export type AgentStateName = 'idle' | 'working' | 'stuck' | 'done' | 'error' | 'paused'
export interface AgentState {
  id: string
  name: string
  color: string
  engine: string
  state: AgentStateName
  task: string | null
  summary: string | null
  stuck_reason: string | null
  updated_at: string
}
export type TaskStatus = 'queued' | 'working' | 'stuck' | 'done' | 'cancelled'
export interface Task {
  id: string
  agent_id: string | null
  title: string
  instruction: string
  status: TaskStatus
  created_at: string
  updated_at: string
}
export interface Session {
  id: string
  channel: 'facetime' | 'web' | 'imessage'
  title: string | null
  summary: string | null
  started_at: string
  ended_at: string | null
}
export interface Message {
  id: number
  session_id: string
  role: 'user' | 'pm' | 'system'
  text: string
  created_at: string
}
export interface ActionRow {
  id: number
  session_id: string | null
  agent_id: string | null
  tool: string
  args_json: string
  result_json: string | null
  created_at: string
}
export interface SessionDetail extends Session {
  messages: Message[]
  actions: ActionRow[]
}
export interface Approval {
  id: string
  agent_id: string
  action: string
  detail: string | null
  status: 'pending' | 'approved' | 'denied'
  session_id: string | null
  created_at: string
  decided_at: string | null
}
export interface SearchHit {
  session_id: string
  snippet: string
  created_at: string
}

/** Thrown for any non-2xx. 404/405 on a §5 route the harness has not built yet means "backend pending". */
export class HarnessError extends Error {
  constructor(public status: number, public detail = '') {
    super(`harness ${status}`)
  }
  get pending() {
    return this.status === 404 || this.status === 405 || this.status === 501
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HARNESS}${path}`, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null
    throw new HarnessError(res.status, typeof body?.detail === 'string' ? body.detail : '')
  }
  return (await res.json()) as T
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// Agents
export const listAgents = () => req<AgentState[]>('/agents')
export const getLog = (id: string, lines = 5) => req<{ lines: string[] }>(`/agents/${id}/log?lines=${lines}`)
export const steerAgent = (id: string, instruction: string, session_id?: string) =>
  req<AgentState>(`/agents/${id}/task`, json('POST', { instruction, session_id }))
export const pauseAgent = (id: string) => req<AgentState>(`/agents/${id}/pause`, json('POST', {}))
export const resumeAgent = (id: string) => req<AgentState>(`/agents/${id}/resume`, json('POST', {}))
export const stopAll = () => req<AgentState[]>('/stop-all', { method: 'POST' })

// Conversations
export const listSessions = (limit = 100) => req<Session[]>(`/sessions?limit=${limit}`)
export const getSession = (id: string) => req<SessionDetail>(`/sessions/${id}`)
export const search = (q: string) => req<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`)
export const chat = (text: string, session_id?: string) =>
  req<{ session_id: string; reply: string; actions: unknown[] }>('/chat', json('POST', { text, session_id }))

// Tasks
export const listTasks = (status?: TaskStatus) => req<Task[]>(`/tasks${status ? `?status=${status}` : ''}`)
export const createTask = (body: { title: string; instruction: string; agent_id?: string }) =>
  req<Task>('/tasks', json('POST', body))
export const patchTask = (id: string, body: { status?: TaskStatus; agent_id?: string }) =>
  req<Task>(`/tasks/${id}`, json('PATCH', body))

// Approvals
export const listApprovals = (status: 'pending' | 'approved' | 'denied' = 'pending') =>
  req<Approval[]>(`/approvals?status=${status}`)
export const decideApproval = (id: string, decision: 'approved' | 'denied') =>
  req<Approval>(`/approvals/${id}`, json('POST', { decision }))

// Settings (secrets arrive masked; PUT never echoes them)
export type SettingsDoc = Record<string, unknown>
export const getSettings = () => req<SettingsDoc>('/settings')
export const putSettings = (body: SettingsDoc) => req<SettingsDoc>('/settings', json('PUT', body))
export const testProvider = (p: string) => req<{ ok: boolean; detail: string }>(`/settings/test/${p}`, { method: 'POST' })
