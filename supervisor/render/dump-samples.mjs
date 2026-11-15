// Writes sample frames as PNGs so you can look at them:  npm run render:samples [-- --live]
//   default: every fixture × (grid, focus per agent) plus the unreachable frame
//   --live : one grid + one focus per agent from the running harness (HARNESS_URL, default http://localhost:8787)
// Output: supervisor/render/out/samples/ (gitignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELS } from './fixtures.mjs';
import { createHarness } from '../src/harness.mjs';
import { createRenderer } from './renderer.mjs';

const OUT = fileURLToPath(new URL('./out/samples/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const renderer = createRenderer();
const save = (name, model) => {
  const { ms } = renderer.render(model);
  const file = `${OUT}${name}.png`;
  writeFileSync(file, renderer.png());
  console.log(`${file}  (${ms.toFixed(1)} ms)`);
};

if (process.argv.includes('--live')) {
  const url = process.env.HARNESS_URL || 'http://localhost:8787';
  const harness = createHarness({ baseUrl: url });
  let agents;
  try {
    agents = await harness.getAgents();
  } catch (error) {
    console.error(`cannot reach the harness at ${url}: ${error.message}`);
    process.exit(1);
  }
  const logs = Object.fromEntries(await Promise.all(agents.map(async a => [a.id, (await harness.getLog(a.id, 10)).lines])));
  const base = { agents, logs, harness: 'ok', harnessUrl: url };
  save('live-grid', { ...base, mode: 'grid' });
  for (const a of agents) save(`live-focus-${a.id}`, { ...base, mode: 'focus', focusId: a.id });
} else {
  for (const [name, m] of Object.entries(MODELS)) {
    save(`${name}-grid`, { ...m, mode: 'grid', harness: 'ok' });
    for (const a of m.agents) save(`${name}-focus-${a.id}`, { ...m, mode: 'focus', focusId: a.id, harness: 'ok' });
  }
  save('unreachable', { harness: 'unreachable', harnessUrl: 'http://localhost:8787', lastSeen: '19:02:11Z', agents: [], logs: {} });
}
