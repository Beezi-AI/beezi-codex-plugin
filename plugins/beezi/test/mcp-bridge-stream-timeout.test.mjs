import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../lib/mcp-bridge.mjs';

// G-9-7 — the bridge's request deadline is an IDLE window, refreshed by incoming data.
//
// What HEAD did, and why the registered description of the bug is not quite the mechanism:
// `post` armed one abort timer and cleared it in a `finally` around `await fetchImpl(...)`. A
// fetch promise resolves at the RESPONSE HEADERS, so that finally ran the moment the headers
// landed — the timer was gone, and the controller went out of scope, before a single byte of the
// SSE body was read. So an actively streaming response was never "killed at 120s"; the opposite
// held. The body read was bounded by nothing at all, and a stream that fell silent after its
// headers hung the tool call forever with no error and no output.
//
// The contract (R5): one idle window, refreshed by every incoming chunk, bounded handling for a
// completely silent response, timers cleaned up on completion and on abort.
//
// Everything here is injected — `fetchImpl` never touches the network, and the response bodies are
// local async generators that honour the abort signal the way fetch does.

const URL_UNDER_TEST = 'https://api.test/api/mcp';

// The bridge resolves the DEFAULT account per request — an index read plus a keyed credential
// read. Both are injected here so this file stays a test of the deadline and nothing else; the
// resolution itself runs against the real modules in test/account-bridge.test.mjs.
const LINKED_ACCOUNT = {
  getDefaultKey: async () => 'a1b2c3d4',
  getAuthentication: async () => ({ state: 'ready', accessToken: 'tok', clientId: 'c-a1b2c3d4' }),
  listAccounts: async () => [{ key: 'a1b2c3d4', clientId: 'c-a1b2c3d4', status: 'linked' }],
};
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_my_usage_summary' } };

// The idle window under test. Wide enough that Windows timer jitter cannot decide an outcome:
// the active stream below runs 6x it, and the chunk gap is a quarter of it.
const IDLE_MS = 200;
const GAP_MS = 50;

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Resolves after `ms`, or rejects the moment the signal aborts — the observable behaviour of a
// fetch body stream being torn down by its controller. `ms === null` never resolves on its own,
// which is how a stalled upstream is modelled: only the deadline can end it.
function waitOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    let timer = null;
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    function cleanup() {
      if (timer !== null) clearTimeout(timer);
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
    }
    if (ms !== null) {
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
    }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
  });
}

const encoder = new TextEncoder();
const frame = (msg) => encoder.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);

// An SSE response that delivers `messages` one every GAP_MS and then either ends the stream or
// goes silent forever. `stall: true` with an empty `messages` is the completely-silent case: the
// headers arrive and nothing ever follows them.
function streamingResponse(signal, { messages = [], stall = false } = {}) {
  const headers = { 'content-type': 'text/event-stream' };
  async function* body() {
    for (const msg of messages) {
      await waitOrAbort(GAP_MS, signal);
      yield frame(msg);
    }
    if (stall) await waitOrAbort(null, signal);
  }
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    body: body(),
  };
}

// Records every timer the bridge arms, whether it was cleared, whether it fired, and — the rule
// this whole family of bugs came from — whether anyone unref'd it. Restored via `t.after`.
function instrumentTimers(t) {
  const armed = new Map(); // handle -> delay
  const cleared = new Set();
  const fired = new Set();
  const unreffed = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });
  globalThis.setTimeout = (fn, delay, ...rest) => {
    let handle;
    handle = realSetTimeout((...args) => {
      fired.add(handle);
      return fn(...args);
    }, delay, ...rest);
    armed.set(handle, delay);
    if (handle && typeof handle.unref === 'function') {
      const realUnref = handle.unref.bind(handle);
      handle.unref = () => {
        unreffed.add(handle);
        return realUnref();
      };
    }
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return realClearTimeout(handle);
  };
  const restore = () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  };
  // Deadline timers are the only ones armed at exactly IDLE_MS; the fake body uses GAP_MS.
  const deadlineHandles = () => [...armed].filter(([, delay]) => delay === IDLE_MS).map(([h]) => h);
  return { armed, cleared, fired, unreffed, restore, deadlineHandles };
}

function streamBridge(options) {
  const out = [];
  let signalSeen = null;
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...LINKED_ACCOUNT,
    fetchImpl: async (url, init) => {
      signalSeen = init.signal;
      return streamingResponse(init.signal, options);
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: IDLE_MS,
  });
  return { bridge, out, signal: () => signalSeen };
}

// --- the active stream -------------------------------------------------------------------------

// A forward guard, not a HEAD reproduction: HEAD has no body deadline at all, so an active stream
// already survives there. What this locks is that the fix did not arm ONE deadline across the whole
// stream — the obvious wrong reading of "make the timeout cover the body", which would cut a
// perfectly healthy long tool call off at the window.
test('an active stream outlives the idle window many times over', { timeout: 30_000 }, async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ jsonrpc: '2.0', id: 1, result: { chunk: i } }));
  const { bridge, out } = streamBridge({ messages });

  const started = Date.now();
  await bridge.handleMessage(CALL);
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed > IDLE_MS,
    `the stream must outlast the idle window for this to prove anything (ran ${elapsed}ms, window ${IDLE_MS}ms)`,
  );
  assert.equal(out.length, messages.length, 'every streamed message reached the client');
  assert.deepEqual(out.map((m) => m.result.chunk), messages.map((m) => m.result.chunk));
  assert.ok(out.every((m) => m.error === undefined), 'a healthy stream is never aborted');
});

