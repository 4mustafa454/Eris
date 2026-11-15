import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from './harness.mjs';
import { loadTools } from './pm-prompt.mjs';
import { agentId, buildTools } from './tools.mjs';

const AGENTS = [
  { id: 'agent-1', name: 'Agent 1', color: '#7F77DD', engine: 'claude-code', state: 'stuck', task: 'Add validation', summary: 'Blocked', stuck_reason: 'v1 or v2?', updated_at: 't' },
  { id: 'agent-2', name: 'Agent 2', color: '#1D9E75', engine: 'claude-code', state: 'working', task: 'Write tests', summary: 'Running pytest', stuck_reason: null, updated_at: 't' },
];

/** A fake video: records mode switches, and knows which agents the renderer last drew. */
function fakeDisplay(agents = AGENTS) {
  const modes = [];
  return { modes, setMode: (...args) => modes.push(args), snapshot: () => ({ agents }) };
}

function setup(overrides = {}, display, sessionId) {
  const calls = [];
  const actions = [];
  const harness = {
    getAgents: async () => { calls.push(['getAgents']); return AGENTS; },
    getAgent: async id => {
      calls.push(['getAgent', id]);
      const a = AGENTS.find(x => x.id === id);
      if (!a) throw new HarnessError(`harness GET /agents/${id} → 404`, { status: 404 });
      return a;
    },
    getLog: async (id, lines) => { calls.push(['getLog', id, lines]); return { lines: ['run pytest → 2 failed', 'edit signup.py'] }; },
    sendTask: async (id, instruction, sessionId) => {
      calls.push(['sendTask', id, instruction, sessionId]);
      const a = AGENTS.find(x => x.id === id);
      if (!a) throw new HarnessError(`harness POST /agents/${id}/task → 404`, { status: 404 });
      return { ...a, state: 'working', stuck_reason: null };
    },
    stopAll: async () => { calls.push(['stopAll']); return AGENTS.map(a => ({ ...a, state: 'paused' })); },
    pauseAgent: async (id, sid) => { calls.push(['pauseAgent', id, sid]); return { ...AGENTS[0], state: 'paused' }; },
    resumeAgent: async (id, sid) => { calls.push(['resumeAgent', id, sid]); return { ...AGENTS[0], state: 'working' }; },
    createTask: async (title, instruction, id, sid) => { calls.push(['createTask', title, instruction, id, sid]); return { title, instruction, agent_id: id, status: 'queued' }; },
    decideApproval: async (id, decision, sid) => { calls.push(['decideApproval', id, decision, sid]); return { id, status: decision }; },
    searchHistory: async query => { calls.push(['searchHistory', query]); return [{ session_id: 'old', snippet: 'v2', created_at: 't' }]; },
    ...overrides,
  };
  const tools = buildTools({ harness, log: { action: a => actions.push(a) }, display, sessionId });
  const run = (name, args) => tools[name].execute(args, { ctx: {}, toolCallId: 't1' });
  return { tools, run, calls, actions };
}

test('agentId accepts positive integers and digit strings only', () => {
  assert.equal(agentId(2), 'agent-2');
  assert.equal(agentId('3'), 'agent-3');
  assert.equal(agentId(12), 'agent-12');
  for (const bad of [0, -1, 1.5, 'x', '', null, undefined, NaN, '2.5', {}]) assert.equal(agentId(bad), null, String(bad));
});

test('one tool per entry in tools.json, with its description and schema', () => {
  const { tools } = setup();
  const defs = loadTools();
  assert.deepEqual(Object.keys(tools), defs.map(d => d.name));
  for (const def of defs) {
    assert.equal(tools[def.name].description, def.description);
    assert.deepEqual(tools[def.name].parameters, def.parameters);
  }
});

test('get_status returns a compact list and logs one action', async () => {
  const { run, actions } = setup();
  const result = await run('get_status', {});
  assert.deepEqual(result.agents.map(a => a.name), ['Agent 1', 'Agent 2']);
  assert.deepEqual(Object.keys(result.agents[0]).sort(), ['name', 'state', 'stuck_reason', 'summary', 'task']);
  assert.equal(result.agents[0].stuck_reason, 'v1 or v2?');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { tool: 'get_status', args: {}, result });
});

