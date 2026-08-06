import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitClean } from '../lib/shutdown.mjs';

// A fake unref'able timer, so a test can assert the backstop was *scheduled* without waiting for
// it and without it holding the test process open.
function fakeTimer() {
  const scheduled = [];
  const schedule = (fn, ms) => {
    const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
    scheduled.push(t);
    return t;
  };
  return { schedule, scheduled };
}

test('drains the dispatcher before deciding anything about exiting', async () => {
  const order = [];
  const { schedule } = fakeTimer();
  const dispatcher = { close: async () => { order.push('close'); }, destroy: async () => { order.push('destroy'); } };
  let exitCode = null;
  await exitClean(3, {
    getDispatcher: () => dispatcher,
    exit: () => order.push('exit'),
    setExitCode: (c) => { order.push('setExitCode'); exitCode = c; },
    setTimeoutImpl: schedule,
  });
  assert.deepEqual(order, ['close', 'setExitCode'], 'pool drained, and nothing forced');
  assert.equal(exitCode, 3);
});

// The regression this file exists for: forcing process.exit() while a socket handle is still
// mid-close fast-fails on Windows —
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
// — and Codex reports the dead process as a failed hook even though the checkpoint completed.
test('does not force an exit on the normal path — the loop is left to drain', async () => {
  let forced = false;
  const { schedule, scheduled } = fakeTimer();
  await exitClean(0, {
    getDispatcher: () => ({ close: async () => {} }),
    exit: () => { forced = true; },
    setExitCode: () => {},
    setTimeoutImpl: schedule,
  });
  assert.equal(forced, false, 'process.exit() must not be called while handles may be closing');
  assert.equal(scheduled.length, 1, 'a backstop is scheduled');
  assert.equal(scheduled[0].unrefd, true, 'the backstop must not keep the process alive itself');
});

test('the exit code is published even though nothing forces the exit', async () => {
  let published = null;
  const { schedule } = fakeTimer();
  await exitClean(0, {
    getDispatcher: () => undefined,
    exit: () => {},
    setExitCode: (c) => { published = c; },
    setTimeoutImpl: schedule,
  });
  assert.equal(published, 0);
});

test('the backstop forces the exit when something still holds the loop open', async () => {
  let forcedWith = null;
  const { schedule, scheduled } = fakeTimer();
  await exitClean(7, {
    getDispatcher: () => ({ close: async () => {} }),
    exit: (c) => { forcedWith = c; },
    setExitCode: () => {},
    setTimeoutImpl: schedule,
  });
  assert.equal(forcedWith, null, 'not forced yet');
  scheduled[0].fn(); // the loop was still alive when the grace period elapsed
  assert.equal(forcedWith, 7);
});

test('the loop-tick flush still runs after the pool is drained', async () => {
  const order = [];
  const { schedule } = fakeTimer();
  const dispatcher = { close: async () => { setImmediate(() => order.push('socket-close-callback')); } };
  await exitClean(0, {
    getDispatcher: () => dispatcher,
    exit: () => order.push('exit'),
    setExitCode: () => order.push('setExitCode'),
    setTimeoutImpl: schedule,
  });
  assert.deepEqual(order, ['socket-close-callback', 'setExitCode']);
});

test('falls back to destroy() when close() throws', async () => {
  const order = [];
  const { schedule } = fakeTimer();
  const dispatcher = {
    close: async () => { throw new Error('close failed'); },
    destroy: async () => { order.push('destroy'); },
  };
  await exitClean(0, {
    getDispatcher: () => dispatcher,
    exit: () => order.push('exit'),
    setExitCode: () => order.push('setExitCode'),
    setTimeoutImpl: schedule,
  });
  assert.deepEqual(order, ['destroy', 'setExitCode']);
});

test('exits cleanly when there is no undici dispatcher', async () => {
  let exitCode = null;
  const { schedule } = fakeTimer();
  await exitClean(1, {
    getDispatcher: () => undefined,
    exit: () => {},
    setExitCode: (c) => { exitCode = c; },
    setTimeoutImpl: schedule,
  });
  assert.equal(exitCode, 1);
});
