import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, mcpUrl, LOGIN_TOOL, STATUS_TOOL, LOCAL_TOOLS } from '../lib/mcp-bridge.mjs';

const URL_UNDER_TEST = 'https://api.test/api/mcp';

// The bridge repairs the hook registry on a linked machine's first message. Stubbed by default so
// a unit test of the message loop does no filesystem work; the heal itself is tested below.
const NO_REPAIR = { repaired: false, before: 'installed', state: 'installed', swept: [] };

const ACCOUNT_KEY = 'a1b2c3d4';
const CLIENT_ID = 'c-a1b2c3d4';

/**
 * The account resolution, injected.
 *
 * The bridge forwards as the DEFAULT account: it reads the accounts index and then that account's
 * credentials. Both are stubbed here — this file is a unit test of the message loop and must do no
 * filesystem work — and the resolution itself is driven end-to-end against the real
 * lib/accounts.mjs and lib/credentials.mjs in test/account-bridge.test.mjs.
 *
 * `readToken` is a FUNCTION, not a value: one test below links the machine mid-run by reassigning
 * the token, and a captured value would leave the bridge unlinked forever.
 */
function accountDeps(readToken) {
  return {
    getDefaultKey: async () => (readToken() === null ? null : ACCOUNT_KEY),
    getAccount: async (key) => (readToken() === null || key !== ACCOUNT_KEY
      ? null
      : { key: ACCOUNT_KEY, clientId: CLIENT_ID, status: 'linked', tenants: null }),
    getAuthentication: async () => ({ state: 'ready', accessToken: readToken(), clientId: CLIENT_ID }),
    listAccounts: async () => (readToken() === null
      ? []
      : [{ key: ACCOUNT_KEY, clientId: CLIENT_ID, status: 'linked' }]),
  };
}

// The hook-trust probe spawns `codex app-server` for real, which the hermetic gate records as an
// escape. Every bridge here gets a stub; the trust tests below script it.
const UNKNOWN_TRUST = Object.freeze({ verdict: 'unknown', untrusted: [], disabled: [], reason: 'test' });

// Each entry in `responses` answers one fetch, in order; an Error entry rejects.
function bridgeWith({
  responses = [],
  token = 'tok',
  ensureHooks = () => NO_REPAIR,
  probe = async () => UNKNOWN_TRUST,
  cached = () => null,
} = {}) {
  const calls = [];
  const out = [];
  const heals = [];
  const probes = [];
  // Every verdict the bridge hands to ~/.codex/AGENTS.md, in order. Stubbed: the file itself is
  // tested in test/agents-notice.test.mjs.
  const synced = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => token),
    probeHookTrust: () => { probes.push(1); return probe(); },
    readCachedTrust: cached,
    syncTrustNotice: (trust) => { synced.push(trust.verdict); return { action: 'none' }; },
    removeTrustNotice: () => { synced.push('removed'); return { action: 'none' }; },
    ensureHooks: () => { heals.push(1); return ensureHooks(); },
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
  });
  return { bridge, calls, out, heals, probes, synced };
}

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseRes(messages, { headers = {} } = {}) {
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const INIT_RESULT = { jsonrpc: '2.0', id: 0, result: { capabilities: {} } };
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_ticket' } };
const CALL_RESULT = { jsonrpc: '2.0', id: 1, result: { content: [] } };

test('mcpUrl honors BEEZI_MCP_URL over the API base', (t) => {
  const prev = process.env.BEEZI_MCP_URL;
  process.env.BEEZI_MCP_URL = 'https://elsewhere/mcp';
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_MCP_URL;
    else process.env.BEEZI_MCP_URL = prev;
  });
  assert.equal(mcpUrl(), 'https://elsewhere/mcp');
});

test('not linked: requests get a sign-in error, notifications are dropped', async () => {
  const { bridge, calls, out } = bridgeWith({ token: null });
  await bridge.handleMessage(CALL);
  await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(calls.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, new RegExp(LOGIN_TOOL.name));
});

