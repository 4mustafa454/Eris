import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { LONG_REASON, LONG_LINE, LONG_TITLE, MODELS, SIX_STATES, THREE, logsFor } from './fixtures.mjs';
import { registerFonts } from './fonts.mjs';
import { cornerZones, effectiveView, fitText, layout, layoutFocus, layoutGrid, layoutUnreachable, modelKey, rowWidth, safeOf, wrapText } from './layout.mjs';
import { COLORS, FONT_STACK, HEIGHT, LANDSCAPE, MIN_FOCUS_PX, MIN_GRID_PX, PORTRAIT, WIDTH } from './theme.mjs';

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

test('grid shows up to six tiles', () => {
  const stripes = m => layoutGrid(grid(m), measure).filter(o => o.type === 'rect' && o.w === 8).length;
  for (const key of ['one', 'two', 'three']) assert.equal(stripes(MODELS[key]), MODELS[key].agents.length);
  assert.equal(stripes(MODELS['six-states']), 6);
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

test('focus caps logs while grid fills available space', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const logLines = ops => texts(ops).filter(o => /^line \d+$/.test(o.text));
  const f = logLines(layoutFocus(focus(m, 'agent-2'), measure));
  assert.ok(f.length >= 8 && f.length <= 10);
  assert.equal(f.at(-1).text, 'line 39');
  assert.ok(logLines(layoutGrid(grid(m), measure)).length > 5);
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

test('portrait grid adapts to one through six agents without overlapping tiles', () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    const agents = SIX_STATES.slice(0, count);
    const ops = layoutGrid(grid({ agents, logs: logsFor(agents) }), measure, PORTRAIT);
    const ps = panels(ops);
    assert.equal(ps.length, count);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }
    assertInsideSafe(ops, PORTRAIT, SAFE, `${count} agents`);
    assertOutOfCorners(ops, PORTRAIT, `${count} agents`);
    assert.ok(texts(ops).every(o => o.fontPx >= MIN_GRID_PX));
    for (const agent of agents) {
      assert.ok(texts(ops).some(o => o.text === agent.name), `${agent.name} remains legible`);
      assert.ok(texts(ops).some(o => o.text.includes(agent.state.toUpperCase())), `${agent.name} state is visible`);
    }
  }
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

test('portrait grid: one tile fills the space with recent logs', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const lines = texts(layoutGrid(grid(m), measure, PORTRAIT)).filter(o => /^line \d+$/.test(o.text));
  assert.ok(lines.length > 5);
  assert.equal(lines.at(-1).text, 'line 39');
  assert.ok(lines.every(o => o.fontPx >= MIN_GRID_PX), 'the minimum text size is kept');
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

// --- portrait safe area and corners ------------------------------------------------------------------------------

const SAFE = { top: 120, bottom: 260, side: 110 };
const everything = (ops, frame) => ops.slice(1).map(o => (o.type === 'text'
  ? { x: o.x, y: o.y, w: measure(o.text, o.fontPx, o.bold), h: o.fontPx, text: o.text }
  : { x: o.x, y: o.y, w: o.w, h: o.h })); // ops[0] is the full-frame background

function assertInsideSafe(ops, frame, safe, label) {
  for (const b of everything(ops, frame)) {
    assert.ok(b.x >= safe.side, `${label}: starts at x=${b.x}, left of the safe side ${safe.side} (${b.text ?? 'rect'})`);
    assert.ok(b.x + b.w <= frame.width - safe.side, `${label}: ends at x=${b.x + b.w}, right of the safe side ${frame.width - safe.side} (${b.text ?? 'rect'})`);
    assert.ok(b.y >= safe.top, `${label}: starts at y=${b.y}, above the safe top ${safe.top} (${b.text ?? 'rect'})`);
    assert.ok(b.y + b.h <= frame.height - safe.bottom, `${label}: ends at y=${b.y + b.h}, below the safe bottom ${frame.height - safe.bottom} (${b.text ?? 'rect'})`);
  }
}

function assertOutOfCorners(ops, frame, label) {
  for (const o of texts(ops)) {
    const w = measure(o.text, o.fontPx, o.bold);
    for (const z of cornerZones(frame)) {
      const hit = o.x < z.x + z.w && o.x + w > z.x && o.y < z.y + z.h && o.y + o.fontPx > z.y;
      assert.ok(!hit, `${label}: "${o.text.slice(0, 30)}" reaches into a corner zone`);
    }
  }
}

test('portrait defaults: safe area 120 top / 260 bottom / 110 each side; zones are the two right-hand corners inside it', () => {
  assert.deepEqual(safeOf(PORTRAIT), SAFE);
  assert.deepEqual(safeOf({ ...PORTRAIT, safe: { top: 10, bottom: 20 } }), { top: 10, bottom: 20, side: 110 }, 'unset insets keep their default');
  assert.deepEqual(safeOf({ ...PORTRAIT, safe: { side: 0 } }), { top: 120, bottom: 260, side: 0 });
  assert.deepEqual(safeOf(LANDSCAPE), { top: 0, bottom: 0, side: 0 }, 'landscape has no safe area');
  assert.deepEqual(cornerZones(LANDSCAPE), []);
  const [top, bottom] = cornerZones(PORTRAIT);
  assert.deepEqual([top.x, top.y, top.w, top.h], [1080 - 110 - 300, 120, 300, 360], 'right edge of the zone is the right safe edge');
  assert.deepEqual([bottom.x, bottom.y + bottom.h], [670, 1920 - 260]);
});

for (const [name, m] of Object.entries(MODELS)) {
  test(`portrait "${name}": every panel and text stays inside the safe area, and text stays out of the corners`, () => {
    const views = [['grid', layoutGrid(grid(m), measure, PORTRAIT)], ...m.agents.map(a => [`focus ${a.id}`, layoutFocus(focus(m, a.id), measure, PORTRAIT)])];
    for (const [view, ops] of views) {
      assertInsideSafe(ops, PORTRAIT, SAFE, `${name}/${view}`);
      assertOutOfCorners(ops, PORTRAIT, `${name}/${view}`);
      assertFits(ops, `${name}/${view}`, PORTRAIT);
    }
  });
}

test('portrait: the unreachable frame, and "No agents", also stay inside the safe area and out of the corners', () => {
  for (const ops of [
    layoutUnreachable({ harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z' }, measure, PORTRAIT),
    layoutGrid(grid({ agents: [], logs: {} }), measure, PORTRAIT),
  ]) {
    assertInsideSafe(ops, PORTRAIT, SAFE, 'extra');
    assertOutOfCorners(ops, PORTRAIT, 'extra');
  }
});

test('portrait grid: the three tiles share the safe height exactly (120 to 1660)', () => {
  const ps = panels(layoutGrid(grid(MODELS.three), measure, PORTRAIT));
  assert.equal(ps[0].y, 120);
  const end = ps.at(-1).y + ps.at(-1).h;
  assert.ok(end <= 1660 && end >= 1658, `the last tile ends at ${end}: inside the safe area, within 2 px of its edge (integer tile heights)`);
  assert.ok(ps.every(p => Math.abs(p.h - ps[0].h) <= 1), 'equal heights apart from rounding');
});

test('portrait focus: the colour stripe covers the safe height only', () => {
  const stripe = layoutFocus(focus(MODELS.three, 'agent-2'), measure, PORTRAIT).filter(o => o.type === 'rect' && o.w === 16)[0];
  assert.deepEqual([stripe.y, stripe.y + stripe.h], [120, 1660]);
  assert.equal(stripe.x, 110, 'and starts at the safe side, not the frame edge');
});

test('the safe area is configurable through the frame; zero insets give the margin layout back', () => {
  const custom = { ...PORTRAIT, safe: { top: 200, bottom: 100, side: 50 } };
  for (const ops of [layoutGrid(grid(MODELS.long), measure, custom), layoutFocus(focus(MODELS.long, 'agent-1'), measure, custom)]) {
    assertInsideSafe(ops, custom, custom.safe, 'custom');
    assertOutOfCorners(ops, custom, 'custom');
  }
  const none = { ...PORTRAIT, safe: { top: 0, bottom: 0, side: 0 } };
  const ps = panels(layoutGrid(grid(MODELS.three), measure, none));
  assert.deepEqual([ps[0].x, ps[0].y, ps[0].w], [40, 40, 1000], 'the 40 px margin still applies');
  assert.ok(ps.at(-1).y + ps.at(-1).h <= 1880 && ps.at(-1).y + ps.at(-1).h >= 1878);
  assertInsideSafe(layoutGrid(grid(MODELS.three), measure, none), none, none.safe, 'zero insets');
});

test('the largest configurable safe area (450 + 450 top/bottom, 250 each side) still fits every state badge and all text', () => {
  const big = { ...PORTRAIT, safe: { top: 450, bottom: 450, side: 250 } }; // the configured maximums
  for (const [name, m] of Object.entries(MODELS)) {
    assertInsideSafe(layoutGrid(grid(m), measure, big), big, big.safe, `grid ${name}`);
    for (const a of m.agents) assertInsideSafe(layoutFocus(focus(m, a.id), measure, big), big, big.safe, `focus ${name}`);
  }
});

test('landscape ignores the safe area: the same ops with or without insets', () => {
  const withSafe = { ...LANDSCAPE, safe: { top: 500, bottom: 500, side: 500 } };
  assert.deepEqual(layoutGrid(grid(MODELS.three), measure, withSafe), layoutGrid(grid(MODELS.three), measure));
  assert.deepEqual(layoutFocus(focus(MODELS.three, 'agent-1'), measure, withSafe), layoutFocus(focus(MODELS.three, 'agent-1'), measure));
});

test('rows that touch a corner zone get less width; rows clear of it keep the full width', () => {
  const full = 900;
  assert.equal(rowWidth(PORTRAIT, 150, 600, 36, full), full, 'middle of the frame');
  assert.equal(rowWidth(PORTRAIT, 150, 150, 36, full), 670 - 16 - 150, 'top-right zone');
  assert.equal(rowWidth(PORTRAIT, 150, 1400, 36, full), 670 - 16 - 150, 'bottom-right zone');
  assert.equal(rowWidth(PORTRAIT, 150, 115, 36, full), 504, 'a row that only just reaches into the zone counts');
  assert.equal(rowWidth(LANDSCAPE, 150, 150, 36, full), full, 'landscape has no zones');
});

test('long grid titles: a first line cut earlier in the corner rows, a second line ending in an ellipsis, same size', () => {
  const long = 'Refactor the entire signup flow to validate every field and normalise email addresses';
  const m = { agents: [0, 1, 2].map(i => ({ ...THREE[i], task: long })), logs: {} };
  const ops = layoutGrid(grid(m), measure, PORTRAIT);
  const task = texts(ops).filter(o => o.fontPx === 36 && !o.bold && o.x === 150);
  const byTile = panels(ops).map(p => task.filter(o => o.y >= p.y && o.y < p.y + p.h));
  assert.deepEqual(byTile.map(t => t.length), [2, 2, 2], 'two lines each, never three');
  assert.ok(byTile[0][0].maxWidth < byTile[1][0].maxWidth, 'tile 1 sits in the top corner band');
  assert.ok(byTile[2][0].maxWidth < byTile[1][0].maxWidth, 'tile 3 sits in the bottom corner band');
  for (const [first, second] of byTile) {
    assert.ok(second.y > first.y + 36, 'the second line is below the first');
    assert.ok(!first.text.endsWith('…'), 'the first line is a whole-word break, not cut');
  }
  assert.ok(byTile[0][1].text.endsWith('…') && byTile[2][1].text.endsWith('…'), 'corner tiles: still too long, so the second line ends in an ellipsis');
  assert.equal(`${byTile[1][0].text} ${byTile[1][1].text}`, long, 'the middle tile has the full width: the whole title fits on two lines, nothing cut');
  // a title too long even for the full width is cut with an ellipsis on the second line
  const hugeAgent = { ...THREE[1], task: LONG_TITLE };
  const hugeLines = texts(layoutGrid(grid({ agents: [hugeAgent], logs: {} }), measure, PORTRAIT)).filter(o => o.fontPx === 36 && !o.bold && o.x === 150);
  assert.equal(hugeLines.length, 2);
  assert.ok(hugeLines[1].text.endsWith('…'));
});

test('a title that fits on one line stays on one line, as before; one that does not wraps at a word', () => {
  const title = 'Add input validation to /signup'; // fits tile 2 (full width) but not the corner rows of tiles 1 and 3
  const m = { agents: [0, 1, 2].map(i => ({ ...THREE[i], task: title })), logs: {} };
  const ops = layoutGrid(grid(m), measure, PORTRAIT);
  const task = texts(ops).filter(o => o.fontPx === 36 && !o.bold && o.x === 150);
  const byTile = panels(ops).map(p => task.filter(o => o.y >= p.y && o.y < p.y + p.h).map(o => o.text));
  assert.deepEqual(byTile[1], [title], 'tile 2: one line, untouched');
  assert.deepEqual(byTile[0], ['Add input validation to', '/signup'], 'tile 1 (corner): wrapped at a word, nothing cut');
  assert.deepEqual(byTile[2], ['Add input validation to', '/signup'], 'tile 3 (corner)');
});

test('grid title wrapping: 3 log lines where the title takes two lines, 4 where it takes one; sizes and bounds unchanged', () => {
  const logs = Object.fromEntries(['agent-1', 'agent-2', 'agent-3'].map(id => [id, Array.from({ length: 10 }, (_, i) => `entry ${i}`)]));
  const m = { agents: [{ ...THREE[0], task: 'Add input validation to /signup' }, { ...THREE[1], task: 'Write tests' }, { ...THREE[2], task: 'Rename the package' }], logs };
  const ops = layoutGrid(grid(m), measure, PORTRAIT);
  const perTile = panels(ops).map(p => texts(ops).filter(o => /^entry \d$/.test(o.text) && o.y >= p.y && o.y < p.y + p.h));
  assert.ok(perTile.every(t => t.length >= 3));
  assert.ok(perTile.every(t => t.at(-1).text === 'entry 9'), 'the latest lines are shown');
  assert.ok(texts(ops).every(o => o.fontPx >= MIN_GRID_PX));
  assertInsideSafe(ops, PORTRAIT, SAFE, 'wrapped');
  assertOutOfCorners(ops, PORTRAIT, 'wrapped');
});

test('landscape grid titles stay on one line (wrapping is a portrait-only change)', () => {
  const long = 'Refactor the entire signup flow to validate every field and normalise email addresses';
  const m = { agents: THREE.map(a => ({ ...a, task: long })), logs: {} };
  const titles = texts(layoutGrid(grid(m), measure, LANDSCAPE)).filter(o => o.fontPx === 32 && !o.bold);
  assert.equal(titles.length, 3);
  assert.ok(titles.every(o => o.text.endsWith('…')));
});

test('a tile with no room for any log line shows none, not all of them (the largest safe area, a wrapped title)', () => {
  const big = { ...PORTRAIT, safe: { top: 450, bottom: 450, side: 250 } };
  const logs = { 'agent-1': Array.from({ length: 10 }, (_, i) => `entry ${i}`) };
  const m = { agents: THREE.map(a => ({ ...a, task: 'Refactor the entire signup flow to validate every field and normalise emails' })), logs };
  const ops = layoutGrid(grid(m), measure, big);
  assert.equal(texts(ops).filter(o => /^entry \d$/.test(o.text)).length, 0);
  assertInsideSafe(ops, big, big.safe, 'no room');
  const huge = { ...PORTRAIT, safe: { top: 600, bottom: 600, side: 250 } };
  assertInsideSafe(layoutFocus(focus(m, 'agent-1'), measure, huge), huge, huge.safe, 'focus no room');
});

test('wrapText takes a width per line', () => {
  const lines = wrapText('alpha beta gamma delta epsilon zeta eta theta', i => (i === 0 ? 300 : 900), 44, 4, measure);
  assert.ok(measure(lines[0], 44) <= 300 && measure(lines[1], 44) <= 900);
  assert.ok(lines[1].split(' ').length > lines[0].split(' ').length, 'the roomier line holds more words');
});

test('portrait side bands: stripe, badge and text start at the safe side and end before the right one, in every fixture', () => {
  for (const [name, m] of Object.entries(MODELS)) {
    const grid = layoutGrid({ mode: 'grid', harness: 'ok', ...m }, measure, PORTRAIT);
    assert.ok(tiles(grid).every(o => o.x >= 110 && o.x + o.w <= 970), `${name}: grid stripes`);
    assert.equal(tiles(grid).length, Math.min(m.agents.length, 6));
    for (const a of m.agents) {
      const f = layoutFocus(focus(m, a.id), measure, PORTRAIT);
      assert.equal(f.filter(o => o.type === 'rect' && o.w === 16)[0].x, 110, `${name}: focus stripe`);
      const badge = f.find(o => o.type === 'rect' && o.radius > 20);
      assert.ok(badge.x >= 110 && badge.x + badge.w <= 970, `${name}: focus badge`);
    }
  }
});

test('with the side bands the stuck reason still fits in its box without being cut (at the minimum text size)', () => {
  const stuck = { ...THREE[0], stuck_reason: LONG_REASON };
  const ops = layoutFocus(focus({ agents: [stuck], logs: logsFor([stuck]) }, 'agent-1'), measure, PORTRAIT);
  const reason = texts(ops).filter(o => o.fill === '#2a1d00');
  assert.ok(reason.every(o => o.fontPx >= MIN_FOCUS_PX));
  assert.ok(reason.length >= 4 && reason.length <= 6, `${reason.length} lines`);
  assert.ok(!reason.some(o => o.text.endsWith('…')), `cut: ${reason.map(o => o.text).join(' / ')}`);
  assertInsideSafe(ops, PORTRAIT, SAFE, 'stuck');
});

test('portrait: a single agent shows more than five log lines', () => {
  const m = { agents: [THREE[1]], logs: { 'agent-2': Array.from({ length: 40 }, (_, i) => `line ${i}`) } };
  const lines = texts(layoutGrid(grid(m), measure, PORTRAIT)).filter(o => o.fontPx === 32);
  assert.ok(lines.length > 5);
});

test('pending approval banner and highlighted tile stay in the portrait safe area', () => {
  const approvals = [{ id: 'ap1', agent_id: 'agent-2', action: 'git_push', status: 'pending' }];
  const model = grid({ agents: SIX_STATES, logs: logsFor(SIX_STATES), approvals });
  const ops = layoutGrid(model, measure, PORTRAIT);
  assertFits(ops, 'approval grid', PORTRAIT);
  assertInsideSafe(ops, PORTRAIT, SAFE, 'approval grid');
  assertOutOfCorners(ops, PORTRAIT, 'approval grid');
  assert.ok(texts(ops).some(o => /Approval: Agent 2 · git push/.test(o.text)));
  assert.ok(texts(ops).some(o => /Say approve or deny/.test(o.text)));
  const ps = panels(ops);
  assert.equal(ps.length, 6);
  assert.equal(ps.filter(p => p.fill === '#574421').length, 1);
  assert.equal(ps[1].fill, '#574421');
  assert.notEqual(modelKey(model), modelKey({ ...model, approvals: [] }));
  const without = layoutGrid({ ...model, approvals: [{ ...approvals[0], status: 'approved' }] }, measure, PORTRAIT);
  assert.equal(panels(without).filter(p => p.fill === '#574421').length, 0);
  assert.ok(!texts(without).some(o => /Say approve or deny/.test(o.text)));
});

test('six compact tiles remain legible and contained with large safe margins and an approval', () => {
  const frame = { ...PORTRAIT, safe: { top: 450, bottom: 450, side: 250 } };
  const approvals = [{ id: 'ap', agent_id: 'agent-2', action: 'git_push', status: 'pending' }];
  const ops = layoutGrid(grid({ agents: SIX_STATES, logs: logsFor(SIX_STATES), approvals }), measure, frame);
  const ps = panels(ops);
  assert.equal(ps.length, 6);
  for (const op of texts(ops).filter(o => o.y >= ps[0].y)) {
    const panel = ps.find(p => op.x >= p.x && op.y >= p.y && op.x < p.x + p.w && op.y < p.y + p.h);
    assert.ok(panel, `no tile for ${op.text}`);
    assert.ok(op.y + op.fontPx <= panel.y + panel.h, `${op.text} exceeds its tile`);
    assert.ok(op.fontPx >= MIN_GRID_PX);
  }
  assertInsideSafe(ops, frame, frame.safe, 'compact approval grid');
});

test('six portrait tiles fill the safe height and prioritize blockers over logs', () => {
  const approvals = [{ id: 'ap', agent_id: 'agent-2', action: 'git_push', status: 'pending' }];
  const logs = Object.fromEntries(SIX_STATES.map(a => [a.id, Array.from({ length: 20 }, (_, i) => `entry ${i}`)]));
  const model = grid({ agents: SIX_STATES, logs, approvals });
  const ops = layoutGrid(model, measure, PORTRAIT);
  const ps = panels(ops);
  const banner = ops.find(o => o.type === 'rect' && o.fill === COLORS.warn);
  assert.equal(ps[0].y, banner.y + banner.h + 24);
  assert.equal(ps.at(-1).y + ps.at(-1).h, PORTRAIT.height - SAFE.bottom);
  assertOutOfCorners(ops, PORTRAIT, 'six with banner');
  assert.ok(texts(ops).find(o => o.text === 'Say approve or deny').fontPx > 28);
  ps.forEach((p, i) => {
    const inPanel = texts(ops).filter(o => o.x >= p.x && o.x < p.x + p.w && o.y >= p.y && o.y < p.y + p.h);
    const entries = inPanel.filter(o => /^entry \d+$/.test(o.text));
    if (SIX_STATES[i].state === 'stuck') {
      assert.equal(entries.length, 0);
      const reason = inPanel.filter(o => o.fill === COLORS.warnText);
      assert.ok(reason.length >= 1 && reason.length <= 2);
      assert.ok(reason[0].text.startsWith('BLOCKED:'));
      assert.ok(reason.at(-1).text.endsWith('…'));
    } else assert.ok(entries.length >= 1, `no log for ${SIX_STATES[i].id}`);
  });
});

test('three portrait tiles keep blocker and at least three logs below an approval banner', () => {
  const approvals = [{ id: 'ap', agent_id: 'agent-2', action: 'git_push', status: 'pending' }];
  const logs = Object.fromEntries(THREE.map(a => [a.id, Array.from({ length: 20 }, (_, i) => `entry ${i}`)]));
  const ops = layoutGrid(grid({ agents: THREE, logs, approvals }), measure, PORTRAIT);
  const ps = panels(ops);
  assertOutOfCorners(ops, PORTRAIT, 'three with banner');
  for (const p of ps) {
    const inPanel = texts(ops).filter(o => o.x >= p.x && o.x < p.x + p.w && o.y >= p.y && o.y < p.y + p.h);
    assert.ok(inPanel.filter(o => /^entry \d+$/.test(o.text)).length >= 3);
  }
  assert.ok(texts(ops).some(o => o.text.startsWith('BLOCKED:')));
});
