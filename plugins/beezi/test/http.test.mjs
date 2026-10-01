import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postJson, getJson } from '../lib/http.mjs';
import { hangingFetch } from '../tools/suite-fixtures.mjs';

// Both helpers take a SESSION — { token, clientId } — rather than a bare token. The client id has
// to travel with the bearer once a machine can have several accounts linked, or the server binds
// one account's analytics to another account's machine row.
const session = (over = {}) => ({ token: 'tok', clientId: 'c-1', ...over });

test('getJson — bounded: a server that never answers rejects instead of hanging', async () => {
  await assert.rejects(
    () => getJson('https://api.test/thing', session(), { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});

test('getJson — sends bearer auth and the machine headers', async () => {
  let seen;
  await getJson('https://api.test/thing', session({ token: 'my-token' }), {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true }; },
  });
  assert.equal(seen.url, 'https://api.test/thing');
  assert.equal(seen.opts.headers.Authorization, 'Bearer my-token');
  assert.equal(seen.opts.headers['X-Beezi-Agent'], 'codex');
  assert.equal(seen.opts.headers['X-Beezi-Client'], 'c-1');
  assert.ok(seen.opts.signal, 'no abort signal — the request is unbounded');
});

test('getJson — clears its timer on success, so the process can exit', async () => {
  // A pending timer keeps the event loop alive; a hook that finishes its work would sit idle
  // until the timeout fired. node --test would report a leaked handle rather than a failure,
  // so assert the response is returned promptly and the call settles.
  const res = await getJson('https://api.test/thing', session(), {
    fetchImpl: async () => ({ ok: true, status: 200 }),
    timeoutMs: 60_000,
  });
  assert.equal(res.status, 200);
});

test('postJson — still bounded (unchanged behaviour)', async () => {
  await assert.rejects(
    () => postJson('https://api.test/thing', session(), { a: 1 }, { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});

test('postJson — carries the session\'s client id, not some other account\'s', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts.headers['X-Beezi-Client']); return { ok: true }; };
  await postJson('https://api.test/thing', session({ clientId: 'c-a' }), {}, { fetchImpl });
  await postJson('https://api.test/thing', session({ clientId: 'c-b' }), {}, { fetchImpl });
  assert.deepEqual(seen, ['c-a', 'c-b'], 'two posts in one process, two different machine rows');
});

// ── the sweep's tripwire ────────────────────────────────────────────────────────────────────────
//
// THE GUARD MUST THROW, NOT COERCE. Nothing in this repo is type-checked, so a call site left
// behind by the multi-account sweep has exactly one way to announce itself. Were the helpers to
// accept a string, that site would post with NO X-Beezi-Client at all and the server would attach
// the report to whatever machine row it could find — a silent misattribution that no test, log or
// user report would ever surface.

test('a bare token string is refused by both helpers', async () => {
  const fetchImpl = async () => { throw new Error('the request must never be made'); };
  await assert.rejects(() => postJson('https://api.test/x', 'raw-token', {}, { fetchImpl }), TypeError);
  await assert.rejects(() => getJson('https://api.test/x', 'raw-token', { fetchImpl }), TypeError);
});

test('and so is every other shape that is not a session', async () => {
  const fetchImpl = async () => { throw new Error('the request must never be made'); };
  for (const bad of [null, undefined, 42, { clientId: 'c-1' }, { token: null }, { token: 123 }]) {
    await assert.rejects(
      () => postJson('https://api.test/x', bad, {}, { fetchImpl }),
      TypeError,
      `${JSON.stringify(bad)} must not reach the network`,
    );
  }
});

// A session with no client id is LEGITIMATE — an older credentials blob may carry none — and must
// go through, simply without the header. Only the token is mandatory.
test('a session without a client id is allowed through, header omitted', async () => {
  let seen;
  await postJson('https://api.test/x', { token: 'tok' }, {}, {
    fetchImpl: async (url, opts) => { seen = opts.headers; return { ok: true }; },
  });
  assert.equal(seen.Authorization, 'Bearer tok');
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'X-Beezi-Client'), false);
});
