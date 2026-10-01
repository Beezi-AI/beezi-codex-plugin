import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta-codex.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from '../lib/reflog.mjs';
import { resolveRepoRoot } from '../lib/repo-timeline.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// G-6-1 — the attribution ratchet. `branch` is a BILLING DIMENSION: it rides on every
// /sessions/report payload built by `enqueueSegments` in lib/checkpoint.mjs, and decides which
// team/task is charged for a window of tokens. Two single-token regressions used to be invisible
// to the whole suite:
//
//   M1  delete `|| run.branch !== branch` from lib/delta-codex.mjs:244
//       -> a mid-window checkout stops splitting the segment, so every token after the checkout
//          bills to the branch the window OPENED on.
//   M2  replace the `branchOf` return in lib/checkpoint.mjs with `return entry.headBranch;`
//       -> attribution stops being reflog-driven and reads current HEAD instead.
//
// Neither was caught, because the head of the chain and the tail of the chain were each tested
// with the other half stubbed out: test/delta-codex.test.mjs injects `branchAt: () => 'main'` (a
// CONSTANT, so the branch term of the split can never fire) and test/checkpoint.test.mjs injects
// `computeDelta` (a STUB, so segments arrive with `branch` pre-set and the real `branchOf` never
// runs). This file joins them.
//
// TECHNIQUE — the synthetic reflog, never a temp git repo. `lib/reflog.mjs` is byte-identical to
// the Claude implementation, so Claude's trick ports verbatim: a literal reflog STRING is fed
// through the real parser (`readCheckoutEvents(() => REFLOG, 'x')`), the real timeline builder and
// the real `branchAt`. Zero filesystem, zero git binary, zero machine state — so this suite cannot
// reproduce the G-10-1 defect class (tests that silently depended on the developer's sign-in, git
// config, PATH or default branch name).
//
// THE SUBTLER HAZARD, AND THE TWO GUARDS AGAINST IT. `resolveRepoRoot`
// (lib/repo-timeline.mjs) wraps its `gitImpl` call in try/catch, SWALLOWS the throw, and falls
// through to `matchKnownRoot` and then `findRepoRootByWalk`, which walks the REAL filesystem. An
// "exhaustive, throwing" stub therefore does not fail loudly — resolution just succeeds from the
// developer's actual disk, with the test green. So:
//
//   Guard 1 — ASSERT THE CALL LOG. The throw is not the guard; `assertGitFullyStubbed` is. It
//             checks both that no unrecognized call was made AND that `rev-parse --show-toplevel`
//             positively appears, so "no fall-through" can never be vacuously true.
//   Guard 2 — USE FIXTURE PATHS THAT CANNOT EXIST (`/repo/demo`, never a mkdtemp dir and never
//             process.cwd()), so a fall-through walks to null rather than to a real repo root.
//
// Both guards are themselves tested, at the bottom of this file.
//
// The fixture VALUES (`feat/BZ-1234-codex-demo`, `https://github.com/beezi-demo/demo-repo.git`)
// reproduce in code the one-off demo that the §6 audit rested its strongest claim on and that no
// longer exists anywhere in this repository.

// --- fixtures -------------------------------------------------------------------------------

// Paths that cannot exist on any machine running this suite (guard 2).
const REPO = '/repo/demo';
const REPO_B = '/repo/demo-two';
const NO_REPO = '/repo/not-a-repo-at-all';
const REMOTE = 'https://github.com/beezi-demo/demo-repo.git';
const MODEL = 'gpt-5.2-codex';

const BRANCH_OLD = 'main';
const BRANCH_NEW = 'feat/BZ-1234-codex-demo';

// One checkout, at 00:10:00. Everything stamped before it bills to `main`, everything at or after
// it bills to `feat/BZ-1234-codex-demo`.
const REFLOG = `a1 HEAD@{2026-01-01T00:10:00+00:00}: checkout: moving from ${BRANCH_OLD} to ${BRANCH_NEW}`;

function writeRollout(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-attr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return appendRollout(path.join(dir, 'rollout.jsonl'), records, 'w');
}

