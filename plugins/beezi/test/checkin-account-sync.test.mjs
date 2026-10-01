import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  RESYNC_MS,
  accountSyncPath,
  accountSyncStateFile,
  buildAccountSyncPayload,
  isEmptyPayload,
  payloadHash,
  syncAccountIfNeeded,
} from '../lib/account-sync.mjs';
import { apiBase } from '../lib/config.mjs';
import { beeziCodexHome, queueDir, stateDir } from '../lib/paths.mjs';
import { recordingFetch, hangingFetch as hangingResponder } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The check-in is per account: the PAYLOAD describes the ChatGPT sign-in this machine is on, which
// is the same for every linked workspace, but the marker that suppresses a redundant POST is that
// account's — so a workspace linked yesterday still gets its first check-in.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// The vendor-generic account check-in (G-2-1).
//
// EVERY test here injects readChatgptAuth AND readBillingConfig, including the ones that return
// before either could be reached. Those two readers are the modules that reach for real machine
// state (~/.codex/auth.json and ~/.beezi-codex/billing.json); an escaped read does not fail an
// assertion, it only moves the runner's PROCESS EXIT STATUS, so the discipline has to be
// unconditional rather than applied where it looks necessary.
//
// No test makes a network call: `fetchImpl` is always a recordingFetch.

// A writer spy, so "the marker was not sealed" is asserted on the WRITE, not inferred from a
// return value.
function spyWrite() {
  const calls = [];
  const impl = (file, obj) => { calls.push({ file, obj }); };
  impl.calls = calls;
  return impl;
}

// The slow-server failure mode, recorded: this file asserts on the call as well as on the hang,
// so the never-answering responder goes through the recorder.
const hangingFetch = () => recordingFetch(hangingResponder());

const ACCOUNT = {
  authMode: null,
  hasStoredApiKey: false,
  subscriptionType: 'plus',
  plan: 'plus',
  expiresAt: null,
  accountId: 'acct-1234',
  email: 'dev@acme.com',
};

const CONFIG = {
  version: 1,
  source: 'subscription',
  subscriptionType: 'plus',
  rateLimitTier: null,
  plan: 'plus',
};

// The full dependency bag for a sync, with both machine-state readers stubbed and no disk touched.
function deps(overrides) {
  const o = overrides || {};
  return {
    fetchImpl: o.fetchImpl || recordingFetch(async () => ({ status: 200 })),
    readChatgptAuth: o.readChatgptAuth || (() => ACCOUNT),
    readBillingConfig: o.readBillingConfig || (() => CONFIG),
    readJsonImpl: o.readJsonImpl || (() => null),
    writeJsonImpl: o.writeJsonImpl || spyWrite(),
    now: o.now || new Date('2026-09-10T12:00:00.000Z'),
    timeoutMs: o.timeoutMs,
  };
}

// ── payload shape ─────────────────────────────────────────────────────────────────────────────

test('payload — carries exactly the DTO keys, and never a null', () => {
  const payload = buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT });
  assert.deepEqual(payload, {
    accountUuid: 'acct-1234',
    email: 'dev@acme.com',
    subscriptionType: 'plus',
  });
});

test('payload — omits (never nulls) an unknown accountUuid / email / subscriptionType', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: null },
    account: { accountId: null, email: '   ', subscriptionType: 'plus' },
  });
  assert.deepEqual(payload, {});
  assert.equal('accountUuid' in payload, false);
  assert.equal('email' in payload, false);
  assert.equal('subscriptionType' in payload, false);
});

test('payload — an all-unknown machine builds {} and is recognised as empty', () => {
  assert.deepEqual(buildAccountSyncPayload({ config: null, account: null }), {});
  assert.equal(isEmptyPayload({}), true);
  assert.equal(isEmptyPayload(null), true);
  assert.equal(isEmptyPayload({ accountUuid: 'x' }), false);
});

test('payload — no rateLimitTier and no keys[], the two fields deliberately not ported', () => {
  const payload = buildAccountSyncPayload({
    config: { ...CONFIG, rateLimitTier: 'default_claude_3_7_sonnet' },
    account: ACCOUNT,
  });
  assert.equal('rateLimitTier' in payload, false);
  assert.equal('keys' in payload, false);
});

test('payload — an oversized value is DROPPED, not truncated (a truncated uuid names another account)', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: 'p'.repeat(51) },
    account: { accountId: 'a'.repeat(65), email: `${'e'.repeat(315)}@acme.com` },
  });
  assert.deepEqual(payload, {});
});

test('payload — values at the DTO bounds still travel', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: 'p'.repeat(50) },
    account: { accountId: 'a'.repeat(64), email: 'e'.repeat(320) },
  });
  assert.equal(payload.accountUuid.length, 64);
  assert.equal(payload.email.length, 320);
  assert.equal(payload.subscriptionType.length, 50);
});

