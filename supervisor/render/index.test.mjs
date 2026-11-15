import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadImage } from '@napi-rs/canvas';
import { THREE } from './fixtures.mjs';
import { startRenderLoop } from './index.mjs';

const quiet = { warn() {}, info() {} };
const fakeHarness = (agents = THREE) => ({
  getAgents: async () => agents,
  getLog: async id => ({ lines: [`log of ${id}`] }),
});

test('serves frame.jpg; setMode changes the next frame; stop closes the server', async () => {
  const loop = await startRenderLoop({ harness: fakeHarness(), port: 0, intervalMs: 50, log: quiet });
  await loop.ready;
  const url = `http://127.0.0.1:${loop.port}/frame.jpg`;
  const grab = async () => Buffer.from(await (await fetch(url)).arrayBuffer());
  try {
    const grid = await grab();
    const img = await loadImage(grid);
    assert.deepEqual([img.width, img.height], [1920, 1080]);
    loop.setMode('focus', 'agent-2');
    const focus = await grab();
    assert.ok(!grid.equals(focus));
    loop.setMode('grid');
    assert.ok((await grab()).equals(grid));
    assert.equal(loop.currentRgba().length, 1920 * 1080 * 4);
    assert.equal(loop.snapshot().agents.length, 3);
  } finally { await loop.stop(); }
  await assert.rejects(fetch(url));
});

test('an unreachable harness still yields a frame, and recovery redraws', async () => {
  let down = true;
  const harness = { getAgents: async () => { if (down) throw new Error('x'); return THREE; }, getLog: async () => ({ lines: [] }) };
  const loop = await startRenderLoop({ harness, serve: false, intervalMs: 20, log: quiet });
  try {
    await loop.ready;
    const unreachable = Uint8Array.from(loop.currentRgba());
    assert.equal(loop.snapshot().harness, 'unreachable');
    down = false;
    await new Promise(r => setTimeout(r, 120));
    assert.equal(loop.snapshot().harness, 'ok');
    assert.notDeepEqual(loop.currentRgba().subarray(0, 200000), unreachable.subarray(0, 200000));
  } finally { await loop.stop(); }
});

test('the same frame instance is returned while nothing changes', async () => {
  const loop = await startRenderLoop({ harness: fakeHarness(), serve: false, intervalMs: 20, log: quiet });
  try {
    await loop.ready;
    const a = loop.currentRgba();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(loop.currentRgba(), a);
  } finally { await loop.stop(); }
});
