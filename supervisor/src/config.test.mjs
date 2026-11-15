import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLogger } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { buildTurnHandling, buildVadOptions, loadVideoConfig, createProviders, describeConfig, loadConfig, registries, ROLES } from './config.mjs';

// The plugins log from their constructors; at runtime the LiveKit CLI / chert-rooms.mjs does this first.
initializeLogger({ pretty: false, level: 'silent' });

// Distinct, recognizable fake secrets so a leak is easy to spot.
const SECRET = {
  DEEPGRAM_API_KEY: 'dg-SECRET-111',
  ELEVENLABS_API_KEY: 'el-SECRET-222',
  OPENAI_API_KEY: 'sk-SECRET-333',
  STT_API_KEY: 'stt-SECRET-444',
  TTS_API_KEY: 'tts-SECRET-555',
  LLM_API_KEY: 'llm-SECRET-666',
};
const SECRET_VALUES = Object.values(SECRET);

// Values for every variable any registry entry can require.
const VARS = {
  ...SECRET,
  STT_BASE_URL: 'http://localhost:9000/v1',
  STT_MODEL: 'whisper-1',
  TTS_BASE_URL: 'http://localhost:9001/v1',
  TTS_MODEL: 'tts-1',
  TTS_VOICE: 'alloy',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_MODEL: 'gpt-oss:20b',
};
const base = { DEEPGRAM_API_KEY: SECRET.DEEPGRAM_API_KEY, OPENAI_API_KEY: SECRET.OPENAI_API_KEY };

// Expected plugin class for every registry entry.
const CLASSES = {
  stt: { deepgram: deepgram.STT, elevenlabs: elevenlabs.STT, 'openai-compatible': openai.STT },
  tts: { deepgram: deepgram.TTS, elevenlabs: elevenlabs.TTS, 'openai-compatible': openai.TTS },
  llm: { openai: openai.LLM, 'openai-compatible': openai.LLM },
};

/** Env selecting `name` for `role` with exactly that entry's required variables set. */
function envFor(role, name) {
  const entry = registries[role][name];
  const required = typeof entry.requires === 'function' ? entry.requires({}) : entry.requires;
  return { ...base, [ROLES[role].selector]: name, ...Object.fromEntries(required.map(n => [n, VARS[n]])) };
}

test('defaults: deepgram STT, deepgram TTS, openai LLM', () => {
  const c = loadConfig(base);
  assert.deepEqual(c.providers, { stt: 'deepgram', tts: 'deepgram', llm: 'openai' });
  assert.equal(c.harnessUrl, 'http://localhost:8787');
  assert.equal(c.greetOnJoin, false);
});

test('the registries have the planned entries', () => {
  assert.deepEqual(Object.keys(registries.stt), ['deepgram', 'elevenlabs', 'openai-compatible']);
  assert.deepEqual(Object.keys(registries.tts), ['deepgram', 'elevenlabs', 'openai-compatible']);
  assert.deepEqual(Object.keys(registries.llm), ['openai', 'openai-compatible']);
  for (const role of Object.keys(registries)) {
    for (const entry of Object.values(registries[role])) {
      assert.equal(typeof entry.create, 'function');
      assert.ok(Array.isArray(entry.requires) || typeof entry.requires === 'function');
    }
  }
});

for (const role of Object.keys(registries)) {
  for (const name of Object.keys(registries[role])) {
    test(`${role} "${name}" resolves with its required variables and builds the right plugin`, () => {
      const env = envFor(role, name);
      assert.equal(loadConfig(env).providers[role], name);
      const built = createProviders(env)[role];
      assert.ok(built instanceof CLASSES[role][name], `${role}/${name} built ${built.constructor.name}`);
    });

    test(`${role} "${name}" fails naming each missing required variable`, () => {
      const entry = registries[role][name];
      const required = typeof entry.requires === 'function' ? entry.requires({}) : entry.requires;
      for (const missing of required) {
        const env = envFor(role, name);
        delete env[missing];
        // an OpenAI key would otherwise satisfy the default llm/stt/tts neighbours; remove only the target
        assert.throws(
          () => loadConfig(env),
          err => err.message.includes(missing) && err.message.includes(role.toUpperCase()) && err.message.includes(`${ROLES[role].selector}=${name}`),
          `${role}/${name} without ${missing}`,
        );
      }
    });
  }
}

