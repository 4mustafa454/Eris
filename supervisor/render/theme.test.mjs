import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOCUS, GRID, MIN_FOCUS_PX, MIN_GRID_PX, STATES, stateStyle } from './theme.mjs';

test('six states, each with a distinct non-empty label and glyph', () => {
  assert.deepEqual(Object.keys(STATES).sort(), ['done', 'error', 'idle', 'paused', 'stuck', 'working']);
  const labels = Object.values(STATES).map(s => s.label);
  const glyphs = Object.values(STATES).map(s => s.glyph);
  assert.ok(labels.every(Boolean) && new Set(labels).size === 6);
  assert.ok(glyphs.every(Boolean) && new Set(glyphs).size === 6);
  assert.equal(stateStyle('nonsense').label, 'UNKNOWN');
});

test('every text size meets its mode minimum', () => {
  for (const k of ['name', 'badge', 'task', 'log']) assert.ok(GRID[k] >= MIN_GRID_PX, `grid ${k}`);
  for (const k of ['name', 'badge', 'task', 'reason', 'log']) assert.ok(FOCUS[k] >= MIN_FOCUS_PX, `focus ${k}`);
});
