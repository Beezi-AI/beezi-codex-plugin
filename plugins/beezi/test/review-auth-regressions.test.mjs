import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken, getAuthentication } from '../lib/token.mjs';
import * as credentials from '../lib/credentials.mjs';
import { linkStatus, describeLink } from '../lib/link-status.mjs';
import { runSessionStart } from '../lib/session-start.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { usageIdentityFields } from '../lib/usage-report-codex.mjs';
import * as diagnostics from '../lib/diagnostics.mjs';
import { accountSession } from '../tools/account-fixtures.mjs';

function home(t) {
  const before = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-auth-'));
  process.env.BEEZI_CODEX_HOME = dir;
  process.env.CODEX_HOME = path.join(dir, 'codex');
  fs.mkdirSync(process.env.CODEX_HOME);
  t.after(() => {
    process.env.BEEZI_CODEX_HOME = before.BEEZI_CODEX_HOME;
    process.env.CODEX_HOME = before.CODEX_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Every credential call is keyed from 0.13 on; these regressions are about one account's store.
const KEY = 'a1b2c3d4';
// What the index says about that account, and the session the fan-out carries for it. Both are
// injected rather than written to disk: these cases are about the credential store and the token
// endpoint, and a real index read would drag the one-time migration in with it.
const ROW = { key: KEY, email: 'd@e.f', name: 'Dev', tenantName: 'W-1', clientId: 'old-client', status: 'linked' };
const INDEXED = { listAccounts: async () => [ROW], getDefaultKey: async () => KEY };
const SESSION = accountSession(KEY, 'synthetic-token');
const store = { checkEnvironment: () => ({ status: 'ok' }), platform: 'unknown', run: () => { throw new Error('No native store'); } };
const old = { client_id: 'old-client', token_endpoint: 'https://invalid.example/token', access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 0 };
const nextTokens = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 };

test('F9: a stale pre-lock read does not resubmit the consumed grant', async t => {
  home(t);
  await credentials.setCredentials(KEY, old, store);
  const readDone = gate(), resume = gate();
  const sent = [];
  const refreshTokens = async ({ refreshToken }) => {
    sent.push(refreshToken);
    return sent.length === 1 ? { tokens: nextTokens } : { invalidGrant: true };
  };
  const a = getAccessToken(KEY, { ...store, refreshTokens, getCredentials: async () => {
    const snapshot = await credentials.getCredentials(KEY, store);
    readDone.resolve(); await resume.promise; return snapshot;
  } });
  await readDone.promise;
  assert.equal(await getAccessToken(KEY, { ...store, refreshTokens }), 'rotated-access');
  resume.resolve();
  assert.equal(await a, 'rotated-access');
  assert.deepEqual(sent, ['old-refresh']);
  assert.equal((await credentials.getCredentials(KEY, store)).access_token, 'rotated-access');
});

for (const action of ['logout', 'new-login']) {
  for (const response of [{ tokens: nextTokens }, { invalidGrant: true }]) {
    test(`F10: ${action} survives an old refresh (${response.invalidGrant ? 'rejected' : 'successful'})`, async t => {
      home(t);
      await credentials.setCredentials(KEY, old, store);
      const started = gate(), reply = gate();
      const refreshing = getAccessToken(KEY, { ...store, refreshTokens: async () => {
        started.resolve(); return reply.promise;
      } });
      await started.promise;
      await credentials.deleteCredentials(KEY, store);
      if (action === 'new-login') await credentials.setCredentials(KEY, { ...old, client_id: 'new-client', access_token: 'new-login', expires_at: Date.now() + 3600000 }, store);
      reply.resolve(response);
      await refreshing;
      const current = await credentials.getCredentials(KEY, store);
      if (action === 'logout') assert.equal(current, null);
      else {
        assert.equal(current.client_id, 'new-client');
        assert.equal(current.access_token, 'new-login');
      }
    });
  }
}

test('F11: fallback commit remains authoritative when the old native entry returns', async t => {
  home(t);
  let native = null, failWrite = false, failRead = false;
  const deps = { platform: 'darwin', run: (_cmd, args) => {
    if (args[0] === 'add-generic-password') {
      if (failWrite) return { ok: false, stdout: '' };
      native = args[args.length - 1]; return { ok: true, stdout: '' };
    }
    if (args[0] === 'find-generic-password') return { ok: !failRead, stdout: native || '' };
    return { ok: false, stdout: '' };
  } };
  await credentials.setCredentials(KEY, old, deps);
  failRead = true;
  await assert.rejects(credentials.getCredentials(KEY, deps), { code: 'CREDENTIALS_UNAVAILABLE' });
  failRead = false;
  failWrite = true;
  await credentials.setCredentials(KEY, { ...old, access_token: 'new-access' }, deps);
  assert.equal((await credentials.getCredentials(KEY, deps)).access_token, 'new-access');
});

test('F12: transient refresh failure preserves the link and reports temporary status', async t => {
  home(t);
  await credentials.setCredentials(KEY, old, store);
  const auth = () => getAuthentication(KEY, { ...store, recordIssue: () => {}, refreshTokens: async () => ({ tokens: null }) });
  const status = await linkStatus({ ...INDEXED, getAuthentication: auth, hooksStatus: () => ({ state: 'installed', registered: [] }) });
  assert.equal(status.state, 'unreachable');
  assert.equal(status.authState, 'unavailable');
  assert.match(describeLink(status), /temporarily/);
  // The account is LINKED in the index but produced no session this run, which is exactly the
  // state that used to be reported as 'this machine is not linked'. getAuthentication is what
  // session start asks for the reason.
  const banner = await runSessionStart({}, { ...INDEXED, linkedSessions: async () => [], getAuthentication: auth });
  assert.match(banner, /temporarily/);
  assert.ok(await credentials.getCredentials(KEY, store));
});

test('F13: live sessions and quota identity agree; explicit history does not guess an owner', async t => {
  const dir = home(t);
  const claims = Buffer.from(JSON.stringify({ email: 'synthetic@example.invalid' })).toString('base64url');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'account-A', id_token: `e30.${claims}.signature` } }));
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'review-session', cwd: dir } },
    { type: 'turn_context', timestamp: '2026-01-01T00:00:01Z', payload: { cwd: dir, model: 'gpt-5.2-codex' } },
    { type: 'event_msg', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 0 } } } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const deps = { linkedSessions: async () => [SESSION], env: {}, gitImpl: () => null,
    resolveTranscript: () => ({ sessionId: 'review-session', transcriptPath: file }), readAgents: () => ({}), findSubagentRollouts: () => [] };
  const payloads = [];
  const opts = { skipFlush: true, drainRateLimits: false, sink: p => payloads.push(p) };
  await runCheckpoint({ session_id: 'review-session', cwd: dir }, deps, opts);
  assert.equal(payloads[0].account_uuid, usageIdentityFields({ env: {} }).account_uuid);
  assert.equal(payloads[0].account_uuid, 'account-A');
  assert.equal(payloads[0].account_email, 'synthetic@example.invalid');
  await runCheckpoint({ session_id: 'review-session', cwd: dir }, deps, { ...opts, persistState: false, startCursor: 0 });
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].account_uuid, undefined);
});

test('F14: rate-limited diagnostics survive and can be delivered by a later drain', async t => {
  home(t);
  diagnostics.grantConsent();
  diagnostics.recordIssue({ code: diagnostics.DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED });
  const files = () => fs.readdirSync(diagnostics.diagnosticsDir()).filter(n => n.endsWith('.json'));
  assert.equal(files().length, 1);
  const limited = await diagnostics.flushDiagnostics(accountSession(KEY, 'token'), { postJsonImpl: async () => ({ status: 429 }) });
  assert.equal(limited.deleted, 0);
  assert.equal(files().length, 1);
  const retry = await diagnostics.flushDiagnostics(accountSession(KEY, 'token'), { postJsonImpl: async () => ({ status: 200 }) });
  assert.equal(retry.sent, 1);
  assert.equal(files().length, 0);
});
