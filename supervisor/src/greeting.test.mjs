import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armGreeting, buildGreeting, FALLBACK_GREETING, isBridgeCaller, resolveGreeting } from './greeting.mjs';

const agent = (n, over = {}) => ({
  id: `agent-${n}`, name: `Agent ${n}`, engine: 'claude-code', state: 'working', task: `Task ${n}`,
  summary: `Summary ${n}`, stuck_reason: null, ...over,
});
const ctx = (agents, extra = {}) => ({ recent_summaries: [], agents, open_tasks: [], pending_approvals: [], ...extra });
const words = text => text.split(/\s+/).filter(Boolean).length;

test('buildGreeting: current state, at most two clauses, rest deferred', () => {
  const text = buildGreeting(ctx([agent(1), agent(2), agent(3, { state: 'done' })]));
  assert.equal(text, `Hi, it's Eris. Agent 1 is working on "Task 1". Agent 2 is working on "Task 2". Ask me for the rest.`);
});

test('buildGreeting: stuck agents come first, with their reason', () => {
  const text = buildGreeting(ctx([agent(1), agent(2, { state: 'stuck', stuck_reason: 'Which endpoint, v1 or v2?' })]));
  assert.equal(text, `Hi, it's Eris. Agent 2 is stuck: Which endpoint, v1 or v2? Agent 1 is working on "Task 1".`);
});

test('buildGreeting: a pending approval is announced, with the agent name and a plain verb', () => {
  const text = buildGreeting(ctx([agent(1, { state: 'done' })], { pending_approvals: [{ id: 'ap-1', agent_id: 'agent-1', action: 'git_push' }] }));
  assert.equal(text, `Hi, it's Eris. Agent 1 wants to push and needs your approval. Agent 1 finished "Task 1".`);
  assert.match(buildGreeting(ctx([agent(1)], { pending_approvals: [{ id: 'x', agent_id: 'agent-1', action: 'deploy_prod' }] })), /wants to deploy prod/);
});

