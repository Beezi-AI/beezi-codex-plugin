import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import { createBridge, LOGIN_TOOL } from '../lib/mcp-bridge.mjs';

// Regression lock for the grace timer in runLoginTool. It used to be `unref()`'d, and it is the
// only thing that can settle its own `await Promise.race([...])` while the sign-in is still with
// the human in the browser. An unref'd timer does not hold the event loop open, so with nothing
// else ref'd libuv drains, the timer never fires, and the await never returns — the tool call is
// answered by nobody. Under `node --test` that surfaces as "Promise resolution is still pending
// but the event loop has already resolved", and every remaining test in the file is cancelled.
//
// The fix keeps the timer ref'd and clears it once the race settles. Two properties to lock:
//   1. the grace path settles even when the timer is the only handle in the loop (the hang);
//   2. the timer is cleared on settle, so a fast sign-in leaves no 25s handle pending in an MCP
//      server that lives for the whole session (the production nit the unref was there to avoid).
//
// Everything here is injected: no network (fetchImpl throws), no browser and no credential store
// (performLogin is a stub), no reads or writes outside the process.
//
// The bridge's OTHER timer family — the per-request idle deadline (G-9-7) — is held to the same
// two properties in test/mcp-bridge-stream-timeout.test.mjs, which also has the harness for
// driving a streaming body. Look there before adding a deadline case here.

const LIB_URL = url.pathToFileURL(
  path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'lib', 'mcp-bridge.mjs'),
).href;

const LOGIN_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: LOGIN_TOOL.name } };

// Property 2, in-process and deterministic. Records every timer the login path arms and every one
// it clears, then asserts the grace timer is gone by the time the tool has answered. Against the
// old code nothing is ever cleared, so this fails outright rather than hanging.
test('a sign-in that beats the grace period leaves no timer armed', { timeout: 10_000 }, async (t) => {
  const GRACE_MS = 5_000; // distinctive, and far longer than this test takes
  const armed = new Map(); // handle -> delay
  const cleared = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  globalThis.setTimeout = (fn, delay, ...rest) => {
    const handle = realSetTimeout(fn, delay, ...rest);
    armed.set(handle, delay);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return realClearTimeout(handle);
  };

  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: "ok" }),
    url: 'https://api.test/api/mcp',
    // The account resolution is injected for the same reason everything else here is: an unlinked
    // machine is the state under test, and the real lookup would read an accounts index.
    getDefaultKey: async () => null,
    listAccounts: async () => [],
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    loginGraceMs: GRACE_MS,
    performLogin: async () => ({ outcome: 'linked', key: 'a1b2c3d4', account: { name: 'Dev' }, storedIn: '/c/creds' }),
  });

  await bridge.handleMessage(LOGIN_CALL);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;

  assert.match(out[0].result.content[0].text, /Signed in to Beezi as Dev/, 'the fast path answered');

  // The login path never calls post(), so the only timer armed at GRACE_MS is the grace timer.
  const graceHandles = [...armed].filter(([, delay]) => delay === GRACE_MS).map(([handle]) => handle);
  assert.equal(graceHandles.length, 1, 'exactly one grace timer was armed');
  assert.ok(
    cleared.has(graceHandles[0]),
    'the grace timer must be cleared once the race settles — an unref()\'d timer that is never ' +
      'cleared cannot settle its own await, and leaves a 25s handle in a session-long server',
  );
});

// Property 1, the hang itself. It cannot be reproduced in-process: this runner's loop always has
// other ref'd handles, which is exactly why the bug hid on Windows and only bit Linux CI. So run
// the grace path in a child whose event loop holds nothing else, and read the outcome off the exit
// code: the child starts at exitCode 1 and only reaches exitCode 0 after the tool has answered.
//   old code -> loop drains under the unref'd timer, exit 1, empty stdout
//   fixed    -> exit 0, the answer on stdout
//   ref'd hang -> this test's own timeout fires
test('the grace path settles when its timer is the only handle in the loop', { timeout: 30_000 }, () => {
  const driver = [
    // Only a completed sign-in answer may set this back to 0.
    'process.exitCode = 1;',
    `const { createBridge } = await import(${JSON.stringify(LIB_URL)});`,
    'const out = [];',
    'const bridge = createBridge({ checkEnvironment: () => ({ status: "ok" }),',
    "  url: 'https://api.test/api/mcp',",
    // This child inherits the sandbox ROOTS but not the GUARD: tools/hermetic-env.mjs rewrites
    // HOME/USERPROFILE/CODEX_HOME/BEEZI_CODEX_HOME on the parent's process.env and the spawn below
    // passes no `env`, so the roots come through — but nothing in the child fails it for escaping
    // one. The account resolution is injected so the bridge does no index work here at all, which
    // is also what keeps this child's event loop empty enough to reproduce the hang it exists for.
    '  getDefaultKey: async () => null,',
    '  listAccounts: async () => [],',
    "  fetchImpl: async () => { throw new Error('must not reach the network'); },",
    '  write: (line) => out.push(line),',
    '  logError: () => {},',
    '  loginGraceMs: 50,',
    // Never settles: the browser round-trip is still with the human, so the grace timer is the
    // only thing that can settle the race — and nothing else in this process is ref'd.
    '  performLogin: ({ onStep }) => {',
    "    onStep({ type: 'authorize-url', url: 'https://auth.test/authorize?x=1' });",
    '    return new Promise(() => {});',
    '  },',
    '});',
    `await bridge.handleMessage(${JSON.stringify(LOGIN_CALL)});`,
    'process.stdout.write(JSON.stringify(out));',
    'process.exitCode = 0;',
  ].join('\n');

  const run = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf-8',
    timeout: 20_000,
  });

  assert.equal(run.signal, null, `the child was killed: ${run.stderr}`);
  assert.equal(
    run.status,
    0,
    'the grace-period await never settled — the event loop drained out from under the grace ' +
      `timer (stdout: ${JSON.stringify(run.stdout)}, stderr: ${run.stderr})`,
  );
  const written = JSON.parse(run.stdout).map((line) => JSON.parse(line));
  assert.equal(written.length, 1, 'the tool call was answered exactly once');
  assert.equal(written[0].id, LOGIN_CALL.id);
  assert.match(written[0].result.content[0].text, /https:\/\/auth\.test\/authorize/);
});
