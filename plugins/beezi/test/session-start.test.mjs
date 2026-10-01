// Imported first, and for its side effect as much as its exports: it redirects every root the
// plugin can resolve into a per-process sandbox and deletes OPENAI_API_KEY from process.env.
// See tools/hermetic-env.mjs for the three leak channels this file used to sit on top of.
import { withCodexAuth } from '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSessionStart, initSessionState } from '../lib/session-start.mjs';
import { stateDir } from '../lib/paths.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, fakeKeyring, TEST_KEY } from '../tools/account-fixtures.mjs';

// The credential store is NOT sandboxed by BEEZI_CODEX_HOME. A test that reaches the real
// getAuthentication — the forced-refresh retry does, unless it stubs it — spawns `security` against
// the DEVELOPER'S OWN keychain. The fake store is carried by every account bag below so no test in
// this file can reach it, whatever it leaves unstubbed.
const store = { run: fakeKeyring().run, platform: 'darwin' };

// SessionStart resolves every linked account and reports the session to each of them. The seams
// are therefore the ACCOUNT ones: `linkedSessions` for "who can produce a token right now" and
// `listAccounts` for "who is linked at all", which is what lets an account that produced no
// session be explained instead of read as "this machine is not linked".
const ACCOUNT = accountSession(TEST_KEY, 'tok');
const ROW = {
  key: ACCOUNT.key, email: ACCOUNT.email, name: ACCOUNT.name,
  tenantName: ACCOUNT.tenantName, clientId: ACCOUNT.clientId, status: 'linked',
};
// One linked account that resolves. `token` overrides the bearer it hands out.
const linked = (token) => ({
  ...store,
  listAccounts: async () => [ROW],
  linkedSessions: async () => [token === undefined ? ACCOUNT : { ...ACCOUNT, token }],
});
// Linked in the index, but no session this run — the caller says why via getAuthentication.
const unresolved = (getAuthentication) => ({
  ...store,
  listAccounts: async () => [ROW],
  linkedSessions: async () => [],
  getAuthentication,
});
// Nothing in the index at all.
const NOT_LINKED = { ...store, listAccounts: async () => [], linkedSessions: async () => [] };

const tmpHome = (t) => sandboxHome(t, 'beezi-start-');

const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const status = (code, body = {}) => ({ ok: code < 400, status: code, json: async () => body });

// A fetch double that answers whoami and /repos/status independently.
function router({ whoami: whoamiRes = () => ok({ email: 'a@b.c' }), repos = () => ok({ connected: false }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith(ENDPOINTS.whoami)) return whoamiRes(init, calls);
    if (u.endsWith(ENDPOINTS.reposStatus)) return repos(init, calls);
    return ok({});
  };
  return { fetchImpl, calls };
}

// Tier 1 of the plan ladder is a SUBPROCESS. Unstubbed it spawns a real `codex app-server` against
// the developer's Codex install — and against the fixture CODEX_HOME, whose temp dir the running
// child then holds open, so the fixture's own cleanup fails with EPERM on Windows. `unavailable` is
// what a machine with no Codex CLI answers, so the tests keep exercising the auth.json tier.
const noAppServer = async () => ({ ok: false, reason: 'unavailable' });

// Defaults that keep the billing nudge out of the way unless a test asks for it. resolveSource is
// the real seam — a resolved api-key source carries no plan, so nothing is stale and nothing nudges.
const quietBilling = {
  resolveSource: () => 'openai_api_key',
  readBillingConfig: () => null,
  writeBillingConfig: () => {},
  isStale: () => false,
  // Always stubbed: unstubbed it reads the real ~/.codex/auth.json and the suite's result would
  // depend on whether the machine running it happens to be signed in to ChatGPT.
  readChatgptAuth: () => null,
  // Tier 1 of the same ladder — see noAppServer above.
  readAccountViaAppServer: noAppServer,
};

const noGit = () => { throw new Error('not a git repository'); };

// Records every account check-in the hook makes: [token, options, deps]. The DEPS are the point —
// the three seams the hook has to hand over are only assertable on the third argument.
function syncSpy(impl) {
  const calls = [];
  const spy = async (key, session, options, syncDeps) => {
    calls.push({ key, session, token: session && session.token, options: options || {}, deps: syncDeps || {} });
    return impl ? impl() : { synced: true, status: 200 };
  };
  spy.calls = calls;
  return spy;
}