// A raw string entry is written verbatim, so a fixture can plant an unparseable line.
function appendRollout(file, records, mode) {
  const text = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  if (mode === 'w') fs.writeFileSync(file, text);
  else fs.appendFileSync(file, text);
  return file;
}

const meta = (cwd, ts = '2026-01-01T00:00:00.000Z') => ({ timestamp: ts, type: 'session_meta', payload: { cwd } });
const turn = (cwd, ts, model = MODEL) => ({ timestamp: ts, type: 'turn_context', payload: { cwd, model } });
const tokens = (ts, input, cached, output) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output,
      },
    },
  },
});
// Deliberately timestamp-less variants — Codex writes these on a resumed/compacted session.
const bareMeta = (cwd) => ({ type: 'session_meta', payload: { cwd } });
const bareTurn = (cwd) => ({ type: 'turn_context', payload: { cwd, model: MODEL } });

// The real parser + the real timeline + the real branchAt, over a literal reflog. `headBranch`
// stands in for `currentBranch()`, exactly as `branchOf` in lib/checkpoint.mjs falls back to it
// when a line carries no usable timestamp.
function reflogBranchAt(headBranch = '(head)', reflogText = REFLOG) {
  const timeline = buildBranchTimeline(readCheckoutEvents(() => reflogText, 'x'));
  return (_root, ms) => (ms == null ? headBranch : branchAtReflog(timeline, ms));
}

const identityRoot = (dir) => dir;

// --- tiling invariants ----------------------------------------------------------------------

// Every line after the cursor is billed exactly once, to exactly one segment. Without this, a
// regression that fixes branch labels by DROPPING lines would still pass the branch assertions.
// Strict form — for fixtures whose every line parses.
function assertTiles(segments, fromLine, nextCursor) {
  assert.ok(segments.length > 0, 'expected at least one segment to tile');
  assert.equal(segments[0].fromLine, fromLine + 1, 'the first segment must open at the cursor');
  assert.equal(segments[segments.length - 1].toLine, nextCursor, 'the last segment must reach nextCursor');
  for (let i = 0; i < segments.length; i++) {
    assert.ok(segments[i].toLine >= segments[i].fromLine, `segment ${i} spans no lines`);
    if (i > 0) {
      assert.equal(segments[i].fromLine, segments[i - 1].toLine + 1, `gap or overlap before segment ${i}`);
    }
  }
}

// Loose form — for fixtures that deliberately plant an unparseable line. Such a line is dropped by
// the engine (lib/delta-codex.mjs:211 `catch { continue; }`) and so belongs to NO run, which is a
// legitimate gap. Ordering, disjointness and the window bounds still hold.
function assertDisjoint(segments, fromLine, nextCursor) {
  assert.ok(segments.length > 0, 'expected at least one segment');
  assert.ok(segments[0].fromLine > fromLine, 'no segment may bill a line at or before the cursor');
  assert.ok(segments[segments.length - 1].toLine <= nextCursor, 'no segment may bill past nextCursor');
  for (let i = 0; i < segments.length; i++) {
    assert.ok(segments[i].toLine >= segments[i].fromLine, `segment ${i} spans no lines`);
    if (i > 0) {
      assert.ok(segments[i].fromLine > segments[i - 1].toLine, `segments ${i - 1} and ${i} overlap`);
    }
  }
}

// ==============================================================================================
// A. Delta layer — the real reflog timeline driving the real computeDelta.
//    This is where M1 gets caught.
// ==============================================================================================

test('A1 — a branch checkout mid-window splits one repo into two segments', (t) => {
  const file = writeRollout(t, [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('2026-01-01T00:05:30.000Z', 100, 0, 10), // pre-checkout  -> main
    tokens('2026-01-01T00:15:00.000Z', 180, 0, 30), // post-checkout -> feat/...
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_NEW),
  });

  assert.equal(segments.length, 2, 'the checkout must split the window');
  assert.deepEqual(segments.map((s) => s.branch), [BRANCH_OLD, BRANCH_NEW]);
  // The post-checkout increment (80 in / 20 out) bills to the NEW branch only.
  const after = segments[1].stats.models[MODEL];
  assert.equal(after.token_input, 80);
  assert.equal(after.token_output, 20);
  assert.equal(after.requests, 1);
  // ...and the pre-checkout increment stays on the old one.
  assert.equal(segments[0].stats.models[MODEL].token_input, 100);
  assertTiles(segments, 0, nextCursor);
});

