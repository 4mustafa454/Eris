import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTeamVideo } from './video.mjs';

const quiet = () => { const lines = { info: [], warn: [] }; return { lines, info: m => lines.info.push(m), warn: m => lines.warn.push(m) }; };

function fakeRtc() {
  const rec = { sources: [], frames: [], captured: [], tracks: [], options: [] };
  class VideoSource {
    constructor(w, h) { this.width = w; this.height = h; this.closed = 0; rec.sources.push(this); }
    captureFrame(frame) { if (rec.captureThrows) throw new Error('ffi'); rec.captured.push(frame); }
    async close() { this.closed += 1; }
  }
  class VideoFrame { constructor(data, width, height, type) { Object.assign(this, { data, width, height, type }); rec.frames.push(this); } }
  const LocalVideoTrack = { createVideoTrack: (name, source) => { const t = { name, source }; rec.tracks.push(t); return t; } };
  class TrackPublishOptions { constructor(o) { Object.assign(this, o); rec.options.push(this); } }
  return { rec, rtc: { VideoSource, VideoFrame, LocalVideoTrack, TrackPublishOptions, TrackSource: { SOURCE_CAMERA: 1 }, VideoBufferType: { RGBA: 0 } } };
}

function fakeRoom({ publish } = {}) {
  const rec = { published: [], unpublished: [] };
  return {
    rec,
    room: {
      localParticipant: {
        publishTrack: async (track, options) => { rec.published.push([track, options]); return publish ? publish(track, options) : { sid: 'TR_cam' }; },
        unpublishTrack: async sid => { rec.unpublished.push(sid); },
      },
    },
  };
}

function fakeLoop({ ready = Promise.resolve() } = {}) {
  const rec = { stops: 0, modes: [], args: null };
  const buffers = [new Uint8Array(4), new Uint8Array(4)];
  let current = 0;
  const loop = {
    ready, lastRenderMs: 4.2,
    setMode: (...args) => rec.modes.push(args),
    snapshot: () => ({ agents: [{ id: 'agent-1' }] }),
    currentRgba: () => buffers[current],
    stop: async () => { rec.stops += 1; },
  };
  return { rec, loop, buffers, change: () => { current = 1; } };
}

/** Collects schedule() calls so the test steps the pump and the stats report by hand. */
function fakeTimers() {
  const timers = [];
  const every = (fn, ms) => { const t = { fn, ms, stopped: false }; timers.push(t); return () => { t.stopped = true; }; };
  return { timers, every };
}

async function setup(overrides = {}) {
  const r = fakeRtc();
  const rm = fakeRoom(overrides.room);
  const lp = fakeLoop(overrides.loop);
  const tm = fakeTimers();
  const log = quiet();
  const createLoop = async args => { lp.rec.args = args; if (overrides.createLoop) return overrides.createLoop(args); return lp.loop; };
  const video = await startTeamVideo({
    room: rm.room, harness: {}, harnessUrl: 'http://h', video: { fps: 15, width: 1920, height: 1080 },
    rtc: r.rtc, createLoop, log, every: tm.every, publishTimeoutMs: 50, ...overrides.deps,
  });
  return { video, r, rm, lp, tm, log };
}

test('publishes one camera track from the agent\'s own participant, sized to the video settings', async () => {
  const { video, r, rm, lp } = await setup();
  assert.ok(video);
  assert.equal(rm.rec.published.length, 1);
  const [track, options] = rm.rec.published[0];
  assert.equal(track.name, 'eris-team');
  assert.equal(options.source, 1, 'SOURCE_CAMERA');
  assert.deepEqual([r.rec.sources[0].width, r.rec.sources[0].height], [1920, 1080]);
  assert.deepEqual([lp.rec.args.width, lp.rec.args.height], [1920, 1080]);
});

test('720p settings size both the source and the renderer', async () => {
  const { r, lp } = await setup({ deps: { video: { fps: 10, width: 1280, height: 720 } } });
  assert.deepEqual([r.rec.sources[0].width, r.rec.sources[0].height], [1280, 720]);
  assert.deepEqual([lp.rec.args.width, lp.rec.args.height], [1280, 720]);
});

test('the pump runs at the configured fps and sends RGBA frames', async () => {
  const { tm, r, lp } = await setup();
  const pump = tm.timers[0];
  assert.equal(pump.ms, 67, '15 fps');
  pump.fn();
  assert.equal(r.rec.captured.length, 1);
  assert.deepEqual([r.rec.captured[0].width, r.rec.captured[0].height, r.rec.captured[0].type], [1920, 1080, 0]);
  assert.equal(r.rec.captured[0].data, lp.buffers[0]);
});

