import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, createSessionLogger, HarnessError } from './harness.mjs';

const HARNESS_DIR = fileURLToPath(new URL('../../harness/', import.meta.url));
const UVICORN = join(HARNESS_DIR, '.venv/bin/uvicorn');

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });

describe('against a real harness on a throwaway database', { skip: existsSync(UVICORN) ? false : 'harness venv not set up' }, () => {
  let proc, dir, base, harness;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eris-harness-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(UVICORN, ['app.main:app', '--port', String(port), '--log-level', 'warning'], {
      cwd: HARNESS_DIR,
      // ERIS_ENV_FILE points away from any real harness/.env: a developer's REAL_WORKERS must never reach this test.
      env: { PATH: process.env.PATH, ERIS_DB_PATH: join(dir, 'eris.db'), ERIS_ENV_FILE: join(dir, 'none.env') },
      stdio: 'ignore',
    });
    harness = createHarness({ baseUrl: base });
    for (let i = 0; i < 100; i++) {
      try { await harness.getAgents(); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error('harness did not start');
  });

  after(async () => {
    if (proc) { proc.kill('SIGINT'); await new Promise(r => proc.once('exit', r)); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const detail = async id => (await fetch(`${base}/sessions/${id}`)).json();

  test('agents, one agent, its log, and a 404 for an unknown agent', async () => {
    const agents = await harness.getAgents();
    assert.deepEqual(agents.map(a => a.id), ['agent-1', 'agent-2', 'agent-3']);
    assert.equal((await harness.getAgent('agent-2')).name, 'Agent 2');
    assert.ok((await harness.getLog('agent-1', 3)).lines.length <= 3);
    await assert.rejects(harness.getAgent('agent-9'), err => err instanceof HarnessError && err.status === 404);
  });

  test('five quick messages and an action arrive in order; end sets ended_at', async () => {
    const session = await harness.createSession('facetime');
    const log = createSessionLogger(harness, session.id);
    log.message('pm', 'one');
    log.message('user', 'two');
    log.action({ tool: 'get_status', args: {}, result: { ok: true } });
    log.message('pm', 'three');
    log.message('user', 'four');
    log.message('pm', 'five');
    log.end();
    await log.flush();
    const d = await detail(session.id);
    assert.deepEqual(d.messages.map(m => m.text), ['one', 'two', 'three', 'four', 'five']);
    assert.deepEqual(d.messages.map(m => m.role), ['pm', 'user', 'pm', 'user', 'pm']);
    assert.deepEqual(d.actions.map(a => a.tool), ['get_status']);
    assert.match(d.ended_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test('context carries a summary written to an ended session', async () => {
    const session = await harness.createSession('web');
    await harness.patchSession(session.id, { ended_at: '2026-11-14T19:30:00Z', summary: 'Agent 3 renamed the package.' });
    const ctx = await harness.getContext();
    assert.ok(ctx.recent_summaries.some(s => s.summary === 'Agent 3 renamed the package.'));
    assert.equal(ctx.agents.length, 3);
  });

  test('sendTask steers a working agent (same task), logs one send_task action for the session, and stopAll pauses', async () => {
    const session = await harness.createSession('facetime');
    const before = await harness.getAgent('agent-1');
    const state = await harness.sendTask('agent-1', 'Use the v2 endpoint', session.id);
    assert.equal(state.state, 'working');
    assert.equal(state.task, before.task, 'steering keeps the task');
    const d = await detail(session.id);
    assert.deepEqual(d.actions.map(a => a.tool), ['send_task']);
    assert.deepEqual(JSON.parse(d.actions[0].args_json), { n: 1, instruction: 'Use the v2 endpoint' });
    assert.equal(d.actions[0].agent_id, 'agent-1');
    assert.ok((await harness.getLog('agent-1', 5)).lines.includes('steered: Use the v2 endpoint'));

    const stopped = await harness.stopAll();
    assert.deepEqual(stopped.map(a => a.state), ['paused', 'paused', 'done']);
    const after = await harness.sendTask('agent-1', 'Carry on', session.id);
    assert.equal(after.state, 'working');
    assert.deepEqual((await detail(session.id)).actions.map(a => a.tool), ['send_task', 'send_task']);
  });

  test('sendTask: 404 for an unknown agent, 422 for a blank instruction, and nothing logged for either', async () => {
    const session = await harness.createSession('facetime');
    await assert.rejects(harness.sendTask('agent-9', 'x', session.id), err => err instanceof HarnessError && err.status === 404);
    await assert.rejects(harness.sendTask('agent-1', '   ', session.id), err => err instanceof HarnessError && err.status === 422);
    assert.deepEqual((await detail(session.id)).actions, []);
  });

  test('a mutating tool is rejected by the actions route (log-once rule)', async () => {
    const session = await harness.createSession('facetime');
    await assert.rejects(
      harness.postAction(session.id, { tool: 'send_task', args: {} }),
      err => err.status === 422,
    );
  });
});

describe('failure handling', () => {
  test('an unreachable harness rejects fast with a HarnessError', async () => {
    const port = await freePort(); // nothing listens on it
    const harness = createHarness({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    await assert.rejects(harness.getAgents(), err => err instanceof HarnessError && /unreachable/.test(err.message));
  });

  test('a hung harness times out', async () => {
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const harness = createHarness({ baseUrl: 'http://x', fetchImpl: hang, timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(harness.getContext(), /timed out after 50 ms/);
    assert.ok(Date.now() - started < 1000);
  });

  test('the logger never throws, reports errors, and flush resolves', async () => {
    const port = await freePort();
    const harness = createHarness({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 });
    const errors = [];
    const log = createSessionLogger(harness, 'sid', e => errors.push(e));
    log.message('user', 'hello');
    log.action({ tool: 'get_status', args: {} });
    log.end();
    await log.flush();
    assert.equal(errors.length, 3);
    assert.ok(errors.every(e => e instanceof HarnessError));
  });

  test('a throwing onError cannot break the chain', async () => {
    const calls = [];
    const harness = { postMessage: async (_id, _role, text) => { calls.push(text); if (text === 'a') throw new Error('boom'); } };
    const log = createSessionLogger(harness, 'sid', () => { throw new Error('onError exploded'); });
    log.message('user', 'a');
    log.message('user', 'b');
    await log.flush();
    assert.deepEqual(calls, ['a', 'b']);
  });

  test('without a session id every call is a no-op', async () => {
    const harness = new Proxy({}, { get() { throw new Error('must not be called'); } });
    const log = createSessionLogger(harness, null);
    log.message('user', 'x');
    log.action({ tool: 'get_status', args: {} });
    log.end();
    await log.flush();
  });

  test('order is kept even when an earlier request is slower', async () => {
    const arrived = [];
    const harness = {
      postMessage: async (_id, _role, text) => {
        await new Promise(r => setTimeout(r, text === 'slow' ? 40 : 1));
        arrived.push(text);
      },
    };
    const log = createSessionLogger(harness, 'sid');
    for (const t of ['slow', 'fast1', 'fast2']) log.message('pm', t);
    await log.flush();
    assert.deepEqual(arrived, ['slow', 'fast1', 'fast2']);
  });

  test('flush gives up after its timeout instead of hanging shutdown', async () => {
    const harness = { postMessage: () => new Promise(() => {}) };
    const log = createSessionLogger(harness, 'sid');
    log.message('pm', 'stuck forever');
    const started = Date.now();
    await log.flush(100);
    assert.ok(Date.now() - started < 1000);
  });
});

test('new PM route clients pass the session and encode search and approval IDs', async () => {
  const seen = [];
  const harness = createHarness({ baseUrl: 'http://h', fetchImpl: async (url, options) => {
    seen.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  await harness.pauseAgent('agent-2', 'sid');
  await harness.resumeAgent('agent-2', 'sid');
  await harness.createTask('Tests', 'Write tests', 'agent-2', 'sid');
  await harness.decideApproval('approval one', 'denied', 'sid');
  await harness.searchHistory('v2 endpoint');
  await harness.getApprovals();
  assert.deepEqual(seen.map(x => [x.method, x.url, x.body]), [
    ['POST', 'http://h/agents/agent-2/pause', { session_id: 'sid' }],
    ['POST', 'http://h/agents/agent-2/resume', { session_id: 'sid' }],
    ['POST', 'http://h/tasks', { title: 'Tests', instruction: 'Write tests', agent_id: 'agent-2', session_id: 'sid' }],
    ['POST', 'http://h/approvals/approval%20one', { decision: 'denied', session_id: 'sid' }],
    ['GET', 'http://h/search?q=v2+endpoint', null],
    ['GET', 'http://h/approvals?status=pending', null],
  ]);
});