test('an unlinked machine says so and makes no network call', async (t) => {
  tmpHome(t);
  const { fetchImpl, calls } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...NOT_LINKED, fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.match(message, /not linked/);
  assert.equal(calls.length, 0);
});

test('a throwing token accessor reports temporary authentication failure', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...unresolved(async () => { throw new Error('keyring locked'); }), fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.match(message, /temporarily unavailable/);
});

// ─── the anonymous row's identity is filled from the whoami already being made ───────────────
//
// A row whose email is null — migrated from a pre-0.13 install, or linked while the portal was
// unreachable — can never be matched by lib/accounts.mjs's findByEmail, so a re-login as its own
// user mints a SECOND linked row and the machine fans out two reports of every session into one
// workspace. Session start is where a valid whoami per account already happens.

test('a valid whoami fills an anonymous account row in', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ whoami: () => ok({ email: 'filled@example.com', name: 'Dev', tenantId: 't-9', tenantName: 'Acme' }) });
  const patches = [];
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      // What linkedSessions hands out for a migrated row: a usable token, and nobody named.
      linkedSessions: async () => [{ ...ACCOUNT, email: null, name: null, tenantName: null }],
      updateAccount: async (key, patch) => { patches.push({ key, patch }); },
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
    },
  );
  assert.equal(message, null, 'a healthy account still says nothing');
  assert.equal(patches.length, 1, 'the row is written exactly once');
  assert.equal(patches[0].key, ACCOUNT.key);
  assert.deepEqual(patches[0].patch, {
    email: 'filled@example.com', name: 'Dev', tenantId: 't-9', tenantName: 'Acme',
  });
});

test('an account that already names somebody is not rewritten every session', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ whoami: () => ok({ email: 'someone@example.com', name: 'Dev' }) });
  const patches = [];
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked(), updateAccount: async (key, patch) => { patches.push({ key, patch }); },
      fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.equal(message, null);
  assert.deepEqual(patches, [], 'an index write on every session start of every account is not free');
});

test('a rejected token is renewed once before the link is called bad', async (t) => {
  tmpHome(t);
  // expires_at is only ever our estimate — the server's 401 is better evidence, so take its
  // word and refresh rather than reporting a rejection a single renewal would have fixed.
  let issued = 0;
  const { fetchImpl } = router({
    whoami: (init) => (init.headers.Authorization === 'Bearer fresh' ? ok({}) : status(401)),
  });
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked('stale'),
      getAuthentication: async (_key, _deps, options) => {
        issued += 1;
        return { accessToken: options?.forceRefresh ? 'fresh' : 'stale', state: 'ready' };
      },
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
    },
  );
  assert.equal(issued, 1, 'the initial bearer rides on the session; only the refresh is a read');
  assert.equal(message, null, 'a recovered link says nothing');
});

test('a token still rejected after renewal reports a rejection, not a revocation', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ whoami: () => status(401) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked('stale'), getAuthentication: async () => ({ accessToken: 'stale', state: 'ready' }),
      fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.match(message, /was rejected/);
  assert.doesNotMatch(message, /revoked/);
});

test('a 403 never deletes credentials', async (t) => {
  tmpHome(t);
  // whoami reports invalid for 401 and 403 alike. A 403 is authenticated-but-not-permitted —
  // a workspace permission change or a wrong-environment token — and wiping the credential
  // store for it costs the user a full re-login. Regression guard.
  let deleted = false;
  const { fetchImpl } = router({ whoami: () => status(403) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      deleteCredentials: async () => { deleted = true; },
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
    },
  );
  assert.match(message, /was rejected/);
  assert.equal(deleted, false);
});

test('an unreachable whoami is treated as valid and stays silent', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ whoami: () => { throw new Error('offline'); } });
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked(), fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.equal(message, null);
});

test('a connected repo is announced with its project name', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ repos: () => ok({ connected: true, projectName: 'Apollo' }) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: process.cwd() },
    {
      ...linked(),
      fetchImpl,
      gitImpl: () => 'https://host/org/repo.git',
      ...quietBilling,
    },
  );
  assert.match(message, /repo connected to "Apollo"/);
});

test('a repo with no Beezi project is announced, without claiming it is untracked', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ repos: () => ok({ connected: false }) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: process.cwd() },
    {
      ...linked(),
      fetchImpl,
      gitImpl: () => 'https://host/org/repo.git',
      ...quietBilling,
    },
  );
  // Nothing gates on `connected` — the checkpoint reports every repo either way, so the old
  // "No analytics tracked here" wording was simply false.
  assert.match(message, /not connected to a Beezi project/);
  assert.match(message, /still tracked/);
});