test('A2 — timestamps predating the checkout attribute to the old branch, not to current HEAD', (t) => {
  const file = writeRollout(t, [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('2026-01-01T00:05:30.000Z', 100, 0, 10),
  ]);
  // The injected HEAD says feat/BZ-1234-codex-demo — every record here predates the checkout, so
  // HEAD must never be consulted.
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_NEW),
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, BRANCH_OLD);
  assertTiles(segments, 0, nextCursor);
});

test('A3 — a run with no usable timestamp falls back to the head branch, asking once per line', (t) => {
  const file = writeRollout(t, [bareMeta(REPO), bareTurn(REPO)]);
  const calls = [];
  const { segments } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: (_root, ms) => { calls.push(ms); return ms == null ? '(head)' : 'never'; },
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, '(head)');
  // Codex asks per LINE (lib/delta-codex.mjs:242), not once in closeRun the way Claude does — so
  // this is [null, null] for a two-line run, NOT Claude's [null]. Locks the `ms != null` arm of
  // `branchOf` in lib/checkpoint.mjs.
  assert.deepEqual(calls, [null, null]);
});

test('A4 — timestamp-less head records join the first resolved run instead of forming their own', (t) => {
  const file = writeRollout(t, [
    bareMeta(REPO),
    bareTurn(REPO),
    tokens('2026-01-01T00:05:00.000Z', 100, 0, 10),
  ]);
  // HEAD is `main`, and these timestamps predate the checkout, so the head fallback and the reflog
  // answer agree — the realistic case, and the run must not be cut in two by the transition.
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].fromLine, 1, 'the untimestamped head records are billed, not skipped');
  assert.equal(segments[0].branch, BRANCH_OLD);
  assertTiles(segments, 0, nextCursor);
});

test('A5 — an unparseable timestamp resolves a branch but never enters the clock', (t) => {
  const file = writeRollout(t, [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('not-a-date', 100, 0, 10),
    tokens('2026-01-01T00:06:00.000Z', 180, 0, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_NEW),
  });

  assert.equal(segments.length, 1, 'an unparseable stamp must not split the run');
  assert.equal(segments[0].branch, BRANCH_OLD);
  // started_at / ended_at come only from the records that DID parse.
  assert.equal(segments[0].stats.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(segments[0].stats.ended_at, '2026-01-01T00:06:00.000Z');
  // The increment still bills — a broken stamp costs the clock, never the tokens.
  assert.equal(segments[0].stats.models[MODEL].token_input, 180);
  assert.equal(segments[0].stats.models[MODEL].requests, 2);
  assertTiles(segments, 0, nextCursor);
  // `stats.duration_sec` used to be NaN here: summarize() let the NaN timestamp into
  // buildActiveIntervals. G-1-6's push-site filter keeps it out, so the clock now reads exactly
  // what it would if the broken-stamp record were simply absent — which is what this test's
  // title claims. Asserted rather than left as a reading of the code.
  assert.equal(segments[0].stats.duration_sec, 60);
});

test('A6 — a repo switch recomputes the branch instead of leaking the previous repo branch', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    tokens('2026-01-01T00:01:30.000Z', 100, 0, 10),
    turn(REPO_B, '2026-01-01T00:02:00.000Z'),
    tokens('2026-01-01T00:02:30.000Z', 180, 0, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: (root) => 'br:' + root,
  });

  assert.equal(segments.length, 2);
  // Guards lib/delta-codex.mjs:242 recomputing the branch from the CURRENT activeRoot.
  assert.deepEqual(segments.map((s) => s.branch), ['br:' + REPO, 'br:' + REPO_B]);
  assert.deepEqual(segments.map((s) => s.repoRoot), [REPO, REPO_B]);
  assertTiles(segments, 0, nextCursor);
});

