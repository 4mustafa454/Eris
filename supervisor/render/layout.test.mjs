import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { LONG_REASON, LONG_LINE, MODELS, SIX_STATES, THREE, logsFor } from './fixtures.mjs';
import { registerFonts } from './fonts.mjs';
import { effectiveView, fitText, layout, layoutFocus, layoutGrid, layoutUnreachable, modelKey, wrapText } from './layout.mjs';
import { FONT_STACK, HEIGHT, LANDSCAPE, MIN_FOCUS_PX, MIN_GRID_PX, PORTRAIT, WIDTH } from './theme.mjs';

const FRAMES = { landscape: LANDSCAPE, portrait: PORTRAIT };

registerFonts();
const ctx = createCanvas(10, 10).getContext('2d');
const measure = (t, px, bold) => { ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT_STACK}`; return ctx.measureText(t).width; };

const grid = m => ({ mode: 'grid', harness: 'ok', ...m });
const focus = (m, id) => ({ mode: 'focus', focusId: id, harness: 'ok', ...m });
const texts = ops => ops.filter(o => o.type === 'text');

function assertFits(ops, label, frame = LANDSCAPE) {
  const { width: WIDTH, height: HEIGHT } = frame;
  for (const o of ops) {
    if (o.type === 'rect') {
      assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.w <= WIDTH && o.y + o.h <= HEIGHT, `${label}: rect out of frame ${JSON.stringify(o)}`);
    } else {
      const w = measure(o.text, o.fontPx, o.bold);
      assert.ok(w <= o.maxWidth + 0.5, `${label}: "${o.text.slice(0, 30)}…" is ${w}px in ${o.maxWidth}px`);
      assert.ok(o.x >= 0 && o.x + w <= WIDTH, `${label}: text outside frame width`);
      assert.ok(o.y >= 0 && o.y + o.fontPx <= HEIGHT, `${label}: text outside frame height (y=${o.y})`);
    }
  }
}

test('fitText: fits, truncates with an ellipsis, never overflows, handles a tiny box', () => {
  assert.equal(fitText('short', 500, 28, measure), 'short');
  const cut = fitText(LONG_LINE, 400, 28, measure);
  assert.ok(cut.endsWith('…') && measure(cut, 28) <= 400);
  const nospace = fitText('x'.repeat(200), 300, 28, measure);
  assert.ok(nospace.endsWith('…') && measure(nospace, 28) <= 300);
  assert.equal(fitText('anything', 5, 28, measure), '');
  assert.equal(fitText(null, 100, 28, measure), '');
});

test('wrapText: wraps, caps lines, ends the last in an ellipsis when cut', () => {
  const lines = wrapText(LONG_REASON, 700, 44, 2, measure, true);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => measure(l, 44, true) <= 700));
  assert.ok(lines[1].endsWith('…'));
  assert.deepEqual(wrapText('one two', 2000, 44, 2, measure), ['one two']);
});

for (const [orientation, frame] of Object.entries(FRAMES)) {
  for (const [name, m] of Object.entries(MODELS)) {
    test(`${orientation} grid "${name}": nothing overflows; text ≥ ${MIN_GRID_PX}px`, () => {
      const ops = layoutGrid(grid(m), measure, frame);
      assertFits(ops, `${orientation}/${name}`, frame);
      assert.ok(texts(ops).every(o => o.fontPx >= MIN_GRID_PX));
    });
    test(`${orientation} focus "${name}" on every agent: nothing overflows; text ≥ ${MIN_FOCUS_PX}px`, () => {
      for (const a of m.agents) {
        const ops = layoutFocus(focus(m, a.id), measure, frame);
        assertFits(ops, `${orientation}/${name}/${a.id}`, frame);
        assert.ok(texts(ops).every(o => o.fontPx >= MIN_FOCUS_PX));
      }
    });
  }
}

test('grid shows 1, 2, 3 tiles and caps at 3', () => {
  const stripes = m => layoutGrid(grid(m), measure).filter(o => o.type === 'rect' && o.w === 8).length;
  for (const key of ['one', 'two', 'three']) assert.equal(stripes(MODELS[key]), MODELS[key].agents.length);
  assert.equal(stripes(MODELS['six-states']), 3);
});

test('every state has its text label and glyph in the output', () => {
  for (const a of SIX_STATES) {
    const m = { agents: [a], logs: logsFor([a]) };
    for (const ops of [layoutGrid(grid(m), measure), layoutFocus(focus(m, a.id), measure)]) {
      assert.ok(texts(ops).some(o => o.text.includes(a.state.toUpperCase())), a.state);
    }
  }
});

test('the stripe uses the agent colour from the API', () => {
  const ops = layoutGrid(grid(MODELS.three), measure);
  const colours = ops.filter(o => o.type === 'rect' && o.w === 8).map(o => o.fill);
  assert.deepEqual(colours, THREE.map(a => a.color));
});

test('focus shows stuck_reason only when stuck', () => {
  const stuck = { ...THREE[0] };
  const working = { ...THREE[0], state: 'working' };
  const has = a => texts(layoutFocus(focus({ agents: [a], logs: {} }, a.id), measure)).some(o => o.text.startsWith('BLOCKED:'));
  assert.equal(has(stuck), true);
  assert.equal(has(working), false);
});

test('focus shows at most ~10 log lines, grid at most 5', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const logLines = ops => texts(ops).filter(o => /^line \d+$/.test(o.text));
  const f = logLines(layoutFocus(focus(m, 'agent-2'), measure));
  assert.ok(f.length >= 8 && f.length <= 10);
  assert.equal(f.at(-1).text, 'line 39');
  assert.equal(logLines(layoutGrid(grid(m), measure)).length, 5);
});

test('long text is truncated with an ellipsis', () => {
  const ops = layoutGrid(grid(MODELS.long), measure);
  assert.ok(texts(ops).some(o => o.text.endsWith('…')));
});

test('focus on an unknown agent falls back to grid; unreachable wins over everything', () => {
  assert.equal(effectiveView(focus(MODELS.three, 'agent-9')), 'grid');
  assert.equal(effectiveView(focus(MODELS.three, 'agent-2')), 'focus');
  assert.equal(effectiveView({ ...focus(MODELS.three, 'agent-2'), harness: 'unreachable' }), 'unreachable');
  assertFits(layout(focus(MODELS.three, 'agent-9'), measure), 'fallback');
});

test('unreachable frame says so, names the URL, and fits', () => {
  const ops = layoutUnreachable({ harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11' }, measure);
  assertFits(ops, 'unreachable');
  const all = texts(ops).map(o => o.text).join('\n');
  assert.match(all, /HARNESS UNREACHABLE/);
  assert.match(all, /localhost:8787/);
  assert.match(all, /19:02:11/);
});

test('zero agents draws a message instead of nothing', () => {
  const ops = layoutGrid(grid({ agents: [], logs: {} }), measure);
  assert.ok(texts(ops).some(o => o.text === 'No agents'));
});

test('modelKey: ignores what is not drawn, changes with what is', () => {
  const base = grid(MODELS.three);
  const k = modelKey(base);
  const touched = { ...base, agents: base.agents.map(a => ({ ...a, updated_at: 'later', summary: 'new summary' })) };
  assert.equal(modelKey(touched), k);
  assert.notEqual(modelKey({ ...base, mode: 'focus', focusId: 'agent-1' }), k);
  assert.notEqual(modelKey(focus(MODELS.three, 'agent-2')), modelKey(focus(MODELS.three, 'agent-1')));
  assert.notEqual(modelKey({ ...base, agents: base.agents.map((a, i) => (i ? a : { ...a, state: 'done' })) }), k);
  assert.notEqual(modelKey({ ...base, logs: { ...base.logs, 'agent-1': ['different'] } }), k);
  assert.notEqual(modelKey({ ...base, harness: 'unreachable' }), k);
  // focus on a missing agent draws the grid, so it must key like the grid
  assert.equal(modelKey(focus(MODELS.three, 'agent-9')), k);
});

// --- portrait (1080×1920) ----------------------------------------------------------------------------------------

const tiles = ops => ops.filter(o => o.type === 'rect' && o.w === 8); // the colour stripes, one per tile
const panels = ops => ops.filter(o => o.type === 'rect' && o.radius === 16);

test('portrait grid: 1, 2, 3 tiles stacked vertically at full width, none overlapping, capped at 3', () => {
  for (const [key, count] of [['one', 1], ['two', 2], ['three', 3], ['six-states', 3], ['long', 3]]) {
    const ps = panels(layoutGrid(grid(MODELS[key]), measure, PORTRAIT));
    assert.equal(ps.length, count, key);
    assert.ok(ps.every(p => p.x === 40 && p.w === PORTRAIT.width - 80), `${key}: full width`);
    ps.slice(1).forEach((p, i) => assert.ok(p.y >= ps[i].y + ps[i].h, `${key}: tile ${i + 2} overlaps the one above`));
    assert.equal(tiles(layoutGrid(grid(MODELS[key]), measure, PORTRAIT)).length, count);
  }
});

test('portrait grid: tile positions do not move when the number of agents changes', () => {
  const y = key => panels(layoutGrid(grid(MODELS[key]), measure, PORTRAIT)).map(p => [p.y, p.h]);
  assert.deepEqual(y('three').slice(0, 1), y('one'));
  assert.deepEqual(y('three').slice(0, 2), y('two'));
});

test('portrait grid: the stripe uses the agent colour, in order top to bottom', () => {
  assert.deepEqual(tiles(layoutGrid(grid(MODELS.three), measure, PORTRAIT)).map(o => o.fill), THREE.map(a => a.color));
});

test('portrait grid: every text op stays inside its own tile', () => {
  const ops = layoutGrid(grid(MODELS.long), measure, PORTRAIT);
  const ps = panels(ops);
  for (const o of texts(ops)) {
    const tile = ps.find(p => o.y >= p.y && o.y < p.y + p.h);
    assert.ok(tile, `text "${o.text.slice(0, 20)}" is in no tile`);
    assert.ok(o.x >= tile.x && o.x + measure(o.text, o.fontPx, o.bold) <= tile.x + tile.w, 'sticks out sideways');
    assert.ok(o.y + o.fontPx <= tile.y + tile.h, `"${o.text.slice(0, 20)}" runs out of the bottom of its tile`);
  }
});

test('portrait grid shows at most 5 log lines per tile, and the last ones', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const lines = texts(layoutGrid(grid(m), measure, PORTRAIT)).filter(o => /^line \d+$/.test(o.text));
  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1).text, 'line 39');
});

test('portrait focus: one agent fills the frame, name then badge, up to ~10 log lines, last ones', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const ops = layoutFocus(focus(m, 'agent-2'), measure, PORTRAIT);
  const bg = ops[0];
  assert.deepEqual([bg.w, bg.h], [1080, 1920]);
  const name = texts(ops).find(o => o.text === 'Agent 2');
  const badgeText = texts(ops).find(o => o.text.includes('WORKING'));
  assert.ok(badgeText.y > name.y + name.fontPx, 'badge is under the name');
  const lines = texts(ops).filter(o => /^line \d+$/.test(o.text));
  assert.ok(lines.length >= 8 && lines.length <= 10);
  assert.equal(lines.at(-1).text, 'line 39');
});

test('portrait focus wraps a long task and a long stuck reason instead of cutting them to one line', () => {
  const stuck = { ...THREE[0], task: 'Refactor the entire signup flow to validate every field and normalise email addresses', stuck_reason: LONG_REASON };
  const ops = layoutFocus(focus({ agents: [stuck], logs: logsFor([stuck]) }, 'agent-1'), measure, PORTRAIT);
  assertFits(ops, 'portrait stuck', PORTRAIT);
  const taskLines = texts(ops).filter(o => o.fontPx === 48 && !o.bold);
  assert.ok(taskLines.length >= 2, `task on ${taskLines.length} line(s)`);
  const reason = texts(ops).filter(o => o.fill === '#2a1d00');
  assert.ok(reason.length >= 2 && reason[0].text.startsWith('BLOCKED:'), 'reason wrapped over several lines');
  assert.ok(!reason.some(o => o.text.endsWith('…')), 'a reason this long fits within the 5 lines');
});

test('portrait: a very long unbroken task and reason are cut with an ellipsis, never overflow', () => {
  const a = { ...THREE[0], task: 'x'.repeat(400), stuck_reason: 'y'.repeat(600) };
  const ops = layoutFocus(focus({ agents: [a], logs: {} }, 'agent-1'), measure, PORTRAIT);
  assertFits(ops, 'portrait long', PORTRAIT);
  assert.ok(texts(ops).some(o => o.text.endsWith('…')));
});

test('portrait: the unreachable frame wraps its heading, names the URL, and fits', () => {
  const ops = layoutUnreachable({ harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z' }, measure, PORTRAIT);
  assertFits(ops, 'portrait unreachable', PORTRAIT);
  const all = texts(ops).map(o => o.text).join('\n');
  assert.match(all, /HARNESS\nUNREACHABLE|UNREACHABLE/);
  assert.match(all, /localhost:8787/);
  assert.match(all, /19:02:11Z/);
  assert.equal(texts(ops).filter(o => o.fontPx >= 88).length, 2, 'heading is on two lines');
});

test('portrait: every state shows its label, and zero agents says so', () => {
  for (const a of SIX_STATES) {
    const m = { agents: [a], logs: logsFor([a]) };
    for (const ops of [layoutGrid(grid(m), measure, PORTRAIT), layoutFocus(focus(m, a.id), measure, PORTRAIT)]) {
      assert.ok(texts(ops).some(o => o.text.includes(a.state.toUpperCase())), a.state);
    }
  }
  assert.ok(texts(layoutGrid(grid({ agents: [], logs: {} }), measure, PORTRAIT)).some(o => o.text === 'No agents'));
});

test('layout() passes the frame through to every view', () => {
  for (const m of [grid(MODELS.three), focus(MODELS.three, 'agent-2'), { ...grid(MODELS.three), harness: 'unreachable' }]) {
    const ops = layout(m, measure, PORTRAIT);
    assert.deepEqual([ops[0].w, ops[0].h], [1080, 1920]);
    assertFits(ops, 'layout()', PORTRAIT);
  }
  assert.deepEqual([layout(grid(MODELS.three), measure)[0].w, layout(grid(MODELS.three), measure)[0].h], [1920, 1080], 'landscape is the default');
});
