// The call flow with fakes for LiveKit, the providers and the harness. No network, no keys.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AutoSubscribe } from '@livekit/agents';
import { handleCall } from './call.mjs';
import { loadTools } from './pm-prompt.mjs';

const CONTEXT = {
  recent_summaries: [],
  agents: [
    { id: 'agent-1', name: 'Agent 1', engine: 'claude-code', state: 'stuck', task: 'Add validation', summary: 'Blocked', stuck_reason: 'v1 or v2?' },
    { id: 'agent-2', name: 'Agent 2', engine: 'claude-code', state: 'working', task: 'Write tests', summary: 'Running pytest', stuck_reason: null },
  ],
  open_tasks: [],
  pending_approvals: [],
};
const READY = JSON.stringify({ chert_call: 'c1', chert_bridge_ready: true });
const silentLog = { info() {}, warn() {}, error() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A LiveKit room that only knows how to carry metadata events. */
function fakeRoom() {
  const listeners = new Map();
  return {
    metadata: '',
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)).add(fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    setMetadata(value) { this.metadata = value; for (const fn of [...(listeners.get('roomMetadataChanged') ?? [])]) fn(); },
  };
}

const order = []; // what happened first: 'video', 'session.start', 'say'
class FakeSession extends EventEmitter {
  constructor(options) { super(); this.options = options; this.said = []; this.closed = 0; FakeSession.last = this; }
  async start(options) { this.startOptions = options; order.push('session.start'); }
  say(text) {
    order.push('say');
    this.said.push(text);
    // the framework adds the spoken text to the chat context and announces it
    queueMicrotask(() => this.item('assistant', text));
  }
  item(role, text, extra = {}) { this.emit('conversation_item_added', { item: { type: 'message', role, textContent: text, ...extra } }); }
  async close() { this.closed += 1; }
}
class FakeAgent { constructor(options) { this.options = options; } }
const fakeVoice = { AgentSession: FakeSession, Agent: FakeAgent };

function fakeHarness({ context = CONTEXT, createFails = false, contextFails = false } = {}) {
  const calls = [];
  return {
    calls,
    createSession: async channel => { calls.push(['createSession', channel]); if (createFails) throw new Error('harness down'); return { id: 'sess-1', channel }; },
    getContext: async () => { calls.push(['getContext']); if (contextFails) throw new Error('harness down'); return typeof context === 'function' ? context() : context; },
    postMessage: async (id, role, text) => { calls.push(['message', id, role, text]); },
    postAction: async (id, action) => { calls.push(['action', id, action.tool]); },
    patchSession: async (id, fields) => { calls.push(['end', id, Object.keys(fields)]); },
    getAgents: async () => CONTEXT.agents,
    getAgent: async id => CONTEXT.agents.find(a => a.id === id),
    getLog: async () => ({ lines: ['x'] }),
  };
}

function fakeCtx(identity = 'agent-console-user') {
  const room = fakeRoom();
  const shutdown = [];
  const connects = [];
  return {
    room, connects, shutdown,
    connect: async (...args) => { connects.push(args); },
    waitForParticipant: async () => ({ identity }),
    addShutdownCallback: fn => shutdown.push(fn),
    runShutdown: async () => { for (const fn of shutdown) await fn(); },
  };
}

async function start({ identity, greetOnJoin = false, harness = fakeHarness(), vad = { vad: true } } = {}) {
  const ctx = fakeCtx(identity);
  const providers = { stt: { name: 'stt' }, tts: { name: 'tts' }, llm: { name: 'llm' } };
  await handleCall(ctx, { config: { greetOnJoin }, harness, createProviders: () => providers, vad, voice: fakeVoice, log: silentLog });
  return { ctx, harness, session: FakeSession.last, providers, vad };
}

test('joins audio-only, waits for the caller, then opens a facetime session and loads context in parallel', async () => {
  const { ctx, harness } = await start();
  assert.deepEqual(ctx.connects, [[undefined, AutoSubscribe.AUDIO_ONLY]]);
  assert.deepEqual(harness.calls.slice(0, 2).map(c => c[0]).sort(), ['createSession', 'getContext']);
  assert.deepEqual(harness.calls.find(c => c[0] === 'createSession'), ['createSession', 'facetime']);
});