test('10 fps schedules a 100 ms pump', async () => {
  const { tm } = await setup({ deps: { video: { fps: 10, width: 1280, height: 720 } } });
  assert.equal(tm.timers[0].ms, 100);
});

test('an unchanged picture re-sends the same VideoFrame; a new picture wraps a new buffer', async () => {
  const { tm, r, lp } = await setup();
  const pump = tm.timers[0].fn;
  pump(); pump(); pump();
  assert.equal(r.rec.frames.length, 1, 'wrapped once');
  assert.equal(r.rec.captured.length, 3);
  lp.change();
  pump();
  assert.equal(r.rec.frames.length, 2);
  assert.equal(r.rec.captured[3].data, lp.buffers[1]);
});

test('a failing captureFrame warns once and the pump keeps going', async () => {
  const { tm, r, log } = await setup();
  r.rec.captureThrows = true;
  tm.timers[0].fn(); tm.timers[0].fn();
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /video frame not sent: ffi/);
  r.rec.captureThrows = false;
  tm.timers[0].fn();
  assert.equal(r.rec.captured.length, 1);
});

test('publishing that hangs gives up after the timeout: null, cleaned up, one warning', async () => {
  const { video, r, lp, log } = await setup({ room: { publish: () => new Promise(() => {}) } });
  assert.equal(video, null);
  assert.equal(r.rec.sources[0].closed, 1);
  assert.equal(lp.rec.stops, 1);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /audio only.*publishing the video track timed out/);
});

test('a rejected publish, a failing loop, or a first frame that never comes all fall back to audio only', async () => {
  const rejected = await setup({ room: { publish: async () => { throw new Error('denied'); } } });
  assert.equal(rejected.video, null);
  assert.match(rejected.log.lines.warn[0], /denied/);

  const noLoop = await setup({ createLoop: async () => { throw new Error('no canvas'); } });
  assert.equal(noLoop.video, null);
  assert.equal(noLoop.rm.rec.published.length, 0);
  assert.match(noLoop.log.lines.warn[0], /no canvas/);

  const slow = await setup({ loop: { ready: new Promise(() => {}) } });
  assert.equal(slow.video, null);
  assert.equal(slow.lp.rec.stops, 1);
  assert.match(slow.log.lines.warn[0], /first frame timed out/);
  assert.equal(slow.tm.timers.length, 0, 'no pump started');
});

test('stop: ends the pump and the report, unpublishes, closes the source and the loop, and is idempotent', async () => {
  const { video, tm, r, rm, lp } = await setup();
  await video.stop();
  await video.stop();
  assert.ok(tm.timers.every(t => t.stopped));
  assert.deepEqual(rm.rec.unpublished, ['TR_cam']);
  assert.equal(r.rec.sources[0].closed, 1);
  assert.equal(lp.rec.stops, 1);
});

test('stop survives a room that is already gone', async () => {
  const { video, rm, lp } = await setup();
  rm.room.localParticipant.unpublishTrack = async () => { throw new Error('room closed'); };
  await video.stop();
  assert.equal(lp.rec.stops, 1);
});

test('setMode and snapshot go to the render loop', async () => {
  const { video, lp } = await setup();
  video.setMode('focus', 'agent-2');
  assert.deepEqual(lp.rec.modes, [['focus', 'agent-2']]);
  assert.equal(video.snapshot().agents[0].id, 'agent-1');
});

test('the CPU report: fps and share of one core over the interval, logged on the stats timer', async () => {
  let wall = 1000;
  let cpu = { user: 0, system: 0 };
  const { video, tm, log } = await setup({ deps: { clock: () => wall, cpuUsage: () => cpu } });
  for (let i = 0; i < 15; i++) tm.timers[0].fn();
  wall += 1000;
  cpu = { user: 300_000, system: 50_000 }; // 350 ms of CPU in 1000 ms
  tm.timers[1].fn();
  assert.equal(tm.timers[1].ms, 15000);
  assert.match(log.lines.info[0], /15\.0 fps at 1920x1080, process cpu 35% of one core, last render 4\.2 ms/);
  for (let i = 0; i < 10; i++) tm.timers[0].fn();
  wall += 1000;
  const s = video.stats();
  assert.equal(Math.round(s.fps), 10);
});

test('the safe area from the video settings is handed to the render loop', async () => {
  const { lp } = await setup({ deps: { video: { fps: 15, width: 1080, height: 1920, safe: { top: 120, bottom: 260, side: 110 } } } });
  assert.deepEqual(lp.rec.args.safe, { top: 120, bottom: 260, side: 110 });
  assert.deepEqual([lp.rec.args.width, lp.rec.args.height], [1080, 1920]);
});
