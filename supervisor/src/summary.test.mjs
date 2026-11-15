import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCall, teamSnapshot } from './summary.mjs';

const messages = [{ role: 'user', text: 'Tell Agent 1 to use v2.' }, { role: 'pm', text: 'Told Agent 1.' }];
const agents = [
  { id: 'agent-1', name: 'Agent 1', state: 'working', task: 'Use v2' },
  { id: 'agent-2', name: 'Agent 2', state: 'idle', task: null },
  { id: 'agent-3', name: 'Agent 3', state: 'done', task: 'Rename eris_core' },
];
const tasks = [
  { agent_id: 'agent-2', title: 'Queued future work', status: 'queued', created_at: '2026-11-15T00:00:00Z' },
  { agent_id: 'agent-2', title: 'Write comprehensive integration tests', status: 'done', created_at: '2026-11-14T00:00:00Z' },
];
const team = teamSnapshot(agents, tasks);
const model = text => ({ chat: () => ({ collect: async () => ({ text }), close() {} }) });

test('the prompt has the snapshot but the stored recap does not append it', async () => {
  let context;
  const provider = { chat: ({ chatCtx }) => { context = chatCtx; return { collect: async () => ({ text: 'You asked Agent 1 to use v2.' }), close() {} }; } };
  const summary = await summarizeCall(provider, messages, [{ tool: 'send_task', args: { n: 1 } }], team);
  for (const expected of ['Agent 1: working; task: Use v2', 'Agent 2: idle; task: Write comprehensive integration tests', 'Agent 3: done; task: Rename eris_core', 'send_task']) {
    assert.ok(context.items[1].textContent.includes(expected), expected);
  }
  assert.equal(summary, 'You asked Agent 1 to use v2.');
});

test('strips headings, echoed snapshot blocks, and filler', async () => {
  const output = '## Summary: Agent 1 chose v2. No other actions were recorded.\nAgent states and tasks:\nAgent 1: working; task: Use v2\nAgent 2: idle; task: Write tests';
  assert.equal(await summarizeCall(model(output), messages, [], team), 'Agent 1 chose v2.');
  const bare = 'Summary: The user chose v2.\nAgent 1: working; task: Use v2\nAgent 2: idle; task: Write tests';
  assert.equal(await summarizeCall(model(bare), messages, [], team), 'The user chose v2.');
  const inline = 'Summary: The user chose v2. Agent 1: working; task: Use v2; Agent 2: idle; task: Write tests';
  assert.equal(await summarizeCall(model(inline), messages, [], team), 'The user chose v2.');
});

test('preserves identifiers and whole task titles', async () => {
  const title = 'Rename eris_core and update all package references';
  const summary = await summarizeCall(model(`**Summary:** Agent 3 finished ${title}.`), messages, [], team);
  assert.equal(summary, `Agent 3 finished ${title}.`);
  assert.equal(team[2].task, 'Rename eris_core');
});

test('limits output at sentence boundaries to three sentences and sixty words', async () => {
  const result = await summarizeCall(model(`First decision. ${'word '.repeat(58)}end. Third decision. Fourth decision.`), messages, [], team);
  assert.equal(result, 'First decision.');
  const three = await summarizeCall(model('One. Two. Three. Four.'), messages, [], team);
  assert.equal(three, 'One. Two. Three.');
  const oversized = await summarizeCall(model(`${'word '.repeat(65)}end.`), messages, [], team);
  assert.equal(oversized, 'The call ended.');
});

test('times out with a factual fallback without a status list', async () => {
  let closed = false;
  const provider = { chat: () => ({ collect: () => new Promise(() => {}), close: () => { closed = true; } }) };
  assert.equal(await summarizeCall(provider, messages, [], team, 10), 'The call ended.');
  assert.ok(closed);
  assert.equal(await summarizeCall(null, [], [], null), 'The call ended.');
  assert.equal(teamSnapshot(agents, null)[1].task, 'task unavailable');
});