test('the session gets the chosen providers, the VAD, and VAD turn detection; audio in and out only', async () => {
  const { session, providers, vad, ctx } = await start({ identity: 'chert-bridge-c1' });
  assert.equal(session.options.stt, providers.stt);
  assert.equal(session.options.tts, providers.tts);
  assert.equal(session.options.llm, providers.llm);
  assert.equal(session.options.vad, vad);
  assert.equal(session.options.turnHandling.turnDetection, 'vad');
  assert.equal(session.options.turnDetection, undefined, 'the deprecated top-level option is not used');
  assert.equal(session.startOptions.room, ctx.room);
  assert.equal(session.startOptions.inputOptions.participantIdentity, 'chert-bridge-c1');
  assert.equal(session.startOptions.inputOptions.videoEnabled, false);
  assert.equal(session.startOptions.record, false);
});

test('the PM agent gets the rendered shared prompt and every tool from tools.json', async () => {
  const { session } = await start();
  const { instructions, tools } = session.startOptions.agent.options;
  assert.ok(instructions.startsWith('You are Eris'));
  assert.ok(instructions.includes('- Agent 1 (stuck, claude-code): Add validation. Blocked. BLOCKED: v1 or v2?'));
  assert.ok(!instructions.includes('{{'));
  assert.deepEqual(Object.keys(tools), loadTools().map(t => t.name));
});

test('silent by default: nothing is spoken on arrival, and nothing before bridge_ready', async () => {
  const { session } = await start({ identity: 'chert-bridge-c1' });
  await tick();
  assert.deepEqual(session.said, []);
});

test('greets once on bridge_ready, with the current state, and logs it once as a pm message', async () => {
  const { ctx, session, harness } = await start({ identity: 'chert-bridge-c1' });
  ctx.room.setMetadata(READY);
  ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.equal(session.said.length, 1);
  assert.equal(session.said[0], `Hi, it's Eris. Agent 1 is stuck: v1 or v2? Agent 2 is working on "Write tests".`);
  await ctx.runShutdown();
  assert.deepEqual(harness.calls.filter(c => c[0] === 'message'), [['message', 'sess-1', 'pm', session.said[0]]]);
});

test('the greeting uses fresh state when the harness answers, not the state from the start of the call', async () => {
  let n = 0;
  const harness = fakeHarness({ context: () => (n++ === 0 ? CONTEXT : { ...CONTEXT, agents: [{ ...CONTEXT.agents[1], task: 'Fresh task' }] }) });
  const { ctx, session } = await start({ identity: 'chert-bridge-c1', harness });
  ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.match(session.said[0], /Fresh task/);
});

test('GREET_ON_JOIN greets an Agent Console caller without the signal; a chert-bridge caller still waits', async () => {
  const console_ = await start({ identity: 'agent-console-user', greetOnJoin: true });
  await tick(); await tick();
  assert.equal(console_.session.said.length, 1);

  const bridge = await start({ identity: 'chert-bridge-c1', greetOnJoin: true });
  await tick(); await tick();
  assert.equal(bridge.session.said.length, 0);
  bridge.ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.equal(bridge.session.said.length, 1);
});

test('transcript: both sides logged in order with roles mapped; non-messages and empty text are skipped', async () => {
  const { ctx, session, harness } = await start();
  session.item('user', 'status?');
  session.item('assistant', 'Agent 2 is writing tests.');
  session.item('assistant', '   ');
  session.item('system', 'internal');
  session.item('developer', 'internal');
  session.emit('conversation_item_added', { item: { type: 'function_call', role: 'assistant', textContent: 'get_status' } });
  session.emit('conversation_item_added', { item: { type: 'agent_handoff' } });
  session.item('user', 'thanks');
  await ctx.runShutdown();
  assert.deepEqual(harness.calls.filter(c => c[0] === 'message').map(c => c.slice(2)), [
    ['user', 'status?'], ['pm', 'Agent 2 is writing tests.'], ['user', 'thanks'],
  ]);
});

test('hangup saves ended_at and a summary once, after the last message', async () => {
  const { ctx, session, harness } = await start();
  session.item('user', 'bye');
  session.emit('close'); // closeOnDisconnect: the caller hung up
  await ctx.runShutdown();
  await ctx.runShutdown(); // a second shutdown must not end it again
  const kinds = harness.calls.map(c => c[0]);
  assert.equal(kinds.filter(k => k === 'end').length, 2);
  assert.ok(kinds.lastIndexOf('message') < kinds.indexOf('end'));
  assert.deepEqual(harness.calls.filter(c => c[0] === 'end'), [['end', 'sess-1', ['ended_at']], ['end', 'sess-1', ['summary']]]);
  assert.ok(session.closed >= 1);
});