test('buildGreeting: errors count as attention; paused and idle are handled', () => {
  assert.match(buildGreeting(ctx([agent(1), agent(2, { state: 'error' })])), /^Hi, it's Eris\. Agent 2 hit an error\./);
  assert.match(buildGreeting(ctx([agent(1, { state: 'paused' })])), /Agent 1 is paused\.$/);
  assert.equal(buildGreeting(ctx([agent(1, { state: 'idle' })])), "Hi, it's Eris. All agents are idle.");
  assert.equal(buildGreeting(ctx([])), "Hi, it's Eris. No agents are running.");
});

test('buildGreeting: tasks without titles and long stuck reasons are tidy', () => {
  assert.match(buildGreeting(ctx([agent(1, { task: null })])), /Agent 1 is working\.$/);
  const long = 'x '.repeat(100);
  const text = buildGreeting(ctx([agent(1, { state: 'stuck', stuck_reason: `needs the staging database url ${long}` })]));
  assert.ok(text.length < 160, text);
  assert.ok(!/\s\.$/.test(text));
});

test('buildGreeting: no context means the fallback, and recap uses state only (not summaries)', () => {
  assert.equal(buildGreeting(null), FALLBACK_GREETING);
  assert.equal(buildGreeting(undefined), FALLBACK_GREETING);
  const text = buildGreeting(ctx([agent(1)], { recent_summaries: [{ session_id: 's', channel: 'web', summary: 'SECRET-SUMMARY', ended_at: 'x' }] }));
  assert.ok(!text.includes('SECRET-SUMMARY'));
});

test('buildGreeting is short, speakable, and never leaks ids or markup', () => {
  const samples = [
    ctx([agent(1), agent(2), agent(3)]),
    ctx([agent(1, { state: 'stuck', stuck_reason: 'Tests need a database URL I do not have' }), agent(2), agent(3)],
      { pending_approvals: [{ id: 'ap-1', agent_id: 'agent-2', action: 'git_push' }] }),
    ctx([]), null,
  ];
  for (const sample of samples) {
    const text = buildGreeting(sample);
    assert.ok(words(text) <= 40, `too long (${words(text)} words): ${text}`);
    assert.ok(!/agent-\d|ap-\d|[*#`_[\]{}]/.test(text), `unspeakable: ${text}`);
    assert.match(text, /[.?!]$/);
    assert.ok(text.startsWith("Hi, it's Eris."));
  }
});

test('resolveGreeting prefers fresh state, then the cached state, then the fallback', async () => {
  const fresh = ctx([agent(1, { task: 'Fresh task' })]);
  const cached = ctx([agent(1, { task: 'Cached task' })]);
  assert.match(await resolveGreeting({ fetchContext: async () => fresh, cached }), /Fresh task/);
  assert.match(await resolveGreeting({ fetchContext: async () => { throw new Error('down'); }, cached }), /Cached task/);
  assert.equal(await resolveGreeting({ fetchContext: async () => { throw new Error('down'); } }), FALLBACK_GREETING);
});

test('resolveGreeting does not wait for a hung harness', async () => {
  const started = Date.now();
  const text = await resolveGreeting({ fetchContext: () => new Promise(() => {}), cached: ctx([agent(1)]), timeoutMs: 50 });
  assert.ok(Date.now() - started < 1000);
  assert.match(text, /Agent 1 is working/);
});

// --- armGreeting -----------------------------------------------------------------------------------------

function fakeRoom(metadata = '') {
  const listeners = new Map();
  return {
    metadata,
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)).add(fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    count: event => listeners.get(event)?.size ?? 0,
    emitMetadata(value) { this.metadata = value; for (const fn of [...(listeners.get('roomMetadataChanged') ?? [])]) fn(); },
  };
}
const READY = JSON.stringify({ chert_call: 'c1', chert_bridge_ready: true });

function arm(options = {}) {
  let greets = 0;
  const errors = [];
  const room = options.room ?? fakeRoom();
  const stop = armGreeting({
    room, callerIdentity: 'chert-bridge-c1', greet: options.greet ?? (() => { greets += 1; }), onError: e => errors.push(e), ...options.arm,
  });
  return { room, stop, errors, greets: () => greets };
}

test('isBridgeCaller recognizes the Chert Mac bridge participant only', () => {
  assert.equal(isBridgeCaller('chert-bridge-abc123'), true);
  for (const id of ['agent-console-user', 'user', '', undefined, null]) assert.equal(isBridgeCaller(id), false);
});

test('greets once when bridge_ready is already in the room metadata', () => {
  const a = arm({ room: fakeRoom(READY) });
  assert.equal(a.greets(), 1);
});

test('greets once when bridge_ready arrives later, however many metadata updates follow', () => {
  const a = arm();
  assert.equal(a.greets(), 0);
  a.room.emitMetadata('{"chert_call":"c1"}'); // metadata without the signal
  assert.equal(a.greets(), 0);
  a.room.emitMetadata(READY);
  a.room.emitMetadata(READY);
  a.room.emitMetadata(READY);
  assert.equal(a.greets(), 1);
  assert.equal(a.room.count('roomMetadataChanged'), 0); // listener removed after greeting
});

test('never greets on arrival alone: no signal and GREET_ON_JOIN off means silence', () => {
  const a = arm({ arm: { callerIdentity: 'agent-console-user', greetOnJoin: false } });
  assert.equal(a.greets(), 0);
  // the dev fallback is off by default: omitting the option must not greet a non-Chert caller either
  const omitted = arm({ arm: { callerIdentity: 'agent-console-user' } });
  assert.equal(omitted.greets(), 0);
});

test('GREET_ON_JOIN greets a normal (Agent Console) caller immediately, and bridge_ready adds nothing', () => {
  const a = arm({ arm: { callerIdentity: 'agent-console-user', greetOnJoin: true } });
  assert.equal(a.greets(), 1);
  a.room.emitMetadata(READY);
  assert.equal(a.greets(), 1);
});

test('GREET_ON_JOIN is ignored for chert-bridge callers; the real signal still greets once', () => {
  const a = arm({ arm: { callerIdentity: 'chert-bridge-c1', greetOnJoin: true } });
  assert.equal(a.greets(), 0);
  a.room.emitMetadata(READY);
  assert.equal(a.greets(), 1);
});

test('both triggers at once still greet exactly once', () => {
  const a = arm({ room: fakeRoom(READY), arm: { callerIdentity: 'agent-console-user', greetOnJoin: true } });
  assert.equal(a.greets(), 1);
});

test('stop() stops waiting for the signal', () => {
  const a = arm();
  a.stop();
  a.room.emitMetadata(READY);
  assert.equal(a.greets(), 0);
});

test('a greet that throws or rejects is reported, not propagated, and is not retried', async () => {
  let calls = 0;
  const a = arm({ greet: () => { calls += 1; throw new Error('session closed'); } });
  a.room.emitMetadata(READY);
  a.room.emitMetadata(READY);
  assert.equal(calls, 1);
  assert.equal(a.errors.length, 1);

  let rejected = 0;
  const b = arm({ greet: async () => { rejected += 1; throw new Error('tts failed'); } });
  b.room.emitMetadata(READY);
  await new Promise(r => setImmediate(r));
  assert.equal(rejected, 1);
  assert.equal(b.errors.length, 1);
});

test('greets with the most recent stored FaceTime summary and current state', () => {
  const context = ctx([agent(1, 'working')], { recent_summaries: [
    { channel: 'web', summary: 'Web discussion.' },
    { channel: 'facetime', summary: 'Agent 3 renamed the package. Tests passed.' },
  ] });
  const greeting = buildGreeting(context);
  assert.match(greeting, /Last call: Agent 3 renamed the package\./);
  assert.match(greeting, /Agent 1/);
  assert.doesNotMatch(greeting, /Web discussion/);
});