test('a cwd outside any repo is not announced at all', async (t) => {
  const home = tmpHome(t); // empty: discoverRepos' child scan finds nothing to walk
  const { fetchImpl, calls } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: home },
    { ...linked(), fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.equal(message, null);
  assert.ok(!calls.some((u) => u.endsWith(ENDPOINTS.reposStatus)), 'no repo probe without an origin');
});

test('a repo probe that fails leaves session start silent', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ repos: () => { throw new Error('offline'); } });
  const message = await runSessionStart(
    { session_id: 's1', cwd: process.cwd() },
    {
      ...linked(),
      fetchImpl,
      gitImpl: () => 'https://host/org/repo.git',
      ...quietBilling,
    },
  );
  assert.equal(message, null);
});

test('a stale subscription plan the account cannot name is nudged about', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ source: 'subscription' }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => null, // auth.json says nothing — the auto-capture cannot help
    },
  );
  // The nudge points at signing in, not at a refresh: the refresh is what just failed.
  assert.match(message, /could not read your ChatGPT plan/);
  assert.match(message, /sign you in/);
});

test('a stale plan is captured from auth.json without asking anyone', async (t) => {
  // The fixture is now belt-and-braces rather than load-bearing: captureFromCodexAccount is handed
  // runSessionStart's own `resolveSource` and `env` (session-start.mjs:223-232), so the inner
  // resolution can no longer reach the real ~/.codex/auth.json or the real environment behind the
  // outer one's back. The dedicated proof of that seam is the api-key test below.
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      // The real isStale, deliberately: the point of capturing here is that the nudge below then
      // sees a fresh config and stays quiet. Stubbing it would assert nothing about that.
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'pro', plan: 'pro', expiresAt: null }),
    },
  );
  const captured = written.find((c) => c.capturedBy === 'session-start');
  assert.ok(captured, 'the plan was captured');
  assert.equal(captured.plan, 'pro_20x', "Codex's bare `pro` is the $200 20× tier");
  assert.equal(captured.source, 'subscription');
  assert.equal(message, null, 'and no nudge is emitted for a machine we just resolved');
});

// G-10-1 L1/L3 for this path. runSessionStart resolves the source ONCE and then captures the plan;
// before the seam was threaded, the capture reached billing-capture.mjs's module-level
// resolveSource and the real process.env, so a second, unseen resolution could contradict the first
// and drop the plan fields it had just earned. The auth.json on disk says the opposite of the
// injected resolver on purpose: only the injected one may decide.
test('the capture follows the session-start resolution, not a second one of its own', async (t) => {
  withCodexAuth(t, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-live-not-a-real-key' });
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      env: { OPENAI_API_KEY: 'sk-live-not-a-real-key' },
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'plus', plan: 'plus', expiresAt: null }),
    },
  );
  const captured = written.find((c) => c.capturedBy === 'session-start');
  assert.ok(captured, 'the capture ran');
  assert.equal(captured.source, 'subscription', 'the inner resolution used the injected ladder');
  assert.equal(captured.plan, 'plus', 'a contradicted resolution would have written plan: null');
});

test('ChatGPT Go is a real plan, not "unknown"', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 + L3 — see the first auto-capture test above
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'go', plan: 'go', expiresAt: null }),
    },
  );
  // Go used to normalize to 'unknown', so nothing was captured and the nudge fired forever.
  assert.equal(written.find((c) => c.capturedBy === 'session-start')?.plan, 'go');
});

test('auto-capture never overrides a plan the user reported by hand', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let read = 0;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'team', selfReported: true }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => { read += 1; return { plan: 'plus', subscriptionType: 'plus' }; },
      // The counter now has a second, legitimate consumer: the account check-in reads the same
      // file for accountUuid/email on every session. Stub it out so this stays a statement about
      // the AUTO-CAPTURE, which is what the assertion is about.
      syncAccount: async () => ({ synced: false }),
    },
  );
  // Deliberately narrower than it used to read. "auth.json is not even read" stopped being true
  // of production the moment the check-in landed — it reads the same file every session for
  // accountUuid/email. What still holds, and what this proves, is that the AUTO-CAPTURE does not.
  assert.equal(read, 0, 'the auto-capture does not read auth.json for a self-reported machine');
});