test('forwards with bearer auth and machine identity headers', async () => {
  const { bridge, calls, out } = bridgeWith({ responses: [jsonRes(CALL_RESULT)] });
  await bridge.handleMessage(CALL);
  assert.equal(calls[0].url, URL_UNDER_TEST);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.ok(calls[0].headers['X-Beezi-Host']);
  assert.equal(calls[0].headers['mcp-session-id'], undefined);
  assert.deepEqual(out, [CALL_RESULT]);
});

test('captures the session id from initialize and sends it on later requests', async () => {
  const { bridge, calls, out } = bridgeWith({
    responses: [sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's1' } }), jsonRes(CALL_RESULT)],
  });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  assert.deepEqual(out, [INIT_RESULT, CALL_RESULT]);
  assert.equal(calls[1].headers['mcp-session-id'], 's1');
});

test('writes every message of an SSE response', async () => {
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  const { bridge, out } = bridgeWith({ responses: [sseRes([notification, CALL_RESULT])] });
  await bridge.handleMessage(CALL);
  assert.deepEqual(out, [notification, CALL_RESULT]);
});

test('202 for a notification writes nothing', async () => {
  const { bridge, out } = bridgeWith({ responses: [new Response(null, { status: 202 })] });
  await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out.length, 0);
});

test('lost session: re-initializes transparently and retries the request', async () => {
  const { bridge, calls, out } = bridgeWith({
    responses: [
      sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's1' } }),
      jsonRes({ jsonrpc: '2.0', error: { code: -32004, message: 'session not found' }, id: null }, { status: 404 }),
      sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's2' } }),
      new Response(null, { status: 202 }),
      jsonRes(CALL_RESULT),
    ],
  });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  // initialize, failed call, replayed initialize, initialized notification, retried call
  assert.equal(calls.length, 5);
  assert.equal(calls[2].body.method, 'initialize');
  assert.equal(calls[2].headers['mcp-session-id'], undefined);
  assert.equal(calls[3].body.method, 'notifications/initialized');
  assert.equal(calls[4].headers['mcp-session-id'], 's2');
  // the replayed initialize response stays hidden from the client
  assert.deepEqual(out, [INIT_RESULT, CALL_RESULT]);
});

test('401 surfaces a relink error', async () => {
  const { bridge, out } = bridgeWith({
    responses: [new Response(null, { status: 401 })],
  });
  await bridge.handleMessage(CALL);
  assert.equal(out.length, 1);
  assert.match(out[0].error.message, /rejected this machine/i);
  assert.match(out[0].error.message, new RegExp(LOGIN_TOOL.name));
});

test('server JSON-RPC error bodies pass their message through', async () => {
  const { bridge, out } = bridgeWith({
    responses: [jsonRes({ jsonrpc: '2.0', error: { code: -32005, message: 'session limit reached' }, id: null }, { status: 503 })],
  });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /session limit reached/);
});

test('network failure produces an error response, not a crash', async () => {
  const { bridge, out } = bridgeWith({ responses: [new Error('socket hang up')] });
  await bridge.handleMessage(CALL);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /socket hang up/);
});

test('handleLine drops non-JSON input without writing', async () => {
  const { bridge, calls, out } = bridgeWith();
  await bridge.handleLine('not json');
  await bridge.handleLine('   ');
  assert.equal(calls.length, 0);
  assert.equal(out.length, 0);
});

// Codex spawns this server at the start of every session, before a machine is necessarily linked.
// A handshake that fails there takes the whole plugin down — skill included — so the unlinked
// bridge has to stay a working, empty MCP server.
test('unlinked: initialize is answered locally and never reaches the network', async () => {
  const { bridge, calls, out } = bridgeWith({ token: null });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  assert.equal(calls.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].error, undefined);
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.ok(out[0].result.serverInfo.name);
});

