import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLogger } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { createProviders, describeConfig, loadConfig, registries, ROLES } from './config.mjs';

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