test('auto-capture leaves an api-key machine alone', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let read = 0;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => ({ version: 1, source: 'openai_api_key' }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => { read += 1; return { plan: 'pro', subscriptionType: 'pro' }; },
      // Scoped to the auto-capture — see the self-reported test above. The check-in reading this
      // file is not a stamping: billing.json's null subscriptionType is already the ladder's
      // decision, so no plan claim reaches the payload on an api-key machine either way.
      syncAccount: async () => ({ synced: false }),
    },
  );
  assert.equal(read, 0, 'the auto-capture never stamps a machine paying per token with a tier');
});

test('auto-capture does not re-read auth.json when the plan is fresh', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let read = 0;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'pro' }),
      writeBillingConfig: () => {},
      isStale: () => false,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => { read += 1; return { plan: 'pro', subscriptionType: 'pro' }; },
      // Scoped to the auto-capture — see the self-reported test above.
      syncAccount: async () => ({ synced: false }),
    },
  );
  assert.equal(read, 0);
});

test('a newer auth.json refreshes the account before check-in even when the plan is fresh', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  let probes = 0;
  const existing = {
    version: 1,
    source: 'subscription',
    subscriptionType: 'plus',
    plan: 'plus',
    accountId: 'account-A',
    email: 'a@example.com',
    capturedAt: new Date().toISOString(),
    authFileMtimeMs: 100,
  };

  await runSessionStart(
    { session_id: 'account-switch', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => existing,
      writeBillingConfig: () => {},
      isStale: () => false,
      readAuthFileMtimeMs: () => 200,
      readAccountViaAppServer: async () => {
        probes += 1;
        return {
          ok: true,
          reason: 'ok',
          authType: 'chatgpt',
          subscriptionType: 'pro',
          plan: 'pro',
          accountId: 'account-B',
          email: 'b@example.com',
        };
      },
      readChatgptAuth: () => null,
      syncAccount: sync,
    },
  );

  assert.equal(probes, 1, 'the newer auth file must trigger live account discovery');
  const checkedIn = sync.calls[0].deps.readBillingConfig();
  assert.equal(checkedIn.accountId, 'account-B');
  assert.equal(checkedIn.email, 'b@example.com');
  assert.equal(checkedIn.authFileMtimeMs, 200);
  assert.equal(sync.calls[0].options.force, false,
    'the changed account moves the payload hash; an unchanged token refresh must stay network-free');
});

test('an already validated auth.json does not trigger account discovery', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let probes = 0;
  await runSessionStart(
    { session_id: 'unchanged-auth', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({
        version: 1,
        source: 'subscription',
        plan: 'plus',
        capturedAt: new Date().toISOString(),
        authFileMtimeMs: 200,
      }),
      writeBillingConfig: () => {},
      isStale: () => false,
      readAuthFileMtimeMs: () => 200,
      readAccountViaAppServer: async () => { probes += 1; return liveAppServer(); },
      readChatgptAuth: () => null,
      syncAccount: async () => ({ synced: false }),
    },
  );
  assert.equal(probes, 0);
});

test('the first mtime validation does not force a token-only account check-in', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  const existing = {
    version: 1,
    source: 'subscription',
    subscriptionType: 'plus',
    plan: 'plus',
    accountId: 'account-A',
    email: 'a@example.com',
    capturedAt: new Date().toISOString(),
  };

  await runSessionStart(
    { session_id: 'first-mtime-validation', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => existing,
      writeBillingConfig: () => {},
      isStale: () => false,
      readAuthFileMtimeMs: () => 200,
      readAccountViaAppServer: async () => ({
        ok: true,
        reason: 'ok',
        authType: 'chatgpt',
        subscriptionType: 'plus',
        plan: 'plus',
        accountId: 'account-A',
        email: 'a@example.com',
      }),
      readChatgptAuth: () => null,
      syncAccount: sync,
    },
  );

  assert.equal(sync.calls[0].options.force, false,
    'the unchanged payload hash may suppress the migration check-in');
});

