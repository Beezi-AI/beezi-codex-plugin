import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// performLogin now has real filesystem side effects (accounts.json, accounts/<key>/tracking.json).
// Point the data root at a throwaway dir BEFORE the lib loads paths, or the suite writes into the
// real ~/.beezi-codex of whoever runs it.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-login-'));
process.env.BEEZI_CODEX_HOME = TEST_HOME;
process.on('exit', () => { try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

const { performLogin, openBrowser } = await import('../lib/login.mjs');
const { trackingStateFile, auditLedgerFile } = await import('../lib/paths.mjs');
const { addAccount, listAccounts } = await import('../lib/accounts.mjs');
const { TEST_KEY, fakeKeyring } = await import('../tools/account-fixtures.mjs');

// Enough of the flow to reach the browser step and past it, with nothing touching the network.
//
// `run` and `platform` are not optional even though `setCredentials` is stubbed: lib/accounts.mjs
// reads the index through the one-time pre-0.13 migration, whose legacy credential probe SPAWNS
// `security` on darwin. The hermetic backstop only RECORDS such a call and then lets it run, so the
// fake keyring is the seam that keeps this file off the developer's own keychain.
function loginDeps(overrides = {}) {
  const ring = fakeKeyring();
  return {
    run: ring.run,
    platform: 'darwin',
    // No stored session for any key, so the branch table never takes the already-linked path
    // unless a test hands it one. It is also what tells lib/token.mjs the environment guard has
    // already been resolved by performLogin itself.
    getCredentials: async () => null,
    discover: async () => ({
      authorizationEndpoint: 'https://auth.test/authorize',
      tokenEndpoint: 'https://auth.test/token',
      registrationEndpoint: 'https://auth.test/register',
    }),
    pkcePair: () => ({ verifier: 'v', challenge: 'c' }),
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:1234/callback',
      port: 1234,
      code: Promise.resolve('auth-code'),
      cancel: () => {},
    }),
    registerClient: async () => 'client-123',
    exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    setCredentials: async () => 'the OS keyring',
    whoami: async () => ({ valid: true, name: 'Dev Eloper', email: null }),
    openBrowser: async () => ({ ok: true }),
    // Handing a grant back is a DELETE against the portal; unstubbed it is a live request.
    unlinkMachine: async () => true,
    // Both halves of the G-2-1 account check-in, always stubbed. Unstubbed, `syncAccountIfNeeded`
    // runs the real module against the real API — and that failure does not show up as a failed
    // assertion, only as the runner's PROCESS EXIT STATUS moving. The discipline has to be
    // unconditional.
    syncAccountIfNeeded: async () => ({ synced: false }),
    ...overrides,
  };
}

// The session a test hands the branch table for an account that is already linked and healthy.
// `expires_at` is in the future so lib/token.mjs answers `ready` without attempting a renewal.
//
// KEYED, because the sandbox index is shared by every test in this file and the login flow now
// walks it: performLogin resolves any row whose email is null through that row's OWN credentials,
// so a reader that answered for every key would hand one test's identity to another test's
// leftover row. `forKey` is the account the test actually seeded; every other key reads as unlinked.
function storedSession(clientId = 'existing-client', token = 'already-stored', forKey = null) {
  return async (key) => (forKey !== null && key !== forKey
    ? null
    : { client_id: clientId, access_token: token, expires_at: Date.now() + 3_600_000 });
}

// Records every account check-in the flow makes: [key, session, options]. The module's signature
// is (key, session, options) — a spy shaped for the pre-0.13 (token, options) call would silently
// record the key as the token and never notice.
function syncSpy(result = { synced: true, status: 200 }) {
  const calls = [];
  const impl = async (key, session, options) => {
    calls.push({ key, session: session || null, options: options || {} });
    return result;
  };
  impl.calls = calls;
  return impl;
}

test('login emits the authorize URL before it tries to open a browser', async () => {
  const steps = [];
  const order = [];
  await performLogin({
    onStep: (s) => { steps.push(s); order.push(`step:${s.type}`); },
    ...loginDeps({ openBrowser: async () => { order.push('openBrowser'); return { ok: true }; } }),
  });
  assert.equal(order[0], 'step:authorize-url');
  assert.equal(order[1], 'openBrowser');
  assert.match(steps[0].url, /^https:\/\/auth\.test\/authorize\?/);
});