test('A7 — an A -> B -> A interleave yields three disjoint contiguous segments', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    tokens('2026-01-01T00:01:30.000Z', 100, 0, 10),
    turn(REPO_B, '2026-01-01T00:02:00.000Z'),
    tokens('2026-01-01T00:02:30.000Z', 180, 0, 30),
    turn(REPO, '2026-01-01T00:03:00.000Z'),
    tokens('2026-01-01T00:03:30.000Z', 260, 0, 50),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), [REPO, REPO_B, REPO]);
  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 2], [3, 4], [5, 6]]);
  assertTiles(segments, 0, nextCursor);
});

test('A8 — multi-repo, multi-branch windows tile with no gaps', (t) => {
  // The checkout lands INSIDE the middle (repo B) run, at 00:02:15.
  const midReflog = `b2 HEAD@{2026-01-01T00:02:15+00:00}: checkout: moving from ${BRANCH_OLD} to ${BRANCH_NEW}`;
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    tokens('2026-01-01T00:01:30.000Z', 100, 0, 10),
    turn(REPO_B, '2026-01-01T00:02:00.000Z'),
    tokens('2026-01-01T00:02:30.000Z', 180, 0, 30),
    turn(REPO, '2026-01-01T00:03:00.000Z'),
    tokens('2026-01-01T00:03:30.000Z', 260, 0, 50),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_NEW, midReflog),
  });

  assert.deepEqual(segments.map((s) => [s.repoRoot, s.branch]), [
    [REPO, BRANCH_OLD],
    [REPO_B, BRANCH_OLD],
    [REPO_B, BRANCH_NEW],
    [REPO, BRANCH_NEW],
  ]);
  // No gap at the head, between any pair, or at the tail.
  assertTiles(segments, 0, nextCursor);
});

test('A9 — an unresolvable cwd carries the previous repo forward rather than switching to null', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    tokens('2026-01-01T00:01:30.000Z', 100, 0, 10),
    turn(NO_REPO, '2026-01-01T00:02:00.000Z'),
    turn(REPO, '2026-01-01T00:03:00.000Z'),
    tokens('2026-01-01T00:03:30.000Z', 180, 0, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: (dir) => (dir === NO_REPO ? null : dir),
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  // Guards lib/delta-codex.mjs:220 `if (root) activeRoot = root`.
  assert.equal(segments.length, 1);
  assert.equal(segments[0].repoRoot, REPO);
  assertTiles(segments, 0, nextCursor);
});

test('A10 — a malformed line on a run boundary is billed to no run, and the runs stay disjoint', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    'NOT JSON',
    turn(REPO_B, '2026-01-01T00:02:00.000Z'),
    tokens('2026-01-01T00:02:30.000Z', 100, 0, 10),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  // The unparseable line is dropped outright, so it joins neither the run before nor the one
  // after. The cursor still advances past it, so it is never re-read.
  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 1], [3, 4]]);
  assert.deepEqual(segments.map((s) => s.repoRoot), [REPO, REPO_B]);
  assert.equal(nextCursor, 4);
  assertDisjoint(segments, 0, nextCursor);
});

test('A11 — untimestamped records mid-run keep the run open rather than splitting it', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    tokens('2026-01-01T00:01:30.000Z', 100, 0, 10),
    bareTurn(REPO),
    tokens('2026-01-01T00:02:00.000Z', 180, 0, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].stats.models[MODEL].token_input, 180, 'tokens summed across the bare record');
  assert.equal(segments[0].stats.models[MODEL].requests, 2);
  assertTiles(segments, 0, nextCursor);
});

test('A12 — a resumed window advances the cursor to the record count, not past a trailing newline', (t) => {
  const file = writeRollout(t, [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('2026-01-01T00:05:30.000Z', 100, 0, 10),
    tokens('2026-01-01T00:15:00.000Z', 180, 0, 30),
  ]);
  // Resumed at cursor 3: only line 4 is in the window, and lib/delta-codex.mjs:274 is
  // Math.max(fromLine, raw.length) — the trailing '\n' must not push it to 5.
  const { segments, nextCursor } = computeDelta(file, 3, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_NEW),
  });

  assert.equal(nextCursor, 4);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, BRANCH_NEW);
  // Only line 4's increment over line 3's baseline.
  assert.equal(segments[0].stats.models[MODEL].token_input, 80);
  assertTiles(segments, 3, nextCursor);
});

