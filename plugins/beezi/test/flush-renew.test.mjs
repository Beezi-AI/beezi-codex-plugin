import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushQueue } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';

// A 401 during the flush is usually an access token that expired between the checkpoint's
// getAccessToken() and this loop — expires_at is only ever this client's estimate. Treating it as
// a permanent rejection deleted queued reports the server never actually judged.
function tmpHome(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-renew-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  fs.mkdirSync(queueDir(), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(path.join(queueDir(), `seg-${i}.json`), JSON.stringify({ segmentId: `s:${i}` }));
  }
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const res = (status, body = {}) => ({ status, json: async () => body });

test('a 401 renews the token once and retries the report', async (t) => {
  tmpHome(t, 1);
  const bearers = [];
  const fetchImpl = async (url, init) => {
    const bearer = init.headers.Authorization;
    bearers.push(bearer);
    return res(bearer === 'Bearer new' ? 200 : 401);
  };
  const result = await flushQueue('old', {
    fetchImpl,
    getAccessToken: async () => 'new',
  });
  assert.deepEqual(bearers, ['Bearer old', 'Bearer new']);
  assert.equal(result.flushed, 1);
  assert.equal(fs.readdirSync(queueDir()).length, 0, 'an accepted report is removed');
});

test('the renewed token is reused for the rest of the queue', async (t) => {
  tmpHome(t, 3);
  let renewals = 0;
  const fetchImpl = async (url, init) =>
    res(init.headers.Authorization === 'Bearer new' ? 200 : 401);
  const result = await flushQueue('old', {
    fetchImpl,
    getAccessToken: async () => { renewals += 1; return 'new'; },
  });
  assert.equal(renewals, 1, 'one renewal covers the whole flush');
  assert.equal(result.flushed, 3);
});

test('a 401 that survives renewal keeps the file instead of deleting it', async (t) => {
  tmpHome(t, 2);
  const result = await flushQueue('old', {
    fetchImpl: async () => res(401),
    getAccessToken: async () => 'new',
  });
  assert.equal(result.failed, 2);
  assert.equal(result.rejected, 0, 'a 401 is never a permanent rejection');
  assert.equal(result.lastError, 'HTTP 401');
  assert.equal(fs.readdirSync(queueDir()).length, 2, 'unjudged reports stay on disk');
});

test('a 401 with no renewal available keeps the file', async (t) => {
  tmpHome(t, 1);
  // getAccessToken hands back the same token — nothing was actually replaced.
  const result = await flushQueue('old', {
    fetchImpl: async () => res(401),
    getAccessToken: async () => 'old',
  });
  assert.equal(result.failed, 1);
  assert.equal(fs.readdirSync(queueDir()).length, 1);
});

test('a renewal that throws does not lose the report', async (t) => {
  tmpHome(t, 1);
  const result = await flushQueue('old', {
    fetchImpl: async () => res(401),
    getAccessToken: async () => { throw new Error('offline'); },
  });
  assert.equal(result.failed, 1);
  assert.equal(fs.readdirSync(queueDir()).length, 1);
});

test('a code-less 403 keeps the file — reversible, not a verdict on the payload', async (t) => {
  tmpHome(t, 1);
  let renewals = 0;
  const result = await flushQueue('old', {
    fetchImpl: async () => res(403, { message: 'seat revoked' }),
    getAccessToken: async () => { renewals += 1; return 'new'; },
  });
  assert.equal(renewals, 0, 'only a 401 triggers a renewal');
  assert.equal(result.failed, 1);
  assert.equal(result.rejected, 0, 'a reversible 403 must not delete queued analytics');
  assert.equal(result.lastError, 'seat revoked');
  assert.equal(fs.readdirSync(queueDir()).length, 1);
});

test('a 403 TRACKING_DISABLED stops the flush, marks the state, and holds the files', async (t) => {
  const home = tmpHome(t, 3);
  let posts = 0;
  const result = await flushQueue('old', {
    fetchImpl: async () => { posts += 1; return res(403, { code: 'TRACKING_DISABLED', message: 'audit mode' }); },
    getAccessToken: async () => 'new',
  });
  assert.equal(posts, 1, 'the storm stops at the first verdict');
  assert.equal(result.trackingDisabled, true);
  assert.equal(fs.readdirSync(queueDir()).length, 3, 'fresh files are held, not dropped');
  const tracking = JSON.parse(fs.readFileSync(path.join(home, 'tracking.json'), 'utf-8'));
  assert.equal(tracking.trackingMode, 'disabled');
});

test('a dark workspace skips the flush loop entirely and expires held files past the window', async (t) => {
  const home = tmpHome(t, 2);
  fs.writeFileSync(path.join(home, 'tracking.json'), JSON.stringify({ version: 1, trackingMode: 'backfill_only' }));
  const old = path.join(queueDir(), 'seg-0.json');
  const past = Date.now() - 4 * 24 * 60 * 60 * 1000;
  fs.utimesSync(old, past / 1000, past / 1000);
  let posts = 0;
  const result = await flushQueue('tok', { fetchImpl: async () => { posts += 1; return res(200); } });
  assert.equal(posts, 0, 'no report leaves a dark workspace');
  assert.equal(result.trackingDisabled, true);
  assert.equal(result.expired, 1);
  assert.deepEqual(fs.readdirSync(queueDir()), ['seg-1.json'], 'in-window files are held');
});

test('no renewal is attempted once the hook budget is spent', async (t) => {
  tmpHome(t, 1);
  let renewals = 0;
  let nowMs = 1_000_000;
  const result = await flushQueue('old', {
    // The request itself consumes the remaining budget, so the renewal round trip has none left.
    fetchImpl: async () => { nowMs += 3000; return res(401); },
    now: () => nowMs,
    deadline: nowMs + 2000,
    getAccessToken: async () => { renewals += 1; return 'new'; },
  });
  assert.equal(renewals, 0, 'a renewal is a network round trip and must respect the deadline');
  assert.equal(result.failed, 1);
  assert.equal(fs.readdirSync(queueDir()).length, 1);
});
