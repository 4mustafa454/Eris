// Writes sample frames as PNGs so you can look at them:  npm run render:samples [-- --live]
//   default: every fixture × (grid, focus per agent) plus the unreachable frame, in BOTH orientations
//   --live : one grid + one focus per agent from the running harness (HARNESS_URL, default http://localhost:8787)
// Output: supervisor/render/out/samples/portrait/ and .../landscape/ (gitignored), 1080×1920 and 1920×1080, plus
// .../portrait-guides/: the same portrait frames with the safe-area bands (red, all four edges) and the self-view corner zones
// (magenta) drawn over them. Honours VIDEO_SAFE_TOP / VIDEO_SAFE_BOTTOM / VIDEO_SAFE_SIDE from the environment.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { MODELS } from './fixtures.mjs';
import { loadVideoConfig } from '../src/config.mjs';
import { cornerZones, safeOf } from './layout.mjs';
import { PORTRAIT } from './theme.mjs';
import { createHarness } from '../src/harness.mjs';
import { createRenderer } from './renderer.mjs';

const SIZES = { portrait: { width: 1080, height: 1920 }, landscape: { width: 1920, height: 1080 } };
const OUT = fileURLToPath(new URL('./out/samples/', import.meta.url));
const live = process.argv.includes('--live');
const { safe } = loadVideoConfig(process.env);

/** The frame with the safe-area bands and corner zones drawn on top (portrait only). */
async function withGuides(png, width) {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const k = width / PORTRAIT.width;
  const frame = { ...PORTRAIT, safe };
  const s = safeOf(frame);
  ctx.fillStyle = 'rgba(255, 60, 60, 0.28)';
  ctx.fillRect(0, 0, img.width, s.top * k);
  ctx.fillRect(0, (PORTRAIT.height - s.bottom) * k, img.width, s.bottom * k);
  ctx.fillRect(0, s.top * k, s.side * k, (PORTRAIT.height - s.top - s.bottom) * k); // the sides, between top and bottom
  ctx.fillRect((PORTRAIT.width - s.side) * k, s.top * k, s.side * k, (PORTRAIT.height - s.top - s.bottom) * k);
  ctx.fillStyle = 'rgba(255, 0, 255, 0.25)';
  for (const z of cornerZones(frame)) ctx.fillRect(z.x * k, z.y * k, z.w * k, z.h * k);
  return canvas.toBuffer('image/png');
}

let liveBase = null;
if (live) {
  const url = process.env.HARNESS_URL || 'http://localhost:8787';
  const harness = createHarness({ baseUrl: url });
  try {
    const agents = await harness.getAgents();
    const logs = Object.fromEntries(await Promise.all(agents.map(async a => [a.id, (await harness.getLog(a.id, 10)).lines])));
    liveBase = { agents, logs, harness: 'ok', harnessUrl: url };
  } catch (error) {
    console.error(`cannot reach the harness at ${url}: ${error.message}`);
    process.exit(1);
  }
}

for (const [orientation, size] of Object.entries(SIZES)) {
  const dir = `${OUT}${orientation}/`;
  mkdirSync(dir, { recursive: true });
  const renderer = createRenderer({ ...size, safe });
  const guideDir = `${OUT}${orientation}-guides/`;
  if (orientation === 'portrait') mkdirSync(guideDir, { recursive: true });
  const save = async (name, model) => {
    const { ms } = renderer.render(model);
    const file = `${dir}${name}.png`;
    writeFileSync(file, renderer.png());
    if (orientation === 'portrait') writeFileSync(`${guideDir}${name}.png`, await withGuides(renderer.png(), size.width));
    console.log(`${file}  (${ms.toFixed(1)} ms)`);
  };
  if (live) {
    await save('live-grid', { ...liveBase, mode: 'grid' });
    for (const a of liveBase.agents) await save(`live-focus-${a.id}`, { ...liveBase, mode: 'focus', focusId: a.id });
  } else {
    for (const [name, m] of Object.entries(MODELS)) {
      await save(`${name}-grid`, { ...m, mode: 'grid', harness: 'ok' });
      for (const a of m.agents) await save(`${name}-focus-${a.id}`, { ...m, mode: 'focus', focusId: a.id, harness: 'ok' });
    }
    await save('unreachable', { harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z', agents: [], logs: {} });
  }
}
