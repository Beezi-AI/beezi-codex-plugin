import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  readAccountViaAppServer,
  mergeAccounts,
  APP_SERVER_REASON,
} from '../lib/codex-app-server.mjs';

// A stand-in for the `codex app-server` child process. NOTHING in this file spawns a real one:
// tools/hermetic-env.mjs records every subprocess as an escape, and a real `codex` would read the
// developer's own ~/.codex — the exact leak the hermetic gate exists to catch.
//
// `respond` is the scripted server: it receives each parsed request the client writes and returns
// an array of raw lines to emit back (which may be notifications, partial chunks, or nothing).
function fakeSpawn(respond, options = {}) {
  const calls = [];
  const spawn = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.stdinEnded = false;
    child.written = [];
    child.stdin = {
      write(chunk) {
        child.written.push(chunk);
        const lines = String(chunk).split('\n').filter((l) => l.trim() !== '');
        for (const line of lines) {
          let message = null;
          try { message = JSON.parse(line); } catch { message = null; }
          if (!message) continue;
          const out = respond(message, child);
          if (!out) continue;
          for (const raw of out) {
            setImmediate(() => child.stdout.emit('data', Buffer.from(raw)));
          }
        }
        return true;
      },
      end() { child.stdinEnded = true; },
      on(event) { (child.stdinListeners[event] = child.stdinListeners[event] || []).push(event); },
    };
    child.stdinListeners = {};
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options: spawnOptions, child });
    if (options.failWith) {
      setImmediate(() => child.emit('error', options.failWith));
    }
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const INIT_RESULT = {
  userAgent: 'beezi/0.0.0',
  codexHome: '/fake/.codex',
  platformFamily: 'linux',
  platformOs: 'linux',
};

// The shape measured against codex-cli 0.154.0 on 2026-09-14. `account/read` carries NO accountId —
// only `account/rateLimits/read` does, which is why both calls are made rather than one.
function scriptedServer({ account, rateLimits, accountError, rateLimitsError } = {}) {
  return (message) => {
    if (message.method === 'initialize') {
      return [JSON.stringify({ id: message.id, result: INIT_RESULT }) + '\n'];
    }
    if (message.method === 'account/read') {
      if (accountError) return [JSON.stringify({ id: message.id, error: accountError }) + '\n'];
      return [JSON.stringify({
        id: message.id,
        result: { account: account === undefined ? null : account, requiresOpenaiAuth: true },
      }) + '\n'];
    }
    if (message.method === 'account/rateLimits/read') {
      if (rateLimitsError) return [JSON.stringify({ id: message.id, error: rateLimitsError }) + '\n'];
      return [JSON.stringify({ id: message.id, result: rateLimits || {} }) + '\n'];
    }
    return null;
  };
}

const CHATGPT_ACCOUNT = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' };
const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  accountId: 'eb76c91d-9f94-4807-99aa-ed350b779ecd',
  rateLimits: { planType: 'plus', primary: { usedPercent: 57, windowDurationMins: 300 } },
};

function run(spawn, env = {}, extra = {}) {
  return readAccountViaAppServer({ env, timeoutMs: 200, spawn, ...extra });
}

test('reads the plan from account/read and the account id from account/rateLimits/read', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  const result = await run(spawn);
  assert.equal(result.ok, true);
  assert.equal(result.reason, APP_SERVER_REASON.OK);
  assert.equal(result.authType, 'chatgpt');
  assert.equal(result.plan, 'plus');
  assert.equal(result.subscriptionType, 'plus');
  assert.equal(result.email, 'user@example.com');
  assert.equal(result.accountId, 'eb76c91d-9f94-4807-99aa-ed350b779ecd');
});

test('sends initialize, then the initialized notification, then both account calls', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn);
  const sent = spawn.calls[0].child.written
    .join('')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  assert.deepEqual(sent.map((m) => m.method), [
    'initialize', 'initialized', 'account/read', 'account/rateLimits/read',
  ]);
  // The notification carries no id; every request does, and they must be distinct or the reader
  // cannot tell the two answers apart.
  assert.equal(sent[1].id, undefined);
  const ids = sent.filter((m) => m.id !== undefined).map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(sent[2].params.refreshToken, false);
});

test('closes stdin and kills the child once both answers are in', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn);
  assert.equal(spawn.calls[0].child.stdinEnded, true);
  assert.equal(spawn.calls[0].child.killed, true);
});