test('provider names are trimmed and case-insensitive', () => {
  const c = loadConfig({ ...base, ELEVENLABS_API_KEY: 'x', STT_PROVIDER: ' ElevenLabs ', TTS_PROVIDER: 'ELEVENLABS' });
  assert.equal(c.providers.stt, 'elevenlabs');
  assert.equal(c.providers.tts, 'elevenlabs');
});

for (const role of Object.keys(registries)) {
  test(`unknown ${role} provider fails with role, bad value and the supported list from the registry`, () => {
    const selector = ROLES[role].selector;
    assert.throws(
      () => loadConfig({ ...base, [selector]: 'whisperx' }),
      err =>
        err.message.includes(role.toUpperCase()) &&
        err.message.includes(`${selector}="whisperx"`) &&
        err.message.includes(`Supported: ${Object.keys(registries[role]).join(', ')}`),
    );
  });
}

test('all problems come back in one error', () => {
  assert.throws(
    () => loadConfig({ STT_PROVIDER: 'nope' }),
    err => /STT: .*nope/.test(err.message) && /TTS: .*DEEPGRAM_API_KEY/.test(err.message) && /LLM: .*OPENAI_API_KEY/.test(err.message),
  );
});

test('openai LLM needs no key when LLM_BASE_URL is set (Ollama)', () => {
  const env = { DEEPGRAM_API_KEY: 'x', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'gpt-oss:20b' };
  assert.equal(loadConfig(env).providers.llm, 'openai');
  assert.ok(createProviders(env).llm instanceof openai.LLM);
  assert.throws(() => loadConfig({ DEEPGRAM_API_KEY: 'x' }), /OPENAI_API_KEY/);
});

test('YOUR_ placeholders count as unset', () => {
  assert.throws(() => loadConfig({ ...base, DEEPGRAM_API_KEY: 'YOUR_DEEPGRAM_API_KEY' }), /DEEPGRAM_API_KEY/);
});

test('base URLs must be http(s), and HARNESS_URL too', () => {
  assert.throws(() => loadConfig({ ...base, LLM_BASE_URL: 'localhost:11434' }), /LLM_BASE_URL must start with http/);
  assert.throws(
    () => loadConfig({ ...envFor('stt', 'openai-compatible'), STT_BASE_URL: 'whisper.local' }),
    /STT_BASE_URL must start with http/,
  );
  assert.throws(() => loadConfig({ ...base, HARNESS_URL: 'localhost:8787' }), /HARNESS_URL must start with http/);
  assert.equal(loadConfig({ ...base, HARNESS_URL: 'http://h:1/' }).harnessUrl, 'http://h:1');
});

test('GREET_ON_JOIN is on only for exactly "1"', () => {
  assert.equal(loadConfig({ ...base, GREET_ON_JOIN: '1' }).greetOnJoin, true);
  for (const v of ['0', '', 'true', 'yes', undefined]) assert.equal(loadConfig({ ...base, GREET_ON_JOIN: v }).greetOnJoin, false, String(v));
});

test('describeConfig reports provider, ok and which variables are set, as booleans', () => {
  const d = describeConfig({ ...base, TTS_PROVIDER: 'elevenlabs', LLM_PROVIDER: 'openai-compatible' });
  assert.equal(d.stt.provider, 'deepgram');
  assert.deepEqual(d.stt.required, { DEEPGRAM_API_KEY: true });
  assert.equal(d.stt.ok, true);
  assert.deepEqual(d.stt.supported, Object.keys(registries.stt));
  assert.deepEqual(d.tts.required, { ELEVENLABS_API_KEY: false });
  assert.deepEqual(d.tts.optional, { ELEVENLABS_VOICE_ID: false });
  assert.equal(d.tts.ok, false);
  assert.deepEqual(d.llm.required, { LLM_BASE_URL: false, LLM_MODEL: false });
  assert.ok(d.llm.problems.length > 0);
});

