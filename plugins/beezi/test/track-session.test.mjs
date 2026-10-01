import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrackTarget, trackSession } from '../lib/track-session.mjs';
import { UserError } from '../lib/friendly-error.mjs';
import { accountSession, fakeKeyring, TEST_KEY } from '../tools/account-fixtures.mjs';

// The credential store is NOT sandboxed by BEEZI_CODEX_HOME. Any bag below that lets trackSession
// reach the real listAccounts runs readIndex, which runs the one-time pre-0.13 migration, which
// spawns `security` against the DEVELOPER'S OWN keychain: measured adding a keyed entry and then
// deleting their `beezi-codex`/`token` login, with the file half of the migration landing in the
// hermetic sandbox that is removed at the end of the run — an orphan secret nothing can find.
const store = { run: fakeKeyring().run, platform: 'darwin' };

// The track flow words one outcome per linked account, so the checkpoint's per-account drain
// results are what it reads — `flushes`, keyed by account — rather than a single summary.
const ACCOUNT = accountSession(TEST_KEY, 'tok');

const SESSION = { sessionId: 's1', transcriptPath: 'C:/roll.jsonl', cwd: 'C:/work/my-repo' };

const linked = { linkedSessions: async () => [ACCOUNT] };
const onBranch = (branch) => ({ currentBranch: () => branch });
const checkpoint = (result) => ({ runCheckpoint: async () => result });

test('an unlinked machine refuses before doing any work', async () => {
  let ran = false;
  const { ok, message } = await trackSession(SESSION, {
    linkedSessions: async () => [],
    // An EMPTY index: nothing has ever been linked here, which is the one state "not linked"
    // describes. Injected rather than left to the real reader, which would run the pre-0.13
    // migration and reach for the credential store to answer.
    listAccounts: async () => [],
    runCheckpoint: async () => { ran = true; return { outcome: 'committed', enqueued: 0, flushes: [{ key: TEST_KEY, flushed: 0 }] }; },
    ...onBranch('main'),
  });
  assert.equal(ok, false);
  assert.match(message, /not linked/);
  assert.equal(ran, false);
});

// The other way linkedSessions() comes back empty, and the one the old single sentence got wrong:
// the accounts ARE in the index and not one of them can produce a token right now. Telling that
// user their machine is not linked is the falsehood sync, backfill and the MCP bridge all stopped
// printing; track was the last copy of it.
test('accounts in the index whose tokens are all unusable are not reported as an unlinked machine', async () => {
  const { ok, message } = await trackSession(SESSION, {
    linkedSessions: async () => [],
    listAccounts: async () => [
      { key: TEST_KEY, status: 'linked' }, { key: '99887766', status: 'linked' },
    ],
    runCheckpoint: async () => { throw new Error('nothing may be checkpointed with no session'); },
    ...onBranch('main'),
  });
  assert.equal(ok, false);
  assert.match(message, /could not use the saved credentials for any linked Beezi account/);
  assert.doesNotMatch(message, /this machine is not linked/);
});

// The third state, and the one the two-way split above would have swallowed: readIndex THROWS for
// a migration in progress, an unreadable accounts.json or a refused lock. A catch that fell back to
// an empty list would call every one of those "not linked".
test('an accounts index that cannot be read keeps its own words instead of claiming nothing is linked', async () => {
  const { ok, message } = await trackSession(SESSION, {
    linkedSessions: async () => [],
    listAccounts: async () => { throw new UserError('Beezi accounts migration is in progress. Retry in a moment.'); },
    runCheckpoint: async () => { throw new Error('nothing may be checkpointed with no session'); },
    ...onBranch('main'),
  });
  assert.equal(ok, false);
  assert.match(message, /could not read this machine's linked accounts/);
  assert.match(message, /migration is in progress/, 'the reason survives instead of being replaced');
  assert.doesNotMatch(message, /this machine is not linked/);
  assert.doesNotMatch(message, /could not use the saved credentials/);
});

test('a saved segment is reported against the task id', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('feature/task-1234-login'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flushes: [{ key: TEST_KEY, flushed: 1 }] }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for task-1234-login \(1 segment\)/);
});

test('a non-task branch is labeled by its branch name', async () => {
  const { message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 2, flushes: [{ key: TEST_KEY, flushed: 2 }] }),
  });
  assert.match(message, /analytics saved for dev \(2 segments\)/);
});

test('a directory that is not a repo is tracked, labeled by its folder name', async () => {
  // With the local:<folder> fallback in the engine there is nothing left to refuse: the
  // checkpoint attributes the work, and the branch lookup only decides the label.
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    currentBranch: () => { throw new Error('fatal: not a git repository'); },
    ...checkpoint({ outcome: 'committed', enqueued: 1, flushes: [{ key: TEST_KEY, flushed: 1 }] }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for my-repo/);
  assert.doesNotMatch(message, /not a git repository/);
});

test('nothing new to save says so instead of claiming a save', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 0, flushes: [{ key: TEST_KEY, flushed: 0 }] }),
  });
  assert.equal(ok, true);
  assert.match(message, /nothing new to save for dev/);
});

test('an unreachable server is a retry, not a loss', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flushes: [{ key: TEST_KEY, failed: 1 }] }),
  });
  assert.equal(ok, false);
  assert.match(message, /retried automatically/);
});

test('a server rejection surfaces the server\'s own reason', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flushes: [{ key: TEST_KEY, rejected: 1, lastError: 'branch not linked' }] }),
  });
  assert.equal(ok, false);
  assert.match(message, /branch not linked/);
});

