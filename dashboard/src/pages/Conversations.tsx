import { useCallback, useEffect, useRef, useState } from 'react'
import {
  chat, getSession, HarnessError, search, type ActionRow, type SearchHit, type Session, type SessionDetail,
} from '../lib/harness'
import { useLive } from '../lib/store'
import { Card, Pending, ago, isPending } from '../lib/ui'

const CHANNEL: Record<string, string> = { facetime: 'Call', web: 'Web', imessage: 'Text' }
const NEW = '__new'
const SUGGESTIONS = [
  { t: 'What is everyone working on?', d: 'One line of status for each agent' },
  { t: 'Is anything stuck?', d: 'Blockers, silence, loops and crashes' },
  { t: 'What is agent 2 doing?', d: 'Its task and latest activity' },
]

/** Start a conversation with the PM through POST /chat (§5.2). The harness creates the session and logs both turns. */
function NewChat({ onCreated }: { onCreated: (id: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<{ pending: boolean; detail: string } | null>(null)
  const send = async (t: string) => {
    const body = t.trim()
    if (!body || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await chat(body)
      onCreated(r.session_id)
    } catch (e) {
      setErr({ pending: isPending(e), detail: e instanceof HarnessError ? e.detail : '' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-2xl flex-col justify-center gap-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight">How is the crew doing?</h2>
        <p className="mt-2 text-sm text-muted">Ask what the agents are doing, who is in trouble, or what happened on the last call.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.t}
            disabled={busy}
            onClick={() => void send(s.t)}
            className="rounded-xl border border-line bg-panel p-4 text-left shadow-md shadow-black/20 transition hover:-translate-y-0.5 hover:bg-panel2"
            style={{ borderTop: '2px solid var(--color-gold)' }}
          >
            <span className="block text-sm font-medium">{s.t}</span>
            <span className="mt-1 block text-xs text-muted">{s.d}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text) } }}
          rows={2}
          placeholder="Message the Eris PM. Enter sends, Shift+Enter adds a line."
          aria-label="New chat message"
          className="flex-1 resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm"
        />
        <button onClick={() => void send(text)} disabled={busy || !text.trim()} className="self-end rounded-md bg-gold px-4 py-2 text-sm font-medium text-black">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {err && (err.pending
        ? <Pending what="New chat" route="POST /chat" />
        : <p className="text-sm text-bad" role="alert">{err.detail || 'That did not send. Try again.'}</p>)}
    </div>
  )
}

function SessionList({ items, sel, onSel }: { items: Session[]; sel: string | null; onSel: (id: string) => void }) {
  return (
    <ul className="space-y-1" aria-label="Conversations">
      {items.map((s) => (
        <li key={s.id}>
          <button
            onClick={() => onSel(s.id)}
            aria-current={sel === s.id ? 'true' : undefined}
            className={`w-full rounded-lg px-3 py-2 text-left ${sel === s.id ? 'bg-panel2' : 'hover:bg-panel'}`}
          >
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="rounded border border-line px-1.5">{CHANNEL[s.channel] ?? s.channel}</span>
              <span>{ago(s.started_at)}</span>
            </div>
            <div className="mt-1 truncate text-sm">{s.title ?? 'Untitled'}</div>
            {s.summary && <div className="truncate text-xs text-muted">{s.summary}</div>}
          </button>
        </li>
      ))}
    </ul>
  )
}

