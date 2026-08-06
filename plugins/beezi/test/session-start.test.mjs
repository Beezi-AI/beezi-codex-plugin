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

test('a stale subscription plan is nudged about', async (t) => {
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
    },
  );
  assert.match(message, /plan info is missing or stale/);
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
