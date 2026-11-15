import { useEffect, useState } from 'react'
import { LiveProvider, useLive } from './lib/store'
import Live from './pages/Live'
import Approvals from './pages/Approvals'
import Conversations from './pages/Conversations'

const TABS = [
  { id: 'live', label: 'Live' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'settings', label: 'Settings' },
] as const
type Tab = (typeof TABS)[number]['id']

const fromHash = (): Tab => {
  const h = window.location.hash.replace('#/', '')
  return (TABS.find((t) => t.id === h)?.id ?? 'live') as Tab
}

function Shell() {
  const { online, approvals } = useLive()
  const [tab, setTab] = useState<Tab>(fromHash)
  useEffect(() => {
    const on = () => setTab(fromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const pending = approvals.filter((a) => a.status === 'pending').length
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-bg/90 px-5 py-3 backdrop-blur">
        <a href="#/live" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="size-2.5 rounded-full bg-gold" />
          Eris
        </a>
        <nav className="flex flex-wrap gap-1" aria-label="Dashboard pages">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={`#/${t.id}`}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-panel2 text-fg' : 'text-muted hover:text-fg'}`}
            >
              {t.label}
              {t.id === 'approvals' && pending > 0 && (
                <span className="ml-1.5 rounded-full bg-bad px-1.5 text-xs text-white">{pending}</span>
              )}
            </a>
          ))}
        </nav>
        <span className={`ml-auto flex items-center gap-1.5 text-xs ${online ? 'text-ok' : 'text-bad'}`}>
          <span className={`size-2 rounded-full ${online ? 'bg-ok' : 'bg-bad'}`} />
          {online ? 'harness live' : 'harness offline'}
        </span>
      </header>
      {!online && (
        <div role="alert" className="border-b border-bad/40 bg-bad/10 px-5 py-2 text-sm text-bad">
          Can&apos;t reach the harness. Start it with{' '}
          <code>cd harness &amp;&amp; MOCK_TICK=1 .venv/bin/uvicorn app.main:app --port 8787</code>. This page reconnects by itself.
        </div>
      )}
      <main className="mx-auto w-full max-w-6xl flex-1 p-5">
        {tab === 'live' && <Live />}
        {tab === 'approvals' && <Approvals />}
        {tab === 'conversations' && <Conversations />}
        {tab !== 'live' && tab !== 'approvals' && tab !== 'conversations' && <p className="text-muted">Coming next.</p>}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  )
}
