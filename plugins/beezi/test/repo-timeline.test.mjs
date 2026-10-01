import { test } from 'node:test';
import assert from 'node:assert/strict';
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
