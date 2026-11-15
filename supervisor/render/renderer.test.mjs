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

test('a 1280×720 renderer scales the same layout: right size, stripe where it should be, fits the budget', async () => {
  const r = createRenderer({ width: 1280, height: 720, log: { warn() {} } });
  const { rgba } = r.render(grid());
  assert.equal(rgba.length, 1280 * 720 * 4);
  const img = await loadImage(r.png());
  assert.deepEqual([img.width, img.height], [1280, 720]);
  const jpg = await loadImage(r.jpeg());
  assert.deepEqual([jpg.width, jpg.height], [1280, 720]);
  // Agent 1's colour stripe (#7F77DD) runs x 40..48 at 1080p, so about x 27..32 at 720p
  const at = (x, y) => [...rgba.subarray((y * 1280 + x) * 4, (y * 1280 + x) * 4 + 3)];
  assert.deepEqual(at(29, 300), [0x7f, 0x77, 0xdd]);
  assert.notDeepEqual(at(40, 300), [0x7f, 0x77, 0xdd]);
  writeFileSync(`${OUT}three-grid-720p.png`, r.png());
  const f = r.render(focus('agent-1'));
  assert.ok(f.changed && f.ms < 30, `720p focus ${f.ms} ms`);
});

// --- portrait ---------------------------------------------------------------------------------------------------

const pixel = (rgba, w, x, y) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];

test('portrait 1080×1920: buffer, PNG and JPEG sizes; the three tiles stack with the agent colours down the left edge', async () => {
  const r = createRenderer({ width: 1080, height: 1920, log: { warn() {} } });
  const { rgba } = r.render(grid());
  assert.equal(rgba.length, 1080 * 1920 * 4);
  for (const [buf, name] of [[r.png(), 'png'], [r.jpeg(), 'jpeg']]) {
    const img = await loadImage(buf);
    assert.deepEqual([img.width, img.height], [1080, 1920], name);
  }
  // safe area 120..1660 and 110 each side: tiles are 497 high with a 24 gap, stripes (x 110..118) at
  // y 120..617, 641..1138, 1162..1659
  assert.deepEqual(pixel(rgba, 1080, 114, 300), [0x7f, 0x77, 0xdd], 'Agent 1');
  assert.deepEqual(pixel(rgba, 1080, 114, 900), [0x1d, 0x9e, 0x75], 'Agent 2');
  assert.deepEqual(pixel(rgba, 1080, 114, 1500), [0xd8, 0x5a, 0x30], 'Agent 3');
  assert.deepEqual(pixel(rgba, 1080, 114, 629), [0x11, 0x14, 0x18], 'background in the gap between tiles');
  assert.deepEqual(pixel(rgba, 1080, 44, 300), [0x11, 0x14, 0x18], 'nothing in the side band where the stripe used to be');
  writeFileSync(`${OUT}three-grid-portrait.png`, r.png());
});

test('portrait 720×1280 is the same picture scaled by 2/3', async () => {
  const r = createRenderer({ width: 720, height: 1280, log: { warn() {} } });
  const { rgba } = r.render(grid());
  assert.equal(rgba.length, 720 * 1280 * 4);
  const img = await loadImage(r.png());
  assert.deepEqual([img.width, img.height], [720, 1280]);
  // the stripe is at x 110..118 at 1080 scale: about 73..79 here
  assert.deepEqual(pixel(rgba, 720, 76, 200), [0x7f, 0x77, 0xdd], 'Agent 1 stripe');
  assert.deepEqual(pixel(rgba, 720, 76, 600), [0x1d, 0x9e, 0x75], 'Agent 2 stripe');
  assert.deepEqual(pixel(rgba, 720, 76, 1000), [0xd8, 0x5a, 0x30], 'Agent 3 stripe');
  assert.deepEqual(pixel(rgba, 720, 29, 200), [0x11, 0x14, 0x18], 'nothing in the side band');
  writeFileSync(`${OUT}three-grid-portrait-720.png`, r.png());
});

test('portrait: mode switching and focus change the output; the unreachable frame differs; each is saved as a PNG', () => {
  const r = createRenderer({ width: 1080, height: 1920, log: { warn() {} } });
  const g = Uint8Array.from(r.render(grid()).rgba);
  const f1 = Uint8Array.from(r.render(focus('agent-1')).rgba);
  writeFileSync(`${OUT}three-focus-portrait.png`, r.png());
  const f2 = Uint8Array.from(r.render(focus('agent-2')).rgba);
  assert.ok(!same(g, f1) && !same(f1, f2) && !same(g, f2));
  const u = r.render(unreachable);
  assert.ok(!same(u.rgba, g) && !same(u.rgba, f1));
  writeFileSync(`${OUT}unreachable-portrait.png`, r.png());
  assert.ok(same(r.render(grid()).rgba, g), 'back to the grid reproduces it');
  for (const [name, m] of Object.entries(MODELS)) {
    r.render({ mode: 'grid', harness: 'ok', ...m });
    writeFileSync(`${OUT}${name}-grid-portrait.png`, r.png());
    r.render({ mode: 'focus', focusId: m.agents[0].id, harness: 'ok', ...m });
    writeFileSync(`${OUT}${name}-focus-portrait.png`, r.png());
  }
});

