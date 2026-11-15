// The one entry point: poller → renderer → frame server. Part B (video publish, show_grid/focus_agent) only
// needs this: setMode(), currentRgba() for the camera track, snapshot() for "is there an agent N?".
import { startFrameServer } from './frame-server.mjs';
import { createPoller } from './poller.mjs';
import { createRenderer } from './renderer.mjs';

/**
 * @param {{ harness: object, harnessUrl?: string, port?: number, intervalMs?: number, logLines?: number,
 *           width?: number, height?: number, safe?: { top: number, bottom: number }, serve?: boolean, log?: Pick<Console,'warn'|'info'> }} options
 *   port: frame.jpg port (default 8788; 0 = any free port). serve:false skips the HTTP server.
 */
export async function startRenderLoop({ harness, harnessUrl, port = 8788, intervalMs = 500, logLines = 10, width, height, safe, serve = true, log = console }) {
  const renderer = createRenderer({ width, height, safe, log });
  const poller = createPoller({ harness, harnessUrl, intervalMs, logLines, onModel: model => renderer.render(model) });
  const server = serve ? await startFrameServer({ port, getJpeg: () => renderer.jpeg(), log }) : null;

  const ready = poller.tick(); // first frame as soon as the first poll lands
  poller.start();

  return {
    /** Resolves when the first frame (data or "unreachable") exists. */
    ready,
    /** Port frame.jpg is served on, or null (disabled, or the port was taken). */
    port: server?.port ?? null,
    /** Reset to grid at the start of each call. */
    setMode: (mode, agentId) => poller.setMode(mode, agentId),
    /** Latest data the poller has: { mode, focusId, agents, harness, ... }. */
    snapshot: () => poller.model,
    /** Latest frame as 1920×1080 RGBA (same instance until the content changes), or null before the first. */
    currentRgba: () => renderer.render(poller.model).rgba,
    currentJpeg: () => renderer.jpeg(),
    currentPng: () => renderer.png(),
    get lastRenderMs() { return renderer.lastRenderMs; },
    async stop() { poller.stop(); await server?.close(); },
  };
}