// --- the stalled stream ------------------------------------------------------------------------

// The regression this fix exists for. At HEAD this never returns: the body read is unbounded, so
// the tool call is answered by nobody and the client spins. The assertion is on the written error
// response, not on the test merely finishing — a hang and a failure read differently in CI.
test('a stream that goes silent is aborted and answered, not left hanging', { timeout: 30_000 }, async () => {
  const messages = [{ jsonrpc: '2.0', id: 1, result: { chunk: 0 } }];
  const { bridge, out } = streamBridge({ messages, stall: true });

  const started = Date.now();
  await bridge.handleMessage(CALL);
  const elapsed = Date.now() - started;

  assert.equal(out.length, 2, 'the chunk that did arrive, then the timeout error');
  assert.deepEqual(out[0].result, { chunk: 0 }, 'data delivered before the stall is not lost');
  assert.equal(out[1].id, CALL.id, 'the request is answered rather than abandoned');
  assert.equal(out[1].error.code, -32000);
  assert.match(out[1].error.message, /timed out/i);
  assert.match(out[1].error.message, new RegExp(String(IDLE_MS)), 'the message names the window');
  assert.ok(
    elapsed >= IDLE_MS,
    `the abort must wait out the idle window, not fire early (took ${elapsed}ms)`,
  );
});

// R5's other half: a response whose headers arrive and whose body then produces nothing at all.
// There is no chunk to refresh the window, so the window armed at the headers is the whole bound.
test('a completely silent response is bounded by the idle window', { timeout: 30_000 }, async () => {
  const { bridge, out } = streamBridge({ messages: [], stall: true });

  const started = Date.now();
  await bridge.handleMessage(CALL);
  const elapsed = Date.now() - started;

  assert.equal(out.length, 1);
  assert.equal(out[0].id, CALL.id);
  assert.match(out[0].error.message, /timed out/i);
  assert.ok(elapsed >= IDLE_MS, `waited the window (${elapsed}ms)`);
  assert.ok(elapsed < IDLE_MS * 20, `bounded rather than open-ended (${elapsed}ms)`);
});

// --- timer hygiene -----------------------------------------------------------------------------

test('a completed stream leaves no deadline timer armed', { timeout: 30_000 }, async (t) => {
  const timers = instrumentTimers(t);
  const messages = Array.from({ length: 8 }, (_, i) => ({ jsonrpc: '2.0', id: 1, result: { chunk: i } }));
  const { bridge, out } = streamBridge({ messages });

  await bridge.handleMessage(CALL);
  timers.restore();

  assert.equal(out.length, messages.length);
  const handles = timers.deadlineHandles();
  // One per chunk plus the arm at request start and the refresh at the headers: the point is that
  // the window really is being re-armed, not that the count is a particular number.
  assert.ok(handles.length > messages.length, `the window is refreshed per chunk (armed ${handles.length})`);
  const pending = handles.filter((h) => !timers.cleared.has(h) && !timers.fired.has(h));
  assert.deepEqual(pending, [], 'every deadline timer is cleared or spent by the time the call returns');
  // Only the deadline handles: the fake body's own chunk timers fire by design.
  assert.deepEqual(
    handles.filter((h) => timers.fired.has(h)),
    [],
    'a healthy stream never lets the deadline fire',
  );
});

// The rule the login grace timer was fixed under (G-10-2) and which must not come back through a
// different timer: an unref'd deadline does not hold the loop open, so in a process whose only
// remaining handle is the deadline itself the loop drains, the timer never fires, and the abort
// that was supposed to end a stalled stream never happens. Clear timers; do not unref them.
test('deadline timers are cleared, never unref()\'d', { timeout: 30_000 }, async (t) => {
  const timers = instrumentTimers(t);
  const { bridge, out } = streamBridge({ messages: [{ jsonrpc: '2.0', id: 1, result: {} }], stall: true });

  await bridge.handleMessage(CALL);
  timers.restore();

  assert.match(out[1].error.message, /timed out/i, 'the stalled stream was aborted');
  const handles = timers.deadlineHandles();
  assert.ok(handles.length > 0, 'the deadline was armed');
  assert.deepEqual(
    handles.filter((h) => timers.unreffed.has(h)),
    [],
    'an unref\'d deadline cannot fire in a process with nothing else in the loop',
  );
  const pending = handles.filter((h) => !timers.cleared.has(h) && !timers.fired.has(h));
  assert.deepEqual(pending, [], 'the aborting timer is spent and the rest are cleared');
});

// --- the non-streaming paths still release ------------------------------------------------------

test('a discarded response releases its deadline instead of leaving one armed', { timeout: 30_000 }, async (t) => {
  const timers = instrumentTimers(t);
  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...LINKED_ACCOUNT,
    // 401 is answered without the body ever being read, so nothing downstream would release it.
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      body: null,
      text: async () => '',
      json: async () => ({}),
    }),
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: IDLE_MS,
  });

  await bridge.handleMessage(CALL);
  timers.restore();

  assert.match(out[0].error.message, /rejected this machine/i);
  const handles = timers.deadlineHandles();
  assert.ok(handles.length > 0, 'the deadline was armed for the request');
  const pending = handles.filter((h) => !timers.cleared.has(h) && !timers.fired.has(h));
  assert.deepEqual(pending, [], 'a 401 answered without reading the body still releases its timer');
});
