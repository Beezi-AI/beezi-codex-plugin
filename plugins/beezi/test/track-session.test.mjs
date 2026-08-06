import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackSession } from '../lib/track-session.mjs';

const SESSION = { sessionId: 's1', transcriptPath: 'C:/roll.jsonl', cwd: 'C:/work/my-repo' };

const linked = { getAccessToken: async () => 'tok' };
const onBranch = (branch) => ({ currentBranch: () => branch });
const checkpoint = (result) => ({ runCheckpoint: async () => result });

test('an unlinked machine refuses before doing any work', async () => {
  let ran = false;
  const { ok, message } = await trackSession(SESSION, {
    getAccessToken: async () => null,
    runCheckpoint: async () => { ran = true; return { enqueued: 0, flush: null }; },
    ...onBranch('main'),
  });
  assert.equal(ok, false);
  assert.match(message, /not linked/);
  assert.equal(ran, false);
});

test('a saved segment is reported against the task id', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('feature/task-1234-login'),
    ...checkpoint({ enqueued: 1, flush: { flushed: 1 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for task-1234-login \(1 segment\)/);
});

test('a non-task branch is labeled by its branch name', async () => {
  const { message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ enqueued: 2, flush: { flushed: 2 } }),
  });
  assert.match(message, /analytics saved for dev \(2 segments\)/);
});

test('a directory that is not a repo is tracked, labeled by its folder name', async () => {
  // With the local:<folder> fallback in the engine there is nothing left to refuse: the
  // checkpoint attributes the work, and the branch lookup only decides the label.
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    currentBranch: () => { throw new Error('fatal: not a git repository'); },
    ...checkpoint({ enqueued: 1, flush: { flushed: 1 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for my-repo/);
  assert.doesNotMatch(message, /not a git repository/);
});

test('nothing new to save says so instead of claiming a save', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ enqueued: 0, flush: { flushed: 0 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /nothing new to save for dev/);
});

test('an unreachable server is a retry, not a loss', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ enqueued: 1, flush: { failed: 1 } }),
  });
  assert.equal(ok, false);
  assert.match(message, /retried automatically/);
});

test('a server rejection surfaces the server\'s own reason', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ enqueued: 1, flush: { rejected: 1, lastError: 'branch not linked' } }),
  });
  assert.equal(ok, false);
  assert.match(message, /branch not linked/);
});

test('the checkpoint is driven without a hook budget', async () => {
  // A user waiting at a terminal would rather see the whole queue drained than a partial flush.
  let seenArgs = null;
  await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    runCheckpoint: async (...args) => { seenArgs = args; return { enqueued: 0, flush: null }; },
  });
  assert.deepEqual(seenArgs[0], {
    session_id: 's1',
    transcript_path: 'C:/roll.jsonl',
    cwd: 'C:/work/my-repo',
  });
  assert.equal(seenArgs.length, 1, 'no options object, so no budgetMs');
});
