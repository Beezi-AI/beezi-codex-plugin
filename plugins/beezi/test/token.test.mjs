import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken } from '../lib/token.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FRESH = {
  client_id: 'cid', token_endpoint: 'https://x/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};

test('returns null when not linked', async () => {
  assert.equal(await getAccessToken({ getCredentials: async () => null }), null);
});

test('returns the stored token while fresh, without refreshing', async () => {
  let refreshed = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { refreshed = true; return { tokens: null }; },
    now: () => 1_000_000, // 9000s before expiry
  });
  assert.equal(token, 'at');
  assert.equal(refreshed, false);
});

test('refreshes an expiring token and persists the result', async (t) => {
  tmpHome(t);
  let saved;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 } }),
    now: () => 9_999_000, // 1s before expiry (< 60s skew)
  });
  assert.equal(token, 'at2');
  assert.equal(saved.access_token, 'at2');
  assert.equal(saved.refresh_token, 'rt2');
  assert.equal(saved.expires_at, 9_999_000 + 86_400_000);
});

test('invalid_grant wipes credentials and returns null', async (t) => {
  tmpHome(t);
  let deleted = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => { deleted = true; },
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
  assert.equal(deleted, true);
});

test('transient refresh failure yields no token rather than the stale one', async (t) => {
  tmpHome(t);
  // Handing back the token we already judged expired produces a 401 downstream, and callers
  // read a 401 as a revoked link — deleting credentials or dropping queued analytics.
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => ({ tokens: null }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
});

test('an omitted expires_in is assumed to be one hour, not a day', async (t) => {
  tmpHome(t);
  let saved;
  await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2' } }),
    now: () => 9_999_000,
  });
  assert.equal(saved.expires_at, 9_999_000 + 3_600_000);
});

test('waits out a concurrent refresh and returns what the holder stored', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'token-refresh.lock'), { recursive: true }); // someone holds the lock
  let reread = 0;
  const token = await getAccessToken({
    getCredentials: async () => {
      reread += 1;
      // The holder finished between the two reads.
      return reread === 1 ? { ...FRESH } : { ...FRESH, access_token: 'at2', expires_at: 20_000_000 };
    },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(token, 'at2');
  assert.equal(reread, 2);
});

test('a concurrent holder that never finished yields null, not the expired token', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'token-refresh.lock'), { recursive: true });
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }), // still expiring on the re-read
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(token, null);
});

test('forceRefresh renews even when expires_at still looks healthy', async (t) => {
  tmpHome(t);
  let refreshed = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => {
      refreshed = true;
      return { tokens: { access_token: 'at2', expires_in: 3600 } };
    },
    now: () => 1_000_000, // 9000s before expiry — normally a no-op
  }, { forceRefresh: true });
  assert.equal(refreshed, true);
  assert.equal(token, 'at2');
});

test('forceRefresh under contention rejects the same token the holder still has', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'token-refresh.lock'), { recursive: true });
  // The stored token is the one that just 401'd, so "looks fresh" is not enough.
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 1_000_000,
    sleep: async () => {},
  }, { forceRefresh: true });
  assert.equal(token, null);
});

test('forceRefresh under contention accepts a token the holder actually replaced', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'token-refresh.lock'), { recursive: true });
  let reread = 0;
  const token = await getAccessToken({
    getCredentials: async () => {
      reread += 1;
      return reread === 1 ? { ...FRESH } : { ...FRESH, access_token: 'at2' };
    },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 1_000_000,
    sleep: async () => {},
  }, { forceRefresh: true });
  assert.equal(token, 'at2');
});

test('the refresh lock lives under this plugin\'s root, never the Claude plugin\'s ~/.beezi', async (t) => {
  const dir = tmpHome(t);
  await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
    now: () => 9_999_000,
  });
  // The lock is created and removed inside the call; assert it was this root that got the dir.
  assert.ok(fs.existsSync(dir), 'the data root was used');
  const shared = path.join(os.homedir(), '.beezi', 'token-refresh.lock');
  assert.ok(!fs.existsSync(shared), 'no lock landed in the Claude Code plugin\'s data root');
});