test('tool calls reach the harness through the session logger (get_status is logged as an action)', async () => {
  const { ctx, session, harness } = await start();
  await session.startOptions.agent.options.tools.get_status.execute({}, { ctx: {}, toolCallId: 't' });
  await ctx.runShutdown();
  assert.deepEqual(harness.calls.filter(c => c[0] === 'action'), [['action', 'sess-1', 'get_status']]);
});

test('harness down at the start: the call still runs, with a note in the prompt and a fallback greeting', async () => {
  const harness = fakeHarness({ createFails: true, contextFails: true });
  const { ctx, session } = await start({ identity: 'chert-bridge-c1', harness });
  const { instructions } = session.startOptions.agent.options;
  assert.match(instructions, /status could not be loaded/);
  assert.ok(!instructions.includes('{{'));
  ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.equal(session.said[0], "Hi, it's Eris. I can't reach the team right now, but I'm here.");
  session.item('user', 'hello');
  await ctx.runShutdown();
  assert.deepEqual(harness.calls.filter(c => ['message', 'action', 'end'].includes(c[0])), []); // nothing to log to
});

test('session errors are logged by message only and never thrown', async () => {
  const lines = [];
  const ctx = fakeCtx();
  await handleCall(ctx, {
    config: { greetOnJoin: false }, harness: fakeHarness(), createProviders: () => ({ stt: {}, tts: {}, llm: {} }),
    vad: {}, voice: fakeVoice, log: { info() {}, warn() {}, error: line => lines.push(line) },
  });
  FakeSession.last.emit('error', { error: { message: 'deepgram: 402 insufficient credit', apiKey: 'SECRET-KEY' } });
  FakeSession.last.emit('error', {});
  assert.deepEqual(lines, ['[eris] session error: deepgram: 402 insufficient credit', '[eris] session error: unknown']);
  assert.ok(!lines.join().includes('SECRET-KEY'));
});

test('a greeting that cannot be spoken is reported, not thrown', async () => {
  const errors = [];
  const ctx = fakeCtx('chert-bridge-c1');
  await handleCall(ctx, {
    config: { greetOnJoin: false }, harness: fakeHarness(), createProviders: () => ({ stt: {}, tts: {}, llm: {} }),
    vad: {}, voice: fakeVoice, log: { info() {}, warn() {}, error: line => errors.push(line) },
  });
  FakeSession.last.say = () => { throw new Error('tts unavailable'); };
  ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.deepEqual(errors, ['[eris] greeting failed: tts unavailable']);
});

test('interruption tuning from config reaches the session; without it the defaults apply', async () => {
  const run = async config => {
    const ctx = { ...fakeCtx(), };
    await handleCall(ctx, { config, harness: fakeHarness(), createProviders: () => ({ stt: {}, tts: {}, llm: {} }), vad: {}, voice: fakeVoice, log: silentLog });
    return FakeSession.last.options.turnHandling;
  };
  const tuned = await run({ greetOnJoin: false, turn: { minDurationMs: 900, minWords: 2, resumeFalse: false, vadActivationThreshold: 0.7 } });
  assert.deepEqual(tuned.interruption, { minDuration: 900, minWords: 2, resumeFalseInterruption: false });
  assert.equal(tuned.turnDetection, 'vad');
  const defaults = await run({ greetOnJoin: false });
  assert.deepEqual(defaults.interruption, { minDuration: 600, minWords: 1, resumeFalseInterruption: true });
});

/** A fake team video: records mode switches and stop, and "draws" the context's agents. */
function fakeVideo() {
  const v = { modes: [], stops: 0 };
  v.setMode = (...args) => v.modes.push(args);
  v.snapshot = () => ({ agents: CONTEXT.agents });
  v.stop = async () => { v.stops += 1; };
  return v;
}

async function startWithVideo({ startVideo, identity = 'chert-bridge-c1', harness = fakeHarness() } = {}) {
  const ctx = fakeCtx(identity);
  await handleCall(ctx, { config: { greetOnJoin: false }, harness, createProviders: () => ({ stt: {}, tts: {}, llm: {} }), vad: {}, startVideo, voice: fakeVoice, log: silentLog });
  return { ctx, harness, session: FakeSession.last };
}

