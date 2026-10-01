import { orDefault } from './compat.mjs';

// End a hook process without tripping libuv on Windows.
//
// The failure this exists to prevent, seen in a real Stop hook:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//   exit code 3221226505 (0xC0000409)
//
// Codex reports that as a failed hook even though the checkpoint itself had completed — the work
// was done and the analytics were reported; the process died on the way out.
//
// The cause is `process.exit()` racing libuv: forcing teardown while an async handle is still
// mid-close fast-fails the process. Draining undici's keep-alive pool first and yielding a loop
// tick narrows that window but does not close it — the assertion was observed with exactly that
// mitigation in place, on Node v24 with a healthy API.
//
// So the normal path no longer forces anything. Set `process.exitCode` and let the loop drain:
// once the pool is closed nothing is left holding it open, and a process that exits on its own has
// no handle to race. The forced exit survives only as a backstop for a stray handle (a lingering
// socket, a timer some dependency left behind), where by definition nothing is mid-close any more.
const FORCE_EXIT_AFTER_MS = 2000;

export async function exitClean(code = 0, deps = {}) {
  const getDispatcher =
    orDefault(deps.getDispatcher, () => globalThis[Symbol.for('undici.globalDispatcher.1')]);
  const exit = orDefault(deps.exit, (c) => process.exit(c));
  const setExitCode = orDefault(deps.setExitCode, (c) => { process.exitCode = c; });
  const schedule = orDefault(deps.setTimeoutImpl, setTimeout);
  const forceAfterMs = orDefault(deps.forceAfterMs, FORCE_EXIT_AFTER_MS);

  const dispatcher = getDispatcher();
  if (dispatcher) {
    try { await dispatcher.close(); }
    catch { try { await dispatcher.destroy(); } catch { /* exit anyway */ } }
  }
  // One loop tick so the closed sockets' callbacks run before anything else is decided.
  await new Promise((resolve) => setImmediate(resolve));

  setExitCode(code);

  // unref'd: this timer must never be the reason the process is still alive. If the loop is
  // already empty the process exits here, with `code`, and the timer never fires.
  const timer = schedule(() => exit(code), forceAfterMs);
  if (timer && timer.unref) timer.unref();
  return timer;
}