test('explain_agent reads the agent and its last 20 log lines, and logs with the agent id', async () => {
  const { run, calls, actions } = setup();
  const result = await run('explain_agent', { n: 2 });
  assert.deepEqual(calls, [['getAgent', 'agent-2'], ['getLog', 'agent-2', 20]]);
  assert.equal(result.agent.name, 'Agent 2');
  assert.deepEqual(result.recent_activity, ['run pytest → 2 failed', 'edit signup.py']);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].tool, 'explain_agent');
  assert.deepEqual(actions[0].args, { n: 2 });
  assert.equal(actions[0].agent_id, 'agent-2');
});

test('explain_agent on an unknown agent says so, without an agent_id on the log', async () => {
  const { run, calls, actions } = setup();
  const result = await run('explain_agent', { n: 7 });
  assert.equal(result.error, "Agent 7 doesn't exist.");
  assert.deepEqual(calls, [['getAgent', 'agent-7']]); // the log is never fetched
  assert.equal(actions.length, 1);
  assert.ok(!('agent_id' in actions[0]));
});

test('explain_agent with a bad agent number never touches the harness', async () => {
  const { run, calls } = setup();
  for (const n of [0, -2, 1.5, 'abc', undefined, null]) {
    const result = await run('explain_agent', { n });
    assert.match(result.error, /not a valid agent number/, String(n));
  }
  assert.deepEqual(calls, []);
});

test('a numeric string agent number is accepted', async () => {
  const { run, calls } = setup();
  await run('explain_agent', { n: '1' });
  assert.deepEqual(calls[0], ['getAgent', 'agent-1']);
});

test('harness down: the tool answers instead of throwing, and still logs once', async () => {
  const down = async () => { throw new HarnessError('harness GET /agents: unreachable'); };
  const { run, actions } = setup({ getAgents: down, getAgent: down });
  assert.deepEqual(await run('get_status', {}), { error: "I can't reach the team right now." });
  assert.deepEqual(await run('explain_agent', { n: 1 }), { error: "I can't reach the team right now." });
  assert.equal(actions.length, 2);
});

test('mutating PM tools pass the session to the harness and are not caller logged', async () => {
  const { run, calls, actions } = setup({}, undefined, 'sess-1');
  assert.equal((await run('pause_agent', { n: 1 })).agent.state, 'paused');
  assert.equal((await run('resume_agent', { n: 1 })).agent.state, 'working');
  assert.equal((await run('create_task', { title: 'Tests', instruction: 'Write tests', agent: 2 })).queued, true);
  assert.equal((await run('decide_approval', { id: 'ap1', decision: 'approved' })).approval.status, 'approved');
  assert.deepEqual(calls, [['pauseAgent', 'agent-1', 'sess-1'], ['resumeAgent', 'agent-1', 'sess-1'],
    ['createTask', 'Tests', 'Write tests', 'agent-2', 'sess-1'], ['decideApproval', 'ap1', 'approved', 'sess-1']]);
  assert.deepEqual(actions, []);
});

test('search_history calls the harness and is logged once by the caller', async () => {
  const { run, calls, actions } = setup();
  assert.equal((await run('search_history', { query: 'v2' })).hits[0].snippet, 'v2');
  assert.deepEqual(calls, [['searchHistory', 'v2']]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].tool, 'search_history');
});

test('show_grid switches the video to the grid and is logged once', async () => {
  const display = fakeDisplay();
  const { run, actions } = setup({}, display);
  const result = await run('show_grid', {});
  assert.deepEqual(display.modes, [['grid']]);
  assert.ok(result.showing);
  assert.deepEqual(actions.map(a => a.tool), ['show_grid']);
  assert.equal(actions[0].agent_id, undefined);
  assert.deepEqual(actions[0].result, result);
});