// ── the plan rule ─────────────────────────────────────────────────────────────────────────────

test('plan — billing.json wins, and a null there is the ladder’s DECISION, not a gap to fill', () => {
  // The machine has a live ChatGPT sign-in claiming `plus`, but the source ladder already resolved
  // it to api-key billing (an exported OPENAI_API_KEY wins step 1), so buildConfig wrote
  // subscriptionType: null. Re-filling it from the id_token would file a metered machine under a
  // subscription plan.
  const payload = buildAccountSyncPayload({
    config: { version: 1, source: 'openai_api_key', subscriptionType: null },
    account: ACCOUNT,
  });
  assert.equal('subscriptionType' in payload, false);
  assert.equal(payload.accountUuid, 'acct-1234');
});

test('plan — falls back to the id_token decode only when there is NO billing config at all', () => {
  const payload = buildAccountSyncPayload({ config: null, account: ACCOUNT });
  assert.equal(payload.subscriptionType, 'plus');
});

test('plan — an EXPIRED id_token claim is dropped on that fallback (a stale "free" files a paying user wrong)', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  const payload = buildAccountSyncPayload({
    config: null,
    account: { ...ACCOUNT, subscriptionType: 'free', expiresAt: now - 1 },
    now,
  });
  assert.equal('subscriptionType' in payload, false);
  assert.equal(payload.accountUuid, 'acct-1234', 'identity survives an expired plan claim');
});

test('plan — an unexpired claim on that fallback still travels', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  const payload = buildAccountSyncPayload({
    config: null,
    account: { ...ACCOUNT, expiresAt: now + 1000 },
    now,
  });
  assert.equal(payload.subscriptionType, 'plus');
});

// ── the change hash ───────────────────────────────────────────────────────────────────────────

test('payloadHash — stable under key reordering, so a reordered build is not new information', () => {
  const a = { accountUuid: 'u', email: 'e', subscriptionType: 's' };
  const b = {};
  b.subscriptionType = 's';
  b.email = 'e';
  b.accountUuid = 'u';
  assert.equal(payloadHash(a), payloadHash(b));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, subscriptionType: 'pro' }));
});

// ── the route ─────────────────────────────────────────────────────────────────────────────────

