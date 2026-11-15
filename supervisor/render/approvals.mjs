// Follow approval SSE events, refreshing pending approvals after each reconnect.
export function startApprovalEvents({ harnessUrl, harness, onApprovals, fetchImpl = fetch, retryMs = 1000 }) {
  const abort = new AbortController();
  let stopped = false;
  let approvals = new Map();
  const emit = () => onApprovals([...approvals.values()]);
  const delay = () => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, retryMs);
    abort.signal.addEventListener('abort', finish, { once: true });
  });
  const run = async () => {
    while (!stopped) {
      try {
        const response = await fetchImpl(`${harnessUrl.replace(/\/+$/, '')}/events`, { signal: abort.signal });
        if (!response.ok || !response.body) throw new Error('event stream unavailable');
        if (harness.getApprovals) {
          const pending = await harness.getApprovals();
          if (stopped) break;
          approvals = new Map(pending.filter(a => a.status === 'pending').map(a => [a.id, a]));
          emit();
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = (buffer + value).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            try {
              const parsed = JSON.parse(data);
              const approval = parsed.data;
              if (parsed.type !== 'approval' || !approval?.id) continue;
              if (approval.status === 'pending') approvals.set(approval.id, approval);
              else approvals.delete(approval.id);
              emit();
            } catch { /* malformed events do not affect the call */ }
          }
        }
      } catch { /* reconnect; rendering and audio remain available */ }
      if (!stopped) await delay();
    }
  };
  const done = run();
  return { async stop() { stopped = true; abort.abort(); await done; } };
}
