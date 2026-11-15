import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFrameServer } from './frame-server.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const quiet = { warn() {}, info() {} };

test('503 before the first frame, then 200 image/jpeg with the JPEG bytes', async () => {
  let frame = null;
  const server = await startFrameServer({ port: 0, getJpeg: () => frame, log: quiet });
  const url = `http://127.0.0.1:${server.port}/frame.jpg`;
  try {
    assert.equal((await fetch(url)).status, 503);
    frame = JPEG;
    const res = await fetch(`${url}?t=123`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...body.subarray(0, 2)], [0xff, 0xd8]);
    assert.ok(body.equals(JPEG));
    const other = await fetch(url, { headers: { origin: 'http://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    await other.arrayBuffer();
  } finally { await server.close(); }
});

test('other paths and methods are 404', async () => {
  const server = await startFrameServer({ port: 0, getJpeg: () => JPEG, log: quiet });
  try {
    for (const [path, method] of [['/', 'GET'], ['/frame.png', 'GET'], ['/frame.jpg', 'POST']]) {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}${path}`, { method })).status, 404, `${method} ${path}`);
    }
  } finally { await server.close(); }
});

test('a throwing encoder gives 503, not a crash', async () => {
  const server = await startFrameServer({ port: 0, getJpeg: () => { throw new Error('encode'); }, log: quiet });
  try { assert.equal((await fetch(`http://127.0.0.1:${server.port}/frame.jpg`)).status, 503); } finally { await server.close(); }
});

test('a port already in use resolves null and warns once', async () => {
  const first = await startFrameServer({ port: 0, getJpeg: () => JPEG, log: quiet });
  const warnings = [];
  try {
    const second = await startFrameServer({ port: first.port, getJpeg: () => JPEG, log: { warn: m => warnings.push(m) } });
    assert.equal(second, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /in use/);
  } finally { await first.close(); }
});
