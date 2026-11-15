// CPU cost of the video path without a call:  npm run bench:video [-- --seconds 8]
// Runs the real publisher (src/video.mjs) with the real render loop and a real VideoSource.captureFrame, against a
// stub room, with the picture changing at the worst-case 2 Hz (every poll). Reports this process's CPU as a share of
// one core, for each resolution/fps combination.
//
// NOT included: the video ENCODER, which only runs for a track that is really published to a room. That cost shows
// up in the "[eris] video ... process cpu" line logged every 15 s during a real call (Agent Console or Chert).
import { THREE } from './fixtures.mjs';
import { startTeamVideo } from '../src/video.mjs';

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 8;
const quiet = { info() {}, warn: m => console.warn(m) };

let tick = 0;
const harness = {
  getAgents: async () => THREE.map(a => ({ ...a, task: `${a.task} (tick ${tick++ % 100})` })), // new content every poll
  getLog: async id => ({ lines: [`log of ${id}`, `run pytest → ${tick} passed`, 'edit signup.py', 'git commit'] }),
};
const room = { localParticipant: { publishTrack: async () => ({ sid: 'bench' }), unpublishTrack: async () => {} } };

const rows = [];
for (const [label, width, height, fps] of [['1080p15', 1920, 1080, 15], ['1080p10', 1920, 1080, 10], ['720p15', 1280, 720, 15], ['720p10', 1280, 720, 10]]) {
  const video = await startTeamVideo({
    room, harness, video: { fps, width, height }, log: quiet, statsEveryMs: 3_600_000,
    createLoop: async args => (await import('../render/index.mjs')).startRenderLoop({ ...args, serve: false }),
  });
  if (!video) { console.error(`${label}: could not start`); process.exit(1); }
  await new Promise(r => setTimeout(r, 1500)); // warm up
  video.stats(); // reset the measurement window
  await new Promise(r => setTimeout(r, seconds * 1000));
  const s = video.stats();
  await video.stop();
  rows.push({ config: label, 'fps achieved': s.fps.toFixed(1), 'cpu % of one core': s.cpuPercent.toFixed(1), 'last render ms': s.renderMs.toFixed(1) });
}
console.table(rows);
console.log('(render + frame hand-off only; the encoder is not included, see the header of this file)');
process.exit(0);
