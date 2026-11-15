import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { MODELS } from './fixtures.mjs';
import { createRenderer } from './renderer.mjs';

const OUT = fileURLToPath(new URL('./out/test/', import.meta.url)); // gitignored
mkdirSync(OUT, { recursive: true });

const grid = (key = 'three') => ({ mode: 'grid', harness: 'ok', ...MODELS[key] });
const focus = (id, key = 'three') => ({ mode: 'focus', focusId: id, harness: 'ok', ...MODELS[key] });
const unreachable = { harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z', agents: [], logs: {} };
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test('frames are 1920×1080: RGBA buffer, PNG and JPEG', async () => {
  const r = createRenderer();
  assert.equal(r.jpeg(), null);
  const { rgba } = r.render(grid());
  assert.equal(rgba.length, 1920 * 1080 * 4);
  for (const [buf, name] of [[r.png(), 'png'], [r.jpeg(), 'jpeg']]) {
    const img = await loadImage(buf);
    assert.deepEqual([img.width, img.height], [1920, 1080], name);
  }
  assert.deepEqual([...r.jpeg().subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(rgba[3] === 255, 'opaque');
});

test('same model twice: not redrawn, same buffer and JPEG instance', () => {
  const r = createRenderer();
  const a = r.render(grid());
  const j = r.jpeg();
  const b = r.render({ ...grid(), agents: grid().agents.map(x => ({ ...x, updated_at: 'later' })) }); // undrawn field
  assert.equal(b.changed, false);
  assert.equal(b.rgba, a.rgba);
  assert.equal(r.jpeg(), j);
});

test('a changed frame gets a fresh buffer; the previous one is untouched', () => {
  const r = createRenderer();
  const a = r.render(grid());
  const snapshot = Uint8Array.from(a.rgba);
  const b = r.render(focus('agent-2'));
  assert.equal(b.changed, true);
  assert.notEqual(b.rgba.buffer, a.rgba.buffer);
  assert.ok(same(a.rgba, snapshot), 'old frame was modified in place');
});

test('mode switching changes the output, and so does the focused agent', () => {
  const r = createRenderer();
  const g = Uint8Array.from(r.render(grid()).rgba);
  const f2 = Uint8Array.from(r.render(focus('agent-2')).rgba);
  const f1 = Uint8Array.from(r.render(focus('agent-1')).rgba);
  assert.ok(!same(g, f2) && !same(f2, f1) && !same(g, f1));
  const back = r.render(grid()).rgba;
  assert.ok(same(back, g), 'going back to grid reproduces the grid');
});

test('the unreachable frame differs from every normal frame', () => {
  const r = createRenderer();
  const normals = [grid(), focus('agent-1'), focus('agent-3')].map(m => Uint8Array.from(r.render(m).rgba));
  const u = r.render(unreachable);
  assert.equal(u.changed, true);
  for (const n of normals) assert.ok(!same(u.rgba, n));
  writeFileSync(`${OUT}unreachable.png`, r.png());
  assert.equal(r.render(grid()).changed, true, 'recovers');
});

test('render time stays under 30 ms (median of 10 forced redraws)', () => {
  const r = createRenderer({ log: { warn() {} } });
  for (const [name, mk] of [['grid', i => grid('three')], ['focus', i => focus('agent-1')]]) {
    r.render(unreachable); // warm
    const times = [];
    for (let i = 0; i < 10; i++) {
      r.render(unreachable);
      const m = mk(i);
      m.logs = { ...m.logs, 'agent-1': [...m.logs['agent-1'], `tick ${i}`] }; // force a new key
      times.push(r.render(m).ms);
    }
    times.sort((a, b) => a - b);
    const median = times[5];
    console.log(`  ${name} render: median ${median.toFixed(1)} ms, max ${times[9].toFixed(1)} ms`);
    assert.ok(median < 30, `${name} median ${median} ms`);
  }
});

test('writes PNGs for each fixture × mode into render/out/test/', () => {
  const r = createRenderer();
  for (const [name, m] of Object.entries(MODELS)) {
    r.render({ mode: 'grid', harness: 'ok', ...m });
    writeFileSync(`${OUT}${name}-grid.png`, r.png());
    r.render({ mode: 'focus', focusId: m.agents[0].id, harness: 'ok', ...m });
    writeFileSync(`${OUT}${name}-focus.png`, r.png());
  }
});
