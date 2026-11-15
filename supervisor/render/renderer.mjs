// Paints layout ops onto a 1920×1080 canvas. Redraws only when modelKey changes; otherwise the cached
// RGBA buffer (and JPEG) are returned as they are. A changed frame always lands in a NEW buffer, so the
// frame being published is never modified mid-capture.
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from './fonts.mjs';
import { layout, modelKey } from './layout.mjs';
import { FONT_STACK, frameFor, HEIGHT, orientationOf, WIDTH } from './theme.mjs';

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
 * @param {{ width?: number, height?: number, safe?: { top: number, bottom: number }, log?: Pick<Console,'warn'> }} [options]  1920×1080 / 1280×720 (landscape) or 1080×1920 / 720×1280 (portrait)
 */
export function createRenderer({ width = WIDTH, height = HEIGHT, safe, log = console } = {}) {
  registerFonts();
  // Logical size: 1920×1080 or 1080×1920. `safe` ({ top, bottom }, logical px) is portrait-only; default in theme.mjs.
  const frame = { ...frameFor(orientationOf(width, height)), ...(safe && { safe }) };
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';

  const measure = (text, px, bold) => { ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT_STACK}`; return ctx.measureText(text).width; };

  let key = null;
  let rgba = null;
  let jpegCache = null;
  let lastRenderMs = 0;

  function draw(model) {
    // Layout is in logical units (see theme.mjs); a smaller canvas (the 720p fallback) just scales it.
    ctx.setTransform(width / frame.width, 0, 0, height / frame.height, 0, 0);
    for (const o of layout(model, measure, frame)) {
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