// The launcher used to be fire-and-forget with stdio ignored, so a sandboxed shell or a machine
// with no http association failed invisibly: no browser, no message, and — through the MCP tool —
// no URL either. The outcome now reaches the caller.
test('a launcher that fails is surfaced as a browser-failed step', async () => {
  const steps = [];
  const result = await performLogin({
    onStep: (s) => steps.push(s),
    ...loginDeps({ openBrowser: async () => ({ ok: false, detail: 'no http association' }) }),
  });

  const failed = steps.find((s) => s.type === 'browser-failed');
  assert.ok(failed, 'no browser-failed step was emitted');
  assert.equal(failed.detail, 'no http association');
  assert.match(failed.url, /^https:\/\/auth\.test\/authorize\?/);
  // The sign-in itself still completes — the user can open the URL by hand.
  assert.equal(result.outcome, 'linked');
  assert.equal(result.account.name, 'Dev Eloper');
});

test('an openBrowser that resolves ok emits no browser-failed step', async () => {
  const steps = [];
  await performLogin({ onStep: (s) => steps.push(s), ...loginDeps() });
  assert.equal(steps.find((s) => s.type === 'browser-failed'), undefined);
});

// whoami is the request that registers the new client AND the source of the email the branch table
// reads. It must never be able to fail the login — that is what stranded a completed sign-in
// behind a pending request — so an unreachable portal links the account under an unknown identity.
test('a whoami that fails still yields a linked result', async () => {
  const result = await performLogin(loginDeps({ whoami: async () => { throw new Error('unreachable'); } }));
  assert.equal(result.outcome, 'linked');
  assert.equal(result.who, null);
  assert.equal(result.account.name, null);
  assert.equal(result.account.email, null, 'nobody is named, and no other account is matched on it');
});

// ─── link side effects (backfill groundwork) ────────────────────────────────

test('a fresh link stamps linkedAt, records whoami, and disturbs no other account', async () => {
  // A neighbouring account with state of its own. Under the keyed layout a new login cannot reach
  // it — which is the property these assertions now pin, in place of the root-level delete that
  // the single-account flow needed.
  fs.mkdirSync(path.dirname(auditLedgerFile(TEST_KEY)), { recursive: true });
  fs.writeFileSync(auditLedgerFile(TEST_KEY), JSON.stringify({ version: 1, identity: 'old-login', sessions: {} }));
  fs.writeFileSync(trackingStateFile(TEST_KEY), JSON.stringify({ version: 1, trackingMode: 'live', identity: 'old-login' }));

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: null, trackingMode: 'backfill_only', backfillCompleted: false }),
  }));

  assert.notEqual(result.key, TEST_KEY, 'a new account is a new key');
  assert.ok(!fs.existsSync(auditLedgerFile(result.key)), 'a fresh identity must not replay a ledger');
  assert.ok(fs.existsSync(auditLedgerFile(TEST_KEY)), 'and must not delete another account’s');
  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(result.key), 'utf-8'));
  assert.ok(tracking.linkedAt, 'the link instant is stamped for the backfill cutoff');
  assert.equal(tracking.identity, 'client-123', 'the state binds to the client this login registered');
  assert.equal(tracking.trackingMode, 'backfill_only');
  const neighbour = JSON.parse(fs.readFileSync(trackingStateFile(TEST_KEY), 'utf-8'));
  assert.equal(neighbour.identity, 'old-login', 'the other account’s policy cache is untouched');
});

test('a whoami that fails still stamps linkedAt but records no policy', async () => {
  const result = await performLogin(loginDeps({ whoami: async () => { throw new Error('offline'); } }));

  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(result.key), 'utf-8'));
  assert.ok(tracking.linkedAt);
  assert.equal(tracking.trackingMode, undefined);
});

test('an already-linked login refreshes the tracking cache from the stored session', async () => {
  const KEY = '77778888';
  await addAccount({ key: KEY, email: 'cache@example.com', name: 'Dev', clientId: 'existing-client' });
  try { fs.rmSync(trackingStateFile(KEY), { force: true }); } catch { /* clean slate */ }

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'cache@example.com', trackingMode: 'live', backfillCompleted: true }),
    getCredentials: storedSession('existing-client', 'already-stored', KEY),
  }));

  assert.equal(result.outcome, 'already-linked');
  assert.equal(result.key, KEY);
  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(KEY), 'utf-8'));
  assert.equal(tracking.trackingMode, 'live');
  assert.equal(tracking.backfillCompleted, true);
  assert.equal(tracking.identity, 'existing-client', 'the stored client keeps the account, so it keeps the state');
});

// ─── the account check-in (G-2-1 wiring) ────────────────────────────────────
//
// The trigger lives in performLogin, not in scripts/login.mjs, because this function is the shared
// entry for both the CLI script and the `beezi_login` MCP tool — putting it in the script would
// leave the MCP path silent.