test('unlinked: any other tool call points at the sign-in tool', async () => {
  const { bridge, out } = bridgeWith({ token: null });
  await bridge.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } });

  assert.equal(out[0].error.code, -32000);
  assert.match(out[0].error.message, /not linked/i);
  assert.match(out[0].error.message, new RegExp(LOGIN_TOOL.name));
  // Codex does not load a plugin's commands, so naming one would send the user nowhere.
  assert.ok(!out[0].error.message.includes('/beezi:login'));
});

test('unlinked: notifications are dropped, not answered', async () => {
  const { bridge, calls, out } = bridgeWith({ token: null });
  await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out.length, 0);
  assert.equal(calls.length, 0);
});

test('a machine linked mid-session replays the client handshake before its first request', async () => {
  let token = null;
  const calls = [];
  const out = [];
  const responses = [
    jsonRes({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': 's1' } }),
    new Response(null, { status: 202 }),
    jsonRes({ jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'draft' }] } }),
  ];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    // The hook-trust probe would spawn codex app-server; the hermetic gate forbids it.
    probeHookTrust: async () => ({ verdict: 'unknown', untrusted: [], disabled: [], reason: 'test' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => token),
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return responses.shift();
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
  });

  // Session starts unlinked: handled locally, nothing sent upstream.
  await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(calls.length, 0);

  token = 'tok';
  await bridge.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' });

  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list']);
  // The client sees its own initialize answer once, then the real tool list.
  assert.deepEqual(out.map((m) => m.id), [1, 9]);
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['draft', ...LOCAL_TOOLS.map((t) => t.name)]);
});

// Auto-login: Codex's native MCP OAuth only covers streamable-HTTP servers, and using it would put
// the token in Codex's store while the analytics hooks read ~/.beezi-codex/credentials.json. So the
// bridge carries its own sign-in tool. It plus beezi_status — LOCAL_TOOLS, two entries — are the
// whole tool list an unlinked machine offers; the next test pins that.
function loginBridge({ token = null, performLogin, loginGraceMs } = {}) {
  const out = [];
  const logged = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    // The hook-trust probe would spawn codex app-server; the hermetic gate forbids it.
    probeHookTrust: async () => ({ verdict: 'unknown', untrusted: [], disabled: [], reason: 'test' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => token),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: (msg) => logged.push(msg),
    performLogin,
    ...(loginGraceMs === undefined ? {} : { loginGraceMs }),
  });
  return { bridge, out, logged };
}

test('unlinked: the tool list is exactly the locally-served tools', async () => {
  const { bridge, out } = loginBridge();
  await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(out[0].result.tools.map((t) => t.name), [LOGIN_TOOL.name, STATUS_TOOL.name]);
  for (const t of out[0].result.tools) {
    assert.ok(t.description.length > 40, `the model needs to know when to call ${t.name}`);
  }
});

test('unlinked: initialize advertises listChanged so the tools can appear mid-session', async () => {
  const { bridge, out } = loginBridge();
  await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.deepEqual(out[0].result.capabilities, { tools: { listChanged: true } });
});

test('the sign-in tool runs the login flow and announces the new tool list', async () => {
  let called = 0;
  const { bridge, out } = loginBridge({
    performLogin: async () => { called += 1; return { outcome: 'linked', key: 'a1b2c3d4', account: { name: 'Dev' }, storedIn: '/c/creds' }; },
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: LOGIN_TOOL.name } });

  assert.equal(called, 1);
  assert.equal(out[0].id, 7);
  assert.equal(out[0].result.isError, undefined);
  assert.match(out[0].result.content[0].text, /Signed in to Beezi as Dev/);
  assert.deepEqual(out[1], { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
});

test('a failed sign-in returns the authorize URL instead of stranding the user', async () => {
  const { bridge, out } = loginBridge({
    performLogin: async ({ onStep }) => {
      onStep({ type: 'authorize-url', url: 'https://auth.test/authorize?x=1' });
      throw new Error('timed out waiting for the callback');
    },
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: LOGIN_TOOL.name } });

  assert.equal(out[0].result.isError, true);
  assert.match(out[0].result.content[0].text, /timed out/);
  assert.match(out[0].result.content[0].text, /https:\/\/auth\.test\/authorize/);
});