test('describeConfig never throws, even for an unsupported provider', () => {
  const d = describeConfig({ STT_PROVIDER: 'whisperx' });
  assert.equal(d.stt.ok, false);
  assert.match(d.stt.problems[0], /Supported: deepgram, elevenlabs, openai-compatible/);
});

test('describeConfig contains no secret value, only names and booleans', () => {
  const env = { ...VARS, STT_PROVIDER: 'openai-compatible', TTS_PROVIDER: 'elevenlabs', LLM_PROVIDER: 'openai' };
  const text = JSON.stringify(describeConfig(env));
  for (const secret of SECRET_VALUES) assert.ok(!text.includes(secret), `leaked ${secret}`);
  for (const role of Object.values(describeConfig(env))) {
    for (const v of [...Object.values(role.required), ...Object.values(role.optional)]) assert.equal(typeof v, 'boolean');
  }
});

test('error text never contains secret values', () => {
  const env = { ...VARS, STT_PROVIDER: 'nope', TTS_PROVIDER: 'nope', LLM_PROVIDER: 'nope', HARNESS_URL: 'bad' };
  try {
    loadConfig(env);
    assert.fail('should throw');
  } catch (err) {
    for (const secret of SECRET_VALUES) assert.ok(!err.message.includes(secret), `leaked ${secret}`);
  }
  try {
    const { ELEVENLABS_API_KEY, ...rest } = { ...VARS, TTS_PROVIDER: 'elevenlabs' };
    loadConfig(rest);
    assert.fail('should throw');
  } catch (err) {
    assert.match(err.message, /ELEVENLABS_API_KEY/);
    for (const secret of SECRET_VALUES) assert.ok(!err.message.includes(secret), `leaked ${secret}`);
  }
});

test('interruption defaults: 600 ms, 1 word, resume after false interruptions, VAD threshold 0.6', () => {
  const { turn } = loadConfig(base);
  assert.deepEqual(turn, { minDurationMs: 600, minWords: 1, resumeFalse: true, vadActivationThreshold: 0.6 });
  assert.deepEqual(buildTurnHandling(turn), {
    turnDetection: 'vad',
    interruption: { minDuration: 600, minWords: 1, resumeFalseInterruption: true },
  });
  assert.deepEqual(buildTurnHandling(), buildTurnHandling(turn));
});

test('interruption variables override the defaults; empty values and placeholders mean the default', () => {
  const { turn } = loadConfig({
    ...base, INTERRUPT_MIN_DURATION_MS: '900', INTERRUPT_MIN_WORDS: '2', INTERRUPT_RESUME_FALSE: '0', VAD_ACTIVATION_THRESHOLD: '0.75',
  });
  assert.deepEqual(turn, { minDurationMs: 900, minWords: 2, resumeFalse: false, vadActivationThreshold: 0.75 });
  assert.deepEqual(loadConfig({ ...base, INTERRUPT_MIN_WORDS: '', INTERRUPT_MIN_DURATION_MS: 'YOUR_VALUE' }).turn.minWords, 1);
  assert.equal(loadConfig({ ...base, INTERRUPT_MIN_WORDS: '0' }).turn.minWords, 0, '0 is a real value, not "unset"');
});

test('bad interruption values fail startup naming the variable, alongside any other problems', () => {
  for (const [name, value] of [
    ['INTERRUPT_MIN_DURATION_MS', '-1'], ['INTERRUPT_MIN_DURATION_MS', 'fast'], ['INTERRUPT_MIN_DURATION_MS', '600.5'],
    ['INTERRUPT_MIN_WORDS', '1.5'], ['INTERRUPT_MIN_WORDS', '99'],
    ['INTERRUPT_RESUME_FALSE', 'yes'], ['VAD_ACTIVATION_THRESHOLD', '1.5'], ['VAD_ACTIVATION_THRESHOLD', '0'],
  ]) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.throws(() => loadConfig({ ...base, STT_PROVIDER: 'nope', INTERRUPT_MIN_WORDS: 'x' }), /STT_PROVIDER[\s\S]*INTERRUPT_MIN_WORDS/);
});

