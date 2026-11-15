import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THREE } from './fixtures.mjs';
import { createPoller } from './poller.mjs';

function setup({ getAgents, getLog } = {}) {
  const models = [];
  const calls = { agents: 0, logs: [] };
  const harness = {
    getAgents: async () => { calls.agents++; return getAgents ? getAgents() : THREE; },
    getLog: async (id, lines) => { calls.logs.push([id, lines]); return getLog ? getLog(id) : { lines: [`log of ${id}`] }; },
  };
  const poller = createPoller({ harness, harnessUrl: 'http://h', onModel: m => models.push(m), now: () => 'T' });
  return { poller, models, calls };
}

test('a tick fetches agents and logs and emits a grid model', async () => {
  const { poller, models, calls } = setup();
  await poller.tick();
  assert.equal(models.length, 1);
  const m = models[0];
  assert.equal(m.harness, 'ok');
  assert.equal(m.mode, 'grid');
  assert.equal(m.agents.length, 3);
  assert.deepEqual(m.logs['agent-2'], ['log of agent-2']);
  assert.equal(m.lastSeen, 'T');
  assert.deepEqual(calls.logs.map(c => c[1]), [40, 40, 40]);
});

test('a throwing /agents gives an unreachable model, keeps the last data, and recovers', async () => {
  let down = false;
  const { poller, models } = setup({ getAgents: () => { if (down) throw new Error('boom'); return THREE; } });
  await poller.tick();
  down = true;
  await poller.tick();
  assert.equal(models[1].harness, 'unreachable');
  assert.equal(models[1].lastSeen, 'T');
  assert.equal(models[1].agents.length, 3);
  down = false;
  await poller.tick();
  assert.equal(models[2].harness, 'ok');
});

test('unreachable from the very first poll has no lastSeen', async () => {
  const { poller, models } = setup({ getAgents: () => { throw new Error('down'); } });
  await poller.tick();
  assert.equal(models[0].harness, 'unreachable');
  assert.equal(models[0].lastSeen, null);
});

test("a /log failure blanks only that agent's lines", async () => {
  const { poller, models } = setup({ getLog: id => { if (id === 'agent-2') throw new Error('x'); return { lines: ['ok'] }; } });
  await poller.tick();
  assert.equal(models[0].harness, 'ok');
  assert.deepEqual(models[0].logs, { 'agent-1': ['ok'], 'agent-2': [], 'agent-3': ['ok'] });
});

test('setMode re-emits at once without polling; unknown input falls back to grid', async () => {
  const { poller, models, calls } = setup();
  await poller.tick();
  poller.setMode('focus', 'agent-2');
  assert.equal(models.length, 2);
  assert.equal(models[1].mode, 'focus');
  assert.equal(models[1].focusId, 'agent-2');
  assert.equal(calls.agents, 1);
  poller.setMode('focus'); // no id
  assert.equal(models[2].mode, 'grid');
  poller.setMode('grid');
  assert.equal(models[3].focusId, null);
});

test('a tick is skipped while the previous one is still running', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { poller, models, calls } = setup({ getAgents: () => gate.then(() => THREE) });
  const first = poller.tick();
  await poller.tick(); // returns immediately
  assert.equal(calls.agents, 1);
  release();
  await first;
  assert.equal(models.length, 1);
});

test('a throwing consumer does not stop polling', async () => {
  const harness = { getAgents: async () => THREE, getLog: async () => ({ lines: [] }) };
  const poller = createPoller({ harness, onModel: () => { throw new Error('consumer'); } });
  await poller.tick();
  await poller.tick();
});

test('start polls on the interval and stop clears the timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { poller, calls } = setup();
  poller.start();
  poller.start(); // idempotent
  await new Promise(r => setImmediate(r));
  const afterStart = calls.agents;
  assert.equal(afterStart, 1);
  t.mock.timers.tick(500);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.agents, 2);
  poller.stop();
  t.mock.timers.tick(5000);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.agents, 2);
});