// The bug this guards: the tool awaited the entire browser round-trip — up to the loopback's five
// minutes — before writing anything. To the client that is a call that never returns ("infinite
// loading"), and when the browser failed to open there was nothing on screen to act on either.
test('a sign-in slower than the grace period answers with the URL instead of spinning', async () => {
  let finish;
  const { bridge, out } = loginBridge({
    loginGraceMs: 20,
    performLogin: async ({ onStep }) => {
      onStep({ type: 'authorize-url', url: 'https://auth.test/authorize?x=1' });
      await new Promise((resolve) => { finish = resolve; });
      return { outcome: 'linked', key: 'a1b2c3d4', account: { name: 'Dev' }, storedIn: '/c' };
    },
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: LOGIN_TOOL.name } });

  assert.equal(out[0].id, 10, 'the request was answered');
  assert.equal(out[0].result.isError, undefined, 'a pending sign-in is not an error');
  assert.match(out[0].result.content[0].text, /https:\/\/auth\.test\/authorize/);
  assert.match(out[0].result.content[0].text, /beezi_status/);

  // The link still lands afterwards, and the client is told its tool list changed.
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(out.at(-1), { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
});

test('a browser that would not open is reported, not hidden behind a spinner', async () => {
  let finish;
  const { bridge, out } = loginBridge({
    loginGraceMs: 20,
    performLogin: async ({ onStep }) => {
      onStep({ type: 'authorize-url', url: 'https://auth.test/authorize?x=1' });
      onStep({ type: 'browser-failed', url: 'https://auth.test/authorize?x=1', detail: 'no http association' });
      await new Promise((resolve) => { finish = resolve; });
      return { outcome: 'linked', key: 'a1b2c3d4', account: null, storedIn: '/c' };
    },
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: LOGIN_TOOL.name } });

  const text = out[0].result.content[0].text;
  assert.match(text, /Could not open a browser automatically/);
  assert.match(text, /no http association/);
  assert.match(text, /https:\/\/auth\.test\/authorize/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
});

// A background sign-in that fails must not take the server down with an unhandled rejection: it
// lives for the whole session, and the user's next move is usually to retry.
test('a background sign-in that fails is logged, not fatal, and unblocks the next attempt', async () => {
  let fail;
  const { bridge, out, logged } = loginBridge({
    loginGraceMs: 20,
    performLogin: async ({ onStep }) => {
      onStep({ type: 'authorize-url', url: 'https://auth.test/a' });
      await new Promise((_, reject) => { fail = reject; });
    },
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: LOGIN_TOOL.name } });
  fail(new Error('callback timed out'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(logged.some((m) => /callback timed out/.test(m)), 'the failure is reported on stderr');
  assert.ok(out.every((m) => m.jsonrpc === '2.0'));

  // in-flight was cleared, so a retry starts a fresh flow rather than being refused
  const { bridge: b2, out: o2 } = loginBridge({
    performLogin: async () => ({ outcome: 'linked', key: 'a1b2c3d4', account: { name: 'Dev' }, storedIn: '/c' }),
  });
  await b2.handleMessage({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: LOGIN_TOOL.name } });
  assert.match(o2[0].result.content[0].text, /Signed in to Beezi as Dev/);
});

test('the sign-in tool never writes to stdout outside the JSON-RPC channel', async () => {
  const { bridge, out } = loginBridge({
    performLogin: async ({ onStep }) => {
      onStep({ type: 'authorize-url', url: 'https://auth.test/a' });
      return { outcome: 'linked', key: 'a1b2c3d4', account: null, storedIn: '/c' };
    },
  });
  await bridge.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: LOGIN_TOOL.name } });
  // Every emitted line parsed as JSON-RPC in `write` above; a stray print would have thrown there.
  assert.ok(out.every((m) => m.jsonrpc === '2.0'));
});

