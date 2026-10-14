import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { gzipJson } from '../lib/gzip-body.mjs';

// What postJson sends today without gzip: fetch encodes the JSON string as UTF-8.
const plainBytes = (value) => Buffer.from(JSON.stringify(value), 'utf-8');

test('gzipJson resolves a gzip Buffer', async () => {
  const out = await gzipJson({ sessions: [] });

  assert.equal(Buffer.isBuffer(out), true);
  assert.equal(out[0], 0x1f);
  assert.equal(out[1], 0x8b);
});

test('gzipJson inflates to exactly the bytes of JSON.stringify, unicode included', async () => {
  const value = {
    sessions: [
      {
        sessionId: 's1',
        session_name: 'café ☕ Привіт 日本語 \u{1F600}    lone \uD800 "quoted" back\\slash\nnewline',
        models: { 'claude-sonnet-4-5': { token_input: 1, cost_usd: 0.1 + 0.2 } },
        empty: [],
        nil: null,
        flag: false,
      },
    ],
    timelines: [],
  };

  const out = await gzipJson(value);

  assert.equal(Buffer.compare(zlib.gunzipSync(out), plainBytes(value)), 0);
});

test('gzipJson shrinks a chunk-shaped body', async () => {
  const value = {
    sessions: Array.from({ length: 50 }, (_unused, i) => ({
      segmentId: `s${i}:0-120`,
      sessionId: `s${i}`,
      remote: 'git@github.com:acme/app.git',
      branch: 'main',
      models: { 'claude-sonnet-4-5': { token_input: i, token_output: i, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    })),
  };

  const out = await gzipJson(value);

  assert.ok(out.length * 5 < plainBytes(value).length, `only ${plainBytes(value).length} -> ${out.length} bytes`);
  assert.equal(Buffer.compare(zlib.gunzipSync(out), plainBytes(value)), 0);
});

test('gzipJson rejects, never throws, on a value JSON cannot encode', async () => {
  const cyclic = {};
  cyclic.self = cyclic;

  const pending = gzipJson(cyclic);

  assert.equal(typeof pending.then, 'function');
  await assert.rejects(pending, TypeError);
});
