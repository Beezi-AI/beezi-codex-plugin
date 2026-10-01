import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccount, setDefault, listAccounts, writeIndex,
} from '../lib/accounts.mjs';
import { setCredentials, deleteCredentials } from '../lib/credentials.mjs';
import { createBridge, LOGIN_TOOL, STATUS_TOOL } from '../lib/mcp-bridge.mjs';
import {
  makeHome, fakeKeyring, fakeCredMan, credentialBlob,
} from '../tools/account-fixtures.mjs';

// Which ACCOUNT the MCP bridge talks to. Everything else about the bridge is covered by
// test/mcp-bridge.test.mjs, which injects the account resolution wholesale; this file drives the
// real lib/accounts.mjs + lib/credentials.mjs path, because the defect it exists for was that the
// bridge resolved no account at all.
//
// `checkEnvironment` is INJECTED for the reason test/account-surfaces.test.mjs states: the real
// guard reaches the credential store with the REAL runner, so against a fake keyring it cannot read
// the entry just written, classifies the root as unverifiable, and blocks every token with
// 'environment-blocked'. Every case below would then take the not-linked branch and prove nothing.

const KEY_A = 'a1b2c3d4';
const KEY_B = '99887766';
const URL_UNDER_TEST = 'https://api.test/api/mcp';
const SESSION_HEADER = 'mcp-session-id';
// The session the portal issues to each account, and its inverse — DECLARED, not derived from the
// id's shape. See assertPaired: a check that parsed the owner out of the id would answer "paired"
// for any id it did not recognise, which is a silent pass rather than a failure.
const SID = { [KEY_A]: `s-${KEY_A}`, [KEY_B]: `s-${KEY_B}` };
const ISSUED_TO = { [SID[KEY_A]]: KEY_A, [SID[KEY_B]]: KEY_B };

const NO_REPAIR = { repaired: false, before: 'installed', state: 'installed', swept: [] };

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const INIT_RESULT = { jsonrpc: '2.0', id: 0, result: { capabilities: {} } };
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_my_usage_summary' } };
const CALL_RESULT = { jsonrpc: '2.0', id: 1, result: { content: [] } };

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

async function two(t, ring = fakeKeyring(), platform = 'darwin') {
  makeHome(t);
  const deps = { run: ring.run, platform, checkEnvironment: () => ({ status: 'ok' }) };
  for (const key of [KEY_A, KEY_B]) {
    await setCredentials(key, credentialBlob({ client_id: `c-${key}`, access_token: `at-${key}` }), deps);
    await addAccount({
      key, email: `${key}@example.com`, name: key,
      tenantId: `t-${key}`, tenantName: `W-${key}`, clientId: `c-${key}`,
    });
  }
  return { deps, ring };
}

