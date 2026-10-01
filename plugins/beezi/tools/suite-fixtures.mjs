// Shared fixtures for the Beezi Codex suite (§7.1).
//
// These are the helpers that had been copy-pasted into individual test files: the same eleven-line
// sandbox-home block appeared 19 times, the same two-root watcher bench 3 times, the same
// never-answers fetch 3 times. They are collected here so a change to the sandbox contract is made
// once rather than nineteen times.
//
// PLACEMENT AND NAME. Both are constrained, and the name is the less obvious of the two.
//
// Not under test/, for the same reason tools/hermetic-env.mjs is not (see its PLACEMENT note):
// Node's default test-file patterns include `**/test/**/*.?(c|m)js`, so anything under test/ is
// collected AND COUNTED as a test file.
//
// Not named `test-helpers.mjs` either, which is the trap this file fell into first. That same
// default set includes `**/test-*.?(c|m)js` — a prefix rule that has nothing to do with the
// directory — so `tools/test-helpers.mjs` was collected from tools/ just as surely as if it had
// been under test/, and the suite reported one extra passing "test" (measured: 1736 -> 1737, the
// phantom being the module itself). A fixtures module must therefore match NONE of `*.test.*`,
// `*-test.*`, `*_test.*`, `test.*` or `test-*` — hence `suite-fixtures.mjs`.
//
// tools/ is also outside the ban-gate's `['lib', 'scripts']` scan (test/compat-syntax.test.mjs),
// so modern syntax is fine here — as it is in every test file.
//
// Node builtins only, and deliberately no `../lib/` import. A fixture that reached into lib/ would
// make the suite's sandbox depend on the code under test; it would also drag `queueDir()` in here,
// and queue seeding differs per caller. That seeding stays at the call sites that need it.
//
// These compose with tools/hermetic-env.mjs rather than replacing it. The gate redirects
// BEEZI_CODEX_HOME and CODEX_HOME to a per-process sandbox and leaves os.tmpdir() usable, so the
// mkdtemp roots below are already inside allowed territory and the save/restore below puts the
// gate's own values back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Normalise the `prefix`-or-options second argument the helpers share.
 *
 * A bare string is the common case (`tmpHome(t, 'beezi-cp-')`); the object form carries
 * `beforeCleanup` for the few tests that must release process-wide state before the sandbox goes.
 */
function settings(options) {
  return typeof options === 'string' ? { prefix: options } : (options || {});
}

/**
 * A disposable BEEZI_CODEX_HOME for one test.
 *
 * Creates a temp dir, points BEEZI_CODEX_HOME at it, and restores the previous value (the
 * hermetic gate's sandbox, normally) plus removes the dir via `t.after`.
 *
 * `beforeCleanup` runs INSIDE that single `t.after`, ahead of the env restore and the removal —
 * it is not a second `t.after` registration. The lock tests pass `forgetHeldLocks` here, and the
 * ordering is load-bearing: released after the rm, the lock module would hold paths into a
 * deleted directory and leak state into the next test.
 */
export function tmpHome(t, options = {}) {
  const { prefix = 'beezi-', beforeCleanup } = settings(options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (beforeCleanup) beforeCleanup();
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A whole disposable machine: both roots the watcher reads.
 *
 * The rollout watcher walks CODEX_HOME/sessions and writes its ledger under BEEZI_CODEX_HOME, so
 * its tests need the two redirected together. `prefix` names the pair — 'watcher-disc-' yields
 * `watcher-disc-home-…` and `watcher-disc-codex-…`, which is how the three copies spelled it.
 */
export function makeMachine(t, options = {}) {
  const { prefix = 'watcher-', beforeCleanup } = settings(options);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}home-`));
  const codex = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}codex-`));
  const before = { home: process.env.BEEZI_CODEX_HOME, codex: process.env.CODEX_HOME };
  process.env.BEEZI_CODEX_HOME = home;
  process.env.CODEX_HOME = codex;
  t.after(() => {
    if (beforeCleanup) beforeCleanup();
    if (before.home === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = before.home;
    if (before.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before.codex;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(codex, { recursive: true, force: true });
  });
  return { home, codex, sessionsDir: path.join(codex, 'sessions') };
}

/**
 * A stable, ordered session id. `uuid(7)` is `00000007-2222-3333-4444-555555555555`.
 *
 * Shaped like a real rollout uuid because the discovery scan filters on that shape, and ordered by
 * `n` so a test can assert which sessions came back and in what order.
 */
export const uuid = (n) => `${String(n).padStart(8, '0')}-2222-3333-4444-555555555555`;

/**
 * A fetch double that records every call and answers with `responder(url, opts)`.
 *
 * The recorded `calls` array hangs off the returned function, so a test asserts on
 * `fetchImpl.calls[0].opts.body` — and `calls.length === 0` is how the skip paths are proved: a
 * `reason` of 'unchanged' says what the module decided, not what it sent.
 */
export function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  impl.calls = calls;
  return impl;
}

/**
 * A fetch that accepts the connection and never answers unless the caller aborts.
 *
 * The slow-server failure mode: a local API paused in a debugger, an app mid-restart, a proxy
 * holding the socket. Node's fetch has no default timeout, so an unbounded call against one of
 * these hangs for the life of the hook process — these tests are the bound's regression lock.
 *
 * Composes with the recorder when a test needs both: `recordingFetch(hangingFetch())`.
 */
export function hangingFetch() {
  return (url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(
      Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    ));
  });
}
