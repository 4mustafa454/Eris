import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { registerFonts } from './fonts.mjs';
import { FONT_FAMILY, STATES } from './theme.mjs';

test('the bundled font is registered and every badge glyph has a non-zero width', () => {
  registerFonts();
  registerFonts(); // idempotent
  assert.ok(GlobalFonts.families.some(f => f.family === FONT_FAMILY));
  const ctx = createCanvas(10, 10).getContext('2d');
  ctx.font = `bold 48px "${FONT_FAMILY}"`;
  for (const [state, { glyph }] of Object.entries(STATES)) {
    assert.ok(ctx.measureText(glyph).width > 0, `${state} glyph ${glyph}`);
  }
});
