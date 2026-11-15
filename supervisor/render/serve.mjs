// Standalone dev runner: the renderer against a real harness, no LiveKit, no keys.  npm run frames
// Serves http://localhost:8788/frame.jpg (open it in a browser, reload to refresh).
// Type  g  for the grid or  f 2  to focus Agent 2 (stdin); Ctrl+C to stop.
import { createInterface } from 'node:readline';
import { createHarness } from '../src/harness.mjs';
import { agentId } from '../src/tools.mjs';
import { loadVideoConfig } from '../src/config.mjs';
import { startRenderLoop } from './index.mjs';

const harnessUrl = process.env.HARNESS_URL || 'http://localhost:8787';
const port = Number(process.env.FRAME_PORT || 8788);
// Same size as the call video (VIDEO_ORIENTATION / VIDEO_RESOLUTION; portrait 1080×1920 by default).
const { width, height } = loadVideoConfig(process.env);
const loop = await startRenderLoop({ harness: createHarness({ baseUrl: harnessUrl }), harnessUrl, port, width, height });
if (loop.port === null) { console.error(`port ${port} is in use; is another frame server running?`); process.exit(1); }

const keepAlive = setInterval(() => {}, 1 << 30); // the poller and server are unref'd, so hold the process open
console.log(`[frames] http://localhost:${loop.port}/frame.jpg  (${width}x${height}, harness ${harnessUrl}; "g" = grid, "f 2" = focus Agent 2)`);

createInterface({ input: process.stdin }).on('line', line => {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'g') { loop.setMode('grid'); console.log('[frames] grid'); }
  else if (cmd === 'f') {
    const id = agentId(arg);
    if (id) { loop.setMode('focus', id); console.log(`[frames] focus ${id}`); } else console.log('[frames] usage: f <agent number>');
  }
});

const shutdown = async () => { clearInterval(keepAlive); await loop.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