test('A13 — a resumed window never bills a line at or before its cursor', (t) => {
  const file = writeRollout(t, [
    turn(REPO, '2026-01-01T00:01:00.000Z'),
    'NOT JSON',
    tokens('2026-01-01T00:02:30.000Z', 100, 0, 10),
  ]);
  const { segments, nextCursor } = computeDelta(file, 1, {
    repoRootOf: identityRoot,
    branchAt: reflogBranchAt(BRANCH_OLD),
  });

  assert.equal(segments.length, 1);
  // Line 1 is pre-window and line 2 does not parse, so the window opens on line 3 — the first
  // record it can actually bill.
  assert.equal(segments[0].fromLine, 3);
  assert.ok(segments[0].fromLine > 1, 'a resumed window must never re-bill a line at or before the cursor');
  // ...but line 1's cwd still seeded the active repo, even though it was never billed.
  assert.equal(segments[0].repoRoot, REPO);
  assertDisjoint(segments, 1, nextCursor);
});

// ==============================================================================================
// B. Checkpoint layer — the REAL computeDelta (no stub) driven by the real branchOf against an
//    injected gitImpl returning reflog text. This is where M2 gets caught.
// ==============================================================================================

const tmpHome = (t) => sandboxHome(t, 'beezi-attr-cp-');

const queued = () => fs.readdirSync(queueDir(KEY))
  .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')))
  .sort((a, b) => a.from_line - b.from_line);

// A git stub that dispatches on args[0]/args[1], because branchOf and resolveRemote call it four
// ways: `reflog`, `rev-parse --abbrev-ref HEAD`, `rev-parse --show-toplevel`, `remote get-url
// origin`. `reflog: null` / `head: null` simulate a repo without one. Every call is logged, and
// anything unrecognized is BOTH recorded and thrown — see assertGitFullyStubbed for why the throw
// alone would not be enough.
function makeGit({ reflog = REFLOG, head = BRANCH_NEW, remote = REMOTE } = {}) {
  const log = [];
  const unexpected = [];
  const impl = (args, dir) => {
    log.push(args.join(' '));
    if (args[0] === 'reflog') {
      if (reflog === null) throw new Error('fatal: no reflog for HEAD');
      return reflog;
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      if (head === null) throw new Error('fatal: ambiguous argument HEAD');
      return head;
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return dir;
    if (args[0] === 'remote' && args[1] === 'get-url') return remote;
    unexpected.push(args.join(' '));
    throw new Error('unexpected git call: ' + args.join(' '));
  };
  impl.log = log;
  impl.unexpected = unexpected;
  return impl;
}

// GUARD 1. Both halves matter. The empty-`unexpected` half proves nothing silently fell through
// resolveRepoRoot's swallowed catch into findRepoRootByWalk; the positive half proves repo-root
// resolution actually went THROUGH the injected git, so the first half cannot be vacuously true
// because a cache or the persisted repo map short-circuited git entirely.
function assertGitFullyStubbed(gitImpl) {
  assert.deepEqual(
    gitImpl.unexpected, [],
    'the stub saw a git call it does not model — resolveRepoRoot swallows that throw and walks the REAL disk',
  );
  assert.ok(
    gitImpl.log.includes('rev-parse --show-toplevel'),
    'repo-root resolution must have gone through the injected git, not the filesystem',
  );
  // And the root it produced was non-null: branchOf returns '(unknown)' immediately for a null
  // root, so a reflog read can only appear in the log if resolution actually succeeded. Without
  // this, a `--show-toplevel` that silently started returning '' would fall through to
  // findRepoRootByWalk -> null, and B4/B5 would still pass on the null-root shortcut instead of
  // on the branch fallback they claim to test.
  assert.ok(
    gitImpl.log.some((c) => c.startsWith('reflog')),
    'branchOf must have run against a resolved root, not short-circuited on a null one',
  );
}

// The existing deps() in test/checkpoint.test.mjs stubs `computeDelta`; this one deliberately does
// NOT, so the real engine and the real branchOf run. `resolveTranscript` must also point at a REAL
// rollout — the sibling suite's stubTranscript writes '\n', an empty rollout that yields zero
// segments and a confusingly green result.
const depsReal = (rollout, gitImpl, over = {}) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('offline'); }, // keep payloads on disk
  resolveTranscript: () => ({ transcriptPath: rollout, sessionId: 's1' }),
  gitImpl,
  ...over,
});