test('route — posts to /me/cli-agent/account, the vendor-generic route (NOT a /me/codex/* one)', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({ fetchImpl }));
  assert.equal(res.synced, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${apiBase()}/me/cli-agent/account`);
  assert.equal(accountSyncPath(), '/me/cli-agent/account');
  assert.equal(accountSyncPath().indexOf('/me/codex/'), -1);
});

test('route — the request carries the bearer token and the codex agent header', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  await syncAccountIfNeeded(KEY, accountSession(KEY, 'my-token'), {}, deps({ fetchImpl }));
  const { headers } = fetchImpl.calls[0].opts;
  assert.equal(headers.Authorization, 'Bearer my-token');
  // The discriminator: there is no vendor field in the body, the server reads it off this header.
  assert.equal(headers['X-Beezi-Agent'], 'codex');
  assert.ok(fetchImpl.calls[0].opts.signal, 'no abort signal — the request is unbounded');
});

test('route — the body carries ONLY whitelisted keys, and no credential, token or path', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  await syncAccountIfNeeded(KEY, accountSession(KEY, 'super-secret-token'), { force: true, via: 'session-start' }, deps({ fetchImpl }));
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  const allowed = ['accountUuid', 'email', 'subscriptionType', 'rateLimitTier', 'keys'];
  for (const key of Object.keys(body)) {
    assert.ok(allowed.includes(key), `unknown key '${key}' would 400 the whole check-in`);
  }
  // `via` names the caller for local reasoning only — it must never reach the wire.
  assert.equal('via' in body, false);
  const raw = fetchImpl.calls[0].opts.body;
  assert.equal(raw.includes('super-secret-token'), false);
  assert.equal(raw.includes(beeziCodexHome()), false);
});

// ── the gate ──────────────────────────────────────────────────────────────────────────────────

test('gate — an unchanged payload inside RESYNC_MS sends NOTHING', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hash = payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    now,
    readJsonImpl: () => ({
      version: 1,
      lastSyncedHash: hash,
      lastSyncedAt: new Date(now.getTime() - RESYNC_MS + 60_000).toISOString(),
    }),
  }));
  assert.deepEqual(res, { synced: false, reason: 'unchanged' });
  assert.equal(fetchImpl.calls.length, 0, 'the steady state must be zero network');
});

test('gate — past RESYNC_MS the same payload is re-sent, which is what moves last_seen_at', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hash = payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    now,
    readJsonImpl: () => ({
      version: 1,
      lastSyncedHash: hash,
      lastSyncedAt: new Date(now.getTime() - RESYNC_MS - 1000).toISOString(),
    }),
  }));
  assert.equal(res.synced, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('gate — a CHANGED payload posts even inside RESYNC_MS (an account switch must propagate)', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    now,
    readChatgptAuth: () => ({ ...ACCOUNT, accountId: 'acct-OTHER', email: 'other@acme.com' }),
    readJsonImpl: () => ({
      version: 1,
      lastSyncedHash: payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT })),
      lastSyncedAt: now.toISOString(),
    }),
  }));
  assert.equal(res.synced, true);
  assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).accountUuid, 'acct-OTHER');
});

test('gate — force bypasses it: a fresh login must not be suppressed by the PREVIOUS identity’s marker', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hash = payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT }));
  const res = await syncAccountIfNeeded(KEY, SESSION, { force: true }, deps({
    fetchImpl,
    now,
    readJsonImpl: () => ({ version: 1, lastSyncedHash: hash, lastSyncedAt: now.toISOString() }),
  }));
  assert.equal(res.synced, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('gate — a marker from an older STATE_VERSION is ignored rather than trusted', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hash = payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    now,
    readJsonImpl: () => ({ version: 99, lastSyncedHash: hash, lastSyncedAt: now.toISOString() }),
  }));
  assert.equal(res.synced, true);
});

test('gate — a marker stamped in the FUTURE is a clock change, not a fresh sync', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hash = payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    now,
    readJsonImpl: () => ({
      version: 1,
      lastSyncedHash: hash,
      lastSyncedAt: new Date(now.getTime() + 60_000).toISOString(),
    }),
  }));
  assert.equal(res.synced, true);
});

// ── the marker ────────────────────────────────────────────────────────────────────────────────

test('marker — sealed only inside the 2xx branch, with the hash and an ISO stamp', async () => {
  const writeJsonImpl = spyWrite();
  const now = new Date('2026-09-10T12:00:00.000Z');
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({ writeJsonImpl, now }));
  assert.equal(res.synced, true);
  assert.equal(writeJsonImpl.calls.length, 1);
  assert.deepEqual(writeJsonImpl.calls[0].obj, {
    version: 1,
    lastSyncedHash: payloadHash(buildAccountSyncPayload({ config: CONFIG, account: ACCOUNT })),
    lastSyncedAt: now.toISOString(),
  });
  assert.equal(writeJsonImpl.calls[0].file, accountSyncStateFile(KEY));
});

test('marker — a 404 from an older API does NOT seal it, so the next trigger retries', async () => {
  const writeJsonImpl = spyWrite();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl,
    fetchImpl: recordingFetch(async () => ({ status: 404 })),
  }));
  assert.deepEqual(res, { synced: false, status: 404, reason: 'rejected' });
  assert.equal(writeJsonImpl.calls.length, 0, 'a 404 sealed as success freezes the account row for a week');
});

test('marker — a 400 (an unknown key reaching the whitelist) does NOT seal it either', async () => {
  const writeJsonImpl = spyWrite();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl,
    fetchImpl: recordingFetch(async () => ({ status: 400 })),
  }));
  assert.equal(res.reason, 'rejected');
  assert.equal(res.status, 400);
  assert.equal(writeJsonImpl.calls.length, 0);
});

test('marker — a 401 does not seal it (the token, not the payload, is the problem)', async () => {
  const writeJsonImpl = spyWrite();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl,
    fetchImpl: recordingFetch(async () => ({ status: 401 })),
  }));
  assert.equal(res.reason, 'rejected');
  assert.equal(writeJsonImpl.calls.length, 0);
});

// REWRITTEN for the keyed layout. The marker moved from the data root into the account directory,
// and the property it pins is unchanged: it is outside state/ and outside every account's queue/,
// the only two trees pruneStale() sweeps, so losing it would cost a redundant POST a fortnight.
// The new half is that two accounts cannot share one marker.
test('marker — lives in the account directory, NOT under state/ or queue/ that pruneStale() sweeps', () => {
  const file = accountSyncStateFile(KEY);
  assert.equal(path.dirname(file), path.join(beeziCodexHome(), 'accounts', KEY));
  assert.equal(path.basename(file), 'account-sync.json');
  assert.notEqual(path.dirname(file), stateDir());
  assert.notEqual(path.dirname(file), queueDir(KEY));
  assert.notEqual(accountSyncStateFile(KEY), accountSyncStateFile('99887766'));
});

// ── the quiet states ──────────────────────────────────────────────────────────────────────────

test('unlinked — no token means no request, and no complaint', async () => {
  // This is ALSO the credentials-bound-to-another-environment state, and deliberately the same
  // code path: lib/credentials.mjs reads a mismatched environment binding as NO credentials, so
  // getAccessToken() answers null and the caller hands us a falsy token. Simulating the binding
  // separately would test lib/credentials.mjs, not this module.
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const writeJsonImpl = spyWrite();
  for (const token of [null, undefined, '']) {
    const res = await syncAccountIfNeeded(KEY, token === null || token === undefined || token === '' ? token : accountSession(KEY, token), { force: true }, deps({ fetchImpl, writeJsonImpl }));
    assert.deepEqual(res, { synced: false, reason: 'no-token' });
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(writeJsonImpl.calls.length, 0);
});

test('nothing known — a machine with no Codex sign-in and no billing config sends nothing', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await syncAccountIfNeeded(KEY, SESSION, { force: true }, deps({
    fetchImpl,
    readChatgptAuth: () => null,
    readBillingConfig: () => null,
  }));
  assert.deepEqual(res, { synced: false, reason: 'nothing-known' });
  assert.equal(fetchImpl.calls.length, 0, 'an empty body would create no rows — not worth a request');
});

test('offline — a throwing fetch is a quiet skip, and the marker is untouched', async () => {
  const writeJsonImpl = spyWrite();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl,
    fetchImpl: recordingFetch(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }),
  }));
  assert.deepEqual(res, { synced: false, reason: 'network' });
  assert.equal(writeJsonImpl.calls.length, 0);
});

test('slow server — the request is bounded, so a hook is never blocked on it', async () => {
  const fetchImpl = hangingFetch();
  const writeJsonImpl = spyWrite();
  const started = Date.now();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({ fetchImpl, writeJsonImpl, timeoutMs: 30 }));
  assert.deepEqual(res, { synced: false, reason: 'network' });
  assert.ok(Date.now() - started < 5000, 'the call did not settle promptly — it is unbounded');
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].opts.signal, 'no abort signal reached fetch');
  assert.equal(writeJsonImpl.calls.length, 0);
});

test('never throws — a reader that blows up degrades to "nothing known" rather than failing a hook', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await syncAccountIfNeeded(KEY, SESSION, { force: true }, deps({
    fetchImpl,
    readChatgptAuth: () => { throw new Error('EACCES'); },
    readBillingConfig: () => { throw new Error('EACCES'); },
  }));
  assert.deepEqual(res, { synced: false, reason: 'nothing-known' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('never throws — a marker that cannot be written costs one redundant POST, not an exception', async () => {
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl: () => { throw new Error('held open by another process'); },
  }));
  assert.equal(res.synced, true);
});

test('never throws — an unreadable marker is treated as absent', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    fetchImpl,
    readJsonImpl: () => { throw new Error('EACCES'); },
  }));
  assert.equal(res.synced, true);
});

test('a fetch answering with no status is a refusal, not a success', async () => {
  const writeJsonImpl = spyWrite();
  const res = await syncAccountIfNeeded(KEY, SESSION, {}, deps({
    writeJsonImpl,
    fetchImpl: recordingFetch(async () => undefined),
  }));
  assert.deepEqual(res, { synced: false, status: null, reason: 'rejected' });
  assert.equal(writeJsonImpl.calls.length, 0);
});

// ─── identity precedence: billing.json before ~/.codex/auth.json ──────────────────────────────
// billing.json is the only place a `codex app-server` identity is ever written down. On a machine
// whose credentials live in the OS keychain, auth.json names no account at all, and the probe that
// does runs at most weekly — so reading auth.json first would report no account id on every session
// except the one that happened to probe. Same precedence as lib/chatgpt-identity.mjs.

test('the check-in prefers the account id recorded in billing.json', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: 'plus', accountId: 'live-uuid', email: 'live@example.com' },
    account: { accountId: 'stale-uuid', email: 'stale@example.com' },
  });
  assert.equal(payload.accountUuid, 'live-uuid');
  assert.equal(payload.email, 'live@example.com');
});

test('the check-in falls back to auth.json when billing.json knows no identity', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: 'plus' },
    account: { accountId: 'from-auth-json', email: 'auth@example.com' },
  });
  assert.equal(payload.accountUuid, 'from-auth-json');
  assert.equal(payload.email, 'auth@example.com');
});

test('an oversized recorded uuid falls through rather than naming a different account', () => {
  const payload = buildAccountSyncPayload({
    config: { subscriptionType: 'plus', accountId: 'x'.repeat(65) },
    account: { accountId: 'from-auth-json' },
  });
  assert.equal(payload.accountUuid, 'from-auth-json');
});