test('focus_agent switches to that agent, and logs the call with its agent_id', async () => {
  const display = fakeDisplay();
  const { run, actions, calls } = setup({}, display);
  for (const n of [2, '2']) assert.equal((await run('focus_agent', { n })).showing, 'Agent 2, full screen');
  assert.deepEqual(display.modes, [['focus', 'agent-2'], ['focus', 'agent-2']]);
  assert.deepEqual(actions.map(a => [a.tool, a.agent_id, a.args]), [['focus_agent', 'agent-2', { n: 2 }], ['focus_agent', 'agent-2', { n: '2' }]]);
  assert.deepEqual(calls, [], 'the drawn list decided; the harness was not asked');
});

test('focus_agent on an agent that is not there: "There\'s no agent N.", no mode change, logged without an agent_id', async () => {
  const display = fakeDisplay();
  const { run, actions } = setup({}, display);
  for (const n of [9, 0, -1, 'x']) assert.deepEqual(await run('focus_agent', { n }), { error: `There's no agent ${n}.` }, String(n));
  assert.deepEqual(display.modes, []);
  assert.equal(actions.length, 4);
  assert.ok(actions.every(a => a.tool === 'focus_agent' && a.agent_id === undefined && a.result.error));
});

test('focus_agent asks the harness only when nothing has been drawn yet; a 404 there is also "no agent"', async () => {
  const display = fakeDisplay([]);
  const { run, calls } = setup({}, display);
  assert.equal((await run('focus_agent', { n: 1 })).showing, 'Agent 1, full screen');
  assert.deepEqual(await run('focus_agent', { n: 7 }), { error: "There's no agent 7." });
  assert.deepEqual(calls, [['getAgent', 'agent-1'], ['getAgent', 'agent-7']]);
  assert.deepEqual(display.modes, [['focus', 'agent-1']]);
});

test('focus_agent when the harness is down and nothing was drawn gives the "can\'t reach the team" answer', async () => {
  const display = fakeDisplay([]);
  const { run } = setup({ getAgent: async () => { throw new HarnessError('unreachable'); } }, display);
  assert.deepEqual(await run('focus_agent', { n: 1 }), { error: "I can't reach the team right now." });
  assert.deepEqual(display.modes, []);
});

test('without video on this call, show_grid and focus_agent say so and change nothing', async () => {
  const { run, actions } = setup();
  assert.deepEqual(await run('show_grid', {}), { error: "The video isn't available on this call." });
  assert.deepEqual(await run('focus_agent', { n: 1 }), { error: "The video isn't available on this call." });
  assert.equal(actions.length, 2);
});

test('no tool throws, whatever the arguments', async () => {
  const { tools, run } = setup();
  for (const name of Object.keys(tools)) {
    for (const args of [{}, undefined, null, { n: 'x' }, { n: { a: 1 } }]) {
      await assert.doesNotReject(run(name, args), `${name}(${JSON.stringify(args)})`);
    }
  }
});

test('logged results are objects or null, as the actions route requires', async () => {
  const { tools, run, actions } = setup();
  for (const name of Object.keys(tools)) await run(name, { n: 1 });
  for (const a of actions) assert.ok(a.result === null || (typeof a.result === 'object' && !Array.isArray(a.result)), a.tool);
});

test('an implementation missing from tools.json is refused at build time (drift guard)', () => {
  const defs = loadTools().filter(d => d.name !== 'get_status');
  assert.throws(
    () => buildTools({ harness: {}, log: { action() {} }, defs }),
    /implements "get_status", which is not in shared\/pm\/tools\.json/,
  );
});

test('a new tool added to tools.json defaults to "not available yet" and is not logged', async () => {
  const actions = [];
  const extra = { name: 'brand_new', description: 'd', parameters: { type: 'object', properties: {}, additionalProperties: false } };
  const tools = buildTools({ harness: {}, log: { action: a => actions.push(a) }, defs: [...loadTools(), extra] });
  assert.equal(await tools.brand_new.execute({}, { ctx: {}, toolCallId: 't' }), 'not available yet');
  assert.deepEqual(actions, []);
});

// --- send_task and stop_all (M3): mutating tools, logged by the harness route, never by the supervisor ------------