test('portrait render time stays under 30 ms (median of 10 forced redraws)', () => {
  const r = createRenderer({ width: 1080, height: 1920, log: { warn() {} } });
  for (const [name, mk] of [['grid', () => grid('three')], ['focus', () => focus('agent-1')]]) {
    const times = [];
    for (let i = 0; i < 10; i++) {
      r.render(unreachable);
      const m = mk();
      m.logs = { ...m.logs, 'agent-1': [...m.logs['agent-1'], `tick ${i}`] };
      times.push(r.render(m).ms);
    }
    times.sort((a, b) => a - b);
    console.log(`  portrait ${name} render: median ${times[5].toFixed(1)} ms, max ${times[9].toFixed(1)} ms`);
    assert.ok(times[5] < 30, `${name} median ${times[5]} ms`);
  }
});

// --- portrait safe area, checked on real pixels ------------------------------------------------------------------

const BG = [0x11, 0x14, 0x18];

/**
 * Rows [top, bottom) may hold content; every other row must be pure background edge to edge. In ALL rows, columns
 * left of `left` and from `right` on must be background too (the side bands).
 */
function assertBands(rgba, w, h, { top, bottom, left, right }, label) {
  const isBg = i => rgba[i] === BG[0] && rgba[i + 1] === BG[1] && rgba[i + 2] === BG[2];
  for (let y = 0; y < h; y++) {
    const inBand = y < top || y >= bottom;
    for (let x = 0; x < w; x++) {
      if (!inBand && x >= left && x < right) continue;
      if (!isBg((y * w + x) * 4)) assert.fail(`${label}: pixel (${x}, ${y}) is not background, inside a safe-area band`);
    }
  }
}

for (const [w, h] of [[1080, 1920], [720, 1280]]) {
  test(`portrait ${w}×${h}: the top 120, bottom 260 and sides 110 (1080p scale) are empty background in every grid and focus frame`, () => {
    const scale = w / 1080;
    // rows [top, bottom) may hold content; every other row is checked. One pixel of slack at each edge of the
    // safe area for anti-aliasing, so the first and last allowed rows are not asserted on.
    const bands = {
      top: Math.floor(120 * scale) - 1,
      bottom: Math.ceil((1920 - 260) * scale) + 1,
      left: Math.floor(110 * scale) - 1,
      right: Math.ceil((1080 - 110) * scale) + 1,
    };
    const r = createRenderer({ width: w, height: h, log: { warn() {} } });
    for (const [name, m] of Object.entries(MODELS)) {
      r.render({ mode: 'grid', harness: 'ok', ...m });
      assertBands(r.render({ mode: 'grid', harness: 'ok', ...m }).rgba, w, h, bands, `${name} grid`);
      for (const a of m.agents) {
        assertBands(r.render({ mode: 'focus', focusId: a.id, harness: 'ok', ...m }).rgba, w, h, bands, `${name} focus ${a.id}`);
      }
    }
  });
}

test('a custom safe area reaches the pixels, and the content really does use the space inside it', () => {
  const r = createRenderer({ width: 1080, height: 1920, safe: { top: 300, bottom: 100, side: 200 }, log: { warn() {} } });
  const { rgba } = r.render(grid());
  assertBands(rgba, 1080, 1920, { top: 300 - 1, bottom: 1920 - 100 + 1, left: 200 - 1, right: 1080 - 200 + 1 }, 'custom');
  assert.deepEqual(pixel(rgba, 1080, 204, 400), [0x7f, 0x77, 0xdd], 'tile 1 starts at the new top and side');
  assert.notDeepEqual(pixel(rgba, 1080, 114, 400), [0x7f, 0x77, 0xdd]);
  assert.notDeepEqual(pixel(rgba, 1080, 204, 250), [0x7f, 0x77, 0xdd]);
  const wide = createRenderer({ width: 1080, height: 1920, safe: { top: 0, bottom: 0, side: 0 }, log: { warn() {} } });
  const w = wide.render(grid()).rgba;
  assert.deepEqual(pixel(w, 1080, 44, 300), [0x7f, 0x77, 0xdd], 'zero insets: the stripe is back at the 40 px margin');
});

test('safe-area samples: portrait frames are written for inspection', () => {
  const r = createRenderer({ width: 1080, height: 1920, log: { warn() {} } });
  r.render(grid('long'));
  writeFileSync(`${OUT}long-grid-portrait-safe.png`, r.png());
});

test('renders and saves portrait samples for one, three, and six agents with an approval', () => {
  const renderer = createRenderer({ width: 1080, height: 1920, log: { warn() {} } });
  for (const [name, model] of [
    ['one', MODELS.one],
    ['three', MODELS.three],
    ['six-approval', { ...MODELS['six-states'], approvals: [{ id: 'ap1', agent_id: 'agent-2', action: 'git_push', status: 'pending' }] }],
  ]) {
    const frame = renderer.render({ ...model, mode: 'grid', harness: 'ok' });
    assert.equal(frame.rgba.length, 1080 * 1920 * 4);
    writeFileSync(`${OUT}portrait-${name}-grid.png`, renderer.png());
  }
});