test('a linked machine keeps the local tools listed alongside the portal’s', async () => {
  const { bridge, calls, out } = bridgeWith({
    responses: [jsonRes({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'draft_ticket' }] } })],
  });
  await bridge.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

  assert.equal(calls.length, 1, 'the listing itself is proxied');
  assert.deepEqual(out[0].result.tools.map((t) => t.name), ['draft_ticket', ...LOCAL_TOOLS.map((t) => t.name)]);
});

// The defect this tool exists for: beezi_login reported "already linked" in the same minute a
// status script reported "not linked", because they ran in different processes with different
// environments. Status is now answered here, in the process that actually holds the link.
test('beezi_status reports the link, the API it checked, and the analytics half', async () => {
  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    // The hook-trust probe would spawn codex app-server; the hermetic gate forbids it.
    probeHookTrust: async () => ({ verdict: 'unknown', untrusted: [], disabled: [], reason: 'test' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => null),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    linkStatus: async () => ({
      state: 'linked',
      account: 'Dev',
      apiBase: 'http://localhost:5001/api',
      hooks: { state: 'absent', registered: [] },
    }),
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: STATUS_TOOL.name } });

  const text = out[0].result.content[0].text;
  assert.equal(out[0].result.isError, undefined);
  assert.match(text, /linked to Beezi as Dev/);
  // The API base is part of the answer: a mismatch between processes is the whole failure mode.
  assert.match(text, /localhost:5001/);
  // And it explains why analytics are empty instead of leaving the user to guess.
  assert.match(text, /NOT being reported/i);
  assert.match(text, /hooks are not installed/i);
});

// ── the bridge repairs the hooks nobody else can ────────────────────────────
//
// A stale hook entry points at the previous plugin version's script, so Codex's spawn fails and
// session-start.mjs never runs: the hooks cannot repair themselves. This process can — it is
// spawned every session, needs no trust, and is alive before any hook would have been.

test('a linked machine has its hooks repaired on the first message, once', async () => {
  const { bridge, heals } = bridgeWith({
    responses: [jsonRes(INIT_RESULT), jsonRes(CALL_RESULT)],
  });

  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);

  // Once per process: nothing about the registry changes mid-session, and a needless rewrite would
  // revoke the trust the user granted.
  assert.equal(heals.length, 1);
});

test('an unlinked machine gets no hook entries written on its behalf', async () => {
  const { bridge, heals } = bridgeWith({ token: null });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  assert.equal(heals.length, 0);
});

test('a repair the bridge performed is reported by beezi_status, with the trust step', async () => {
  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => 'tok'),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    probeHookTrust: async () => UNKNOWN_TRUST,
    ensureHooks: () => ({ repaired: true, before: 'stale', state: 'installed', swept: [{ event: 'Stop' }] }),
    linkStatus: async () => ({
      state: 'linked', account: 'Dev', apiBase: 'http://localhost:5001/api',
      hooks: { state: 'installed', registered: ['Stop'], broken: [] },
    }),
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: STATUS_TOOL.name } });

  const text = out[0].result.content[0].text;
  assert.match(text, /repaired the analytics hooks automatically/);
  assert.match(text, /1 dead entry from an older install was removed/);
  // The one half that cannot be automated is the one half the user is asked for.
  assert.match(text, /\/hooks/);
});

test('a hook repair that throws never reaches the client', async () => {
  const { bridge, out } = bridgeWith({
    responses: [jsonRes(INIT_RESULT)],
    ensureHooks: () => { throw new Error('registry is not writable'); },
  });

  await bridge.handleMessage(INIT);

  assert.equal(out.length, 1);
  assert.deepEqual(out[0], INIT_RESULT);
});

test('beezi_status answers on an unlinked machine too', async () => {
  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    // The hook-trust probe would spawn codex app-server; the hermetic gate forbids it.
    probeHookTrust: async () => ({ verdict: 'unknown', untrusted: [], disabled: [], reason: 'test' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => null),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test/api', hooks: { state: 'absent', registered: [] } }),
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: STATUS_TOOL.name } });
  assert.match(out[0].result.content[0].text, /not linked/i);
});

