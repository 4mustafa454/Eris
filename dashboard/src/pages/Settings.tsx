import { useEffect, useState } from 'react'
import { getSettings, putSettings, testProvider, type SettingsDoc } from '../lib/harness'
import { Card, Pending, isPending } from '../lib/ui'

/** Providers by role, with the §5.2 /settings/test/{provider} names. */
const ROLES: { role: string; note: string; providers: { id: string; label: string }[] }[] = [
  { role: 'Speech to text', note: 'Hears the caller', providers: [{ id: 'deepgram', label: 'Deepgram' }] },
  { role: 'PM brain', note: 'The model Eris thinks with', providers: [{ id: 'openai', label: 'OpenAI' }, { id: 'ollama', label: 'Ollama (local)' }] },
  { role: 'Worker engines', note: 'What the agents run on', providers: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] },
  { role: 'Alerts', note: 'How Eris reaches you when an agent is stuck', providers: [{ id: 'ntfy', label: 'ntfy' }] },
  { role: 'Call line', note: 'FaceTime and the room it runs in', providers: [{ id: 'chert', label: 'Chert line' }, { id: 'livekit', label: 'LiveKit' }] },
]

type Result = { state: 'busy' } | { state: 'ok' | 'bad'; detail: string } | { state: 'pending' }

/** A secret arrives masked (`sk-…a1b2`) with `set: true|false`. Typing a new value replaces it; it is never echoed back. */
const isSecret = (v: unknown): v is { set: boolean; value?: string } =>
  typeof v === 'object' && v !== null && 'set' in (v as object)

function Field({ k, v, onSave }: { k: string; v: unknown; onSave: (k: string, val: string) => Promise<void> }) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const secret = isSecret(v)
  const shown = secret ? (v.set ? (v.value ?? 'set') : 'not set') : String(v ?? '')
  return (
    <form
      className="grid items-center gap-2 py-2 sm:grid-cols-[220px_1fr_auto]"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!val) return
        setBusy(true)
        await onSave(k, val).finally(() => setBusy(false))
        setVal('')
      }}
    >
      <label htmlFor={`f-${k}`} className="font-mono text-xs text-muted">{k}</label>
      <input
        id={`f-${k}`} value={val} onChange={(e) => setVal(e.target.value)} type={secret ? 'password' : 'text'}
        autoComplete="off" placeholder={shown}
        className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm"
      />
      <button disabled={busy || !val} className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-black">Save</button>
    </form>
  )
}

export default function Settings() {
  const [doc, setDoc] = useState<SettingsDoc | null>(null)
  const [missing, setMissing] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<Record<string, Result>>({})

  useEffect(() => {
    getSettings().then(setDoc).catch((e) => (isPending(e) ? setMissing(true) : setErr('Could not load settings.')))
  }, [])

  const save = async (k: string, val: string) => {
    setErr('')
    try { setDoc(await putSettings({ [k]: val })) } catch (e) { setErr(isPending(e) ? 'PUT /settings is not served yet.' : 'Save failed.') }
  }
  const test = async (id: string) => {
    setRes((r) => ({ ...r, [id]: { state: 'busy' } }))
    try {
      const out = await testProvider(id)
      setRes((r) => ({ ...r, [id]: { state: out.ok ? 'ok' : 'bad', detail: out.detail } }))
    } catch (e) {
      setRes((r) => ({ ...r, [id]: isPending(e) ? { state: 'pending' } : { state: 'bad', detail: 'Test failed to run.' } }))
    }
  }

  const entries = doc ? Object.entries(doc).filter(([, v]) => typeof v !== 'object' || isSecret(v)) : []
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted">Keys are masked here and written to the harness&apos;s own .env. They are never shown again.</p>
      </div>
      {missing && <Pending what="Reading and saving settings" route="GET/PUT /settings" />}
      {err && <p className="text-sm text-bad" role="alert">{err}</p>}

      <section className="space-y-3" aria-label="Providers">
        {ROLES.map((r) => (
          <Card key={r.role}>
            <div className="mb-2"><span className="font-medium">{r.role}</span> <span className="text-sm text-muted">· {r.note}</span></div>
            <ul className="divide-y divide-line">
              {r.providers.map((p) => {
                const x = res[p.id]
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="w-40">{p.label}</span>
                    <button onClick={() => test(p.id)} disabled={x?.state === 'busy'} className="rounded-md border border-line px-3 py-1 text-xs">
                      {x?.state === 'busy' ? 'Testing…' : 'Test'}
                    </button>
                    {x?.state === 'ok' && <span className="text-ok">OK · {x.detail}</span>}
                    {x?.state === 'bad' && <span className="text-bad">Failed · {x.detail}</span>}
                    {x?.state === 'pending' && <span className="text-warn">Backend pending: POST /settings/test/{p.id}</span>}
                  </li>
                )
              })}
            </ul>
          </Card>
        ))}
      </section>

      {entries.length > 0 && (
        <Card>
          <h3 className="mb-1 font-medium">Configuration</h3>
          <div className="divide-y divide-line">
            {entries.map(([k, v]) => <Field key={k} k={k} v={v} onSave={save} />)}
          </div>
        </Card>
      )}
    </div>
  )
}
