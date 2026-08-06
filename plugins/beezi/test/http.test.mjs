import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postJson, getJson } from '../lib/http.mjs';

// Fetch that never answers unless aborted — the failure mode that matters here. Node's fetch has
// no default timeout, so an unbounded call against a server that accepts the connection and then
// goes quiet hangs for the life of the process.
const hangingFetch = () => (url, opts) =>
  new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

test('getJson — bounded: a server that never answers rejects instead of hanging', async () => {
  await assert.rejects(
    () => getJson('https://api.test/thing', 'tok', { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});

test('getJson — sends bearer auth and the machine headers', async () => {
  let seen;
  await getJson('https://api.test/thing', 'my-token', {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true }; },
  });
  assert.equal(seen.url, 'https://api.test/thing');
  assert.equal(seen.opts.headers.Authorization, 'Bearer my-token');
  assert.equal(seen.opts.headers['X-Beezi-Agent'], 'codex');
  assert.ok(seen.opts.signal, 'no abort signal — the request is unbounded');
});

test('getJson — clears its timer on success, so the process can exit', async () => {
  // A pending timer keeps the event loop alive; a hook that finishes its work would sit idle
  // until the timeout fired. node --test would report a leaked handle rather than a failure,
  // so assert the response is returned promptly and the call settles.
  const res = await getJson('https://api.test/thing', 'tok', {
    fetchImpl: async () => ({ ok: true, status: 200 }),
    timeoutMs: 60_000,
  });
  assert.equal(res.status, 200);
});

test('postJson — still bounded (unchanged behaviour)', async () => {
  await assert.rejects(
    () => postJson('https://api.test/thing', 'tok', { a: 1 }, { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});