test('a fresh link checks the account in, FORCED, with the session it just exchanged', async () => {
  const sync = syncSpy();
  const result = await performLogin(loginDeps({ syncAccountIfNeeded: sync }));

  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].key, result.key, 'under the key this login just minted');
  assert.equal(sync.calls[0].session.token, 'at', 'the token from exchangeCode, not one re-read from disk');
  assert.equal(sync.calls[0].session.clientId, 'client-123', 'the client id travels with the bearer');
  // The one trigger where force is genuinely load-bearing: a fresh identity inherits the PREVIOUS
  // identity's marker, so an unchanged payload hash would suppress the check-in guaranteed to be
  // news. Dropping `force` here is invisible until an account switch fails to propagate.
  assert.equal(sync.calls[0].options.force, true);
});

test('an already-linked re-login checks in UNFORCED, on the session the machine already holds', async () => {
  const KEY = '11112222';
  await addAccount({ key: KEY, email: 'held@example.com', name: 'Dev', clientId: 'existing-client' });
  const sync = syncSpy();

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'held@example.com' }),
    getCredentials: storedSession('existing-client', 'already-stored', KEY),
    syncAccountIfNeeded: sync,
  }));

  assert.equal(result.outcome, 'already-linked');
  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].key, KEY);
  assert.equal(sync.calls[0].session.token, 'already-stored', 'the stored session, not the one just exchanged');
  // Unforced on purpose: re-running the login command on an unchanged machine is not news, so the
  // payload hash still gates it and last_seen_at refreshes on the resync interval instead.
  assert.notEqual(sync.calls[0].options.force, true);
});

// lib/accounts.mjs's own sessionFor states the rule this pins: the blob's client_id wins when it
// has one, and the index row is the fallback. A pre-0.13 credential blob carries none, and dropping
// the row's would null the account's tracking identity and send the check-in with no X-Beezi-Client
// — a silent misattribution on the one machine that cannot tell anyone about it.
test('an already-linked account whose stored blob names no client falls back to the index row', async () => {
  const KEY = '99990000';
  await addAccount({ key: KEY, email: 'noclient@example.com', name: 'Dev', clientId: 'row-client' });
  try { fs.rmSync(trackingStateFile(KEY), { force: true }); } catch { /* clean slate */ }
  const sync = syncSpy();

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'noclient@example.com' }),
    // Keyed for the same reason storedSession is: this account's blob, and nobody else's.
    getCredentials: async (key) => (key === KEY
      ? { access_token: 'already-stored', expires_at: Date.now() + 3_600_000 }
      : null),
    syncAccountIfNeeded: sync,
  }));

  assert.equal(result.outcome, 'already-linked');
  assert.equal(sync.calls[0].session.clientId, 'row-client', 'the check-in still names a machine row');
  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(KEY), 'utf-8'));
  assert.equal(tracking.identity, 'row-client', 'the account keeps an identity to bind its state to');
});

test('a re-login whose stored token cannot be read re-arms that account rather than stranding it', async () => {
  const KEY = '33334444';
  await addAccount({ key: KEY, email: 'locked@example.com', name: 'Dev', clientId: 'old-client' });
  const sync = syncSpy();

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'locked@example.com' }),
    getCredentials: async () => { throw new Error('keyring locked'); },
    syncAccountIfNeeded: sync,
  }));

  assert.equal(result.outcome, 'relinked', 'a locked keyring must not fail a sign-in that succeeded');
  assert.equal(result.key, KEY, 'the account keeps its key, its directory and its linkedAt');
  assert.equal(result.account.clientId, 'client-123', 'the client just registered replaces the unreadable one');
  assert.equal(sync.calls[0].session.token, 'at', 'the check-in rides the session just exchanged');
  assert.equal(sync.calls[0].options.force, true);
});

// ─── an anonymous row is the SAME account, not a new one ────────────────────
//
// A row whose email is null cannot be matched by findByEmail, so before this the branch table fell
// through to "a new account" and minted a SECOND linked row for the same user — and linkedSessions
// filters on status, not identity, so the machine then fanned out two reports of every session into
// one workspace. Two kinds of row arrive null: one migrated from a pre-0.13 install, and one linked
// while the portal was unreachable (the test above pins that a link still happens).

test('a re-login as the user behind an anonymous MIGRATED row matches it instead of duplicating it', async () => {
  const KEY = 'cccc3333';
  // Exactly what migrateSingleAccount writes: a key, a client id, and nothing that names anybody.
  await addAccount({ key: KEY, email: null, name: null, tenantId: null, tenantName: null, clientId: 'legacy-client' });

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'migrated@example.com', tenantId: 't-1', tenantName: 'Acme' }),
    getCredentials: storedSession('legacy-client', 'already-stored', KEY),
  }));

  assert.equal(result.outcome, 'already-linked', 'the same user, so nothing new is linked');
  assert.equal(result.key, KEY, 'and it is the row that was already here');
  const rows = await listAccounts();
  assert.equal(rows.filter((row) => row.email === 'migrated@example.com').length, 1, 'exactly one row');
  const filled = rows.find((row) => row.key === KEY);
  assert.equal(filled.email, 'migrated@example.com', 'the row now carries the identity its own token names');
  assert.equal(filled.name, 'Dev');
  assert.equal(filled.tenantId, 't-1');
  assert.equal(filled.tenantName, 'Acme');
});