test('a failed auth.json revalidation leaves its old marker so the next session retries', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let stored = {
    version: 1,
    source: 'subscription',
    subscriptionType: 'plus',
    plan: 'plus',
    accountId: 'account-A',
    capturedAt: new Date().toISOString(),
    authFileMtimeMs: 100,
  };
  let probes = 0;
  const deps = {
    ...linked(),
    fetchImpl,
    gitImpl: noGit,
    resolveSource: () => 'subscription',
    readBillingConfig: () => stored,
    writeBillingConfig: (config) => { stored = config; },
    isStale: () => false,
    readAuthFileMtimeMs: () => 200,
    readAccountViaAppServer: async () => {
      probes += 1;
      if (probes === 1) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        reason: 'ok',
        authType: 'chatgpt',
        subscriptionType: 'pro',
        plan: 'pro',
        accountId: 'account-B',
      };
    },
    readChatgptAuth: () => null,
    syncAccount: async () => ({ synced: false }),
  };

  await runSessionStart({ session_id: 'retry-1', cwd: null }, deps);
  assert.equal(stored.authFileMtimeMs, 100, 'a failed validation must not seal the newer file');
  await runSessionStart({ session_id: 'retry-2', cwd: null }, deps);
  assert.equal(probes, 2);
  assert.equal(stored.accountId, 'account-B');
  assert.equal(stored.authFileMtimeMs, 200);
});

test('a throwing readChatgptAuth does not break session start', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: () => {},
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => { throw new Error('unreadable'); },
    },
  );
  // The billing block is best-effort: the throw is swallowed and session start still returns. The
  // source was resolved before it, so the machine is still correctly nudged.
  assert.match(message, /could not read your ChatGPT plan/);
});

test('a machine with no billing signal is nudged, not silently guessed at', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'unknown',
      readBillingConfig: () => null,
      writeBillingConfig: () => {},
      isStale: () => false,
      // `unknown` is exactly the source shouldProbeAccount fires on, so without this the tier-1
      // ladder SPAWNS A REAL `codex app-server` from the suite — lib/session-start.mjs says so at
      // its own `readAccountViaAppServer` seam.
      readAccountViaAppServer: noAppServer,
    },
  );
  assert.match(message, /cannot determine how this machine bills Codex/);
});

test('billing.json is realigned to the resolved source at session start', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let written = null;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      // The user exported a key since the last session; the stored source still says subscription.
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'plus', capturedAt: '2026-01-01T00:00:00.000Z' }),
      writeBillingConfig: (cfg) => { written = cfg; },
      isStale: () => false,
    },
  );
  assert.equal(written.source, 'openai_api_key');
  assert.equal(written.plan, 'plus', 'the captured plan detail survives the realignment');
  assert.equal(written.capturedAt, '2026-01-01T00:00:00.000Z', 'capturedAt tracks the plan, not the source');
});

test('an already-correct billing.json is not rewritten', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let wrote = false;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => ({ version: 1, source: 'openai_api_key' }),
      writeBillingConfig: () => { wrote = true; },
      isStale: () => false,
    },
  );
  assert.equal(wrote, false);
});

test('initSessionState never resets an existing cursor', async (t) => {
  tmpHome(t);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 's1.json'), JSON.stringify({ cursor: 42 }));

  initSessionState('s1', { cwd: 'C:/work', transcriptPath: 'C:/roll.jsonl' });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8'));
  assert.equal(state.cursor, 42, 'a resume must not re-report the whole session');
  assert.equal(state.cwd, 'C:/work');
  assert.equal(state.transcriptPath, 'C:/roll.jsonl');
});

test('initSessionState seeds a new session at cursor 0', async (t) => {
  tmpHome(t);
  initSessionState('fresh', { cwd: 'C:/work' });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir(), 'fresh.json'), 'utf-8'));
  assert.equal(state.cursor, 0);
});

// The real shape observed on a live machine: an expired id_token still asserting a plan whose
// subscription window closed weeks ago. Believing it files a paying user under `free`, and `free`
// is valid enough that nothing would ever ask again.
const expiredAccount = (expiresAt) => () => ({
  authMode: 'chatgpt', subscriptionType: 'free', plan: 'free', expiresAt,
});

test('an expired plan claim records the expiry but not the stale plan label', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 + L3 — see the first auto-capture test above
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: expiredAccount(expiresAt),
    },
  );
  const captured = written.find((c) => c.capturedBy === 'session-start');
  assert.ok(captured, 'the observation is recorded rather than discarded');
  assert.equal(captured.plan, 'unknown', 'the stale label is NOT believed');
  assert.equal(captured.credentialsExpiresAt, expiresAt, 'but its expiry is kept');
  // Naming the date matters: re-signing in to Codex fixes this at the source and is far cheaper
  // than answering a tier questionnaire.
  assert.match(message, /Codex sign-in expired on \d{4}-\d{2}-\d{2}/);
});

