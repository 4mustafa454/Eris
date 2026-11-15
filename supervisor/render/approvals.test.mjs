import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApprovalEvents } from './approvals.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('approval SSE adds pending items, clears decided items, and handles split events', async () => {
  let stream;
  const signals = [];
  const snapshots = [];
  const fetchImpl = async (_url, { signal }) => {
    signals.push(signal);
    return { ok: true, body: new ReadableStream({
      start(controller) { stream = controller; signal.addEventListener('abort', () => controller.close(), { once: true }); },
    }) };
  };
  const listener = startApprovalEvents({ harnessUrl: 'http://h', harness: { getApprovals: async () => [] },
    onApprovals: items => snapshots.push(items), fetchImpl });
  try {
    await tick();
    const encode = new TextEncoder();
    const event = JSON.stringify({ type: 'approval', data: { id: 'ap1', agent_id: 'agent-2', action: 'git_push', status: 'pending' } });
    stream.enqueue(encode.encode(`data: ${event.slice(0, 20)}`));
    stream.enqueue(encode.encode(`${event.slice(20)}\r\n\r\n`));
    await tick(); await tick();
    assert.equal(snapshots.at(-1)[0].id, 'ap1');
    stream.enqueue(encode.encode(`data: ${JSON.stringify({ type: 'approval', data: { id: 'ap1', status: 'approved' } })}\n\n`));
    await tick(); await tick();
    assert.deepEqual(snapshots.at(-1), []);
  } finally { await listener.stop(); }
  assert.ok(signals[0].aborted);
});