const splitRollout = (home) => appendRollout(path.join(home, 'rollout.jsonl'), [
  meta(REPO),
  turn(REPO, '2026-01-01T00:05:00.000Z'),
  tokens('2026-01-01T00:05:30.000Z', 100, 0, 10), // pre-checkout  -> main
  tokens('2026-01-01T00:15:00.000Z', 180, 0, 30), // post-checkout -> feat/...
], 'w');

test('B1 — a real rollout and a real reflog bill each segment to the branch of its own timestamps', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit();
  const rollout = splitRollout(home);

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  const rows = queued();
  assert.equal(rows.length, 2, 'the checkout must produce two payloads');
  assert.deepEqual(rows.map((r) => r.branch), [BRANCH_OLD, BRANCH_NEW]);
  for (const r of rows) assert.equal(r.remote, REMOTE);
  // The payloads tile the transcript: no line billed twice, none dropped.
  assert.deepEqual(rows.map((r) => [r.from_line, r.to_line]), [[1, 3], [4, 4]]);
  assert.deepEqual(rows.map((r) => r.segmentId), ['s1:1-3', 's1:4-4']);
  assertGitFullyStubbed(gitImpl);
});

test('B2 — attribution is reflog-driven, not HEAD-driven', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit();
  const rollout = appendRollout(path.join(home, 'rollout.jsonl'), [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('2026-01-01T00:05:30.000Z', 100, 0, 10), // every stamp precedes the checkout
  ], 'w');

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  const rows = queued();
  assert.equal(rows.length, 1);
  // git reports HEAD as feat/BZ-1234-codex-demo, but these timestamps predate the checkout, so
  // the whole window bills to main. This is the demo's exact claim, as a test.
  assert.equal(rows[0].branch, BRANCH_OLD);
  assert.ok(gitImpl.log.includes('rev-parse --abbrev-ref HEAD'), 'HEAD was read...');
  assertGitFullyStubbed(gitImpl);
});

test('B3 — branchOf memoizes per root: exactly one reflog read for one repo', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit();
  const rollout = splitRollout(home);

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  // Two segments over one root — guards `branchOf`'s timelineCache in lib/checkpoint.mjs.
  assert.equal(queued().length, 2);
  assert.equal(gitImpl.log.filter((c) => c.startsWith('reflog')).length, 1, 'reflog must be read once per root');
  assertGitFullyStubbed(gitImpl);
});

test('B4 — a repo with no reflog still bills every segment to its current HEAD', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit({ reflog: null });
  const rollout = splitRollout(home);

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  // Guards `branchOf`'s `catch { /* no reflog */ }` in lib/checkpoint.mjs — nothing throws, and with no
  // timeline the branch is constant, so the window is one segment on HEAD.
  const rows = queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, BRANCH_NEW);
  // Not a null-root shortcut: the root resolved, so the remote resolved too (a null root would
  // have fallen back to localRemote and produced a `local:` key instead).
  assert.equal(rows[0].remote, REMOTE);
  assertGitFullyStubbed(gitImpl);
});

test('B5 — a repo where both reflog and HEAD fail bills to (unknown), not null and not a throw', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit({ reflog: null, head: null });
  const rollout = splitRollout(home);

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  // Guards `branchOf`'s '(unknown)' headBranch fallback. The repo root itself still resolves, so
  // this is genuinely the
  // branch fallback and not a null-root shortcut.
  const rows = queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, '(unknown)');
  assert.equal(rows[0].remote, REMOTE);
  assertGitFullyStubbed(gitImpl);
});

