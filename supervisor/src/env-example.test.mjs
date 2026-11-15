import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registries, ROLES, TURN_ENV } from './config.mjs';

const text = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const assignments = text.split('\n').filter(l => /^[A-Z][A-Z0-9_]*=/.test(l));
const names = assignments.map(l => l.split('=')[0]);

test('.env.example has names only, no values', () => {
  for (const line of assignments) assert.match(line, /^[A-Z][A-Z0-9_]*=$/, `value set in: ${line.split('=')[0]}`);
});

test('.env.example has no duplicate names', () => {
  assert.equal(new Set(names).size, names.length);
});

test('.env.example lists every variable the supervisor reads', () => {
  const wanted = new Set([
    'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'AGENT_NAME',
    'HARNESS_URL', 'GREET_ON_JOIN', 'LOG_LEVEL',
  ]);
  for (const name of TURN_ENV) wanted.add(name);
  for (const { selector } of Object.values(ROLES)) wanted.add(selector);
  for (const role of Object.values(registries)) {
    for (const entry of Object.values(role)) {
      const required = typeof entry.requires === 'function' ? [...entry.requires({}), ...entry.requires({ LLM_BASE_URL: 'x' })] : entry.requires;
      for (const name of [...required, ...(entry.optional ?? [])]) wanted.add(name);
    }
  }
  const missing = [...wanted].filter(n => !names.includes(n));
  assert.deepEqual(missing, [], `missing from .env.example: ${missing.join(', ')}`);
});

test('.env.example has nothing the supervisor does not read', () => {
  const known = new Set(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'AGENT_NAME', 'HARNESS_URL', 'GREET_ON_JOIN', 'LOG_LEVEL']);
  for (const name of TURN_ENV) known.add(name);
  for (const { selector } of Object.values(ROLES)) known.add(selector);
  for (const role of Object.values(registries)) {
    for (const entry of Object.values(role)) {
      const required = typeof entry.requires === 'function' ? [...entry.requires({}), ...entry.requires({ LLM_BASE_URL: 'x' })] : entry.requires;
      for (const name of [...required, ...(entry.optional ?? [])]) known.add(name);
    }
  }
  assert.deepEqual(names.filter(n => !known.has(n)), []);
});