test('ignores notifications interleaved with the responses', async () => {
  const noisy = (message) => {
    const base = scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS })(message);
    const notification = JSON.stringify({
      method: 'remoteControl/status/changed',
      params: { status: 'disabled' },
      emittedAtMs: 1,
    }) + '\n';
    return base ? [notification].concat(base) : null;
  };
  const result = await run(fakeSpawn(noisy));
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'plus');
});

test('reassembles a response split across chunks and several packed into one', async () => {
  const respond = (message) => {
    if (message.method === 'initialize') {
      const line = JSON.stringify({ id: message.id, result: INIT_RESULT }) + '\n';
      // Split mid-object: a line boundary is the only framing, so a partial chunk must be held.
      return [line.slice(0, 12), line.slice(12)];
    }
    if (message.method === 'account/rateLimits/read') {
      // Packed: the rate-limit answer arrives glued to a notification in one chunk.
      return [
        JSON.stringify({ method: 'thread/event', params: {} }) + '\n'
        + JSON.stringify({ id: message.id, result: RATE_LIMITS }) + '\n',
      ];
    }
    return scriptedServer({ account: CHATGPT_ACCOUNT })(message);
  };
  const result = await run(fakeSpawn(respond));
  assert.equal(result.ok, true);
  assert.equal(result.accountId, RATE_LIMITS.accountId);
});

test('an unparseable line does not abort the read', async () => {
  const respond = (message) => {
    const base = scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS })(message);
    return base ? ['<not json at all>\n'].concat(base) : null;
  };
  const result = await run(fakeSpawn(respond));
  assert.equal(result.ok, true);
});

test('maps the Codex plan vocabulary through the shared alias table', async () => {
  const account = { type: 'chatgpt', email: 'p@example.com', planType: 'prolite' };
  const result = await run(fakeSpawn(scriptedServer({ account, rateLimits: RATE_LIMITS })));
  assert.equal(result.plan, 'pro_5x');
  assert.equal(result.subscriptionType, 'pro_5x');
});

test('an unrecognised plan is unknown with a null subscriptionType, never free', async () => {
  const account = { type: 'chatgpt', email: 'p@example.com', planType: 'mystery_tier' };
  const result = await run(fakeSpawn(scriptedServer({ account, rateLimits: RATE_LIMITS })));
  assert.equal(result.plan, 'unknown');
  assert.equal(result.subscriptionType, null);
});

test('a missing planType is unknown, never free', async () => {
  const account = { type: 'chatgpt', email: 'p@example.com' };
  const result = await run(fakeSpawn(scriptedServer({ account, rateLimits: RATE_LIMITS })));
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'unknown');
  assert.equal(result.subscriptionType, null);
});

test('an api-key account reports its auth type and carries no plan', async () => {
  const account = { type: 'apiKey' };
  const result = await run(fakeSpawn(scriptedServer({ account, rateLimits: RATE_LIMITS })));
  assert.equal(result.ok, true);
  assert.equal(result.authType, 'apikey');
  assert.equal(result.plan, null);
  assert.equal(result.subscriptionType, null);
});

test('no signed-in account is no-credentials, not an error', async () => {
  const result = await run(fakeSpawn(scriptedServer({ account: null })));
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.NO_CREDENTIALS);
  assert.equal(result.plan, null);
});

test('a JSON-RPC error on account/read fails the read', async () => {
  const spawn = fakeSpawn(scriptedServer({ accountError: { code: -32601, message: 'nope' } }));
  const result = await run(spawn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.ERROR);
  assert.equal(spawn.calls[0].child.killed, true);
});

test('a failed rate-limit call still yields the plan, with a null account id', async () => {
  const spawn = fakeSpawn(scriptedServer({
    account: CHATGPT_ACCOUNT,
    rateLimitsError: { code: -32603, message: 'unavailable' },
  }));
  const result = await run(spawn);
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'plus');
  assert.equal(result.accountId, null);
});

test('a missing codex binary is unavailable, not a throw', async () => {
  const error = new Error('spawn codex ENOENT');
  error.code = 'ENOENT';
  const spawn = fakeSpawn(() => null, { failWith: error });
  const result = await run(spawn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.UNAVAILABLE);
});

