import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCall, teamSnapshot } from './summary.mjs';

const messages = [{ role: 'user', text: 'Tell Agent 1 to use v2.' }, { role: 'pm', text: 'Told Agent 1.' }];
const agents = [
  { id: 'agent-1', name: 'Agent 1', state: 'working', task: 'Use v2' },
  { id: 'agent-2', name: 'Agent 2', state: 'idle', task: null },
  { id: 'agent-3', name: 'Agent 3', state: 'done', task: 'Rename package' },
];
const tasks = [
  { agent_id: 'agent-2', title: 'Queued future work', status: 'queued', created_at: '2026-11-15T00:00:00Z' },
  { agent_id: 'agent-2', title: 'Write tests', status: 'done', created_at: '2026-11-14T00:00:00Z' },
];
const team = teamSnapshot(agents, tasks);

test('prompt includes every current state and last task and result preserves them', async () => {
  let context, closed = false;
  const model = { chat: ({ chatCtx }) => {
    context = chatCtx;
    return { collect: async () => ({ text: 'You asked Agent 1 to use v2. No other actions were recorded.' }), close: () => { closed = true; } };
  } };
  const summary = await summarizeCall(model, messages, [{ tool: 'send_task', args: { n: 1 } }], team);
  assert.match(context.items[0].textContent, /must be requested/);
  for (const expected of ['Agent 1: working; task: Use v2', 'Agent 2: idle; task: Write tests', 'Agent 3: done; task: Rename package', 'send_task']) {
    assert.ok(context.items[1].textContent.includes(expected), expected);
  }
  assert.match(summary, /Agent 1 is working on Use v2/);
  assert.match(summary, /Agent 2 is idle, last task Write tests/);
  assert.match(summary, /Agent 3 is done with Rename package/);
  assert.doesNotMatch(summary, /No other actions were recorded|must be requested/i);
  assert.equal(summary.split(/(?<=[.!?])\s+/).length, 2);
  assert.ok(closed);
});

test('removes filler and caps model output to two sentences', async () => {
  const model = { chat: () => ({ collect: async () => ({ text: 'Changes must be requested. The user picked v2. Tests are next. A fourth sentence.' }), close() {} }) };
  const summary = await summarizeCall(model, messages, [], team);
  assert.doesNotMatch(summary, /must be requested|fourth sentence/i);
  assert.equal(summary.split(/(?<=[.!?])\s+/).length, 3);
});

test('timeout and missing snapshots produce honest spoken fallbacks', async () => {
  let closed = false;
  const model = { chat: () => ({ collect: () => new Promise(() => {}), close: () => { closed = true; } }) };
  const summary = await summarizeCall(model, messages, [], team, 10);
  assert.match(summary, /Agent 2 is idle, last task Write tests/);
  assert.ok(closed);
  assert.equal(await summarizeCall(null, [], [], null), 'The call ended. The team status is unavailable.');
  assert.equal(teamSnapshot(agents, null)[1].task, 'task unavailable');
});