test('the checkpoint is driven without a hook budget, but with the rate-limit drain on', async () => {
  // A user waiting at a terminal would rather see the whole queue drained than a partial flush —
  // and that includes the queued rate-limit rows, which are otherwise only shipped at a turn end.
  let seenArgs = null;
  await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    runCheckpoint: async (...args) => { seenArgs = args; return { outcome: 'committed', enqueued: 0, flushes: [{ key: TEST_KEY, flushed: 0 }] }; },
  });
  assert.deepEqual(seenArgs[0], {
    session_id: 's1',
    transcript_path: 'C:/roll.jsonl',
    cwd: 'C:/work/my-repo',
  });
  assert.deepEqual(seenArgs[2], { drainRateLimits: true }, 'the drain opts in; budgetMs stays unset');
});

// ─── G-3-1: the track path is the one that must be able to NAME the session ──

test('a resolved transcript with a usable id is what gets tracked', () => {
  const target = resolveTrackTarget('C:/work/my-repo', {
    resolveTranscriptByCwdImpl: () => ({ sessionId: 's1', transcriptPath: 'C:/roll.jsonl' }),
  });
  assert.deepEqual(target, { ok: true, sessionId: 's1', transcriptPath: 'C:/roll.jsonl' });
});

test('no transcript at all is refused with the find message', () => {
  const target = resolveTrackTarget('C:/work/my-repo', { resolveTranscriptByCwdImpl: () => null });
  assert.equal(target.ok, false);
  assert.match(target.message, /could not find/);
});

// The resolver deliberately returns { sessionId: null, transcriptPath } for a transcript it can
// locate but not name — lib/session-audit.mjs needs that to exclude the live session by path. The
// TRACK caller cannot use it: every durable key it writes is derived from the id, and a null one
// becomes `state/null.json`, shared by every id-less session in this directory.
test('a transcript that cannot be named is refused rather than filed under "null"', () => {
  const target = resolveTrackTarget('C:/work/my-repo', {
    resolveTranscriptByCwdImpl: () => ({ sessionId: null, transcriptPath: 'C:/roll.jsonl' }),
  });
  assert.equal(target.ok, false);
  assert.match(target.message, /could not identify this session/);
  assert.match(target.message, /Nothing was written/);
});

test('an id that is the stringified form of a missing one is refused too', () => {
  for (const sessionId of ['null', 'undefined', 'NaN', '']) {
    const target = resolveTrackTarget('C:/work/my-repo', {
      resolveTranscriptByCwdImpl: () => ({ sessionId, transcriptPath: 'C:/roll.jsonl' }),
    });
    assert.equal(target.ok, false, `${sessionId} must not be treated as a session id`);
  }
});

// Second gate, on the value actually handed to runCheckpoint — which is what turns an id into
// state/<id>.json and a segmentId.
test('trackSession refuses a null id before it can write any state', async () => {
  let ran = false;
  const { ok, message } = await trackSession({ ...SESSION, sessionId: null }, {
    ...linked,
    ...onBranch('dev'),
    runCheckpoint: async () => { ran = true; return { outcome: 'committed', enqueued: 1, flushes: [{ key: TEST_KEY, flushed: 1 }] }; },
  });
  assert.equal(ok, false);
  assert.match(message, /could not identify this session/);
  assert.equal(ran, false, 'no checkpoint, so no state file and no queued segment');
});

// ─── the fan-out: one outcome per linked account ─────────────────────────────────────────────

const OTHER = accountSession('99887766', 'tok-b');

// One checkpoint, not one per account — the cursor advances on the first pass, so a second would
// find nothing left to bill and the later accounts would silently receive an empty report.
test('the checkpoint runs once for the whole fan-out', async () => {
  let runs = 0;
  await trackSession(SESSION, {
    linkedSessions: async () => [ACCOUNT, OTHER],
    ...onBranch('dev'),
    runCheckpoint: async () => {
      runs += 1;
      return { outcome: 'committed', enqueued: 1, flushes: [
        { key: ACCOUNT.key, flushed: 1 }, { key: OTHER.key, flushed: 1 },
      ] };
    },
  });
  assert.equal(runs, 1, 'a second pass would read a cursor the first one already advanced');
});

test('a rejection for one account is named, and the account that saved still says so', async () => {
  const { ok, message, lines } = await trackSession(SESSION, {
    linkedSessions: async () => [ACCOUNT, OTHER],
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flushes: [
      { key: ACCOUNT.key, flushed: 1 },
      { key: OTHER.key, rejected: 1, lastError: 'branch not linked' },
    ] }),
  });
  assert.equal(ok, false, 'one refusal makes the whole run unsuccessful');
  assert.match(message, /W-a1b2c3d4 — Beezi: analytics saved for dev \(1 segment\)/);
  assert.match(message, /W-99887766 — Beezi: branch not linked\./);
  // The per-line verdict scripts/track.mjs marks each line with. Without it the script's single ✗
  // would sit over the account that saved — the run's verdict printed as that account's.
  assert.deepEqual(lines.map((line) => line.ok), [true, false]);
  assert.equal(lines.map((line) => line.text).join('\n'), message);
});

// Every shape trackSession answers with carries `lines`, including the ones that belong to no
// account at all — scripts/track.mjs iterates it unconditionally.
test('a refusal that belongs to no account still answers with one marked line', async () => {
  const { ok, message, lines } = await trackSession(SESSION, {
    linkedSessions: async () => [],
    ...store,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 0, flushes: [] }),
  });
  assert.equal(ok, false);
  assert.deepEqual(lines, [{ ok: false, text: message }]);
});
