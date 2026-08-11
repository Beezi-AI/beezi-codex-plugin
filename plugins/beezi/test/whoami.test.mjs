import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoami } from '../lib/whoami.mjs';

const deps = (fetchImpl) => ({ fetchImpl, base: 'https://api.test' });

test('whoami — 200 with body → valid with fields', async () => {
  const res = await whoami('tok', deps(async () => ({
    ok: true,
    json: async () => ({
      email: 'dev@acme.com',
      name: 'Dev Eloper',
      tenantTier: 'AUDIT',
      trackingMode: 'backfill_only',
      backfillCompleted: true,
    }),
  })));
  assert.deepEqual(res, {
    valid: true,
    email: 'dev@acme.com',
    name: 'Dev Eloper',
    tenantTier: 'AUDIT',
    trackingMode: 'backfill_only',
    backfillCompleted: true,
  });
});

test('whoami — 401 → { valid: false }', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 401, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — 403 → { valid: false }', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 403, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — other non-ok (500) → null', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 500, ok: false })));
  assert.equal(res, null);
});

test('whoami — fetch throws (offline) → null', async () => {
  const res = await whoami('tok', deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res, null);
});

// An old server without the tracking/backfill fields must read as "no policy", never as sealed.
test('whoami — 200 but body missing fields → nulls', async () => {
  const res = await whoami('tok', deps(async () => ({ ok: true, json: async () => ({}) })));
  assert.deepEqual(res, {
    valid: true,
    email: null,
    name: null,
    tenantTier: null,
    trackingMode: null,
    backfillCompleted: false,
  });
});

// A connection the server accepts and never answers — a local API paused in a debugger, an app
// mid-restart, a proxy holding the socket. Without a bound this never settles, and because
// performLogin calls whoami *after* storing the credentials, a completed login is stranded: the
// browser round-trip succeeded, the token is on disk, and the MCP tool call never returns a result.
const hangingFetch = () => (url, opts) =>
  new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

test('whoami — server accepts but never answers → null, not a hang', async () => {
  const res = await whoami('tok', { fetchImpl: hangingFetch(), base: 'https://api.test', timeoutMs: 30 });
  assert.equal(res, null);
});

test('whoami — every request carries an abort signal', async () => {
  let seen;
  await whoami('tok', {
    base: 'https://api.test',
    fetchImpl: async (url, opts) => { seen = opts?.signal; return { ok: true, json: async () => ({}) }; },
  });
  assert.ok(seen, 'no signal passed — the request is unbounded');
  assert.equal(typeof seen.aborted, 'boolean');
});

test('whoami — sends bearer token to the whoami URL', async () => {
  let seen;
  await whoami('my-token', deps(async (url, opts) => {
    seen = { url, auth: opts?.headers?.Authorization };
    return { ok: true, json: async () => ({}) };
  }));
  assert.equal(seen.url, 'https://api.test/me/codex/whoami');
  assert.equal(seen.auth, 'Bearer my-token');
});
