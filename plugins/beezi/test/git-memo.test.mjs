import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as gitMemo from '../lib/git-memo.mjs';

const { memoizeGit } = gitMemo;

// A fake git that records every call and answers `${cwd}|${args joined by spaces}` by default.
function recordingGit(answer = (args, cwd) => `${cwd}|${args.join(' ')}`) {
  const calls = [];
  const gitImpl = (args, cwd) => {
    calls.push([args, cwd]);
    return answer(args, cwd);
  };
  return { gitImpl, calls };
}

test('memoizeGit — one underlying call per distinct (cwd, args)', () => {
  const { gitImpl, calls } = recordingGit();
  const git = memoizeGit(gitImpl);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(git(['rev-parse', '--show-toplevel'], '/r'), '/r|rev-parse --show-toplevel');
  }
  assert.equal(calls.length, 1);
});

test('memoizeGit — passes args and cwd through and returns the output untouched', () => {
  const { gitImpl, calls } = recordingGit(() => '  raw output \n');
  const git = memoizeGit(gitImpl);
  const args = ['remote', 'get-url', 'origin'];
  assert.equal(git(args, '/r'), '  raw output \n');
  assert.equal(calls[0][0], args);
  assert.equal(calls[0][1], '/r');
});

test('memoizeGit — a different cwd or different args make separate entries', () => {
  const { gitImpl, calls } = recordingGit();
  const git = memoizeGit(gitImpl);
  const cases = [
    [['rev-parse', '--show-toplevel'], '/a'],
    [['rev-parse', '--show-toplevel'], '/b'],
    [['rev-parse', '--abbrev-ref', 'HEAD'], '/a'],
  ];
  for (let round = 0; round < 2; round += 1) {
    for (const [args, cwd] of cases) assert.equal(git(args, cwd), `${cwd}|${args.join(' ')}`);
  }
  assert.deepEqual(calls, cases);
});

test('memoizeGit — args whose joined text would collide under a naive key stay separate', () => {
  const answer = (args, cwd) => JSON.stringify([cwd, args]);
  const { gitImpl, calls } = recordingGit(answer);
  const git = memoizeGit(gitImpl);
  const cases = [
    [['a,b'], '/r'], // collides with the next under Array's default comma join
    [['a', 'b'], '/r'],
    [['rev-parse --show-toplevel'], '/r'], // collides with the next under a space join
    [['rev-parse', '--show-toplevel'], '/r'],
    [['x', 'y'], '/r'], // collides with the next under a slash join of cwd and args
    [['y'], '/r/x'],
    [['log'], '/r'], // collides with the next when a trailing empty arg is dropped
    [['log', ''], '/r'],
    [[], '/r'], // collides with the next when an empty arg is dropped
    [[''], '/r'],
  ];
  for (let round = 0; round < 2; round += 1) {
    for (const [args, cwd] of cases) assert.equal(git(args, cwd), answer(args, cwd));
  }
  assert.equal(calls.length, cases.length);
});

test('memoizeGit — a throw is cached and the same error object is rethrown without calling again', () => {
  let calls = 0;
  const git = memoizeGit(() => {
    calls += 1;
    throw new Error(`fatal: not a git repository (call ${calls})`);
  });
  let first;
  try {
    git(['rev-parse', '--show-toplevel'], '/nowhere');
  } catch (err) {
    first = err;
  }
  assert.ok(first instanceof Error);
  for (let i = 0; i < 3; i += 1) {
    assert.throws(() => git(['rev-parse', '--show-toplevel'], '/nowhere'), (err) => err === first);
  }
  assert.equal(calls, 1);
});

test('memoizeGit — a cached throw does not affect another key', () => {
  const git = memoizeGit((args, cwd) => {
    if (cwd === '/bad') throw new Error('boom');
    return 'ok';
  });
  assert.throws(() => git(['status'], '/bad'), /boom/);
  assert.equal(git(['status'], '/good'), 'ok');
});

test('memoizeGit — an empty-string output is cached, not treated as a miss', () => {
  const { gitImpl, calls } = recordingGit(() => '');
  const git = memoizeGit(gitImpl);
  assert.equal(git(['config', '--get', 'remote.origin.url'], '/r'), '');
  assert.equal(git(['config', '--get', 'remote.origin.url'], '/r'), '');
  assert.equal(calls.length, 1);
});

test('memoizeGit — two instances do not share a cache', () => {
  const { gitImpl, calls } = recordingGit();
  const first = memoizeGit(gitImpl);
  const second = memoizeGit(gitImpl);
  first(['status'], '/r');
  second(['status'], '/r');
  first(['status'], '/r');
  second(['status'], '/r');
  assert.equal(calls.length, 2);
});

test('memoizeGit — a throw cached by one instance is not seen by a new one', () => {
  let fail = true;
  const gitImpl = () => {
    if (fail) throw new Error('transient');
    return 'ok';
  };
  const first = memoizeGit(gitImpl);
  assert.throws(() => first(['status'], '/r'), /transient/);
  fail = false;
  assert.throws(() => first(['status'], '/r'), /transient/);
  assert.equal(memoizeGit(gitImpl)(['status'], '/r'), 'ok');
});

test('memoizeGit — no module-level state: one export, no imports, no top-level bindings', () => {
  assert.deepEqual(Object.keys(gitMemo), ['memoizeGit']);
  assert.equal(typeof memoizeGit, 'function');
  const source = fs.readFileSync(new URL('../lib/git-memo.mjs', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'imports nothing');
  assert.doesNotMatch(source, /^(?:export\s+)?(?:const|let|var|class)\s/m, 'no top-level bindings');
  assert.equal((source.match(/^export\s/gm) || []).length, 1, 'exactly one export');
});
