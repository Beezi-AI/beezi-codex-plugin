import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fastRepoRoot, FAILED } from '../lib/repo-root-fast.mjs';

// Fake absolute paths, built with the same `path` module the implementation walks.
const P = (...parts) => path.join(path.sep, ...parts);

const REPO = P('w', 'repo');
const SRC = P('w', 'repo', 'src', 'deep');
const ARGS = ['rev-parse', '--show-toplevel'];
const ANSWER = '/git/says/top';
const DISCOVERY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_COMMON_DIR',
];

function enoent(p) {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`);
  err.code = 'ENOENT';
  return err;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// In-memory fs: `dirs` maps a directory to its device id, `files` are non-directory entries, `links` maps a path to its real path.
function fakeFs({ dirs, files = [], links = {}, env = {} }) {
  const fileSet = new Set(files);
  const node = (p) => {
    if (own(dirs, p)) return { dev: dirs[p], isDirectory: () => true };
    if (fileSet.has(p)) return { dev: 1, isDirectory: () => false };
    throw enoent(p);
  };
  return {
    env,
    realpath: (p) => {
      const real = own(links, p) ? links[p] : p;
      node(real);
      return real;
    },
    statSync: node,
    lstatSync: node,
  };
}

// The base tree: /w/repo holds a `.git` dir with /w/repo/src/deep below it, all on device 1.
function repoFs({ extraDirs = [], files = [], links = {}, env = {}, devs = {} } = {}) {
  const dirs = {};
  for (const d of [P(), P('w'), REPO, P('w', 'repo', '.git'), P('w', 'repo', 'src'), SRC, ...extraDirs]) dirs[d] = 1;
  Object.assign(dirs, devs);
  return fakeFs({ dirs, files, links, env });
}

function spyGit(result) {
  const calls = [];
  const gitImpl = (args, cwd) => {
    calls.push([args, cwd]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { gitImpl, calls };
}

// The control resolves to git's answer; the guarded case returns undefined and never runs git.
function assertGuard(control, guarded) {
  const ok = spyGit(ANSWER);
  assert.equal(fastRepoRoot(ok.gitImpl, control.dir, new Map(), control.deps), ANSWER, 'control resolves');
  const spy = spyGit(ANSWER);
  assert.equal(fastRepoRoot(spy.gitImpl, guarded.dir, new Map(), guarded.deps), undefined);
  assert.deepEqual(spy.calls, [], 'git never runs for a guarded dir');
}

test('fastRepoRoot — runs git once at the candidate root with exactly rev-parse --show-toplevel', () => {
  const { gitImpl, calls } = spyGit(`${ANSWER}\n`);
  const gitRoots = new Map();
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, repoFs()), ANSWER);
  assert.deepEqual(calls, [[ARGS, REPO]]);
  assert.deepEqual([...gitRoots], [[REPO, ANSWER]]);
});

test('fastRepoRoot — the dir itself is the candidate when it holds `.git`', () => {
  const { gitImpl, calls } = spyGit(ANSWER);
  assert.equal(fastRepoRoot(gitImpl, REPO, new Map(), repoFs()), ANSWER);
  assert.deepEqual(calls, [[ARGS, REPO]]);
});

test('fastRepoRoot — a `.git` file (worktree or submodule) marks the candidate', () => {
  const wt = P('w', 'wt');
  const lib = P('w', 'wt', 'lib');
  const deps = fakeFs({ dirs: { [P()]: 1, [P('w')]: 1, [wt]: 1, [lib]: 1 }, files: [P('w', 'wt', '.git')] });
  const { gitImpl, calls } = spyGit(ANSWER);
  assert.equal(fastRepoRoot(gitImpl, lib, new Map(), deps), ANSWER);
  assert.deepEqual(calls, [[ARGS, wt]]);
});

test("fastRepoRoot — returns git's trimmed output, never the candidate path", () => {
  const { gitImpl } = spyGit('  /Volumes/Other/Checkout \n');
  const gitRoots = new Map();
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, repoFs()), '/Volumes/Other/Checkout');
  assert.equal(gitRoots.get(REPO), '/Volumes/Other/Checkout');
});

test('fastRepoRoot — a realpath that differs from the input (a symlinked dir) is a guard', () => {
  const alias = P('links', 'alias');
  const deps = repoFs({ links: { [alias]: SRC } });
  assertGuard({ dir: SRC, deps }, { dir: alias, deps });
});

test('fastRepoRoot — a realpath equal to the input still answers', () => {
  const { gitImpl, calls } = spyGit(ANSWER);
  const realpathCalls = [];
  const base = repoFs();
  const realpath = (p) => { realpathCalls.push(p); return base.realpath(p); };
  assert.equal(fastRepoRoot(gitImpl, SRC, new Map(), { ...base, realpath, platform: 'linux' }), ANSWER);
  assert.deepEqual(realpathCalls, [SRC]);
  assert.deepEqual(calls, [[ARGS, REPO]]);
});

test('fastRepoRoot — on win32 a slash-only difference counts as equal', () => {
  const slashed = `${P('w', 'repo', 'src')}\\deep`;
  const deps = repoFs({ links: { [slashed]: SRC } });
  const { gitImpl, calls } = spyGit(ANSWER);
  assert.equal(fastRepoRoot(gitImpl, slashed, new Map(), { ...deps, platform: 'win32' }), ANSWER);
  assert.deepEqual(calls, [[ARGS, REPO]]);
  assertGuard({ dir: SRC, deps }, { dir: slashed, deps: { ...deps, platform: 'linux' } });
});

test('fastRepoRoot — on win32 a letter-case difference is still a guard', () => {
  const upper = P('w', 'repo', 'src', 'DEEP');
  const deps = { ...repoFs({ links: { [upper]: SRC } }), platform: 'win32' };
  assertGuard({ dir: SRC, deps }, { dir: upper, deps });
});

test('fastRepoRoot — a second dir under the same candidate reuses gitRoots and does not run git', () => {
  const { gitImpl, calls } = spyGit(ANSWER);
  const gitRoots = new Map();
  const deps = repoFs();
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, deps), ANSWER);
  assert.equal(fastRepoRoot(gitImpl, P('w', 'repo', 'src'), gitRoots, deps), ANSWER);
  assert.equal(fastRepoRoot(gitImpl, REPO, gitRoots, deps), ANSWER);
  assert.equal(calls.length, 1);
});

test('fastRepoRoot — a pre-seeded gitRoots answer is returned without running git', () => {
  const { gitImpl, calls } = spyGit('unused');
  assert.equal(fastRepoRoot(gitImpl, SRC, new Map([[REPO, '/cached/top']]), repoFs()), '/cached/top');
  assert.equal(calls.length, 0);
});

test('fastRepoRoot — distinct candidates each run git once', () => {
  const other = P('w', 'other');
  const deps = repoFs({ extraDirs: [other, P('w', 'other', '.git')] });
  const calls = [];
  const gitImpl = (args, cwd) => {
    calls.push(cwd);
    return `top:${cwd}`;
  };
  const gitRoots = new Map();
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, deps), `top:${REPO}`);
  assert.equal(fastRepoRoot(gitImpl, other, gitRoots, deps), `top:${other}`);
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, deps), `top:${REPO}`);
  assert.deepEqual(calls, [REPO, other]);
});

test('fastRepoRoot — git throwing stores FAILED and later dirs under that root skip git', () => {
  const { gitImpl, calls } = spyGit(new Error('fatal: detected dubious ownership'));
  const gitRoots = new Map();
  const deps = repoFs();
  assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, deps), undefined);
  assert.equal(gitRoots.get(REPO), FAILED);
  assert.equal(fastRepoRoot(gitImpl, P('w', 'repo', 'src'), gitRoots, deps), undefined);
  assert.equal(calls.length, 1);
});

for (const out of ['', '\n', '  \n']) {
  test(`fastRepoRoot — git printing ${JSON.stringify(out)} stores FAILED`, () => {
    const { gitImpl, calls } = spyGit(out);
    const gitRoots = new Map();
    assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, repoFs()), undefined);
    assert.equal(gitRoots.get(REPO), FAILED);
    assert.equal(fastRepoRoot(gitImpl, SRC, gitRoots, repoFs()), undefined);
    assert.equal(calls.length, 1);
  });
}

test('fastRepoRoot — FAILED is a symbol, so no git answer can equal it', () => {
  assert.equal(typeof FAILED, 'symbol');
});

for (const key of DISCOVERY_ENV) {
  test(`fastRepoRoot — ${key} in the env is a guard`, () => {
    assertGuard({ dir: SRC, deps: repoFs() }, { dir: SRC, deps: repoFs({ env: { [key]: '/elsewhere' } }) });
  });
}

test('fastRepoRoot — a GIT_* var set to the empty string still guards', () => {
  assertGuard({ dir: SRC, deps: repoFs() }, { dir: SRC, deps: repoFs({ env: { GIT_DIR: '' } }) });
});

test('fastRepoRoot — unrelated env vars do not guard', () => {
  const { gitImpl } = spyGit(ANSWER);
  const env = { PATH: '/usr/bin', GIT_AUTHOR_NAME: 'x', GIT_TERMINAL_PROMPT: '0' };
  assert.equal(fastRepoRoot(gitImpl, SRC, new Map(), repoFs({ env })), ANSWER);
});

test('fastRepoRoot — realpath throwing is a guard', () => {
  const deps = repoFs();
  const throwing = { ...deps, realpath: (p) => { throw enoent(p); } };
  assertGuard({ dir: SRC, deps }, { dir: SRC, deps: throwing });
});

test('fastRepoRoot — a missing dir is a guard', () => {
  assertGuard({ dir: SRC, deps: repoFs() }, { dir: P('w', 'repo', 'gone'), deps: repoFs() });
});

test('fastRepoRoot — a path that is not a directory is a guard', () => {
  const thing = P('w', 'repo', 'thing');
  assertGuard({ dir: thing, deps: repoFs({ extraDirs: [thing] }) }, { dir: thing, deps: repoFs({ files: [thing] }) });
});

test('fastRepoRoot — a `.git` component in the real path is a guard', () => {
  const inside = P('w', 'repo', '.git', 'objects');
  const twin = P('w', 'repo', 'gitdata', 'objects');
  const alias = P('links', 'objects');
  const deps = repoFs({ extraDirs: [inside, P('w', 'repo', 'gitdata'), twin], links: { [alias]: inside } });
  assertGuard({ dir: twin, deps }, { dir: inside, deps });
  assertGuard({ dir: twin, deps }, { dir: alias, deps });
});

test('fastRepoRoot — the `.git` component check ignores case', () => {
  const upper = P('w', 'repo', '.GIT');
  const inside = P('w', 'repo', '.GIT', 'objects');
  const deps = repoFs({ extraDirs: [upper, inside] });
  assertGuard({ dir: SRC, deps }, { dir: inside, deps });
});

test('fastRepoRoot — no `.git` entry up to the filesystem root is a guard', () => {
  const dirs = { [P()]: 1, [P('x')]: 1, [P('x', 'y')]: 1 };
  assertGuard(
    { dir: P('x', 'y'), deps: fakeFs({ dirs: { ...dirs, [P('x', '.git')]: 1 } }) },
    { dir: P('x', 'y'), deps: fakeFs({ dirs }) },
  );
});

test('fastRepoRoot — a device change between the dir and the candidate is a guard', () => {
  assertGuard({ dir: SRC, deps: repoFs() }, { dir: SRC, deps: repoFs({ devs: { [P('w', 'repo', 'src')]: 2 } }) });
});

test('fastRepoRoot — a device change at the candidate itself is a guard', () => {
  const devs = { [SRC]: 2, [P('w', 'repo', 'src')]: 2 };
  assertGuard({ dir: SRC, deps: repoFs() }, { dir: SRC, deps: repoFs({ devs }) });
});

test('fastRepoRoot — a device change above the candidate does not matter', () => {
  const { gitImpl } = spyGit(ANSWER);
  assert.equal(fastRepoRoot(gitImpl, SRC, new Map(), repoFs({ devs: { [P()]: 9, [P('w')]: 9 } })), ANSWER);
});

test('fastRepoRoot — a level whose stat throws is a guard', () => {
  const deps = repoFs();
  const mid = P('w', 'repo', 'src');
  const statSync = (p) => {
    if (p === mid) throw enoent(p);
    return deps.statSync(p);
  };
  assertGuard({ dir: SRC, deps }, { dir: SRC, deps: { ...deps, statSync } });
});

test('fastRepoRoot — HEAD in a level below the candidate (a possible bare repo) is a guard', () => {
  const mirror = P('w', 'repo', 'mirror.git');
  const hooks = P('w', 'repo', 'mirror.git', 'hooks');
  assertGuard(
    { dir: hooks, deps: repoFs({ extraDirs: [mirror, hooks] }) },
    { dir: hooks, deps: repoFs({ extraDirs: [mirror, hooks], files: [P('w', 'repo', 'mirror.git', 'HEAD')] }) },
  );
});

test('fastRepoRoot — HEAD in the dir itself is a guard', () => {
  assertGuard({ dir: SRC, deps: repoFs() }, { dir: SRC, deps: repoFs({ files: [P('w', 'repo', 'src', 'deep', 'HEAD')] }) });
});

test("fastRepoRoot — HEAD beside the candidate's `.git` does not guard", () => {
  const { gitImpl } = spyGit(ANSWER);
  assert.equal(fastRepoRoot(gitImpl, SRC, new Map(), repoFs({ files: [P('w', 'repo', 'HEAD')] })), ANSWER);
});
