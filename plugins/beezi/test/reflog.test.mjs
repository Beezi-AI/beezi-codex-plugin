import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutEvents, buildBranchTimeline, branchAt } from '../lib/reflog.mjs';

const SAMPLE = [
  'a1 HEAD@{2026-07-03T10:10:00+00:00}: checkout: moving from feature/task-A to main',
  'b2 HEAD@{2026-07-03T10:05:00+00:00}: commit: wip',
  'c3 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  'd4 HEAD@{2026-07-03T09:50:00+00:00}: reset: moving to HEAD~1',
].join('\n');

const fakeGit = (out) => () => out;
const t = (iso) => Date.parse(iso);

test('readCheckoutEvents — only checkout lines, ascending by ms', () => {
  const events = readCheckoutEvents(fakeGit(SAMPLE), 'x');
  assert.equal(events.length, 2);
  assert.equal(events[0].from, 'main');
  assert.equal(events[0].to, 'feature/task-A');
  assert.equal(events[1].from, 'feature/task-A');
  assert.equal(events[1].to, 'main');
  assert.ok(events[0].ms < events[1].ms);
});

test('buildBranchTimeline — sentinel is first event.from; boundaries ordered', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(tl[0].ms, -Infinity);
  assert.equal(tl[0].branch, 'main');
  assert.equal(tl[1].branch, 'feature/task-A');
  assert.equal(tl[2].branch, 'main');
});

test('buildBranchTimeline — null when no checkout events', () => {
  assert.equal(buildBranchTimeline([]), null);
  const commitsOnly = readCheckoutEvents(fakeGit('x1 HEAD@{2026-07-03T10:00:00+00:00}: commit: y'), 'x');
  assert.equal(buildBranchTimeline(commitsOnly), null);
});

test('branchAt — resolves by timestamp; checkout second belongs to the new branch', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(branchAt(tl, t('2026-07-03T09:00:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T10:00:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:03:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:10:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T11:00:00+00:00')), 'main');
});

test('readCheckoutEvents — detached HEAD (to = sha) preserved verbatim', () => {
  const out = 'z9 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to 1a2b3c4';
  const events = readCheckoutEvents(fakeGit(out), 'x');
  assert.equal(events[0].to, '1a2b3c4');
});

// Today's linear scan, kept verbatim as the oracle the binary search must match.
function linearBranchAt(timeline, ms) {
  let branch = timeline[0].branch;
  for (const b of timeline) {
    if (b.ms <= ms) branch = b.branch;
    else break;
  }
  return branch;
}

// mulberry32: a seeded PRNG, so any failing round reproduces.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Ascending timeline with a distinct branch per index, frequent equal-ms runs and an optional -Infinity sentinel.
function randomTimeline(rand) {
  const big = rand() < 0.05;
  const n = big ? 1001 : 1 + Math.floor(rand() * 12);
  const buckets = big ? 1500 : 6;
  const ms = [];
  for (let i = 0; i < n; i += 1) ms.push(Math.floor(rand() * buckets) * 1000);
  ms.sort((a, b) => a - b);
  if (rand() < 0.8) ms[0] = -Infinity;
  return ms.map((v, i) => ({ ms: v, branch: `b${i}` }));
}

// Targets before, on, between and after the boundaries, plus the non-finite edges.
function targetsFor(timeline, rand) {
  const out = [-Infinity, Infinity, NaN, -1, 0];
  const picks = timeline.length <= 16
    ? timeline
    : Array.from({ length: 48 }, () => timeline[Math.floor(rand() * timeline.length)]);
  for (const b of picks) {
    if (!Number.isFinite(b.ms)) continue;
    out.push(b.ms - 1, b.ms - 0.5, b.ms, b.ms + 0.5, b.ms + 1);
  }
  return out;
}

test('branchAt — matches the old linear scan on seeded random timelines', () => {
  const rand = prng(20261013);
  for (let round = 0; round < 600; round += 1) {
    const timeline = randomTimeline(rand);
    for (const target of targetsFor(timeline, rand)) {
      assert.equal(
        branchAt(timeline, target),
        linearBranchAt(timeline, target),
        `round ${round}, n=${timeline.length}, target=${target}`,
      );
    }
  }
});

test('branchAt — an equal-ms run resolves to the last boundary of the run', () => {
  const tl = [
    { ms: -Infinity, branch: 'start' },
    { ms: 10, branch: 'a' },
    { ms: 10, branch: 'b' },
    { ms: 10, branch: 'c' },
    { ms: 20, branch: 'd' },
  ];
  assert.equal(branchAt(tl, 9), 'start');
  assert.equal(branchAt(tl, 10), 'c');
  assert.equal(branchAt(tl, 19), 'c');
  assert.equal(branchAt(tl, 20), 'd');
});

test('branchAt — NaN and -Infinity give the first boundary; +Infinity gives the last', () => {
  const tl = [{ ms: -Infinity, branch: 'start' }, { ms: 5, branch: 'x' }, { ms: 7, branch: 'y' }];
  assert.equal(branchAt(tl, NaN), 'start');
  assert.equal(branchAt(tl, -Infinity), 'start');
  assert.equal(branchAt(tl, Infinity), 'y');
});

test('branchAt — without a sentinel, a target before the first boundary answers the first branch', () => {
  const tl = [{ ms: 5, branch: 'x' }, { ms: 7, branch: 'y' }];
  assert.equal(branchAt(tl, 1), 'x');
  assert.equal(branchAt(tl, NaN), 'x');
  assert.equal(branchAt(tl, 6), 'x');
  assert.equal(branchAt(tl, 7), 'y');
});

test('branchAt — a single-boundary timeline always answers that branch', () => {
  const tl = [{ ms: -Infinity, branch: 'only' }];
  for (const target of [-Infinity, -1, 0, 1e15, Infinity, NaN]) assert.equal(branchAt(tl, target), 'only');
});

test('branchAt — an empty timeline throws a TypeError, as before', () => {
  assert.throws(() => linearBranchAt([], 0), TypeError);
  assert.throws(() => branchAt([], 0), TypeError);
});

test('branchAt — same-second checkouts from the reflog match the old scan', () => {
  const out = [
    'a1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from feature/x to main',
    'b2 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/x',
    'c3 HEAD@{2026-07-03T09:00:00+00:00}: checkout: moving from dev to main',
  ].join('\n');
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(out), 'x'));
  for (const iso of [
    '2026-07-03T08:00:00+00:00',
    '2026-07-03T09:00:00+00:00',
    '2026-07-03T09:30:00+00:00',
    '2026-07-03T10:00:00+00:00',
    '2026-07-03T11:00:00+00:00',
  ]) {
    assert.equal(branchAt(tl, t(iso)), linearBranchAt(tl, t(iso)), iso);
  }
});

test('branchAt — reads O(log n) boundaries on a reflog-sized timeline', () => {
  const plain = [{ ms: -Infinity, branch: 'b0' }];
  for (let i = 1; i <= 1000; i += 1) plain.push({ ms: i * 1000, branch: `b${i}` });
  let reads = 0;
  const counted = new Proxy(plain, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(branchAt(counted, 999500), 'b999');
  const bound = 2 * Math.ceil(Math.log2(plain.length)) + 4;
  assert.ok(reads <= bound, `read ${reads} boundaries, expected at most ${bound}`);
});
