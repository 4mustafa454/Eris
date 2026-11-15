// HTTP client for the harness (AGENTS.md §5.2) and the per-session logger (§5.4).
//
// The client throws on failure. The session logger never does: a harness outage must not break the
// voice pipeline, so logging errors are reported through onError and the call carries on.

const SLOW_MS = 20000;

export class HarnessError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'HarnessError';
    this.status = status;
  }
}

/**
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createHarness({ baseUrl, fetchImpl = fetch, timeoutMs = 3000 }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body, timeout = timeoutMs) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (cause) {
      const reason = cause?.name === 'TimeoutError' ? `timed out after ${timeout} ms` : 'unreachable';
      throw new HarnessError(`harness ${method} ${path}: ${reason}`, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HarnessError(`harness ${method} ${path} → ${response.status}`, { status: response.status });
    }
    return response.json();
  }

  return {
    getAgents: () => request('GET', '/agents'),
    getAgent: id => request('GET', `/agents/${encodeURIComponent(id)}`),
    getLog: (id, lines = 40) => request('GET', `/agents/${encodeURIComponent(id)}/log?lines=${lines}`),
    getContext: () => request('GET', '/context'),
    // Steering a running worker interrupts it first, and stop-all waits for the interrupt: both can take over 5 s.
    sendTask: (id, instruction, sessionId) =>
      request('POST', `/agents/${encodeURIComponent(id)}/task`, { instruction, ...(sessionId ? { session_id: sessionId } : {}) }, SLOW_MS),
    stopAll: () => request('POST', '/stop-all', undefined, SLOW_MS),
    createSession: channel => request('POST', '/sessions', { channel }),
    patchSession: (id, fields) => request('PATCH', `/sessions/${encodeURIComponent(id)}`, fields),
    postMessage: (id, role, text) => request('POST', `/sessions/${encodeURIComponent(id)}/messages`, { role, text }),
    postAction: (id, { tool, args, result = null, agent_id }) =>
      request('POST', `/sessions/${encodeURIComponent(id)}/actions`, {
        tool, args, result, ...(agent_id ? { agent_id } : {}),
      }),
  };
}

/** ISO-8601 UTC without milliseconds, the format the harness stores. */
export const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Logs one session's turns, in order, without ever throwing. Every call is queued on a single promise
 * chain, so messages and actions reach the harness in the order they were logged even though the
 * callers do not wait. With no session id (the harness was down at the start) everything is a no-op.
 *
 * @param {ReturnType<typeof createHarness>} harness
 * @param {string | null | undefined} sessionId
 * @param {(error: Error) => void} [onError]
 */
export function createSessionLogger(harness, sessionId, onError = () => {}) {
  let chain = Promise.resolve();
  const enqueue = work => {
    if (!sessionId) return;
    chain = chain.then(work).catch(error => { try { onError(error); } catch { /* logging must not throw */ } });
  };
  return {
    sessionId,
    message: (role, text) => enqueue(() => harness.postMessage(sessionId, role, text)),
    action: action => enqueue(() => harness.postAction(sessionId, action)),
    /** Marks the session ended (hangup). Summaries are M4; this only sets ended_at. */
    end: () => enqueue(() => harness.patchSession(sessionId, { ended_at: utcNow() })),
    /** Resolves when everything queued so far has been sent, or after timeoutMs, whichever is first. */
    flush: (timeoutMs = 5000) => {
      const wait = new Promise(resolve => setTimeout(resolve, timeoutMs).unref());
      return Promise.race([chain, wait]);
    },
  };
}
