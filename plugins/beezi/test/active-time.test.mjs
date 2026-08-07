import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveIntervals,
  mergeIntervals,
  subtractIntervals,
  totalMs,
  claimIntervals,
} from '../lib/active-time.mjs';

const GAP = 300_000; // IDLE_GAP_SEC * 1000

// The gap sum that summarize() used before intervals existed. buildActiveIntervals must remain
// exactly equivalent to it for any lone transcript, or every existing duration_sec shifts.
function legacyActiveMs(timestamps, idleGapMs) {
  const sorted = [...timestamps].sort((a, z) => a - z);
  let ms = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < idleGapMs) ms += gap;
  }
  return ms;
}

test('buildActiveIntervals totals exactly what the old gap sum did', () => {
  // The acceptance gate for replacing the scalar: same integer, or every reported duration moves.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 300; trial++) {
    const n = Math.floor(rand() * 25);
    const ts = [];
    let t = 1_700_000_000_000;
    for (let i = 0; i < n; i++) {
      // A mix of sub-idle gaps, super-idle gaps and exact duplicates.
      t += Math.floor(rand() * (rand() < 0.25 ? GAP * 2 : GAP));
      ts.push(t);
    }
    // Shuffle: the caller does not promise sorted input.
    for (let i = ts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ts[i], ts[j]] = [ts[j], ts[i]];
    }
    assert.equal(totalMs(buildActiveIntervals(ts, GAP)), legacyActiveMs(ts, GAP), `trial ${trial}`);
  }
});

test('consecutive sub-idle gaps coalesce into one interval', () => {
  const out = buildActiveIntervals([0, 100, 200, 300], GAP);
  assert.deepEqual(out, [[0, 300]]);
});

test('an idle gap splits the run and contributes nothing', () => {
  const out = buildActiveIntervals([0, 100, 100 + GAP, 100 + GAP + 50], GAP);
  assert.deepEqual(out, [[0, 100], [100 + GAP, 100 + GAP + 50]]);
  assert.equal(totalMs(out), 150);
});

test('duplicate and single timestamps produce no interval', () => {
  assert.deepEqual(buildActiveIntervals([5, 5, 5], GAP), []);
  assert.deepEqual(buildActiveIntervals([5], GAP), []);
  assert.deepEqual(buildActiveIntervals([], GAP), []);
});

test('mergeIntervals normalizes overlap, adjacency and empties', () => {
  assert.deepEqual(mergeIntervals([[10, 20], [15, 25]]), [[10, 25]]);
  assert.deepEqual(mergeIntervals([[10, 20], [20, 30]]), [[10, 30]], 'touching intervals coalesce');
  assert.deepEqual(mergeIntervals([[30, 40], [10, 20]]), [[10, 20], [30, 40]], 'unsorted input');
  assert.deepEqual(mergeIntervals([[10, 10]]), [], 'zero-length dropped');
  assert.deepEqual(mergeIntervals([]), []);
});

test('subtractIntervals removes only what is already covered', () => {
  assert.deepEqual(subtractIntervals([[0, 100]], []), [[0, 100]], 'nothing covered');
  assert.deepEqual(subtractIntervals([[0, 100]], [[0, 100]]), [], 'fully covered');
  assert.deepEqual(subtractIntervals([[0, 100]], [[200, 300]]), [[0, 100]], 'disjoint');
  assert.deepEqual(subtractIntervals([[0, 100]], [[0, 40]]), [[40, 100]], 'head covered');
  assert.deepEqual(subtractIntervals([[0, 100]], [[60, 100]]), [[0, 60]], 'tail covered');
  assert.deepEqual(subtractIntervals([[0, 100]], [[40, 60]]), [[0, 40], [60, 100]], 'hole punched');
  assert.deepEqual(subtractIntervals([[0, 100]], [[10, 20], [30, 40]]), [[0, 10], [20, 30], [40, 100]]);
  assert.deepEqual(subtractIntervals([[0, 30], [40, 70]], [[0, 100]]), [], 'one span covers several');
});

test('the parent billing after a subagent gets only the residual', () => {
  // The real shape: the agent works 4s-10s, the parent's segment spans the same window because it
  // was blocked in wait_agent. Summed that is 12s of "active" time for 6s of clock.
  const agent = [[4000, 10000]];
  const parent = [[4000, 10000]];
  const covered = claimIntervals([], agent);
  assert.equal(totalMs(agent), 6000);
  assert.equal(totalMs(subtractIntervals(parent, covered)), 0);
});

test('claimIntervals folds in new coverage and stays bounded', () => {
  assert.deepEqual(claimIntervals([[0, 10]], [[5, 20]]), [[0, 20]]);
  const many = Array.from({ length: 600 }, (_, i) => [i * 10, i * 10 + 1]);
  const claimed = claimIntervals([], many);
  assert.equal(claimed.length, 512, 'bounded for on-disk storage');
  // The newest are kept: activity only moves forward, so old spans can no longer overlap.
  assert.deepEqual(claimed[claimed.length - 1], [5990, 5991]);
});
