import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushQueue, HOOK_BUDGET_MS } from '../lib/checkpoint.mjs';
import { HOOK_TIMEOUT_SEC } from '../lib/hooks-install.mjs';
import { queueDir } from '../lib/paths.mjs';

// Codex kills a hook at its registered timeout and reports the kill as a failed hook. The queue
// flush is a serial loop with a per-request bound but no overall one, so N pending reports against
// a stalled API cost N × the per-request timeout: six queued reports measured 24.9s against a 10s
// budget. The reports that landed before the kill were tracked, which is why this surfaced as
// "hook exited with code 1" *and* working analytics.
function tmpHome(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-flush-'));
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

// A clock the test drives: every request "costs" the full per-request timeout, the way a stalled
// server does. No real waiting, so the assertion is about the budget, not about timing luck.
function stalledClock(costMs = 3000) {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    fetchImpl: async () => { nowMs += costMs; return { status: 200, json: async () => ({}) }; },
  };
}

test('the flush stops at its deadline and leaves the rest queued for next time', async (t) => {
  tmpHome(t, 6);
  const { now, fetchImpl } = stalledClock();

  const result = await flushQueue('tok', { fetchImpl, now, deadline: now() + 8000 });

  assert.equal(result.flushed, 3, 'three 3s requests fit in an 8s budget');
  assert.equal(result.deferred, 3, 'the rest are reported as deferred, not failed');
  assert.equal(fs.readdirSync(queueDir()).length, 3, 'deferred reports stay on disk for the retry');
});

test('a deferred report is not counted as failed or rejected', async (t) => {
  tmpHome(t, 4);
  const { now, fetchImpl } = stalledClock();
  const result = await flushQueue('tok', { fetchImpl, now, deadline: now() + 3500 });
  assert.equal(result.failed, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.flushed + result.deferred, 4);
});

test('without a deadline the flush drains the whole queue, as before', async (t) => {
  tmpHome(t, 5);
  const { fetchImpl } = stalledClock();
  const result = await flushQueue('tok', { fetchImpl });
  assert.equal(result.flushed, 5);
  assert.equal(result.deferred, 0);
  assert.equal(fs.readdirSync(queueDir()).length, 0);
});

test('no request is allowed to outlive the deadline it was started under', async (t) => {
  tmpHome(t, 3);
  let nowMs = 1_000_000;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.signal ? 'bounded' : 'unbounded');
    nowMs += 3000;
    return { status: 200, json: async () => ({}) };
  };
  // 4.5s of budget: the first request may take its full 3s, the second only has 1.5s left.
  const timeouts = [];
  await flushQueue('tok', {
    fetchImpl,
    now: () => nowMs,
    deadline: nowMs + 4500,
    onRequestTimeout: (ms) => timeouts.push(ms),
  });
  assert.deepEqual(seen, ['bounded', 'bounded']);
  assert.ok(timeouts[1] <= 1500, `second request was given ${timeouts[1]}ms of a 1500ms remainder`);
});

test('the hook budget leaves room inside the timeout Codex registers', () => {
  assert.ok(
    HOOK_BUDGET_MS < HOOK_TIMEOUT_SEC * 1000,
    `budget ${HOOK_BUDGET_MS}ms must finish before Codex kills the hook at ${HOOK_TIMEOUT_SEC}s`,
  );
  // Enough margin for the work that is not network: git shell-outs, transcript parsing, state writes.
  assert.ok(HOOK_TIMEOUT_SEC * 1000 - HOOK_BUDGET_MS >= 1500, 'too little margin before the kill');
});