test('video defaults to 15 fps, portrait 1080×1920; env switches orientation and the 720p / 10 fps fallback', () => {
  assert.deepEqual(loadConfig(base).video, { fps: 15, resolution: '1080p', orientation: 'portrait', safe: { top: 120, bottom: 260 }, width: 1080, height: 1920 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_FPS: '10', VIDEO_RESOLUTION: '720P' }).video, { fps: 10, resolution: '720p', orientation: 'portrait', safe: { top: 120, bottom: 260 }, width: 720, height: 1280 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_ORIENTATION: 'Landscape' }).video, { fps: 15, resolution: '1080p', orientation: 'landscape', safe: { top: 120, bottom: 260 }, width: 1920, height: 1080 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_ORIENTATION: 'landscape', VIDEO_RESOLUTION: '720p' }).video, { fps: 15, resolution: '720p', orientation: 'landscape', safe: { top: 120, bottom: 260 }, width: 1280, height: 720 });
  assert.equal(loadConfig({ ...base, VIDEO_FPS: '', VIDEO_ORIENTATION: '' }).video.fps, 15);
  assert.equal(loadConfig({ ...base, VIDEO_ORIENTATION: '' }).video.orientation, 'portrait');
});

test('bad video values fail startup naming the variable', () => {
  for (const [name, value] of [['VIDEO_FPS', '0'], ['VIDEO_FPS', '31'], ['VIDEO_FPS', '7.5'], ['VIDEO_FPS', 'x'], ['VIDEO_RESOLUTION', '4k'], ['VIDEO_RESOLUTION', '800x600'], ['VIDEO_ORIENTATION', 'square'], ['VIDEO_ORIENTATION', 'sideways']]) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test('loadVideoConfig reads only the video settings, with no provider keys', () => {
  assert.deepEqual(loadVideoConfig({}), loadConfig(base).video);
  assert.deepEqual(loadVideoConfig({ VIDEO_ORIENTATION: 'landscape' }).width, 1920);
  assert.throws(() => loadVideoConfig({ VIDEO_ORIENTATION: 'x', VIDEO_FPS: '0' }), /VIDEO_FPS[\s\S]*VIDEO_ORIENTATION/);
});

test('safe area: 120 top / 260 bottom by default; VIDEO_SAFE_TOP and VIDEO_SAFE_BOTTOM override each, 0 is a real value', () => {
  assert.deepEqual(loadConfig(base).video.safe, { top: 120, bottom: 260 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_SAFE_TOP: '200' }).video.safe, { top: 200, bottom: 260 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_SAFE_BOTTOM: '300' }).video.safe, { top: 120, bottom: 300 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_SAFE_TOP: '0', VIDEO_SAFE_BOTTOM: '0' }).video.safe, { top: 0, bottom: 0 });
  assert.deepEqual(loadConfig({ ...base, VIDEO_SAFE_TOP: '', VIDEO_SAFE_BOTTOM: 'YOUR_VALUE' }).video.safe, { top: 120, bottom: 260 });
  assert.deepEqual(loadVideoConfig({ VIDEO_SAFE_BOTTOM: '400' }).safe, { top: 120, bottom: 400 });
});

test('the safe area is in 1080p pixels whatever the resolution; the renderer scales it', () => {
  assert.deepEqual(loadConfig({ ...base, VIDEO_RESOLUTION: '720p' }).video.safe, { top: 120, bottom: 260 });
});

test('bad safe-area values fail startup naming the variable', () => {
  for (const [name, value] of [['VIDEO_SAFE_TOP', '-1'], ['VIDEO_SAFE_TOP', '601'], ['VIDEO_SAFE_TOP', '12.5'], ['VIDEO_SAFE_TOP', 'x'], ['VIDEO_SAFE_BOTTOM', '-5'], ['VIDEO_SAFE_BOTTOM', 'big']]) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.throws(() => loadConfig({ ...base, VIDEO_SAFE_TOP: '500', VIDEO_SAFE_BOTTOM: '500' }), /VIDEO_SAFE_TOP \+ VIDEO_SAFE_BOTTOM must be at most 900/);
  assert.doesNotThrow(() => loadConfig({ ...base, VIDEO_SAFE_TOP: '450', VIDEO_SAFE_BOTTOM: '450' }));
});
