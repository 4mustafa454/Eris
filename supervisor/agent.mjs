// Eris: the PM voice agent. STT → LLM → TTS (providers chosen in src/config.mjs), the shared PM prompt and
// tools from shared/pm/, every turn logged to the harness. The call flow lives in src/call.mjs.
import { fileURLToPath } from 'node:url';
import { defineAgent, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { runAgent } from './chert-rooms.mjs';
import { handleCall } from './src/call.mjs';
import { buildVadOptions, createProviders, describeConfig, loadConfig } from './src/config.mjs';
import { createHarness } from './src/harness.mjs';
import { startTeamVideo } from './src/video.mjs';

// Fail fast: a bad provider name or a missing key stops startup with one message naming the variables.
// (Not for --help, which runs without an env file.)
let config;
if (!process.argv.some(arg => arg === '--help' || arg === '-h')) {
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(`[eris] ${error.message}`);
    process.exit(1);
  }
  const roles = describeConfig(process.env);
  console.log(
    `[eris] stt=${roles.stt.provider} tts=${roles.tts.provider} llm=${roles.llm.provider} ` +
      `interrupt=${config.turn.minDurationMs}ms/${config.turn.minWords}w vad=${config.turn.vadActivationThreshold} ` +
      `video=${config.video.width}x${config.video.height}@${config.video.fps} harness=${config.harnessUrl} greet-on-join=${config.greetOnJoin ? 'on (development)' : 'off'}`,
  );
}

const agent = defineAgent({
  // Loaded once per worker, before any call: the voice activity detector.
  prewarm: async proc => { proc.userData.vad = await silero.VAD.load(buildVadOptions(config)); },
  entry: ctx => {
    const harness = createHarness({ baseUrl: config.harnessUrl });
    return handleCall(ctx, {
      config,
      harness,
      // Short timeouts: the greeting must not wait on video (Chert ends a silent call 10 s after bridge_ready).
      startVideo: room => startTeamVideo({ room, harness, harnessUrl: config.harnessUrl, video: config.video, publishTimeoutMs: 3000 }),
      createProviders: () => createProviders(process.env),
      vad: ctx.proc.userData.vad,
      voice,
    });
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'eris' });
