// Provider registries and startup validation (AGENTS.md §10). One registry per role: STT, TTS, LLM.
//
// Each entry is { requires, optional?, create(env) }:
//   requires  env var names that must be set. A function of env is allowed for the one case where it
//             depends on another variable (OpenAI needs a key unless LLM_BASE_URL points elsewhere).
//   optional  env var names the entry reads when present (reported by describeConfig, URL-checked).
//   create    builds the LiveKit plugin instance. Nothing connects at construction time.
//
// Everything here takes an env object, so it is testable without touching process.env. Error text and
// describeConfig() mention variable NAMES only, never their values.
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';

/** The OpenAI plugin refuses to build without a key; local OpenAI-compatible servers ignore it. */
const NO_KEY = 'not-needed';

/** A value counts as set unless empty or still a YOUR_ placeholder from an old .env.example. */
const filled = value => typeof value === 'string' && value.trim() !== '' && !/^YOUR_/.test(value.trim());
const get = (env, name) => (filled(env[name]) ? env[name].trim() : undefined);

/**
 * Interruption tuning (all optional). Fewer false interruptions from echo and background noise: the caller must
 * speak for a while, and say actual words, before the PM stops talking; a false stop resumes by itself.
 * Names and units are from @livekit/agents turnHandling.interruption (milliseconds) and the Silero VAD.
 */
export const TURN_DEFAULTS = {
  minDurationMs: 600, //   LiveKit default 500
  minWords: 1, //          LiveKit default 0 (any noise that trips the VAD counts). 1 still lets a lone "stop" through.
  resumeFalse: true, //    resume the PM's sentence after a false interruption (LiveKit default true)
  vadActivationThreshold: 0.6, // Silero default 0.5: slightly harder for noise to count as speech
};

const TURN_VARS = {
  minDurationMs: { name: 'INTERRUPT_MIN_DURATION_MS', min: 0, max: 5000, integer: true },
  minWords: { name: 'INTERRUPT_MIN_WORDS', min: 0, max: 10, integer: true },
  vadActivationThreshold: { name: 'VAD_ACTIVATION_THRESHOLD', min: 0.1, max: 0.95 },
};

/** Every env var the interruption tuning reads (for .env.example). */
export const TURN_ENV = [...Object.values(TURN_VARS).map(v => v.name), 'INTERRUPT_RESUME_FALSE'];

/** Parses the interruption variables; bad values are reported as problems, never thrown from here. */
function readTurn(env, problems) {
  const out = { ...TURN_DEFAULTS };
  for (const [key, { name, min, max, integer }] of Object.entries(TURN_VARS)) {
    const raw = get(env, name);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      problems.push(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    } else out[key] = n;
  }
  const resume = get(env, 'INTERRUPT_RESUME_FALSE');
  if (resume !== undefined) {
    if (resume === '0' || resume === '1') out.resumeFalse = resume === '1';
    else problems.push('INTERRUPT_RESUME_FALSE must be 0 or 1');
  }
  return out;
}

/** The AgentSession `turnHandling` option for a loaded config's `turn` settings (defaults when omitted). */
export function buildTurnHandling(turn = TURN_DEFAULTS) {
  return {
    // The default end-of-turn detector needs LiveKit's inference executor, which Chert rooms do not have.
    turnDetection: 'vad',
    interruption: {
      minDuration: turn.minDurationMs,
      minWords: turn.minWords,
      resumeFalseInterruption: turn.resumeFalse,
    },
  };
}

export const registries = {
  stt: {
    deepgram: {
      requires: ['DEEPGRAM_API_KEY'],
      create: env => new deepgram.STT({ apiKey: get(env, 'DEEPGRAM_API_KEY'), model: 'nova-3' }),
    },
    elevenlabs: {
      requires: ['ELEVENLABS_API_KEY'],
      create: env => new elevenlabs.STT({ apiKey: get(env, 'ELEVENLABS_API_KEY') }),
    },
    // Any server with OpenAI's /audio/transcriptions (Groq, faster-whisper-server, ...). Not the
    // realtime websocket, which only OpenAI itself offers.
    'openai-compatible': {
      requires: ['STT_BASE_URL', 'STT_MODEL'],
      optional: ['STT_API_KEY'],
      create: env =>
        new openai.STT({
          baseURL: get(env, 'STT_BASE_URL'),
          model: get(env, 'STT_MODEL'),
          apiKey: get(env, 'STT_API_KEY') ?? NO_KEY,
          useRealtime: false,
        }),
    },
  },
  tts: {
    deepgram: {
      requires: ['DEEPGRAM_API_KEY'],
      create: env => new deepgram.TTS({ apiKey: get(env, 'DEEPGRAM_API_KEY'), model: 'aura-2-andromeda-en' }),
    },
    elevenlabs: {
      requires: ['ELEVENLABS_API_KEY'],
      optional: ['ELEVENLABS_VOICE_ID'],
      create: env =>
        new elevenlabs.TTS({
          apiKey: get(env, 'ELEVENLABS_API_KEY'),
          model: 'eleven_flash_v2_5',
          ...(get(env, 'ELEVENLABS_VOICE_ID') && { voiceId: get(env, 'ELEVENLABS_VOICE_ID') }),
        }),
    },
    'openai-compatible': {
      requires: ['TTS_BASE_URL', 'TTS_MODEL', 'TTS_VOICE'],
      optional: ['TTS_API_KEY'],
      create: env =>
        new openai.TTS({
          baseURL: get(env, 'TTS_BASE_URL'),
          model: get(env, 'TTS_MODEL'),
          voice: get(env, 'TTS_VOICE'),
          apiKey: get(env, 'TTS_API_KEY') ?? NO_KEY,
        }),
    },
  },
  llm: {
    // OpenAI itself, or any server reached through LLM_BASE_URL (Ollama: http://localhost:11434/v1).
    openai: {
      requires: env => (get(env, 'LLM_BASE_URL') ? [] : ['OPENAI_API_KEY']),
      optional: ['OPENAI_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'],
      create: env => buildLlm(env, { model: get(env, 'LLM_MODEL') ?? 'gpt-5-mini', apiKey: get(env, 'OPENAI_API_KEY') }),
    },
    // Explicit non-OpenAI endpoint: the URL and model are mandatory, the key optional.
    'openai-compatible': {
      requires: ['LLM_BASE_URL', 'LLM_MODEL'],
      optional: ['LLM_API_KEY'],
      create: env => buildLlm(env, { model: get(env, 'LLM_MODEL'), apiKey: get(env, 'LLM_API_KEY') }),
    },
  },
};

