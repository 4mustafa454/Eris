// The team view as the agent's camera track (AGENTS.md §5.5, Chert rules in AGENTS.md here).
//
// One participant publishes both audio and video: the agent's own localParticipant, the one that speaks.
// A second video participant would not be seen by the Mac, and a second audio publisher ends the call.
// Frames come from render/ as RGBA, which VideoFrame accepts directly (VideoBufferType.RGBA), so there is no
// conversion step. Nothing here may delay or break the call: every failure logs one warning and returns null,
// and the call carries on with audio only.
import * as livekitRtc from '@livekit/rtc-node';
import { startRenderLoop } from '../render/index.mjs';

const TRACK_NAME = 'eris-team';

/** Rejects after ms; the timer never keeps the process alive and is always cleared. */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const every = (fn, ms) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); };

/**
 * @param {{
 *   room: { localParticipant: { publishTrack(track: any, options: any): Promise<{ sid?: string }>, unpublishTrack(sid: string): Promise<void> } },
 *   harness: object, harnessUrl?: string,
 *   video: { fps: number, width: number, height: number, safe?: { top: number, bottom: number } },
 *   rtc?: typeof livekitRtc, createLoop?: typeof startRenderLoop,
 *   log?: Pick<Console, 'info' | 'warn'>,
 *   publishTimeoutMs?: number, statsEveryMs?: number,
 *   every?: (fn: () => void, ms: number) => () => void,
 *   cpuUsage?: () => { user: number, system: number }, clock?: () => number,
 * }} deps
 * @returns {Promise<null | { setMode(mode: 'grid' | 'focus', agentId?: string): void, snapshot(): any, stats(): object, stop(): Promise<void> }>}
 */
export async function startTeamVideo({
  room, harness, harnessUrl, video, rtc = livekitRtc, createLoop = startRenderLoop, log = console,
  publishTimeoutMs = 5000, statsEveryMs = 15000, every: schedule = every,
  cpuUsage = () => process.cpuUsage(), clock = () => performance.now(),
}) {
  const { fps, width, height, safe } = video;
  let loop = null;
  let source = null;
  let publication = null;
  const cleanups = [];
  const abandon = async () => {
    for (const stop of cleanups.splice(0).reverse()) { try { await stop(); } catch { /* best effort */ } }
  };

  try {
    loop = await createLoop({ harness, harnessUrl, width, height, safe, log });
    cleanups.push(() => loop.stop());
    // Bounded: a slow harness must not hold up the greeting. The loop draws the "unreachable" frame by itself.
    await withTimeout(loop.ready, publishTimeoutMs, 'first frame');

    source = new rtc.VideoSource(width, height);
    cleanups.push(() => source.close());
    const track = rtc.LocalVideoTrack.createVideoTrack(TRACK_NAME, source);
    const options = new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_CAMERA });
    publication = await withTimeout(room.localParticipant.publishTrack(track, options), publishTimeoutMs, 'publishing the video track');
  } catch (error) {
    log.warn(`[eris] video unavailable, continuing with audio only: ${error.message}`);
    await abandon();
    return null;
  }

  // --- frame pump: the same RGBA buffer is wrapped once and re-sent until the picture changes -----------------
  let lastRgba = null;
  let lastFrame = null;
  let sent = 0;
  let captureWarned = false;
  const pump = () => {
    try {
      const rgba = loop.currentRgba();
      if (rgba !== lastRgba) {
        lastRgba = rgba;
        lastFrame = new rtc.VideoFrame(rgba, width, height, rtc.VideoBufferType.RGBA);
      }
      source.captureFrame(lastFrame);
      loop.markPublished?.();
      sent += 1;
    } catch (error) {
      if (!captureWarned) { captureWarned = true; log.warn(`[eris] video frame not sent: ${error.message}`); }
    }
  };
  const stopPump = schedule(pump, Math.round(1000 / fps));

  // --- CPU/fps report: the whole process (voice + video), as a share of one core ---------------------------------
  let mark = { at: clock(), cpu: cpuUsage(), sent: 0 };
  const stats = () => {
    const now = clock();
    const cpu = cpuUsage();
    const wallMs = Math.max(now - mark.at, 1);
    const cpuMs = (cpu.user - mark.cpu.user + (cpu.system - mark.cpu.system)) / 1000;
    const out = {
      fps: ((sent - mark.sent) * 1000) / wallMs,
      cpuPercent: (cpuMs / wallMs) * 100,
      renderMs: loop.lastRenderMs,
      width, height,
    };
    mark = { at: now, cpu, sent };
    return out;
  };
  const stopStats = schedule(() => {
    const s = stats();
    log.info(`[eris] video ${s.fps.toFixed(1)} fps at ${width}x${height}, process cpu ${s.cpuPercent.toFixed(0)}% of one core, last render ${s.renderMs.toFixed(1)} ms`);
  }, statsEveryMs);

  let stopped = false;
  return {
    setMode: (mode, agentId) => loop.setMode(mode, agentId),
    snapshot: () => loop.snapshot(),
    stats,
    async stop() {
      if (stopped) return;
      stopped = true;
      stopPump();
      stopStats();
      try { if (publication?.sid) await room.localParticipant.unpublishTrack(publication.sid); } catch { /* room already closed */ }
      await abandon();
    },
  };
}