test('an expired claim stays stale, so the next session start re-reads auth.json', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 + L3 — see the first auto-capture test above
  tmpHome(t);
  const { fetchImpl } = router();
  // Session 1 wrote the unknown-plan config above; session 2 must not treat it as settled, because
  // Codex refreshes auth.json on use and the real plan appears the moment it does.
  const afterExpired = { version: 1, source: 'subscription', plan: 'unknown', credentialsExpiresAt: Date.now() - 1000, capturedBy: 'session-start' };
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => afterExpired,
      writeBillingConfig: (c) => written.push(c),
      // The token has since been refreshed and now names a real, still-valid plan.
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'pro', plan: 'pro', expiresAt: Date.now() + 86_400_000 }),
    },
  );
  assert.equal(written.find((c) => c.capturedBy === 'session-start')?.plan, 'pro_20x',
    'the refreshed plan is picked up with no user action');
});

test('a plan claim with no expiry at all is still captured', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 + L3 — see the first auto-capture test above
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'team', plan: 'team', expiresAt: null }),
    },
  );
  assert.equal(written.find((c) => c.capturedBy === 'session-start')?.plan, 'team');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The account check-in (G-2-1 wiring).
//
// Every test here injects `syncAccount`. Unstubbed it runs the real module, and while the seams
// below keep that hermetic, a spy is the only way to assert WHAT was handed over — and the three
// things handed over are each independently droppable in a later edit without any assertion going
// red. Hence one test per seam rather than one test for the call.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('session start checks the account in, after billing, on the token it ended up with', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked(), fetchImpl, gitImpl: noGit, ...quietBilling, syncAccount: sync },
  );
  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].token, 'tok');
});

test('the check-in rides the RENEWED token, not the one the server just rejected', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({
    whoami: (init) => (init.headers.Authorization === 'Bearer fresh' ? ok({}) : status(401)),
  });
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked('stale'),
      getAuthentication: async (_key, _deps, options) => ({ accessToken: options && options.forceRefresh ? 'fresh' : 'stale', state: 'ready' }),
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
      syncAccount: sync,
    },
  );
  assert.equal(sync.calls[0].token, 'fresh', 'a check-in on the stale token would 401 for no reason');
});

test('an unlinked machine never checks in', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...NOT_LINKED, fetchImpl, gitImpl: noGit, ...quietBilling, syncAccount: sync },
  );
  assert.equal(sync.calls.length, 0);
});

test('the check-in gets the hook OWN fetch and account reader, never the module defaults', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const readChatgptAuth = () => null;
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth,
      syncAccount: sync,
    },
  );
  // Identity, not truthiness. A bare call would fall back to fetchCompat and the real
  // ~/.codex/auth.json reader — reopening exactly the hermeticity class G-10-1 closed on this
  // path, and doing it in a way that fails no assertion, only the runner's exit status.
  assert.equal(sync.calls[0].deps.fetchImpl, fetchImpl);
  assert.equal(sync.calls[0].deps.readChatgptAuth, readChatgptAuth);
});

test('the check-in is bounded at 1500ms, well inside the hook budget', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked(), fetchImpl, gitImpl: noGit, ...quietBilling, syncAccount: sync },
  );
  // Not optional. A refusal never seals the marker, so an unreachable API costs this on EVERY
  // session start, forever — at postJson's own 3s default that is a third of the hook's budget.
  assert.equal(sync.calls[0].deps.timeoutMs, 1500);
});

test('the check-in reads the billing config the hook already resolved', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  const stored = { version: 1, source: 'subscription', subscriptionType: 'pro', plan: 'pro' };
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => stored,
      writeBillingConfig: () => {},
      isStale: () => false,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => null,
      syncAccount: sync,
    },
  );
  // One fewer read, and — the part that matters — the check-in cannot disagree with the hook
  // about which plan this machine is on.
  assert.equal(sync.calls[0].deps.readBillingConfig(), stored);
});

test('a billing read that throws leaves the check-in with no config, not a stale one', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => { throw new Error('EACCES'); },
      writeBillingConfig: () => {},
      isStale: () => false,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => null,
      syncAccount: sync,
    },
  );
  // The caveat the reuse buys: the billing `try` threw before its read, so there is no config and
  // the module falls through to the id_token decode — the right answer for a machine with none.
  assert.equal(sync.calls[0].deps.readBillingConfig(), null);
});