// JSON.parse('null') succeeds, so handleLine's guard lets non-objects through. These checks run
// before the token check, on the very path that exists to keep an unlinked server alive, so an
// unguarded deref would kill the bridge with an unhandled rejection.
test('a bare null or scalar line cannot take the bridge down', async () => {
  const { bridge, out } = bridgeWith({ token: null });
  await bridge.handleLine('null');
  await bridge.handleLine('7');
  await bridge.handleLine('"hello"');
  assert.equal(out.length, 0);
});

test('a second sign-in while one is in flight is refused, not run twice', async () => {
  let started = 0;
  let entered;
  let release;
  const enteredLogin = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });

  const { bridge, out } = loginBridge({
    performLogin: async () => {
      started += 1;
      entered();
      await gate;
      return { outcome: 'linked', key: 'a1b2c3d4', account: { name: 'Dev' }, storedIn: '/c' };
    },
  });

  const first = bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: LOGIN_TOOL.name } });
  await enteredLogin; // the flag is only set once the flow is actually running
  await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: LOGIN_TOOL.name } });

  // Two PKCE flows would register two OAuth clients, open two browsers, and race on the store.
  assert.equal(started, 1);
  assert.equal(out[0].id, 2);
  assert.equal(out[0].result.isError, true);
  assert.match(out[0].result.content[0].text, /already in progress/i);

  release();
  await first;
  assert.ok(out.some((m) => m.id === 1 && m.result?.isError === undefined), 'the first sign-in still answers');
});

// ── hook trust: the AGENTS.md reminder, and the verified "done" ──────────────────────────────
//
// An untrusted hook does not run and nothing reports it. The bridge is the one Beezi process that
// needs no trust, so it asks Codex (`hooks/list`, through lib/hook-trust.mjs) and moves
// ~/.codex/AGENTS.md to match (lib/agents-notice.mjs): block in while untrusted, out once trusted.
// AGENTS.md and not `initialize.instructions`, because only the former was MEASURED to reach the
// model. The handshake NEVER waits on the probe: a failed `initialize` takes the whole plugin down.

const UNTRUSTED = Object.freeze({ verdict: 'untrusted', untrusted: ['stop'], disabled: [], reason: 'ok' });
const TRUSTED = Object.freeze({ verdict: 'trusted', untrusted: [], disabled: [], reason: 'ok' });
const REPAIRED = { repaired: true, before: 'absent', state: 'installed', swept: [] };

// The probe settles off the message path; give its promise chain a turn to land.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('trust — an untrusted probe result puts the reminder into AGENTS.md', async () => {
  const { bridge, synced } = bridgeWith({ responses: [jsonRes(INIT_RESULT)], probe: async () => UNTRUSTED });
  await bridge.handleMessage(INIT);
  await settle();
  assert.deepEqual(synced, ['untrusted']);
});

test('trust — a trusted probe result takes it out again', async () => {
  const { bridge, synced } = bridgeWith({ responses: [jsonRes(INIT_RESULT)], probe: async () => TRUSTED });
  await bridge.handleMessage(INIT);
  await settle();
  assert.deepEqual(synced, ['trusted']);
});

test('trust — an unknown result leaves AGENTS.md alone', async () => {
  const { bridge, synced } = bridgeWith({ responses: [jsonRes(INIT_RESULT)] });
  await bridge.handleMessage(INIT);
  await settle();
  assert.deepEqual(synced, []);
});

test('trust — hooks the bridge just wrote are untrusted by definition, probe or not', async () => {
  const { bridge, synced } = bridgeWith({
    responses: [jsonRes(INIT_RESULT)], ensureHooks: () => REPAIRED, probe: () => new Promise(() => {}),
  });
  await bridge.handleMessage(INIT);
  assert.deepEqual(synced, ['untrusted']);
});