test('B6 — payloads tile across two checkpoint windows: no line billed twice, none skipped', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit();
  const rollout = splitRollout(home);

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));
  const first = queued();
  const firstIds = new Set(first.map((r) => r.segmentId));

  // The session keeps going: two more records land after the first checkpoint.
  appendRollout(rollout, [
    turn(REPO, '2026-01-01T00:20:00.000Z'),
    tokens('2026-01-01T00:20:30.000Z', 260, 0, 50),
  ], 'a');
  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  const second = queued().filter((r) => !firstIds.has(r.segmentId));
  assert.equal(second.length, 1, 'the second window produces exactly one new payload');
  assert.equal(
    second[0].from_line, first[first.length - 1].to_line + 1,
    'window 2 must open on the line after window 1 closed',
  );
  // Every line 1..6 billed exactly once, across both windows.
  const windows = [...first, ...second].map((r) => [r.from_line, r.to_line]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(windows, [[1, 3], [4, 4], [5, 6]]);
  assertGitFullyStubbed(gitImpl);
});

test('B7 — a detached HEAD bills to the sha verbatim rather than (unknown)', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit({
    reflog: 'z9 HEAD@{2026-01-01T00:10:00+00:00}: checkout: moving from main to 1a2b3c4',
    head: '1a2b3c4',
  });
  const rollout = appendRollout(path.join(home, 'rollout.jsonl'), [
    meta(REPO, '2026-01-01T00:12:00.000Z'),
    turn(REPO, '2026-01-01T00:12:30.000Z'),
    tokens('2026-01-01T00:13:00.000Z', 100, 0, 10),
  ], 'w');

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  // Pairs with the parser-level unit test at test/reflog.test.mjs:48, which stops at the parser.
  const rows = queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, '1a2b3c4');
  assertGitFullyStubbed(gitImpl);
});

test('B8 — an unparseable timestamp never reaches the wire as a non-finite duration', async (t) => {
  const home = tmpHome(t);
  const gitImpl = makeGit();
  const rollout = appendRollout(path.join(home, 'rollout.jsonl'), [
    meta(REPO),
    turn(REPO, '2026-01-01T00:05:00.000Z'),
    tokens('not-a-date', 100, 0, 10),
    tokens('2026-01-01T00:06:00.000Z', 180, 0, 30),
  ], 'w');

  await runCheckpoint({ session_id: 's1', cwd: REPO }, depsReal(rollout, gitImpl));

  // A broken timestamp costs the clock, never the payload's validity. This used to hold only by
  // accident: the delta layer emitted a NaN interval and mergeIntervals' `e > s` filter dropped
  // it, so the wire value was 0. With the NaN kept out at the push site it is 60 — the duration
  // the rollout actually has once the unparseable record is ignored. Both are finite; only one is
  // right, so assert the number as well as its finiteness.
  const rows = queued();
  assert.equal(rows.length, 1);
  assert.ok(Number.isFinite(rows[0].duration_sec), `duration_sec must be finite, got ${rows[0].duration_sec}`);
  assert.equal(rows[0].duration_sec, 60);
  assert.equal(rows[0].branch, BRANCH_OLD);
  assertGitFullyStubbed(gitImpl);
});

// ==============================================================================================
// The guards themselves. Without these two, everything above could be green while silently
// resolving from the developer's actual checkout.
// ==============================================================================================

test('guard — the disk fall-through is real: a throwing gitImpl still resolves a root that exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-attr-walk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'));
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  const throwing = () => { throw new Error('unexpected git call'); };

  // resolveRepoRoot SWALLOWS the throw and falls through to findRepoRootByWalk, which walks the
  // filesystem. On a fixture path under the developer's real checkout this resolves to their
  // actual repo root, with the test green — the §10 defect class, arriving through a seam the
  // stub cannot see.
  assert.equal(resolveRepoRoot(throwing, sub, new Map(), null), dir.replace(/\\/g, '/'));
});

test('guard — the fixture repo paths cannot fall through, because they cannot exist', () => {
  for (const fixture of [REPO, REPO_B, NO_REPO]) {
    const seen = [];
    const throwing = (args) => { seen.push(args.join(' ')); throw new Error('unexpected git call'); };
    assert.equal(
      resolveRepoRoot(throwing, fixture, new Map(), null), null,
      `${fixture} must resolve to null without git — otherwise this suite reads the real machine`,
    );
    assert.deepEqual(seen, ['rev-parse --show-toplevel']);
  }
});
