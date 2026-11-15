import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { LONG_REASON, LONG_LINE, MODELS, SIX_STATES, THREE, logsFor } from './fixtures.mjs';
import { registerFonts } from './fonts.mjs';
import { effectiveView, fitText, layout, layoutFocus, layoutGrid, layoutUnreachable, modelKey, wrapText } from './layout.mjs';
import { FONT_STACK, HEIGHT, MIN_FOCUS_PX, MIN_GRID_PX, WIDTH } from './theme.mjs';

registerFonts();
const ctx = createCanvas(10, 10).getContext('2d');
const measure = (t, px, bold) => { ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT_STACK}`; return ctx.measureText(t).width; };

const grid = m => ({ mode: 'grid', harness: 'ok', ...m });
const focus = (m, id) => ({ mode: 'focus', focusId: id, harness: 'ok', ...m });
const texts = ops => ops.filter(o => o.type === 'text');

function assertFits(ops, label) {
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

for (const [name, m] of Object.entries(MODELS)) {
  test(`grid "${name}": nothing overflows; text ≥ ${MIN_GRID_PX}px`, () => {
    const ops = layoutGrid(grid(m), measure);
    assertFits(ops, name);
    assert.ok(texts(ops).every(o => o.fontPx >= MIN_GRID_PX));
  });
  test(`focus "${name}" on every agent: nothing overflows; text ≥ ${MIN_FOCUS_PX}px`, () => {
    for (const a of m.agents) {
      const ops = layoutFocus(focus(m, a.id), measure);
      assertFits(ops, `${name}/${a.id}`);
      assert.ok(texts(ops).every(o => o.fontPx >= MIN_FOCUS_PX));
    }
  });
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
