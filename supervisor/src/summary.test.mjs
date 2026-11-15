import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCall } from './summary.mjs';

const messages = [{ role: 'user', text: 'Tell Agent 1 to use v2.' }, { role: 'pm', text: 'Told Agent 1.' }];

test('uses the configured model to summarize transcript and actions', async () => {
  let context, closed = false;
  const model = { chat: ({ chatCtx }) => {
    context = chatCtx;
    return { collect: async () => ({ text: 'Agent 1 was told to use v2. Work is in progress.' }), close: () => { closed = true; } };
  } };
  const summary = await summarizeCall(model, messages, [{ tool: 'send_task', args: { n: 1 } }]);
  assert.match(summary, /Agent 1/);
  assert.match(context.items[1].textContent, /send_task/);
  assert.ok(closed);
});

test('times out and uses a factual fallback', async () => {
  let closed = false;
  const model = { chat: () => ({ collect: () => new Promise(() => {}), close: () => { closed = true; } }) };
  const summary = await summarizeCall(model, messages, [], 10);
  assert.match(summary, /1 user messages/);
  assert.ok(closed);
});