test('a child that never answers times out and is killed', async () => {
  const spawn = fakeSpawn(() => null);
  const result = await run(spawn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.TIMEOUT);
  assert.equal(spawn.calls[0].child.killed, true);
});

test('a child that exits before answering fails rather than hanging', async () => {
  const spawn = fakeSpawn((message, child) => {
    if (message.method === 'initialize') setImmediate(() => child.emit('close', 1, null));
    return null;
  });
  const result = await run(spawn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.UNAVAILABLE);
});

test('BEEZI_CODEX_APP_SERVER=0 disables the probe without spawning anything', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT }));
  const result = await run(spawn, { BEEZI_CODEX_APP_SERVER: '0' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.DISABLED);
  assert.equal(spawn.calls.length, 0);
});

// On Windows the launch goes through cmd.exe — MEASURED: `codex` is an npm .cmd shim, so a bare
// spawn is ENOENT and spawning the .cmd directly is EINVAL. cmd.exe is named explicitly rather than
// reached through `shell: true`, which spawns the same thing but prints Node's DEP0190 warning to
// the hook's stderr.
const onWindows = process.platform === 'win32';

test('BEEZI_CODEX_CLI overrides which binary is launched', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn, { BEEZI_CODEX_CLI: '/opt/codex/bin/codex' });
  const { command, args, options } = spawn.calls[0];
  if (onWindows) {
    assert.match(String(command), /cmd\.exe$/i);
    assert.deepEqual(args, ['/d', '/s', '/c', '"/opt/codex/bin/codex app-server"']);
    assert.equal(options.windowsVerbatimArguments, true);
  } else {
    assert.equal(command, '/opt/codex/bin/codex');
    assert.deepEqual(args, ['app-server']);
  }
});

// THE EXACT BYTES, because a shape that looks right is not a shape cmd.exe accepts. Measured
// against the real npm shim, launching from a directory whose name contains a space:
//   /c <path> app-server              → works until the path holds a space
//   /c "<path>" app-server            → FAILS, "The filename, directory name, or volume label
//                                       syntax is incorrect" — Node escapes the quotes to \" first
//   /c ""<path>" app-server" + verbatim → works
// An earlier version of this test asserted the middle form and passed while the feature was broken.
test('a binary path containing a space gets the outer-quoted verbatim form cmd.exe accepts', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn, { BEEZI_CODEX_CLI: 'C:/Program Files/codex/codex.cmd' });
  const { command, args, options } = spawn.calls[0];
  if (onWindows) {
    assert.deepEqual(args, ['/d', '/s', '/c', '""C:/Program Files/codex/codex.cmd" app-server"']);
    assert.equal(options.windowsVerbatimArguments, true, 'without this Node escapes the quotes');
  } else {
    assert.equal(command, 'C:/Program Files/codex/codex.cmd');
    assert.deepEqual(args, ['app-server']);
  }
});

test('no shell option is set — DEP0190 is why cmd.exe is named explicitly', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn);
  assert.equal(spawn.calls[0].options.shell, undefined);
  // The default `codex` on PATH takes the same outer-quoted form; one code path, not two.
  if (onWindows) {
    assert.deepEqual(spawn.calls[0].args, ['/d', '/s', '/c', '"codex app-server"']);
  }
});

test('the child inherits the environment it was handed, CODEX_HOME included', async () => {
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn, { CODEX_HOME: '/sandbox/.codex' });
  assert.equal(spawn.calls[0].options.env.CODEX_HOME, '/sandbox/.codex');
});

test('runaway output is cut off rather than buffered without bound', async () => {
  const spawn = fakeSpawn((message) => {
    if (message.method === 'initialize') return ['x'.repeat(2 * 1024 * 1024)];
    return null;
  });
  const result = await run(spawn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, APP_SERVER_REASON.ERROR);
  assert.equal(spawn.calls[0].child.killed, true);
});

// ── mergeAccounts ────────────────────────────────────────────────────────────────────────────
// The live app-server answer and the auth.json decode answer overlapping questions. The merge is
// where the three-tier ladder actually resolves, so it is tested apart from the transport.

const FILE_ACCOUNT = {
  authMode: 'chatgpt',
  hasStoredApiKey: false,
  subscriptionType: 'free',
  plan: 'free',
  expiresAt: 1000,
  accountId: 'from-auth-json',
  email: 'stale@example.com',
};