test('a plan captured after an auth.json change relies on its changed payload hash', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: () => {},
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => ({ authMode: 'chatgpt', subscriptionType: 'pro', plan: 'pro', expiresAt: null }),
      syncAccount: sync,
    },
  );
  assert.equal(sync.calls[0].options.force, false,
    'the new plan changes the payload hash without forcing token-only refreshes to POST');
});

test('an ordinary session start does NOT force — the payload hash is gate enough', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...linked(), fetchImpl, gitImpl: noGit, ...quietBilling, syncAccount: sync },
  );
  // Any content change — an account switch, a plan change — moves the hash on its own. Forcing
  // every session would defeat the resync suppression that makes the steady state zero network.
  assert.equal(sync.calls[0].options.force, false);
});

test('realigning billing.json is not a capture, so it does not force', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      // The user exported a key since the last session: the source is rewritten, the plan fields
      // survive untouched — so the check-in payload cannot have moved.
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'plus' }),
      writeBillingConfig: () => {},
      isStale: () => false,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => null,
      syncAccount: sync,
    },
  );
  assert.equal(sync.calls[0].options.force, false);
});

test('a check-in that throws does not break session start', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ repos: () => ok({ connected: true, projectName: 'Apollo' }) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: process.cwd() },
    {
      ...linked(),
      fetchImpl,
      gitImpl: () => 'https://host/org/repo.git',
      ...quietBilling,
      // The module never throws by contract; this asserts the hook does not RELY on that.
      syncAccount: async () => { throw new Error('boom'); },
    },
  );
  assert.match(message, /repo connected to "Apollo"/, 'the message is assembled after the check-in');
});

test('a check-in that throws does not swallow the billing nudge either', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'unknown',
      readBillingConfig: () => null,
      writeBillingConfig: () => {},
      isStale: () => false,
      readAccountViaAppServer: noAppServer,
      readChatgptAuth: () => null,
      syncAccount: async () => { throw new Error('boom'); },
    },
  );
  assert.match(message, /cannot determine how this machine bills Codex/);
});

// ─── the machine the app-server tier exists for ───────────────────────────────────────────────
// Codex kept this machine's credentials in the OS keychain, so there is NO ~/.codex/auth.json. The
// source ladder has nothing to read and answers `unknown`. Before the probe gate was widened and
// step 4b was added, that machine could never capture a plan: session start skipped the capture
// (gated on `subscription`), and a plan captured by hand was overwritten back to `unknown` on the
// very next session.
const liveAppServer = async () => ({
  ok: true,
  reason: 'ok',
  authType: 'chatgpt',
  plan: 'plus',
  subscriptionType: 'plus',
  accountId: 'eb76c91d-9f94-4807-99aa-ed350b779ecd',
  email: 'live@example.com',
});

test('a machine with no auth.json captures its plan from the app server', async (t) => {
  withCodexAuth(t, null); // no auth.json at all
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      // The REAL ladder and the REAL gate, deliberately: they are what this asserts.
      readBillingConfig: () => null,
      writeBillingConfig: (c) => written.push(c),
      readAccountViaAppServer: liveAppServer,
      readChatgptAuth: () => null,
      syncAccount: async () => ({ synced: false }),
    },
  );
  const captured = written.find((c) => c.capturedBy === 'session-start');
  assert.ok(captured, 'the probe ran and its answer was written');
  assert.equal(captured.plan, 'plus');
  assert.equal(captured.source, 'subscription', 'resolved from what Codex itself said');
  assert.equal(captured.authType, 'chatgpt', 'recorded so the NEXT session resolves the same way');
  assert.equal(captured.accountId, 'eb76c91d-9f94-4807-99aa-ed350b779ecd');
  assert.equal(message, null, 'and the machine is not nudged about a plan it just captured');
});

