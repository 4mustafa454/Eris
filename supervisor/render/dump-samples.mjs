// Writes sample frames as PNGs so you can look at them:  npm run render:samples [-- --live]
//   default: every fixture × (grid, focus per agent) plus the unreachable frame, in BOTH orientations
//   --live : one grid + one focus per agent from the running harness (HARNESS_URL, default http://localhost:8787)
// Output: supervisor/render/out/samples/portrait/ and .../landscape/ (gitignored), 1080×1920 and 1920×1080.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELS } from './fixtures.mjs';
import { createHarness } from '../src/harness.mjs';
import { createRenderer } from './renderer.mjs';

const SIZES = { portrait: { width: 1080, height: 1920 }, landscape: { width: 1920, height: 1080 } };
const OUT = fileURLToPath(new URL('./out/samples/', import.meta.url));
const live = process.argv.includes('--live');

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
  const renderer = createRenderer(size);
  const save = (name, model) => {
    const { ms } = renderer.render(model);
    const file = `${dir}${name}.png`;
    writeFileSync(file, renderer.png());
    console.log(`${file}  (${ms.toFixed(1)} ms)`);
  };
  if (live) {
    save('live-grid', { ...liveBase, mode: 'grid' });
    for (const a of liveBase.agents) save(`live-focus-${a.id}`, { ...liveBase, mode: 'focus', focusId: a.id });
  } else {
    for (const [name, m] of Object.entries(MODELS)) {
      save(`${name}-grid`, { ...m, mode: 'grid', harness: 'ok' });
      for (const a of m.agents) save(`${name}-focus-${a.id}`, { ...m, mode: 'focus', focusId: a.id, harness: 'ok' });
    }
    save('unreachable', { harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z', agents: [], logs: {} });
  }
}
