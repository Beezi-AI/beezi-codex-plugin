import { recordIssue as _recordIssue, setCurrentSource, DIAGNOSTIC_CODES } from './diagnostics.mjs';
import { exitClean as _exitClean } from './shutdown.mjs';

// Loads a hook's implementation module AFTER the recorder is live, so a module that throws on
// import — a syntax error, a missing dependency, a half-written file after an upgrade — is
// recorded from a runtime that still works. A static import at the top of the hook script would
// take the whole process down before anything could observe it.
//
// `name` resolves against lib/, so hook scripts pass './checkpoint.mjs'.
export async function importHookModule(name, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  try {
    return await (deps.importImpl == null ? import(new URL(name, import.meta.url).href) : deps.importImpl(name));
  } catch (error) {
    try {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_IMPORT_FAILED, error });
    } catch { /* never */ }
    return null;
  }
}

// Wraps a hook body. Every hook script used to end `.catch(() => {}).finally(() => exitClean(0))`,
// which is exactly where a crash disappears. Same exit behaviour, one extra step: the failure is
// recorded first. Never rethrows — a hook that fails must still exit 0.
//
// `source` must be a DIAGNOSTIC_SOURCES value: the subagent hooks pass UNKNOWN, because the public
// route's source enum has no subagent members yet.
export async function runHook(source, fn, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const exitClean = deps.exitClean == null ? _exitClean : deps.exitClean;
  const onResult = deps.onResult == null ? () => {} : deps.onResult;

  const onRejection = (reason) => {
    try {
      recordIssue({
        code: DIAGNOSTIC_CODES.HOOK_UNHANDLED_REJECTION,
        source,
        error: reason instanceof Error ? reason : new Error('unhandled'),
      });
    } catch { /* never */ }
  };
  process.on('unhandledRejection', onRejection);
  // Published for call sites (fs-store, token) that don't know their own source — they fall
  // back to whatever hook is currently in flight instead of guessing.
  setCurrentSource(source);

  try {
    onResult(await fn());
  } catch (error) {
    try {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source, error });
    } catch { /* never */ }
  } finally {
    // Not cleared here: a write failure's report is fired-and-forgotten via a lazy import that
    // can resolve after this hook has already finished, and it still needs to see this hook's
    // source. Each hook is its own short-lived process, so nothing after this ever reads it.
    process.removeListener('unhandledRejection', onRejection);
    await exitClean(0);
  }
}
