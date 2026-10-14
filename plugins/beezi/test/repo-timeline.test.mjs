import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRepoRoot } from '../lib/repo-timeline.mjs';

// `extractPathSignal` and its ten tests were removed with G-6-3. It sniffed Claude-shaped
// `message.content[].tool_use` blocks, a record shape Codex rollouts never carry, so it could not
// fire on a single line of a single rollout. Codex's native equivalent is the cwd chain in
// lib/delta-codex.mjs (session_meta.cwd -> turn_context.cwd -> function_call arguments.workdir),
// which test/attribution-integration.test.mjs now exercises end to end.

test('resolveRepoRoot — trims git output and caches; second call does not re-invoke git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return '/repo/alpha\n'; };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(calls, 1, 'result memoized by dir');
});

test('resolveRepoRoot — throw (not a repo) caches null', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; throw new Error('not a git repository'); };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(calls, 1, 'null result memoized too');
});

test('resolveRepoRoot — null dir returns null without calling git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return 'x'; };
  assert.equal(resolveRepoRoot(gitImpl, null, new Map()), null);
  assert.equal(calls, 0);
});

// git discovery vars the shortcut refuses to second-guess; a git hook running the suite may export them.
const GIT_DISCOVERY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_COMMON_DIR'];

// Clears those vars for one test so the shortcut's env guard does not decide the outcome.
function withoutGitEnv(t) {
  const saved = GIT_DISCOVERY_ENV.map((name) => [name, process.env[name]]);
  for (const name of GIT_DISCOVERY_ENV) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// A repository on disk: top/.git plus two plain subdirectories.
function tempRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fastroot-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A real-path base: the shortcut declines a dir whose realpath differs (macOS tmpdir sits under /var → /private/var).
  const top = path.join(fs.realpathSync(base), 'top');
  fs.mkdirSync(path.join(top, '.git'), { recursive: true });
  fs.mkdirSync(path.join(top, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(top, 'c'), { recursive: true });
  return { realTop: fs.realpathSync(top), sub: path.join(top, 'a', 'b'), other: path.join(top, 'c') };
}

test('resolveRepoRoot — without gitRoots, git is asked in the directory itself, even inside a repo', (t) => {
  withoutGitEnv(t);
  const { sub } = tempRepo(t);
  const seen = [];
  const gitImpl = (args, cwd) => { seen.push([args.join(' '), cwd]); return '/from/git\n'; };
  assert.equal(resolveRepoRoot(gitImpl, sub, new Map()), '/from/git');
  assert.equal(resolveRepoRoot(gitImpl, sub, new Map(), null, null), '/from/git');
  assert.deepEqual(seen, [['rev-parse --show-toplevel', sub], ['rev-parse --show-toplevel', sub]]);
});

test('resolveRepoRoot — with gitRoots, one git call at the repo root answers every directory under it', (t) => {
  withoutGitEnv(t);
  const { realTop, sub, other } = tempRepo(t);
  const seen = [];
  const gitImpl = (args, cwd) => { seen.push([args.join(' '), cwd]); return '/from/git\n'; };
  const cache = new Map();
  const gitRoots = new Map();
  assert.equal(resolveRepoRoot(gitImpl, sub, cache, null, gitRoots), '/from/git');
  assert.equal(resolveRepoRoot(gitImpl, other, cache, null, gitRoots), '/from/git');
  assert.equal(resolveRepoRoot(gitImpl, sub, cache, null, gitRoots), '/from/git');
  assert.deepEqual(seen, [['rev-parse --show-toplevel', realTop]]);
  assert.equal(gitRoots.get(realTop), '/from/git');
  assert.equal(cache.get(sub), '/from/git');
  assert.equal(cache.get(other), '/from/git');
});

test('resolveRepoRoot — with gitRoots, a directory the shortcut cannot vouch for takes today\'s path', () => {
  const seen = [];
  const gitImpl = (args, cwd) => { seen.push(cwd); return '/repo/alpha\n'; };
  const gitRoots = new Map();
  const missing = path.join(os.tmpdir(), 'beezi-no-such-dir', 'x');
  assert.equal(resolveRepoRoot(gitImpl, missing, new Map(), null, gitRoots), '/repo/alpha');
  assert.deepEqual(seen, [missing]);
  assert.equal(gitRoots.size, 0);
});
