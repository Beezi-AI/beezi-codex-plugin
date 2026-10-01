import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoami } from '../lib/whoami.mjs';
import { hangingFetch } from '../tools/suite-fixtures.mjs';

const deps = (fetchImpl) => ({ fetchImpl, base: 'https://api.test' });

// whoami takes a SESSION now — it hands its argument straight to getJson, which refuses a bare
// token so that a call site missed by the multi-account sweep cannot post without a client id.
const session = (over = {}) => ({ token: 'tok', clientId: 'c-1', ...over });

test('whoami — 200 with body → valid with fields', async () => {
  const res = await whoami(session(), deps(async () => ({
    ok: true,
    json: async () => ({
      email: 'dev@acme.com',
      name: 'Dev Eloper',
      tenantId: 'tenant-1',
      tenantName: 'Acme',
      tenantTier: 'AUDIT',
      trackingMode: 'backfill_only',
      backfillCompleted: true,
    }),
  })));
  assert.deepEqual(res, {
    valid: true,
    email: 'dev@acme.com',
    name: 'Dev Eloper',
    tenantId: 'tenant-1',
    tenantName: 'Acme',
    tenantTier: 'AUDIT',
    trackingMode: 'backfill_only',
    backfillCompleted: true,
  });
});

test('whoami — 401 → { valid: false }', async () => {
  const res = await whoami(session(), deps(async () => ({ status: 401, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — 403 → { valid: false }', async () => {
  const res = await whoami(session(), deps(async () => ({ status: 403, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — other non-ok (500) → null', async () => {
  const res = await whoami(session(), deps(async () => ({ status: 500, ok: false })));
  assert.equal(res, null);
});

test('whoami — fetch throws (offline) → null', async () => {
  const res = await whoami(session(), deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res, null);
});

// An old server without the tracking/backfill fields must read as "no policy", never as sealed.
// tenantId/tenantName are null against a portal older than ADO PR #3893 — that disables only the
// same-tenant refusal on the login path, so they must read as absent rather than throw or default.
test('whoami — 200 but body missing fields → nulls', async () => {
  const res = await whoami(session(), deps(async () => ({ ok: true, json: async () => ({}) })));
  assert.deepEqual(res, {
    valid: true,
    email: null,
    name: null,
    tenantId: null,
    tenantName: null,
    tenantTier: null,
    trackingMode: null,
    backfillCompleted: false,
  });
});

// Why this one matters here: performLogin calls whoami *after* storing the credentials, so without
// a bound a completed login is stranded — the browser round-trip succeeded, the token is on disk,
// and the MCP tool call never returns a result.
test('whoami — server accepts but never answers → null, not a hang', async () => {
  const res = await whoami(session(), { fetchImpl: hangingFetch(), base: 'https://api.test', timeoutMs: 30 });
  assert.equal(res, null);
});

test('whoami — every request carries an abort signal', async () => {
  let seen;
  await whoami(session(), {
    base: 'https://api.test',
    fetchImpl: async (url, opts) => { seen = opts?.signal; return { ok: true, json: async () => ({}) }; },
  });
  assert.ok(seen, 'no signal passed — the request is unbounded');
  assert.equal(typeof seen.aborted, 'boolean');
});

test('whoami — sends bearer token to the whoami URL', async () => {
  let seen;
  await whoami(session({ token: 'my-token' }), deps(async (url, opts) => {
    seen = { url, auth: opts?.headers?.Authorization };
    return { ok: true, json: async () => ({}) };
  }));
  assert.equal(seen.url, 'https://api.test/me/codex/whoami');
  assert.equal(seen.auth, 'Bearer my-token');
});

// The guard must not be swallowed by this function's own catch. whoami maps every throw to null,
// and null means "offline/unknown" to linkStatus, session-start and the login path alike — so a
// caller still handing over a bare token would read as an unreachable server rather than as the
// missed call site it is. This is the one place in the sweep where the tripwire could go quiet.
test('whoami — a bare token throws rather than reading as offline', async () => {
  await assert.rejects(
    () => whoami('bare-token', deps(async () => ({ ok: true, json: async () => ({}) }))),
    TypeError,
  );
});

test('whoami — a genuine transport failure still reads as null, not as a throw', async () => {
  const res = await whoami(session(), deps(async () => { throw new TypeError('socket hang up'); }));
  assert.equal(res, null, 'only programming errors escape; the network still degrades quietly');
});
