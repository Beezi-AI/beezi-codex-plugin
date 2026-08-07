import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSessionStart, initSessionState } from '../lib/session-start.mjs';
import { stateDir } from '../lib/paths.mjs';
import { ENDPOINTS } from '../lib/config.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-start-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

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

// Defaults that keep the billing nudge out of the way unless a test asks for it. resolveSource is
// the real seam — a resolved api-key source carries no plan, so nothing is stale and nothing nudges.
const quietBilling = {
  resolveSource: () => 'openai_api_key',
  readBillingConfig: () => null,
  writeBillingConfig: () => {},
  isStale: () => false,
  // Always stubbed: unstubbed it reads the real ~/.codex/auth.json and the suite's result would
  // depend on whether the machine running it happens to be signed in to ChatGPT.
  readCodexAccount: () => null,
};

const noGit = () => { throw new Error('not a git repository'); };

test('an unlinked machine says so and makes no network call', async (t) => {
  tmpHome(t);
  const { fetchImpl, calls } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { getAccessToken: async () => null, fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.match(message, /not linked/);
  assert.equal(calls.length, 0);
});

test('a token getAccessToken throws on reads as unlinked', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { getAccessToken: async () => { throw new Error('keyring locked'); }, fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.match(message, /not linked/);
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
      getAccessToken: async (_deps, options) => {
        issued += 1;
        return options?.forceRefresh ? 'fresh' : 'stale';
      },
      fetchImpl,
      gitImpl: noGit,
      ...quietBilling,
    },
  );
  assert.equal(issued, 2, 'one initial read, one forced refresh');
  assert.equal(message, null, 'a recovered link says nothing');
});

test('a token still rejected after renewal reports a rejection, not a revocation', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ whoami: () => status(401) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    { getAccessToken: async () => 'stale', fetchImpl, gitImpl: noGit, ...quietBilling },
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
      getAccessToken: async () => 'tok',
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
    { getAccessToken: async () => 'tok', fetchImpl, gitImpl: noGit, ...quietBilling },
  );
  assert.equal(message, null);
});

test('a connected repo is announced with its project name', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router({ repos: () => ok({ connected: true, projectName: 'Apollo' }) });
  const message = await runSessionStart(
    { session_id: 's1', cwd: process.cwd() },
    {
      getAccessToken: async () => 'tok',
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
      getAccessToken: async () => 'tok',
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
    { getAccessToken: async () => 'tok', fetchImpl, gitImpl: noGit, ...quietBilling },
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
      getAccessToken: async () => 'tok',
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
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ source: 'subscription' }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readCodexAccount: () => null, // auth.json says nothing — the auto-capture cannot help
    },
  );
  // The nudge points at signing in, not at a refresh: the refresh is what just failed.
  assert.match(message, /could not read your ChatGPT plan/);
  assert.match(message, /sign you in/);
});

test('a stale plan is captured from auth.json without asking anyone', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      // The real isStale, deliberately: the point of capturing here is that the nudge below then
      // sees a fresh config and stays quiet. Stubbing it would assert nothing about that.
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readCodexAccount: () => ({ authMode: 'chatgpt', subscriptionType: 'pro', plan: 'pro', expiresAt: null }),
    },
  );
  const captured = written.find((c) => c.capturedBy === 'session-start');
  assert.ok(captured, 'the plan was captured');
  assert.equal(captured.plan, 'pro_20x', "Codex's bare `pro` is the $200 20× tier");
  assert.equal(captured.source, 'subscription');
  assert.equal(message, null, 'and no nudge is emitted for a machine we just resolved');
});

test('ChatGPT Go is a real plan, not "unknown"', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readCodexAccount: () => ({ authMode: 'chatgpt', subscriptionType: 'go', plan: 'go', expiresAt: null }),
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
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'team', selfReported: true }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readCodexAccount: () => { read += 1; return { plan: 'plus', subscriptionType: 'plus' }; },
    },
  );
  assert.equal(read, 0, 'auth.json is not even read for a self-reported machine');
});

test('auto-capture leaves an api-key machine alone', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let read = 0;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => ({ version: 1, source: 'openai_api_key' }),
      writeBillingConfig: () => {},
      isStale: () => true,
      readCodexAccount: () => { read += 1; return { plan: 'pro', subscriptionType: 'pro' }; },
    },
  );
  assert.equal(read, 0, 'a machine paying per token is never stamped with a subscription tier');
});

test('auto-capture does not re-read auth.json when the plan is fresh', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  let read = 0;
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription', plan: 'pro' }),
      writeBillingConfig: () => {},
      isStale: () => false,
      readCodexAccount: () => { read += 1; return { plan: 'pro', subscriptionType: 'pro' }; },
    },
  );
  assert.equal(read, 0);
});

test('a throwing readCodexAccount does not break session start', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: () => {},
      readCodexAccount: () => { throw new Error('unreadable'); },
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
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'unknown',
      readBillingConfig: () => null,
      writeBillingConfig: () => {},
      isStale: () => false,
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
      getAccessToken: async () => 'tok',
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
      getAccessToken: async () => 'tok',
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
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
  const message = await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readCodexAccount: expiredAccount(expiresAt),
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
  tmpHome(t);
  const { fetchImpl } = router();
  // Session 1 wrote the unknown-plan config above; session 2 must not treat it as settled, because
  // Codex refreshes auth.json on use and the real plan appears the moment it does.
  const afterExpired = { version: 1, source: 'subscription', plan: 'unknown', credentialsExpiresAt: Date.now() - 1000, capturedBy: 'session-start' };
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => afterExpired,
      writeBillingConfig: (c) => written.push(c),
      // The token has since been refreshed and now names a real, still-valid plan.
      readCodexAccount: () => ({ authMode: 'chatgpt', subscriptionType: 'pro', plan: 'pro', expiresAt: Date.now() + 86_400_000 }),
    },
  );
  assert.equal(written.find((c) => c.capturedBy === 'session-start')?.plan, 'pro_20x',
    'the refreshed plan is picked up with no user action');
});

test('a plan claim with no expiry at all is still captured', async (t) => {
  tmpHome(t);
  const { fetchImpl } = router();
  const written = [];
  await runSessionStart(
    { session_id: 's1', cwd: null },
    {
      getAccessToken: async () => 'tok',
      fetchImpl,
      gitImpl: noGit,
      resolveSource: () => 'subscription',
      readBillingConfig: () => ({ version: 1, source: 'subscription' }),
      writeBillingConfig: (c) => written.push(c),
      readCodexAccount: () => ({ authMode: 'chatgpt', subscriptionType: 'team', plan: 'team', expiresAt: null }),
    },
  );
  assert.equal(written.find((c) => c.capturedBy === 'session-start')?.plan, 'team');
});