test('an anonymous row whose own token names nobody is left alone', async () => {
  // The resolution has to be able to give up without disturbing anything: an account that cannot
  // produce a token, or a portal that does not answer, must leave the row exactly as it was.
  const KEY = '99990000';
  await addAccount({ key: KEY, email: null, name: null, clientId: 'legacy-client' });

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Someone Else', email: 'other@example.com' }),
    getCredentials: async () => null,
  }));

  assert.equal(result.outcome, 'linked', 'an unresolvable row cannot be claimed, so this is a new account');
  const stale = (await listAccounts()).find((row) => row.key === KEY);
  assert.equal(stale.email, null, 'and nothing was written to it on a guess');
});

// ─── a portal blip is not a verdict on the stored grant ─────────────────────

test('a whoami blip while re-checking a healthy account keeps its credentials', async () => {
  const KEY = 'aaaa1111';
  await addAccount({ key: KEY, email: 'blip@example.com', name: 'Dev', clientId: 'existing-client' });
  const stored = [];

  const result = await performLogin(loginDeps({
    // The NEW grant's whoami answers — that is where the email comes from — and the check of the
    // STORED one hits a 5xx, which lib/whoami.mjs reports as null. `null` is "we could not ask",
    // not "the grant is dead": collapsing the two replaced good credentials on a blip.
    whoami: async (session) => (session.token === 'already-stored'
      ? null
      : { valid: true, name: 'Dev', email: 'blip@example.com' }),
    getCredentials: storedSession('existing-client', 'already-stored', KEY),
    setCredentials: async (key) => { stored.push(key); return 'the OS keyring'; },
  }));

  assert.equal(result.outcome, 'already-linked');
  assert.equal(result.key, KEY);
  assert.deepEqual(stored, [], 'nothing was written over the working credentials');
  assert.equal(result.account.clientId, 'existing-client', 'and the tracking identity still names the stored client');
});

test('a stored token the portal REFUSES still re-arms the account', async () => {
  // The other half of the same distinction: 401/403 is the portal's own verdict, and it must go on
  // taking branch 2 exactly as it did.
  const KEY = 'bbbb2222';
  await addAccount({ key: KEY, email: 'dead@example.com', name: 'Dev', clientId: 'old-client' });

  const result = await performLogin(loginDeps({
    whoami: async (session) => (session.token === 'already-stored'
      ? { valid: false }
      : { valid: true, name: 'Dev', email: 'dead@example.com' }),
    getCredentials: storedSession('existing-client', 'already-stored', KEY),
  }));

  assert.equal(result.outcome, 'relinked');
  assert.equal(result.key, KEY);
  assert.equal(result.account.clientId, 'client-123', 'the client just registered replaces the refused one');
});

test('a check-in that throws never strands a completed sign-in', async () => {
  // The credentials are already stored by the time this runs. It is exactly the position whoami
  // was in when an unsettled request stranded a finished login, so it gets the same guarantee.
  const result = await performLogin(loginDeps({
    syncAccountIfNeeded: async () => { throw new Error('offline'); },
  }));
  assert.equal(result.outcome, 'linked');
  assert.equal(result.account.name, 'Dev Eloper');
});

test('a check-in that throws does not break the already-linked report either', async () => {
  const KEY = '55556666';
  await addAccount({ key: KEY, email: 'steady@example.com', name: 'Dev', clientId: 'existing-client' });

  const result = await performLogin(loginDeps({
    whoami: async () => ({ valid: true, name: 'Dev', email: 'steady@example.com' }),
    getCredentials: storedSession('existing-client', 'already-stored', KEY),
    syncAccountIfNeeded: async () => { throw new Error('offline'); },
  }));
  assert.equal(result.outcome, 'already-linked');
  assert.equal(result.account.name, 'Dev');
});

test('openBrowser refuses a non-http(s) URL instead of handing it to a shell', async () => {
  const result = await openBrowser('file:///c:/windows/system32/calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.detail, /non-http/);
});

test('openBrowser reports a launcher it cannot start', { skip: process.platform !== 'win32' }, async (t) => {
  // Point the launcher at a directory that holds no powershell.exe: the spawn fails, and the
  // caller has to learn about it rather than believing a browser opened.
  const prev = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\beezi-no-such-root';
  t.after(() => {
    if (prev === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prev;
  });

  const result = await openBrowser('https://auth.test/authorize?x=1');
  assert.equal(result.ok, false);
  assert.ok(result.detail, 'the failure carries a reason');
});