function buildLlm(env, { model, apiKey }) {
  const baseURL = get(env, 'LLM_BASE_URL');
  // strictToolSchema off: OpenAI's strict mode rejects tools with optional arguments (create_task.agent).
  return new openai.LLM({ model, apiKey: apiKey ?? NO_KEY, strictToolSchema: false, ...(baseURL && { baseURL }) });
}

/** Env var that picks each role's provider, and what it defaults to. */
export const ROLES = {
  stt: { selector: 'STT_PROVIDER', fallback: 'deepgram' },
  tts: { selector: 'TTS_PROVIDER', fallback: 'deepgram' },
  llm: { selector: 'LLM_PROVIDER', fallback: 'openai' },
};

const requiredNames = (entry, env) => (typeof entry.requires === 'function' ? entry.requires(env) : entry.requires);

/** Which provider a role picks and what it still needs. Never throws. */
function resolveRole(role, env) {
  const { selector, fallback } = ROLES[role];
  const name = (get(env, selector) ?? fallback).toLowerCase();
  const supported = Object.keys(registries[role]);
  const entry = registries[role][name];
  if (!entry) return { role, selector, name, supported, entry: undefined, required: [], optional: [], missing: [] };
  const required = requiredNames(entry, env);
  const optional = (entry.optional ?? []).filter(n => !required.includes(n));
  return { role, selector, name, supported, entry, required, optional, missing: required.filter(n => !get(env, n)) };
}

function problemsOf(resolved) {
  const label = resolved.role.toUpperCase();
  if (!resolved.entry) {
    return [`${label}: ${resolved.selector}="${resolved.name}" is not supported. Supported: ${resolved.supported.join(', ')}`];
  }
  const problems = [];
  if (resolved.missing.length) {
    problems.push(`${label}: ${resolved.selector}=${resolved.name} requires ${resolved.missing.join(', ')} (not set)`);
  }
  for (const name of [...resolved.required, ...resolved.optional]) {
    if (/_BASE_URL$/.test(name) && get(resolved.env, name) && !/^https?:\/\//.test(get(resolved.env, name))) {
      problems.push(`${label}: ${name} must start with http:// or https://`);
    }
  }
  return problems;
}

/**
 * Validates the environment and returns the non-secret settings. Fails fast with ONE error that lists
 * every problem (unknown provider, missing variable, bad URL), naming roles and variables only.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const resolved = Object.keys(ROLES).map(role => ({ ...resolveRole(role, env), env }));
  const harnessUrl = (get(env, 'HARNESS_URL') ?? 'http://localhost:8787').replace(/\/+$/, '');
  const problems = resolved.flatMap(problemsOf);
  const turn = readTurn(env, problems);
  if (!/^https?:\/\//.test(harnessUrl)) problems.push('HARNESS_URL must start with http:// or https://');
  if (problems.length) throw new Error(`Invalid supervisor configuration:\n- ${problems.join('\n- ')}`);
  return {
    providers: Object.fromEntries(resolved.map(r => [r.role, r.name])),
    harnessUrl,
    greetOnJoin: env.GREET_ON_JOIN === '1',
    turn,
  };
}

/**
 * Builds the selected STT, TTS and LLM plugin instances (validates first). Call it from the agent's
 * entry or prewarm: the plugins log while constructing, so LiveKit's logger must already be initialized.
 */
export function createProviders(env = process.env) {
  const { providers } = loadConfig(env);
  return Object.fromEntries(Object.keys(ROLES).map(role => [role, registries[role][providers[role]].create(env)]));
}

/**
 * The provider per role and which variables are set (true/false). Safe to log or show in Settings:
 * contains names and booleans, never values. Does not throw; an unsupported provider is reported.
 */
export function describeConfig(env = process.env) {
  const out = {};
  for (const role of Object.keys(ROLES)) {
    const r = { ...resolveRole(role, env), env };
    const flag = names => Object.fromEntries(names.map(n => [n, Boolean(get(env, n))]));
    const problems = problemsOf(r);
    out[role] = {
      provider: r.name,
      supported: r.supported,
      ok: problems.length === 0,
      required: flag(r.required),
      optional: flag(r.optional),
      ...(problems.length && { problems }),
    };
  }
  return out;
}