function bridgeFor(deps, responses = []) {
  return routedBridge(deps, async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

// The same harness with the response chosen per REQUEST rather than by position — the two cases
// below interleave two accounts' requests, and a shift()-ordered queue cannot express that.
function routedBridge(deps, route) {
  const calls = [];
  const out = [];
  const bridge = createBridge({
    ...deps,
    url: URL_UNDER_TEST,
    ensureHooks: () => NO_REPAIR,
    fetchImpl: async (url, init) => {
      const call = { headers: init.headers, body: JSON.parse(init.body) };
      calls.push(call);
      return route(call, calls);
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
  });
  return { bridge, calls, out };
}

const initializes = (calls) => calls.filter((c) => c.body.method === 'initialize');

/**
 * THE PAIR, on every request that carried one — not the bearer alone.
 *
 * An upstream session id is only meaningful together with the bearer it was issued to. Checking one
 * half is exactly how the first version of case 8 passed while a foreign pairing happened inside
 * it: it asserted the three `initialize` bearers and never looked at the `mcp-session-id` on the
 * posts that followed.
 *
 * Owners come from ISSUED_TO, a declared map. The first version read the key out of the id with
 * `sid.slice(2)`, which couples the assertion to the fixture's naming: a case that named a session
 * anything else would have been compared against a bearer nobody holds, matched nothing, and
 * PASSED without checking a thing. An id this file did not issue now fails loudly instead.
 */
function assertPaired(calls) {
  const foreign = calls
    .filter((c) => {
      const sid = c.headers[SESSION_HEADER];
      if (sid === undefined) return false;
      const owner = ISSUED_TO[sid];
      assert.ok(owner !== undefined, `a session id this file never issued reached the wire: ${sid}`);
      return c.headers.Authorization !== `Bearer at-${owner}`;
    })
    .map((c) => `${c.body.method} auth=${c.headers.Authorization} sid=${c.headers[SESSION_HEADER]}`);
  assert.deepEqual(foreign, [], 'a request carried a session id issued to a different account');
}

// The bearer and the client id are ONE credential from the server's point of view, so they are
// asserted together: a bridge that read the right token and the wrong client id would bind another
// account's machine row, and a bridge that read neither would post as nobody.
test('1. the bridge posts with the default account’s own bearer and client id', async (t) => {
  const { deps } = await two(t);
  const { bridge, calls, out } = bridgeFor(deps, [jsonRes(CALL_RESULT), jsonRes(CALL_RESULT)]);

  await bridge.handleMessage(CALL);
  await setDefault(KEY_B);
  await bridge.handleMessage(CALL);

  assert.deepEqual(calls.map((c) => c.headers.Authorization), [`Bearer at-${KEY_A}`, `Bearer at-${KEY_B}`]);
  assert.deepEqual(calls.map((c) => c.headers['X-Beezi-Client']), [`c-${KEY_A}`, `c-${KEY_B}`]);
  assert.deepEqual(out, [CALL_RESULT, CALL_RESULT]);
});

// A stale upstream session id paired with a foreign bearer 401s, and that 401 would wrongly tell
// the user to log in again.
test('2. switching the default drops the upstream session id instead of pairing it with the new bearer', async (t) => {
  const { deps } = await two(t);
  const { bridge, calls } = bridgeFor(deps, [
    sseRes([INIT_RESULT], { headers: { [SESSION_HEADER]: SID[KEY_A] } }),
    jsonRes(CALL_RESULT),
    sseRes([INIT_RESULT], { headers: { [SESSION_HEADER]: SID[KEY_B] } }),
    new Response(null, { status: 202 }),
    jsonRes(CALL_RESULT),
  ]);

  await bridge.handleMessage(INIT);
  assert.deepEqual(bridge.state(), { accountKey: KEY_A, sessionId: SID[KEY_A] });
  await bridge.handleMessage(CALL);
  assert.equal(calls[1].headers[SESSION_HEADER], SID[KEY_A]);

  await setDefault(KEY_B);
  await bridge.handleMessage(CALL);

  // The client's own handshake is replayed under the new bearer, with NO session id on it.
  assert.equal(calls[2].body.method, 'initialize');
  assert.equal(calls[2].headers[SESSION_HEADER], undefined);
  assert.equal(calls[2].headers.Authorization, `Bearer at-${KEY_B}`);
  assert.equal(calls[3].body.method, 'notifications/initialized');
  // ...and the retried request carries the session the NEW account was given.
  assert.equal(calls[4].headers[SESSION_HEADER], SID[KEY_B]);
  assert.deepEqual(bridge.state(), { accountKey: KEY_B, sessionId: SID[KEY_B] });
  assertPaired(calls);
});

// Reachable by logging out the default while two accounts are left (test/account-surfaces.test.mjs
// case 19). "Not linked" would be false about this machine — two accounts are — and it would send
// the model to a sign-in that does not set a default.
test('3. accounts linked with no default is refused by naming the accounts skill, not the sign-in tool', async (t) => {
  const { deps } = await two(t);
  writeIndex({ version: 1, default: null, accounts: await listAccounts() });
  const { bridge, calls, out } = bridgeFor(deps);

  await bridge.handleMessage(CALL);

  assert.equal(calls.length, 0, 'nothing is posted without an account to post as');
  assert.match(out[0].error.message, /none is set as the one the analytics tools read from/);
  assert.match(out[0].error.message, /accounts skill/);
  // A sign-in links ANOTHER account (or re-arms one of these); it is not how you choose among the
  // accounts already here, which is the whole of what is wrong in this state.
  assert.ok(!out[0].error.message.includes(LOGIN_TOOL.name), 'signing in does not pick among linked accounts');
});

test('4. a machine with no accounts at all still points at the sign-in tool', async (t) => {
  makeHome(t);
  const { bridge, calls, out } = bridgeFor({ run: fakeKeyring().run, platform: 'darwin', checkEnvironment: () => ({ status: 'ok' }) });

  await bridge.handleMessage(CALL);

  assert.equal(calls.length, 0);
  assert.match(out[0].error.message, /not linked/i);
  assert.match(out[0].error.message, new RegExp(LOGIN_TOOL.name));
});

// The default row is there and its credentials are not. "This machine is not linked" is false of a
// machine with two linked accounts, so the refusal says what actually happened instead.
test('5. a default whose credentials cannot be read is not reported as an unlinked machine', async (t) => {
  const { deps } = await two(t);
  await deleteCredentials(KEY_A, deps);
  const { bridge, calls, out } = bridgeFor(deps);

  await bridge.handleMessage(CALL);

  assert.equal(calls.length, 0);
  assert.match(out[0].error.message, /could not use the saved credentials/);
  assert.ok(!out[0].error.message.includes('This machine is not linked to Beezi'));
});

// ── the pairing under concurrency ─────────────────────────────────────────────────────────────
//
// scripts/mcp.mjs starts each line's handling without awaiting the previous, so a default switch
// can land between a request going out and its response coming back. These two drive exactly that.

test('7. a response that lands after the default moved does not publish its session id', async (t) => {
  const { deps } = await two(t);
  let releaseA = null;
  const heldA = new Promise((resolve) => { releaseA = resolve; });
  const { bridge, calls } = routedBridge(deps, async (call) => {
    if (call.headers.Authorization === `Bearer at-${KEY_A}`) {
      await heldA;
      return jsonRes(CALL_RESULT, { headers: { [SESSION_HEADER]: SID[KEY_A] } });
    }
    return jsonRes(CALL_RESULT, { headers: { [SESSION_HEADER]: SID[KEY_B] } });
  });

  const first = bridge.handleMessage(CALL);          // as A, held open at the fetch
  await setDefault(KEY_B);
  await bridge.handleMessage(CALL);                  // as B, completes first
  assert.deepEqual(bridge.state(), { accountKey: KEY_B, sessionId: SID[KEY_B] });

  releaseA();
  await first;
  // A's response carries a perfectly good session id — for A. Writing it here would hand the very
  // next request B's bearer paired with A's session.
  assert.deepEqual(bridge.state(), { accountKey: KEY_B, sessionId: SID[KEY_B] });

  await bridge.handleMessage(CALL);
  assert.equal(calls[calls.length - 1].headers[SESSION_HEADER], SID[KEY_B]);
  assert.equal(calls[calls.length - 1].headers.Authorization, `Bearer at-${KEY_B}`);
  assertPaired(calls);
});

test('8. a re-initialize in flight for one account is not handed to a request forwarding as another', async (t) => {
  const { deps } = await two(t);
  let releaseB = null;
  const heldB = new Promise((resolve) => { releaseB = resolve; });
  const { bridge, calls } = routedBridge(deps, async (call) => {
    const forB = call.headers.Authorization === `Bearer at-${KEY_B}`;
    if (call.body.method === 'initialize') {
      // B's replayed handshake is held open. A's must not wait on it — nor inherit its session.
      if (forB && initializes(calls).length > 1) await heldB;
      return sseRes([INIT_RESULT], { headers: { [SESSION_HEADER]: SID[forB ? KEY_B : KEY_A] } });
    }
    if (call.body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return jsonRes(CALL_RESULT);
  });

  // The client's own handshake, as A.
  await bridge.handleMessage(INIT);
  assert.equal(bridge.state().accountKey, KEY_A);

  // Switch to B and start a request: the key change drops the handshake, so this re-initializes.
  await setDefault(KEY_B);
  const onB = bridge.handleMessage(CALL);
  // Switch back to A and let a request in while B's handshake is still open.
  await setDefault(KEY_A);
  const onA = bridge.handleMessage(CALL);

  releaseB();
  await Promise.all([onB, onA]);

  // Three initializes: the client's own as A, then one per account's own re-initialize. A shared
  // promise would have produced two, with A proceeding on the handshake B performed.
  const bearers = initializes(calls).map((c) => c.headers.Authorization);
  assert.equal(bearers.length, 3, `each account handshakes for itself: ${JSON.stringify(bearers)}`);
  assert.deepEqual(bearers, [`Bearer at-${KEY_A}`, `Bearer at-${KEY_B}`, `Bearer at-${KEY_A}`]);
  // THE HALF THIS CASE USED TO MISS. Keying `reinit` stops one account INHERITING another's
  // handshake, but every post between the key check and the request still reads the ambient
  // session id — so this exact interleaving was sending `notifications/initialized` and the
  // `tools/call` that follows with B's bearer and A's session. The bearers were right and the pair
  // was not, and the assertion above could not see it.
  assertPaired(calls);
});

// The 404 path reaches it too, and this is the ordinary one: a portal restart loses its in-memory
// sessions, which lib/mcp-bridge.mjs calls routine and recovers transparently. The recovery has its
// own awaits, so a default switch landing inside one leaves the ORIGINAL account's re-initialize
// and retry reading an ambient session id that now belongs to somebody else.
test('9. a re-initialize provoked by a 404 does not pick up a session issued after it started', async (t) => {
  const { deps } = await two(t);
  let releaseA = null;
  const heldA = new Promise((resolve) => { releaseA = resolve; });
  let restarted = false;
  const { bridge, calls } = routedBridge(deps, async (call) => {
    const key = call.headers.Authorization === `Bearer at-${KEY_B}` ? KEY_B : KEY_A;
    if (call.body.method === 'initialize') {
      // A's RE-initialize (its second handshake) is held open across the switch below.
      if (key === KEY_A && initializes(calls).length > 1) await heldA;
      return sseRes([INIT_RESULT], { headers: { [SESSION_HEADER]: SID[key] } });
    }
    if (call.body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    // The portal restarted once: the first forwarded call, A's, finds its session gone.
    if (!restarted && key === KEY_A) {
      restarted = true;
      return jsonRes({ jsonrpc: '2.0', error: { code: -32004, message: 'session not found' }, id: null }, { status: 404 });
    }
    return jsonRes(CALL_RESULT);
  });

  await bridge.handleMessage(INIT);                  // handshake as A
  const onA = bridge.handleMessage(CALL);            // 404s, then blocks in its own re-initialize
  await setDefault(KEY_B);
  await bridge.handleMessage(CALL);                  // as B: handshakes and completes

  releaseA();
  await onA;

  assertPaired(calls);
});

// ── what beezi_status says about the MACHINE ─────────────────────────────────────────────────
//
// A UNIT TEST CANNOT REACH THIS, which is why Task 11's end-to-end pass found it and the suite did
// not: every existing beezi_status case injects `linkStatus` wholesale, so the defect — which STATE
// the bridge reports for a real index — was stubbed out of existence. These drive the real
// lib/link-status.mjs over a real accounts index, with only the credential store and the whoami
// round-trip faked.
function statusBridge(deps, over = {}) {
  const out = [];
  const bridge = createBridge({
    ...deps,
    url: URL_UNDER_TEST,
    ensureHooks: () => NO_REPAIR,
    hooksStatus: () => ({ state: 'installed', registered: ['Stop'], broken: [] }),
    whoami: async (session) => ({
      valid: true, name: 'Dev', email: `${session.clientId}@example.com`, tenantName: 'Acme',
      tenantTier: 'pro', trackingMode: 'live', backfillCompleted: true,
    }),
    apiBase: 'https://api.test/api',
    fetchImpl: async () => { throw new Error('beezi_status must not reach the network itself'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    ...over,
  });
  const ask = async () => {
    await bridge.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: STATUS_TOOL.name } });
    return out[out.length - 1].result.content[0].text;
  };
  return { bridge, ask };
}

// THE DEFECT. The top-level fields of a linkStatus answer describe the DEFAULT account, so a dead
// default answered "not linked" and "NOT being reported" for a machine that is linked and is
// reporting — and told the user to link a third account.
test('10. a dead default with a healthy sibling is not reported as an unlinked machine', async (t) => {
  const { deps } = await two(t);
  await deleteCredentials(KEY_A, deps);   // KEY_A is the default; its credentials are gone
  const { ask } = statusBridge(deps);

  const text = await ask();

  assert.doesNotMatch(text, /not linked to Beezi/, 'two accounts are linked here');
  assert.doesNotMatch(text, /Analytics are NOT being reported/, 'the healthy account is reporting');
  assert.match(text, /This machine is linked to Beezi/);
  assert.match(text, /1 of 2 linked Beezi accounts can report/);
  assert.match(text, /cannot report just now/);
  assert.match(text, /accounts skill/, 'the remedy is choosing another account, not linking a third');
});

// The lift must not invent a link. With nothing in the index there is no account to raise from.
test('11. a machine with no accounts is still reported as not linked', async (t) => {
  makeHome(t);
  const { ask } = statusBridge({ run: fakeKeyring().run, platform: 'darwin', checkEnvironment: () => ({ status: 'ok' }) });

  const text = await ask();

  assert.match(text, /not linked to Beezi/);
  assert.doesNotMatch(text, /linked Beezi accounts can report/, 'there is no discrepancy to explain');
});

// Neither may it fire when the default is healthy — that answer was already correct, and a note
// about an account that cannot report would be false.
test('12. a healthy default reports no discrepancy', async (t) => {
  const { deps } = await two(t);
  const { ask } = statusBridge(deps);

  const text = await ask();

  assert.match(text, /This machine is linked to Beezi/);
  assert.doesNotMatch(text, /cannot report just now/);
  assert.doesNotMatch(text, /linked Beezi accounts can report/);
});

// The Windows credential store is keyed by TARGET NAME ALONE — the keyspace a (service, account)
// fake cannot model, and the one that hid a defect in Task 3. A bridge that reached for an un-keyed
// credential would hand both accounts the same bearer here and pass every darwin case above.
test('6. on Windows the bridge reads each default account’s own credential target', async (t) => {
  const ring = fakeCredMan();
  const { deps } = await two(t, ring, 'win32');
  assert.equal(ring.store.size, 2, 'the fixture wrote one target per account');
  const { bridge, calls } = bridgeFor(deps, [jsonRes(CALL_RESULT), jsonRes(CALL_RESULT)]);

  await bridge.handleMessage(CALL);
  await setDefault(KEY_B);
  await bridge.handleMessage(CALL);

  assert.deepEqual(calls.map((c) => c.headers.Authorization), [`Bearer at-${KEY_A}`, `Bearer at-${KEY_B}`]);
  assert.deepEqual(calls.map((c) => c.headers['X-Beezi-Client']), [`c-${KEY_A}`, `c-${KEY_B}`]);
});
