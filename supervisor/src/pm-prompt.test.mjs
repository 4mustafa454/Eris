// Parity: the Node renderer must produce exactly what harness/app/pm.py renders, for the same context.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatCurrentState, formatLastTime, loadTemplate, loadTools, renderPrompt } from './pm-prompt.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function python(code, stdin = '') {
  // Isolated interpreter, standard library only: pm.py needs no venv.
  return execFileSync('python3', ['-I', '-X', 'utf8', '-c', code], {
    input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONIOENCODING: 'utf-8' },
  });
}
const PY_PRELUDE = `import sys, json; sys.path.insert(0, ${JSON.stringify(`${REPO}harness`)}); from app import pm`;
const pyRender = ctx => python(`${PY_PRELUDE}\nsys.stdout.write(pm.render_prompt(json.load(sys.stdin)))`, JSON.stringify(ctx));

let hasPython = true;
try { python('print(1)'); } catch { hasPython = false; }
const parity = (name, fn) => test(name, { skip: hasPython ? false : 'python3 not available' }, fn);

const agent = (n, over = {}) => ({
  id: `agent-${n}`, name: `Agent ${n}`, color: '#7F77DD', engine: n === 3 ? 'codex' : 'claude-code',
  state: 'working', task: `Task ${n}`, summary: `Summary ${n}`, stuck_reason: null,
  updated_at: '2026-11-14T19:02:11Z', ...over,
});

const CONTEXTS = {
  empty: { recent_summaries: [], agents: [], open_tasks: [], pending_approvals: [] },
  'no keys at all': {},
  seeded: {
    recent_summaries: [
      { session_id: 's2', channel: 'facetime', summary: 'Agent 3 renamed the package.', ended_at: '2026-11-14T19:30:00Z' },
      { session_id: 's1', channel: 'web', summary: 'Asked for status.', ended_at: '2026-11-13T10:00:00Z' },
    ],
    agents: [agent(1), agent(2), agent(3, { state: 'done' })],
    open_tasks: [{ id: 't1', status: 'working', title: 'Task 1' }],
    pending_approvals: [],
  },
  'stuck agent, approval, queued task, odd detail': {
    recent_summaries: [{ session_id: 's', channel: 'imessage', summary: 'Pushed v2 → done', ended_at: null }],
    agents: [
      agent(1, { state: 'stuck', stuck_reason: 'Which endpoint, v1 or v2?' }),
      agent(2, { task: null, summary: null }),
      agent(3, { task: '', state: 'idle' }),
    ],
    open_tasks: [
      { id: 'q1', status: 'queued', title: 'Add pagination to /orders' },
      { id: 'w1', status: 'working', title: 'not shown' },
    ],
    pending_approvals: [
      { id: 'ap-1', agent_id: 'agent-1', action: 'git_push', detail: 'push main' },
      { id: 'ap-2', agent_id: 'agent-9', action: 'deploy', detail: null },
    ],
  },
  'values with replacement-pattern and template text': {
    recent_summaries: [
      { session_id: 's', channel: 'web', summary: "cost was $& then $1 and $$ and $' and `$`", ended_at: '2026-11-14T00:00:00Z' },
      { session_id: 't', channel: 'web', summary: 'literal {{current_state}} and {{unknown}} stay as written', ended_at: '2026-11-14T00:00:01Z' },
    ],
    agents: [agent(1, { task: 'Fix $& "quotes" and ünïcode ✓', summary: 'line1\nline2' })],
    open_tasks: [], pending_approvals: [],
  },
};

for (const [name, ctx] of Object.entries(CONTEXTS)) {
  parity(`renders byte-identical to harness/app/pm.py: ${name}`, () => {
    assert.equal(renderPrompt(ctx), pyRender(ctx));
  });
}

parity('template and tools match the Python loader', () => {
  assert.equal(loadTemplate(), python(`${PY_PRELUDE}\nsys.stdout.write(pm.load_template())`));
  assert.deepEqual(loadTools(), JSON.parse(python(`${PY_PRELUDE}\nsys.stdout.write(json.dumps(pm.load_tools()))`)));
});

test('the documentation header is stripped and both placeholders are filled', () => {
  const template = loadTemplate();
  assert.ok(template.startsWith('You are Eris'));
  assert.ok(template.includes('{{what_happened_last_time}}') && template.includes('{{current_state}}'));
  const out = renderPrompt(CONTEXTS.seeded);
  assert.ok(!out.includes('{{') && !out.includes('<!--'));
  assert.ok(out.includes('- [facetime, 2026-11-14T19:30:00Z] Agent 3 renamed the package.'));
  assert.ok(out.includes('- Agent 1 (working, claude-code): Task 1. Summary 1.'));
});

test('dollar patterns in values stay literal', () => {
  const out = renderPrompt(CONTEXTS['values with replacement-pattern and template text']);
  assert.ok(out.includes("cost was $& then $1 and $$ and $' and `$`"));
});

test('format helpers handle sparse contexts', () => {
  assert.equal(formatLastTime({}), 'No previous conversations.');
  assert.equal(formatCurrentState({}), 'No agents.');
  assert.equal(formatLastTime({ recent_summaries: [{ channel: 'web', summary: 'x', ended_at: null }] }), '- [web, unknown time] x');
});

test('tools.json has the contract tools', () => {
  assert.deepEqual(loadTools().map(t => t.name), [
    'get_status', 'show_grid', 'focus_agent', 'send_task', 'pause_agent', 'resume_agent',
    'stop_all', 'explain_agent', 'create_task', 'decide_approval', 'search_history',
  ]);
});
