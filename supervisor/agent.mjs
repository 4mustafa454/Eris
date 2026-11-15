// Eris: the PM voice agent. STT → LLM → TTS (providers chosen in src/config.mjs), the shared PM prompt and
// tools from shared/pm/, every turn logged to the harness. The call flow lives in src/call.mjs.
import { fileURLToPath } from 'node:url';
import { defineAgent, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { runAgent } from './chert-rooms.mjs';
import { handleCall } from './src/call.mjs';
import { createProviders, describeConfig, loadConfig } from './src/config.mjs';
import { createHarness } from './src/harness.mjs';

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
      `harness=${config.harnessUrl} greet-on-join=${config.greetOnJoin ? 'on (development)' : 'off'}`,
  );
}

const agent = defineAgent({
  // Loaded once per worker, before any call: the voice activity detector.
  prewarm: async proc => { proc.userData.vad = await silero.VAD.load(); },
  entry: ctx => handleCall(ctx, {
    config,
    harness: createHarness({ baseUrl: config.harnessUrl }),
    createProviders: () => createProviders(process.env),
    vad: ctx.proc.userData.vad,
    voice,
  }),
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'eris' });