function argsOf(a: ActionRow): string {
  try {
    const o = JSON.parse(a.args_json) as Record<string, unknown>
    return Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
  } catch {
    return a.args_json
  }
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<SessionDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [chatState, setChatState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const [chatErr, setChatErr] = useState('')
  const [continuing, setContinuing] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const load = useCallback(() => getSession(id).then(setD).catch(() => setMissing(true)), [id])
  useEffect(() => {
    setD(null); setMissing(false); setContinuing(false); setChatState('idle'); load()
  }, [id, load])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [d?.messages.length])

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true); setChatState('idle')
    try {
      await chat(t, id) // shared PM brain: logs both turns to this session
      setText('')
      await load()
    } catch (e) {
      setChatState(isPending(e) ? 'pending' : 'failed')
      setChatErr(e instanceof HarnessError ? e.detail : '')
    } finally {
      setBusy(false)
    }
  }

  if (missing) return <p className="text-muted">Could not load this conversation.</p>
  if (!d) return <p className="text-muted">Loading…</p>
  return (
    <div className="flex h-full min-h-[60vh] flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{d.title ?? 'Untitled'}</h2>
        <p className="text-xs text-muted">
          {CHANNEL[d.channel] ?? d.channel} · started {ago(d.started_at)}{d.ended_at ? ` · ended ${ago(d.ended_at)}` : ' · open'}
        </p>
      </div>
      {d.summary && (
        <Card><div className="text-xs uppercase tracking-wide text-muted">Summary</div><p className="mt-1 text-sm">{d.summary}</p></Card>
      )}
      <section aria-label="Transcript" className="space-y-3">
        {d.messages.length === 0 && <p className="text-sm text-muted">No messages in this conversation.</p>}
        {d.messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
              m.role === 'user' ? 'bg-panel2' : m.role === 'system' ? 'border border-line text-muted' : 'border border-line bg-panel'}`}>
              {m.text}
            </div>
          </div>
        ))}
      </section>
      {d.actions.length > 0 && (
        <section aria-label="Actions">
          <h3 className="mb-2 text-sm font-medium text-muted">What the PM did</h3>
          <ol className="space-y-1 border-l border-line pl-4 text-sm">
            {d.actions.map((a) => (
              <li key={a.id}><code className="text-gold">{a.tool}</code> <span className="text-muted">{argsOf(a)}</span></li>
            ))}
          </ol>
        </section>
      )}
      <div ref={end} />
      <div className="sticky bottom-0 mt-auto border-t border-line bg-bg pt-3">
        {!continuing ? (
          <button onClick={() => setContinuing(true)} className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-black">
            Continue this conversation
          </button>
        ) : (
          <>
            <div className="flex gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                rows={2}
                placeholder="Type a follow-up. Enter sends, Shift+Enter adds a line."
                aria-label="Follow-up message"
                className="flex-1 resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
              <button onClick={send} disabled={busy || !text.trim()} className="self-end rounded-md bg-gold px-4 py-2 text-sm font-medium text-black">
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
            {chatState === 'pending' && <div className="mt-3"><Pending what="Continue" route="POST /chat" /></div>}
            {chatState === 'failed' && <p className="mt-2 text-sm text-bad" role="alert">{chatErr || 'That did not send. Try again.'}</p>}
          </>
        )}
      </div>
    </div>
  )
}

export default function Conversations() {
  const { sessions } = useLive()
  const [sel, setSel] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searchState, setSearchState] = useState<'idle' | 'pending' | 'failed'>('idle')

  useEffect(() => {
    const t = q.trim()
    if (!t) { setHits(null); setSearchState('idle'); return }
    const h = setTimeout(() => {
      search(t).then((r) => { setHits(r); setSearchState('idle') })
        .catch((e) => { setHits(null); setSearchState(isPending(e) ? 'pending' : 'failed') })
    }, 300)
    return () => clearTimeout(h)
  }, [q])
  useEffect(() => { if (!sel && sessions.length) setSel(sessions[0].id) }, [sessions, sel])

  const byId = new Map(sessions.map((s) => [s.id, s]))
  const shown = hits ? hits.map((h) => byId.get(h.session_id)).filter((s): s is Session => !!s) : sessions
  const snippets = new Map((hits ?? []).map((h) => [h.session_id, h.snippet]))

  return (
    <div className="grid gap-6 md:grid-cols-[300px_1fr]">
      <aside>
        <button
          onClick={() => setSel(NEW)}
          aria-current={sel === NEW ? 'true' : undefined}
          className="mb-3 w-full rounded-lg border border-gold/60 px-3 py-2 text-left text-sm font-medium text-gold hover:bg-gold/10"
        >
          + New chat
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search every call and chat"
          aria-label="Search conversations"
          className="mb-3 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
        />
        {searchState === 'pending' && <div className="mb-3"><Pending what="Search" route="GET /search" /></div>}
        {searchState === 'failed' && <p className="mb-3 text-sm text-bad" role="alert">Search failed.</p>}
        {hits && hits.length === 0 && <p className="mb-3 text-sm text-muted">No matches.</p>}
        <SessionList items={shown} sel={sel} onSel={setSel} />
        {hits && shown.length > 0 && sel && snippets.get(sel) && (
          <p className="mt-3 rounded-md border border-line p-2 text-xs text-muted">…{snippets.get(sel)}…</p>
        )}
        {!sessions.length && <p className="text-sm text-muted">No conversations yet. Call Eris or open a chat.</p>}
      </aside>
      <section>
        {sel === NEW ? <NewChat key="new" onCreated={setSel} /> : sel ? <Detail id={sel} key={sel} /> : <p className="text-muted">Pick a conversation.</p>}
      </section>
    </div>
  )
}