test('video is published from the agent\'s own room, before the PM starts and before the greeting; the call starts on the grid', async () => {
  order.length = 0;
  const video = fakeVideo();
  const rooms = [];
  const { ctx, session } = await startWithVideo({ startVideo: async room => { rooms.push(room); order.push('video'); return video; } });
  assert.deepEqual(rooms, [ctx.room], 'the same room (and so the same participant) that carries the audio');
  assert.deepEqual(video.modes, [['grid']]);
  ctx.room.setMetadata(READY);
  await tick(); await tick();
  assert.deepEqual(order.slice(-3), ['video', 'session.start', 'say']);
  assert.equal(session.said.length, 1);
});

test('show_grid and focus_agent on the call switch the video and are logged to the session', async () => {
  const video = fakeVideo();
  const { ctx, session, harness } = await startWithVideo({ startVideo: async () => video });
  const { tools } = session.startOptions.agent.options;
  await tools.focus_agent.execute({ n: 2 }, { ctx: {}, toolCallId: 't1' });
  await tools.show_grid.execute({}, { ctx: {}, toolCallId: 't2' });
  const missing = await tools.focus_agent.execute({ n: 9 }, { ctx: {}, toolCallId: 't3' });
  assert.deepEqual(video.modes, [['grid'], ['focus', 'agent-2'], ['grid']]);
  assert.deepEqual(missing, { error: "There's no agent 9." });
  await ctx.runShutdown();
  assert.deepEqual(harness.calls.filter(c => c[0] === 'action'), [
    ['action', 'sess-1', 'focus_agent'], ['action', 'sess-1', 'show_grid'], ['action', 'sess-1', 'focus_agent'],
  ]);
});

test('no video (publish failed or startVideo threw): the call still starts and greets, and the tools say so', async () => {
  for (const startVideo of [async () => null, async () => { throw new Error('boom'); }, undefined]) {
    order.length = 0;
    const { ctx, session } = await startWithVideo({ startVideo });
    ctx.room.setMetadata(READY);
    await tick(); await tick();
    assert.equal(session.said.length, 1, 'greeted');
    const result = await session.startOptions.agent.options.tools.show_grid.execute({}, { ctx: {}, toolCallId: 't' });
    assert.deepEqual(result, { error: "The video isn't available on this call." });
  }
});

test('hangup stops the video once', async () => {
  const video = fakeVideo();
  const { ctx } = await startWithVideo({ startVideo: async () => video });
  await ctx.runShutdown();
  assert.equal(video.stops, 1);
});

test('a video that fails to stop cannot break shutdown', async () => {
  const video = { ...fakeVideo(), stop: async () => { throw new Error('room gone'); } };
  const { ctx, harness } = await startWithVideo({ startVideo: async () => video });
  await ctx.runShutdown();
  assert.equal(harness.calls.filter(c => c[0] === 'end').length, 2, 'the session was ended and summarized');
});

test('hangup summary uses the latest harness snapshot and task history', async () => {
  const harness = fakeHarness();
  const snapshots = [
    { id: 'agent-1', name: 'Agent 1', state: 'done', task: 'Use v2' },
    { id: 'agent-2', name: 'Agent 2', state: 'idle', task: null },
    { id: 'agent-3', name: 'Agent 3', state: 'working', task: 'Billing tests' },
  ];
  harness.getAgents = async () => snapshots;
  harness.getTasks = async () => [{ agent_id: 'agent-2', title: 'Write docs', status: 'done', created_at: '2026-11-15T00:00:00Z' }];
  const patches = [];
  harness.patchSession = async (_id, fields) => patches.push(fields);
  const { ctx, session } = await start({ harness });
  let prompt;
  session.options.llm.chat = ({ chatCtx }) => {
    prompt = chatCtx.items[1].textContent;
    return { collect: async () => ({ text: 'The user selected v2.' }), close() {} };
  };
  session.item('user', 'Use v2');
  await ctx.runShutdown();
  assert.match(prompt, /Agent 1: done; task: Use v2/);
  assert.match(prompt, /Agent 2: idle; task: Write docs/);
  assert.match(prompt, /Agent 3: working; task: Billing tests/);
  const summary = patches.find(p => p.summary)?.summary;
  assert.equal(summary, 'The user selected v2.');
});
