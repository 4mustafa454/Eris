// Paints layout ops onto a 1920×1080 canvas. Redraws only when modelKey changes; otherwise the cached
// RGBA buffer (and JPEG) are returned as they are. A changed frame always lands in a NEW buffer, so the
// frame being published is never modified mid-capture.
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from './fonts.mjs';
import { layout, modelKey } from './layout.mjs';
import { FONT_STACK, HEIGHT, WIDTH } from './theme.mjs';

export const RENDER_BUDGET_MS = 30;

function rect(ctx, o) {
  ctx.fillStyle = o.fill;
  if (o.radius && typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(o.x, o.y, o.w, o.h, o.radius);
    ctx.fill();
  } else {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }
}

/**
 * @param {{ width?: number, height?: number, log?: Pick<Console,'warn'> }} [options]
 */
export function createRenderer({ width = WIDTH, height = HEIGHT, log = console } = {}) {
  registerFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';

  const measure = (text, px, bold) => { ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT_STACK}`; return ctx.measureText(text).width; };

  let key = null;
  let rgba = null;
  let jpegCache = null;
  let lastRenderMs = 0;

  function draw(model) {
    for (const o of layout(model, measure)) {
      if (o.type === 'rect') rect(ctx, o);
      else {
        ctx.font = `${o.bold ? 'bold ' : ''}${o.fontPx}px ${FONT_STACK}`;
        ctx.fillStyle = o.fill;
        ctx.fillText(o.text, o.x, o.y);
      }
    }
  }

  return {
    width, height,
    /** @returns {{ rgba: Uint8Array, changed: boolean, ms: number }} */
    render(model) {
      const next = modelKey(model);
      if (next === key && rgba) return { rgba, changed: false, ms: 0 };
      const start = performance.now();
      draw(model);
      const data = ctx.getImageData(0, 0, width, height).data; // a fresh buffer on every call
      rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      key = next;
      jpegCache = null;
      lastRenderMs = performance.now() - start;
      if (lastRenderMs > RENDER_BUDGET_MS) log.warn(`[eris] frame render took ${lastRenderMs.toFixed(1)} ms (budget ${RENDER_BUDGET_MS} ms)`);
      return { rgba, changed: true, ms: lastRenderMs };
    },
    /** JPEG of the latest rendered frame (encoded lazily, once per frame), or null before the first render. */
    jpeg() {
      if (!rgba) return null;
      return (jpegCache ??= canvas.toBuffer('image/jpeg', 80));
    },
    /** PNG of the latest rendered frame, for tests and the sample dump. */
    png() { return rgba ? canvas.toBuffer('image/png') : null; },
    get lastRenderMs() { return lastRenderMs; },
  };
}