test('trust — a fresh trusted cache spawns no probe, and still clears a leftover block', async () => {
  const { bridge, probes, synced } = bridgeWith({ responses: [jsonRes(INIT_RESULT)], cached: () => TRUSTED });
  await bridge.handleMessage(INIT);
  await settle();
  assert.equal(probes.length, 0);
  assert.deepEqual(synced, ['trusted']);
});

test('trust — initialize goes out while the probe is still pending', async () => {
  const { bridge, out } = bridgeWith({ responses: [jsonRes(INIT_RESULT)], probe: () => new Promise(() => {}) });
  await bridge.handleMessage(INIT);
  assert.deepEqual(out[0], INIT_RESULT);
});

test('trust — the probe runs once per process, not once per message', async () => {
  const { bridge, probes } = bridgeWith({ responses: [jsonRes(INIT_RESULT), jsonRes(CALL_RESULT)] });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  assert.equal(probes.length, 1);
});

test('trust — an unlinked machine is never probed, and only ever has the block taken OUT', async () => {
  // Logged out of every account, or revoked: nothing reports, and beezi_status cannot re-check
  // trust there, so a block left in AGENTS.md could never be cleared by "done". Remove it, once.
  const { bridge, probes, synced } = bridgeWith({ token: null, cached: () => UNTRUSTED });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  await settle();
  assert.equal(probes.length, 0);
  assert.deepEqual(synced, ['removed']);
});

test('trust — a sync that throws never reaches the client', async () => {
  const out = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => 'tok'),
    fetchImpl: async () => jsonRes(INIT_RESULT),
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    ensureHooks: () => REPAIRED,
    probeHookTrust: async () => UNTRUSTED,
    syncTrustNotice: () => { throw new Error('disk full'); },
  });
  await bridge.handleMessage(INIT);
  await settle();
  assert.deepEqual(out, [INIT_RESULT]);
});

test('trust — beezi_status re-asks Codex every time and moves AGENTS.md with the answer', async () => {
  let answer = UNTRUSTED;
  const out = [];
  const probes = [];
  const synced = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => 'tok'),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    ensureHooks: () => NO_REPAIR,
    readCachedTrust: () => TRUSTED,
    probeHookTrust: async () => { probes.push(1); return answer; },
    syncTrustNotice: (trust) => { synced.push(trust.verdict); return { action: 'none' }; },
    linkStatus: async () => ({
      state: 'linked', account: 'Dev', apiBase: 'https://api.test/api',
      hooks: { state: 'installed', registered: ['Stop'], broken: [] },
    }),
  });
  const status = (id) => bridge.handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: STATUS_TOOL.name } });

  await status(7);
  assert.match(out[0].result.content[0].text, /Hook trust: untrusted \(stop\)/);
  assert.match(out[0].result.content[0].text, /NOT being reported/);

  // The user trusted them in /hooks and said "done": checked again, and the reminder comes out.
  answer = TRUSTED;
  await status(8);
  assert.match(out[1].result.content[0].text, /Hook trust: trusted/);
  // The cached TRUSTED clears on the first message; each status call then syncs its own answer.
  assert.deepEqual(synced, ['trusted', 'untrusted', 'trusted']);
  assert.equal(probes.length, 2);
});

test('trust — beezi_status does not probe a machine whose hooks are not installed', async () => {
  const out = [];
  const probes = [];
  const bridge = createBridge({ checkEnvironment: () => ({ status: 'ok' }),
    url: URL_UNDER_TEST,
    ...accountDeps(() => null),
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    probeHookTrust: async () => { probes.push(1); return UNTRUSTED; },
    syncTrustNotice: () => ({ action: 'none' }),
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test/api', hooks: { state: 'absent', registered: [] } }),
  });
  await bridge.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: STATUS_TOOL.name } });
  assert.equal(probes.length, 0);
  assert.doesNotMatch(out[0].result.content[0].text, /Hook trust:/);
});

test('trust — the status tool tells the model it reports hook trust', () => {
  assert.match(STATUS_TOOL.description, /trusted/);
});