test('send_task sends the instruction with the call\'s session id and is not logged by the supervisor', async () => {
  const { run, calls, actions } = setup({}, undefined, 'sess-1');
  const result = await run('send_task', { n: 1, instruction: '  Use the v2 endpoint  ' });
  assert.deepEqual(calls, [['sendTask', 'agent-1', 'Use the v2 endpoint', 'sess-1']]);
  assert.deepEqual(result, { sent: true, agent: 'Agent 1', state: 'working', task: 'Add validation', instruction: 'Use the v2 endpoint' });
  assert.deepEqual(actions, [], 'the harness route writes the action row (AGENTS.md §5.3)');
});

test('send_task accepts the agent number as a digit string, and works with no session (the harness was down at call start)', async () => {
  const { run, calls } = setup();
  assert.equal((await run('send_task', { n: '2', instruction: 'go' })).sent, true);
  assert.deepEqual(calls, [['sendTask', 'agent-2', 'go', undefined]]);
});

test('send_task to an agent that is not there says so, politely, without calling the harness for a bad number', async () => {
  const { run, calls } = setup();
  assert.deepEqual(await run('send_task', { n: 9, instruction: 'go' }), { error: "There's no agent 9." });
  for (const n of [0, -1, 'x', null]) {
    assert.deepEqual(await run('send_task', { n, instruction: 'go' }), { error: `There's no agent ${n}.` }, String(n));
  }
  assert.deepEqual(calls, [['sendTask', 'agent-9', 'go', undefined]], 'only the well-formed number reached the harness');
});

test('send_task with a blank instruction sends nothing', async () => {
  const { run, calls } = setup();
  for (const instruction of ['', '   ', '\n', undefined, null, 5]) {
    assert.deepEqual(await run('send_task', { n: 1, instruction }), { error: 'There was no instruction to send.' }, String(instruction));
  }
  assert.deepEqual(calls, []);
});

test('send_task: a 422 from the harness is the same blank-instruction answer; a down harness is the usual one', async () => {
  let { run } = setup({ sendTask: async () => { throw new HarnessError('x', { status: 422 }); } });
  assert.deepEqual(await run('send_task', { n: 1, instruction: 'go' }), { error: 'There was no instruction to send.' });
  ({ run } = setup({ sendTask: async () => { throw new HarnessError('unreachable'); } }));
  assert.deepEqual(await run('send_task', { n: 1, instruction: 'go' }), { error: "I can't reach the team right now." });
  ({ run } = setup({ sendTask: async () => { throw new Error('boom'); } }));
  assert.deepEqual(await run('send_task', { n: 1, instruction: 'go' }), { error: "I can't reach the team right now." });
});

test('a long instruction is passed whole to the harness; only the echoed copy for the model is shortened', async () => {
  const { run, calls } = setup();
  const long = 'x'.repeat(500);
  const result = await run('send_task', { n: 1, instruction: long });
  assert.equal(calls[0][2], long);
  assert.equal(result.instruction.length, 120);
});

test('stop_all calls the kill switch and reports every agent, briefly', async () => {
  const { run, calls, actions } = setup();
  const result = await run('stop_all', {});
  assert.deepEqual(calls, [['stopAll']]);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.agents.map(a => [a.name, a.state]), [['Agent 1', 'paused'], ['Agent 2', 'paused']]);
  assert.ok(result.agents.every(a => !('id' in a) && !('color' in a)), 'no ids or colors to read out');
  assert.deepEqual(actions, []);
});

test('stop_all with the harness down says so', async () => {
  const { run } = setup({ stopAll: async () => { throw new HarnessError('unreachable'); } });
  assert.deepEqual(await run('stop_all', {}), { error: "I can't reach the team right now." });
});

test('new tools handle denied and conflicting approvals without caller-side mutation logs', async () => {
  const { run, calls, actions } = setup({}, undefined, 'sess-2');
  assert.equal((await run('decide_approval', { id: 'a2', decision: 'denied' })).approval.status, 'denied');
  assert.deepEqual(calls[0], ['decideApproval', 'a2', 'denied', 'sess-2']);
  assert.deepEqual(actions, []);
  const failed = setup({ decideApproval: async () => { throw new HarnessError('conflict', { status: 409 }); } });
  assert.match((await failed.run('decide_approval', { id: 'a2', decision: 'approved' })).error, /already been decided/);
});
