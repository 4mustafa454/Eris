import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from './harness.mjs';
import { loadTools } from './pm-prompt.mjs';
import { agentId, buildTools } from './tools.mjs';

const AGENTS = [
  { id: 'agent-1', name: 'Agent 1', color: '#7F77DD', engine: 'claude-code', state: 'stuck', task: 'Add validation', summary: 'Blocked', stuck_reason: 'v1 or v2?', updated_at: 't' },
  { id: 'agent-2', name: 'Agent 2', color: '#1D9E75', engine: 'claude-code', state: 'working', task: 'Write tests', summary: 'Running pytest', stuck_reason: null, updated_at: 't' },
];

function setup(overrides = {}) {
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
    ...overrides,
  };
  const tools = buildTools({ harness, log: { action: a => actions.push(a) } });
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

test('mutating tools answer "not available yet" and log nothing (the harness logs them later)', async () => {
  const { run, calls, actions } = setup();
  for (const name of ['send_task', 'pause_agent', 'resume_agent', 'stop_all', 'create_task', 'decide_approval']) {
    assert.equal(await run(name, { n: 1, instruction: 'x', title: 't', id: 'a', decision: 'approved' }), 'not available yet', name);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(actions, []);
});

test('read-only/display stubs answer "not available yet" and are logged once each', async () => {
  const { run, calls, actions } = setup();
  for (const name of ['show_grid', 'focus_agent', 'search_history']) {
    assert.equal(await run(name, { n: 1, query: 'x' }), 'not available yet', name);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(actions.map(a => a.tool), ['show_grid', 'focus_agent', 'search_history']);
  assert.ok(actions.every(a => a.result.available === false));
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