test('mergeAccounts — a live app-server answer outranks the auth.json decode', () => {
  const live = {
    ok: true, authType: 'chatgpt', plan: 'plus', subscriptionType: 'plus',
    accountId: 'live-uuid', email: 'live@example.com',
  };
  const merged = mergeAccounts(live, FILE_ACCOUNT);
  assert.equal(merged.plan, 'plus');
  assert.equal(merged.subscriptionType, 'plus');
  assert.equal(merged.accountId, 'live-uuid');
  assert.equal(merged.email, 'live@example.com');
  assert.equal(merged.live, true);
  // A live lookup cannot be stale, so it must carry no expiry for the expired-claim rule to act on.
  assert.equal(merged.expiresAt, null);
});

test('the merged account keeps the auth.json billing signals', () => {
  const live = { ok: true, authType: 'chatgpt', plan: 'plus', subscriptionType: 'plus', accountId: null, email: null };
  const merged = mergeAccounts(live, { ...FILE_ACCOUNT, hasStoredApiKey: true });
  assert.equal(merged.authMode, 'chatgpt');
  assert.equal(merged.hasStoredApiKey, true);
});

test('with no auth.json at all the signals come from the app-server auth type', () => {
  const live = { ok: true, authType: 'chatgpt', plan: 'pro_20x', subscriptionType: 'pro_20x', accountId: 'u', email: null };
  const merged = mergeAccounts(live, null);
  assert.equal(merged.authMode, 'chatgpt');
  assert.equal(merged.hasStoredApiKey, false);
  assert.equal(merged.plan, 'pro_20x');
});

test('an api-key machine merges to an apikey auth mode', () => {
  const live = { ok: true, authType: 'apikey', plan: null, subscriptionType: null, accountId: null, email: null };
  const merged = mergeAccounts(live, null);
  assert.equal(merged.authMode, 'apikey');
  assert.equal(merged.hasStoredApiKey, true);
});

test('a failed probe falls back to the auth.json decode, marked not live', () => {
  const merged = mergeAccounts({ ok: false, reason: 'timeout' }, FILE_ACCOUNT);
  assert.equal(merged.plan, 'free');
  assert.equal(merged.accountId, 'from-auth-json');
  assert.equal(merged.expiresAt, 1000);
  assert.equal(merged.live, false);
});

test('a live answer that names no account id keeps the one auth.json knows', () => {
  const live = { ok: true, authType: 'chatgpt', plan: 'plus', subscriptionType: 'plus', accountId: null, email: null };
  const merged = mergeAccounts(live, FILE_ACCOUNT);
  assert.equal(merged.accountId, 'from-auth-json');
  assert.equal(merged.email, 'stale@example.com');
});

test('nothing known at all merges to null', () => {
  assert.equal(mergeAccounts({ ok: false, reason: 'unavailable' }, null), null);
});

test('an EPIPE on the child stdin is handled, not thrown at the hook', async () => {
  // A child that exits mid-request makes its stdin emit 'error' asynchronously. An unhandled
  // 'error' on a stream THROWS, which inside the SessionStart hook is a dead hook rather than a
  // failed probe — so the listener has to be attached, not assumed away.
  const spawn = fakeSpawn(scriptedServer({ account: CHATGPT_ACCOUNT, rateLimits: RATE_LIMITS }));
  await run(spawn);
  assert.ok(spawn.calls[0].child.stdinListeners.error, 'nothing is listening for stdin EPIPE');
});

test('the live auth type outranks the one auth.json recorded', () => {
  // The machine moved to an API key; auth.json still carries the old ChatGPT sign-in. Letting the
  // file win here reports `chatgpt` with no plan behind it — which the capture reads as
  // "no account", writes nothing, and nudges about forever.
  const live = { ok: true, authType: 'apikey', plan: null, subscriptionType: null, accountId: null, email: null };
  const merged = mergeAccounts(live, { ...FILE_ACCOUNT, authMode: 'chatgpt' });
  assert.equal(merged.authMode, 'apikey');
});

test('auth.json still answers the auth type when the live reading did not name one', () => {
  const live = { ok: true, authType: null, plan: 'plus', subscriptionType: 'plus', accountId: 'u', email: null };
  assert.equal(mergeAccounts(live, FILE_ACCOUNT).authMode, 'chatgpt');
});