test('the plan captured on such a machine survives the next session', async (t) => {
  withCodexAuth(t, null);
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  // What the run above wrote, fed back in as the existing config.
  const existing = {
    version: 1,
    source: 'subscription',
    subscriptionType: 'plus',
    plan: 'plus',
    capturedAt: new Date().toISOString(),
    capturedBy: 'session-start',
    authType: 'chatgpt',
  };
  const message = await runSessionStart(
    { session_id: 's2', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      readBillingConfig: () => existing,
      writeBillingConfig: (c) => written.push(c),
      // The probe must NOT run again — the plan is fresh.
      readAccountViaAppServer: async () => { throw new Error('the probe must not run'); },
      readChatgptAuth: () => null,
      syncAccount: async () => ({ synced: false }),
    },
  );
  const reverted = written.find((c) => c.source === 'unknown');
  assert.equal(reverted, undefined, 'syncBillingSource must not overwrite the captured source');
  assert.equal(message, null, 'and no nudge — the machine knows what it bills');
});

test('a machine that neither Codex nor auth.json can name is still nudged, not guessed at', async (t) => {
  withCodexAuth(t, null);
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's3', cwd: null },
    {
      ...linked(),
      fetchImpl,
      gitImpl: noGit,
      readBillingConfig: () => null,
      writeBillingConfig: () => {},
      readAccountViaAppServer: async () => ({ ok: false, reason: 'no-credentials' }),
      readChatgptAuth: () => null,
      syncAccount: async () => ({ synced: false }),
    },
  );
  assert.match(message, /cannot determine how this machine bills/);
});

// ─── the fan-out ─────────────────────────────────────────────────────────────────────────────
//
// One session, reported to every linked account: one whoami each under that account's own client
// id, one queue drain each, one check-in each, and one repo announce each — because the repo→
// project mapping is a fact about a TENANT and two workspaces answer it differently.

const SECOND = accountSession('99887766', 'tok-b');
const SECOND_ROW = {
  key: SECOND.key, email: SECOND.email, name: SECOND.name,
  tenantName: SECOND.tenantName, clientId: SECOND.clientId, status: 'linked',
};
const both = (sessions) => ({
  listAccounts: async () => [ROW, SECOND_ROW],
  linkedSessions: async () => (sessions || [ACCOUNT, SECOND]),
});

test('two linked accounts are each checked in, under their own client id', async (t) => {
  tmpHome(t);
  const seen = [];
  const { fetchImpl } = router({
    whoami: (init) => { seen.push(init.headers['X-Beezi-Client']); return ok({}); },
  });
  const sync = syncSpy();

  await runSessionStart(
    { session_id: 's1', cwd: null },
    { ...both(), fetchImpl, gitImpl: noGit, ...quietBilling, syncAccount: sync },
  );

  assert.deepEqual(seen, ['c-a1b2c3d4', 'c-99887766'],
    'each whoami carries its own account client id, never one shared machine id');
  assert.deepEqual(sync.calls.map((c) => c.key), ['a1b2c3d4', '99887766']);
  assert.deepEqual(sync.calls.map((c) => c.token), ['tok', 'tok-b']);
});

test('one rejected account is named and skipped; the other still reports', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({
    // The second account's bearer is refused, and refused again after the renewal.
    whoami: (init) => (init.headers.Authorization === 'Bearer tok' ? ok({}) : status(401)),
    repos: () => ok({ connected: true, projectName: 'App' }),
  });
  const sync = syncSpy();

  const message = await runSessionStart(
    { session_id: 's1', cwd: 'C:/work/app' },
    {
      ...both(),
      getAuthentication: async () => ({ accessToken: 'tok-b', state: 'ready' }),
      fetchImpl,
      gitImpl: () => 'https://host/org/repo.git',
      ...quietBilling,
      syncAccount: sync,
    },
  );

  assert.match(message, /W-99887766 is not reporting/, 'the broken workspace is named');
  assert.deepEqual(sync.calls.map((c) => c.key), ['a1b2c3d4'],
    'the rejected account is skipped for the session, and the healthy one is not');
  assert.match(message, /W-a1b2c3d4 — Beezi: repo connected to "App"/,
    'each announcement names the workspace it came from');
});

test('an account that is linked but produced no session is explained, not reported as unlinked', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const sync = syncSpy();

  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      ...both([ACCOUNT]),              // the second account could not produce a token this run
      getAuthentication: async () => ({ state: 'refreshing' }),
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
      syncAccount: sync,
    },
  );

  assert.match(message, /W-99887766 is temporarily unavailable or refreshing/);
  assert.doesNotMatch(message, /not linked/, 'one account mid-refresh is not an unlinked machine');
  assert.deepEqual(sync.calls.map((c) => c.key), ['a1b2c3d4']);
});
