import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SOURCES,
  MAX_PENDING,
  MAX_EVENT_AGE_MS,
  CONSENT_VERSION,
  recordIssue,
  flushDiagnostics,
  diagnosticsSession,
  isPostableEvent,
  isTelemetryGranted,
  hasBeenAsked,
  markAsked,
  grantConsent,
  denyConsent,
  discardPendingDiagnostics,
  readConsent,
  setCurrentSource,
  getCurrentSource,
  siteFrom,
  diagnosticsDir,
  diagnosticsConsentFile,
} from '../lib/diagnostics.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The event store and the consent record stay MACHINE-level — a crash is a fact about this
// install, not about a tenant — but the batch still travels as ONE account's session, because a
// bearer without its client id names no machine row (lib/http.mjs sessionOf).
const SESSION = accountSession(TEST_KEY, 'tok');


// plugins/beezi — the same root lib/diagnostics.mjs computes for its containment check.
const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// Every test gets its own data root. Nothing here may read the developer's real home.
function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-diagnostics-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  setCurrentSource(DIAGNOSTIC_SOURCES.UNKNOWN);
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function events() {
  try {
    return fs.readdirSync(diagnosticsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function readEvent(name) {
  return JSON.parse(fs.readFileSync(path.join(diagnosticsDir(), name), 'utf-8'));
}

// Records the calls and replies with a queued status. No test may make a real network call, so this
// is the only thing flushDiagnostics is ever allowed to reach.
function fakePost(statuses) {
  const calls = [];
  let i = 0;
  // `session`, not a bare token: the flush posts as one account, bearer and client id together.
  const impl = async (endpoint, session, body, deps) => {
    calls.push({ url: endpoint, session, token: session && session.token, body, deps });
    const status = Array.isArray(statuses) ? statuses[Math.min(i, statuses.length - 1)] : statuses;
    i += 1;
    if (status === 'throw') throw new TypeError('fetch failed');
    return { status };
  };
  return { impl, calls };
}

// ─── consent: the privacy boundary ──────────────────────────────────────────

test('consent is default OFF — recordIssue writes nothing and returns false', (t) => {
  withHome(t);
  assert.equal(isTelemetryGranted(), false);
  const out = recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  assert.equal(out, false);
  // The return value alone would also be false for an implementation that writes first and reports
  // afterwards. The directory is the assertion that matters.
  assert.equal(fs.existsSync(diagnosticsDir()), false);
  assert.deepEqual(events(), []);
});

test('a consent record from another version is denied, granted or not', (t) => {
  withHome(t);
  fs.mkdirSync(path.dirname(diagnosticsConsentFile()), { recursive: true });
  fs.writeFileSync(
    diagnosticsConsentFile(),
    JSON.stringify({ version: CONSENT_VERSION + 1, consent: 'granted' }),
    'utf-8',
  );
  assert.equal(readConsent(), null);
  assert.equal(isTelemetryGranted(), false);
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH }), false);
  assert.deepEqual(events(), []);
});

test('an unparseable consent file is denied rather than treated as granted', (t) => {
  withHome(t);
  fs.mkdirSync(path.dirname(diagnosticsConsentFile()), { recursive: true });
  fs.writeFileSync(diagnosticsConsentFile(), '{ not json', 'utf-8');
  assert.equal(isTelemetryGranted(), false);
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH }), false);
});

test('"asked" and "granted" stay distinguishable — a shown notice is not a yes', (t) => {
  withHome(t);
  assert.equal(hasBeenAsked(), false);
  assert.equal(markAsked(), true);
  assert.equal(hasBeenAsked(), true);
  assert.equal(isTelemetryGranted(), false);
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH }), false);
  assert.deepEqual(events(), []);
  // Shown once, never re-stamped.
  assert.equal(markAsked(), false);
});

test('the consent record lives at the data root, not under state/', (t) => {
  const home = withHome(t);
  grantConsent();
  assert.equal(diagnosticsConsentFile(), path.join(home, 'telemetry.json'));
  assert.equal(fs.existsSync(path.join(home, 'telemetry.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'state', 'telemetry.json')), false);
});

test('denyConsent discards everything already pending', (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED, source: DIAGNOSTIC_SOURCES.LOGIN });
  assert.equal(events().length, 2);
  denyConsent();
  assert.deepEqual(events(), []);
  assert.equal(isTelemetryGranted(), false);
  assert.equal(readConsent().consent, 'denied');
});

test('discardPendingDiagnostics removes every pending event and reports the count', (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  assert.equal(discardPendingDiagnostics(), 1);
  assert.deepEqual(events(), []);
});

// ─── recording ──────────────────────────────────────────────────────────────

test('a granted machine records the event to disk before the call returns', (t) => {
  withHome(t);
  grantConsent();
  const out = recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  // Synchronous by contract: F11 says a hard kill must not lose what was already recorded, which
  // only holds if the write completed inside the call rather than on a later tick.
  assert.equal(out, true);
  assert.equal(out instanceof Promise, false);
  const files = events();
  assert.equal(files.length, 1);
  const record = readEvent(files[0]);
  assert.equal(record.code, 'hook_crash');
  assert.equal(record.source, 'checkpoint');
  assert.equal(record.count, 1);
});

test('two identical issues dedup into one file with count 2', (t) => {
  withHome(t);
  grantConsent();
  let clock = Date.parse('2026-09-10T10:00:00.000Z');
  const now = () => clock;
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }, { now });
  clock += 60_000;
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }, { now });
  const files = events();
  assert.equal(files.length, 1);
  const record = readEvent(files[0]);
  assert.equal(record.count, 2);
  assert.equal(record.firstSeenAt, '2026-09-10T10:00:00.000Z');
  assert.equal(record.lastSeenAt, '2026-09-10T10:01:00.000Z');
});

test('different sources are different events', (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.SESSION_START });
  assert.equal(events().length, 2);
});

test('a code outside the vocabulary is dropped and writes nothing', (t) => {
  withHome(t);
  grantConsent();
  assert.equal(recordIssue({ code: 'codex_specific_explosion' }), false);
  assert.equal(recordIssue({}), false);
  assert.equal(recordIssue(null), false);
  assert.deepEqual(events(), []);
});

test('a source outside the server enum is dropped rather than sent', (t) => {
  withHome(t);
  grantConsent();
  // subagent_start is a real Codex hook with no PluginDiagnosticSource member (BE-2). Emitting it
  // would 400 the whole batch, so it must never reach disk.
  assert.equal(
    recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: 'subagent_start' }),
    false,
  );
  assert.deepEqual(events(), []);
});

test('a source-less issue inherits the hook in flight', (t) => {
  withHome(t);
  grantConsent();
  setCurrentSource(DIAGNOSTIC_SOURCES.SESSION_START);
  assert.equal(getCurrentSource(), 'session_start');
  recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED });
  assert.equal(readEvent(events()[0]).source, 'session_start');
  // An unknown label cannot be published either.
  setCurrentSource('subagent_stop');
  assert.equal(getCurrentSource(), 'session_start');
});

test('MAX_PENDING caps NEW keys only — a repeat still increments', (t) => {
  withHome(t);
  grantConsent();
  fs.mkdirSync(diagnosticsDir(), { recursive: true });
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  const existing = events()[0];
  for (let i = 0; i < MAX_PENDING; i += 1) {
    fs.writeFileSync(path.join(diagnosticsDir(), `filler${i}.json`), '{}', 'utf-8');
  }
  // A new dedup key is refused …
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.MCP_HANDSHAKE_TIMEOUT, source: DIAGNOSTIC_SOURCES.MCP_BRIDGE }), false);
  // … while the recurring failure keeps counting, which is the one that matters.
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }), true);
  assert.equal(readEvent(existing).count, 2);
});

test('a file at the dedup path that is not this failure is replaced, not incremented', (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  const file = events()[0];
  // A record from a schema that no longer exists, sitting on this key's path.
  fs.writeFileSync(
    path.join(diagnosticsDir(), file),
    JSON.stringify({ code: 'mcp_handshake_timeout', count: 7 }),
    'utf-8',
  );
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }), true);
  const record = readEvent(file);
  assert.equal(record.code, 'hook_crash');
  assert.equal(record.count, 1);
  assert.equal(events().length, 1);
});

test('a torn file at the dedup path does not inherit a bogus count', (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  const file = events()[0];
  fs.writeFileSync(path.join(diagnosticsDir(), file), '{"code":"hook_crash","count":', 'utf-8');
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }), true);
  assert.equal(readEvent(file).count, 1);
});

test('grantConsent keeps the moment the notice was shown', (t) => {
  withHome(t);
  markAsked(() => Date.parse('2026-09-01T00:00:00.000Z'));
  grantConsent(() => Date.parse('2026-09-30T00:00:00.000Z'));
  const record = readConsent();
  assert.equal(record.askedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(record.decidedAt, '2026-09-30T00:00:00.000Z');
  assert.equal(record.consent, 'granted');
  // An unasked machine that answers directly still gets both stamps.
  denyConsent(() => Date.parse('2026-10-01T00:00:00.000Z'));
  assert.equal(readConsent().askedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(readConsent().decidedAt, '2026-10-01T00:00:00.000Z');
});

test('recordIssue never throws, and never reenters itself', (t) => {
  withHome(t);
  grantConsent();
  const inner = [];
  const write = () => {
    // The shape a follow-up creates by wiring STATE_WRITE_FAILED into fs-store: a write failure
    // inside the diagnostics directory reports, which writes, which fails, which reports.
    inner.push(recordIssue({ code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED }));
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH }, { write }), false);
  assert.deepEqual(inner, [false]);
});

// ─── redaction ──────────────────────────────────────────────────────────────

test('no token, absolute path or prompt text can reach a record', (t) => {
  withHome(t);
  grantConsent();
  const secretPath = path.join(os.homedir(), 'projects', 'acme', 'secrets.env');
  const error = new Error(
    `refresh failed for https://api.example.com/token?access_token=sk-live-AbCdEf0123456789 ` +
    `while reading ${secretPath} — user asked: "rewrite the billing module for ACME Corp"`,
  );
  error.code = 'ENOENT';
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED, source: DIAGNOSTIC_SOURCES.LOGIN, error }), true);

  const record = readEvent(events()[0]);
  // Assert on the WHOLE serialized record, not on named fields: that is what catches a future
  // field being added carelessly.
  const wire = JSON.stringify(record);
  assert.equal(wire.includes('sk-live-AbCdEf0123456789'), false);
  assert.equal(wire.includes('access_token'), false);
  assert.equal(wire.includes(secretPath), false);
  assert.equal(wire.includes('secrets.env'), false);
  assert.equal(wire.includes('ACME Corp'), false);
  assert.equal(wire.includes('billing module'), false);
  assert.equal(wire.includes(os.homedir()), false);
  assert.equal(wire.includes('refresh failed'), false);
  // The structural guarantee: there is no field that could carry free text at all.
  assert.deepEqual(Object.keys(record).sort(), [
    'arch', 'code', 'count', 'errorCode', 'errorName', 'eventId', 'firstSeenAt',
    'httpStatus', 'lastSeenAt', 'nodeVersion', 'os', 'osRelease', 'pluginVersion',
    'site', 'source',
  ]);
  assert.equal('message' in record, false);
  assert.equal('stack' in record, false);
  // Claude-named and optional-nullable server-side; omitted rather than invented around.
  assert.equal('claudeCodeVersion' in record, false);
  // The structured dimensions still survive.
  assert.equal(record.errorName, 'Error');
  assert.equal(record.errorCode, 'ENOENT');
});

test('an errorCode that is not a bare identifier is dropped, not truncated', (t) => {
  withHome(t);
  grantConsent();
  const error = new Error('boom');
  error.code = `open ${path.join(os.homedir(), 'id_rsa')} failed`;
  recordIssue({ code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
  const record = readEvent(events()[0]);
  assert.equal(record.errorCode, null);
  assert.equal(JSON.stringify(record).includes('id_rsa'), false);
});

test('a transport failure reports the cause errno, not "fetch failed"', (t) => {
  withHome(t);
  grantConsent();
  const error = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.REPORT, error });
  const record = readEvent(events()[0]);
  assert.equal(record.errorName, 'TypeError');
  assert.equal(record.errorCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(JSON.stringify(record).includes('fetch failed'), false);
});

test('httpStatus is a bounded integer or null', (t) => {
  withHome(t);
  grantConsent();
  let clock = 0;
  const now = () => (clock += 1000);
  recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.BACKFILL, httpStatus: 413 }, { now });
  assert.equal(readEvent(events()[0]).httpStatus, 413);
  discardPendingDiagnostics();
  recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.BACKFILL, httpStatus: 'Bearer sk-live-1' }, { now });
  assert.equal(readEvent(events()[0]).httpStatus, null);
});

// ─── site ───────────────────────────────────────────────────────────────────

test('siteFrom keeps only frames inside the plugin, rendered relative with / separators', () => {
  const inside = new Error('x');
  inside.stack = `Error: x\n    at flushQueue (${path.join(PLUGIN_ROOT, 'lib', 'checkpoint.mjs')}:661:9)`;
  assert.equal(siteFrom(inside), 'lib/checkpoint.mjs:661');
});

test('siteFrom drops a frame outside the plugin root — no user path survives', () => {
  const outside = new Error('x');
  const userFile = path.join(os.homedir(), 'work', 'client-project', 'index.mjs');
  outside.stack = `Error: x\n    at run (${userFile}:12:3)`;
  assert.equal(siteFrom(outside), null);
});

test('siteFrom tolerates a file:// frame and a missing stack', () => {
  const asUrl = new Error('x');
  asUrl.stack = `Error: x\n    at run (${url.pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'token.mjs')).href}:98:5)`;
  assert.equal(siteFrom(asUrl), 'lib/token.mjs:98');
  assert.equal(siteFrom(null), null);
  assert.equal(siteFrom({}), null);
  assert.equal(siteFrom({ stack: 'no frames here' }), null);
});

test('a real thrown error records a plugin-relative site that matches the wire pattern', (t) => {
  withHome(t);
  grantConsent();
  let thrown;
  try {
    throw new RangeError('nope');
  } catch (error) {
    thrown = error;
  }
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error: thrown });
  const record = readEvent(events()[0]);
  assert.match(record.site, /^[A-Za-z0-9_./-]+:\d+$/);
  assert.equal(record.site.includes('\\'), false);
  assert.equal(record.site.startsWith('test/diagnostics.test.mjs:'), true);
});

// ─── flush ──────────────────────────────────────────────────────────────────

test('the flush sends nothing without consent, even with events already on disk', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  assert.equal(events().length, 1);
  // Revoke without discarding, so the only thing standing between the events and the wire is the
  // send-time gate.
  fs.writeFileSync(
    diagnosticsConsentFile(),
    JSON.stringify({ version: CONSENT_VERSION, consent: 'denied' }),
    'utf-8',
  );
  const post = fakePost(200);
  const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl, endpointPath: '/cli-agent/plugin-diagnostics' });
  assert.equal(res.skipped, 'no-consent');
  assert.equal(res.sent, 0);
  assert.equal(post.calls.length, 0);
  assert.equal(events().length, 1);
});

test('the flush sends nothing without a token', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const post = fakePost(200);
  const res = await flushDiagnostics(null, { postJsonImpl: post.impl, endpointPath: '/cli-agent/plugin-diagnostics' });
  assert.equal(res.skipped, 'no-token');
  assert.equal(post.calls.length, 0);
});

test('the flush never guesses a URL when ENDPOINTS has no route for it', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const post = fakePost(200);
  const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl, endpointPath: null });
  assert.equal(res.skipped, 'no-endpoint');
  assert.equal(post.calls.length, 0);
  assert.equal(events().length, 1);
});

test('the flush follows ENDPOINTS.pluginDiagnostics, and no-ops until that entry exists', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const post = fakePost(200);
  const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl });
  if (ENDPOINTS.pluginDiagnostics === undefined || ENDPOINTS.pluginDiagnostics === null) {
    // Today. The entry is BE-side plumbing this module deliberately does not add for itself.
    assert.equal(res.skipped, 'no-endpoint');
    assert.equal(post.calls.length, 0);
  } else {
    assert.equal(post.calls.length, 1);
    assert.equal(post.calls[0].url.endsWith(ENDPOINTS.pluginDiagnostics), true);
  }
});

test('a 2xx unlinks the batch and reports what was sent', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED, source: DIAGNOSTIC_SOURCES.LOGIN });
  const post = fakePost(202);
  const res = await flushDiagnostics(SESSION, {
    postJsonImpl: post.impl,
    endpointPath: '/cli-agent/plugin-diagnostics',
    timeoutMs: 900,
  });
  assert.equal(res.sent, 2);
  assert.deepEqual(events(), []);
  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].token, 'tok');
  assert.equal(post.calls[0].session.clientId, SESSION.clientId,
    'the batch names the machine row of the account it was sent as');
  assert.equal(post.calls[0].body.events.length, 2);
  // The hook budget is passed through, not ignored.
  assert.equal(post.calls[0].deps.timeoutMs, 900);
});

test('a permanent 4xx deletes the batch; 401, 403 and 5xx keep it for the next pass', async (t) => {
  withHome(t);
  grantConsent();
  const send = async (status) => {
    discardPendingDiagnostics();
    recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
    const post = fakePost(status);
    const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl, endpointPath: '/x' });
    return { res, remaining: events().length };
  };
  assert.deepEqual(await send(400), { res: { sent: 0, deleted: 1, expired: 0, failed: 0, skipped: null }, remaining: 0 });
  assert.deepEqual(await send(401), { res: { sent: 0, deleted: 0, expired: 0, failed: 1, skipped: null }, remaining: 1 });
  assert.deepEqual(await send(403), { res: { sent: 0, deleted: 0, expired: 0, failed: 1, skipped: null }, remaining: 1 });
  assert.deepEqual(await send(500), { res: { sent: 0, deleted: 0, expired: 0, failed: 1, skipped: null }, remaining: 1 });
  assert.deepEqual(await send('throw'), { res: { sent: 0, deleted: 0, expired: 0, failed: 1, skipped: null }, remaining: 1 });
});

test('an unpostable event is deleted rather than 400-ing the whole batch', async (t) => {
  withHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  fs.writeFileSync(
    path.join(diagnosticsDir(), 'poison.json'),
    JSON.stringify({ eventId: 'x', code: 'invented_code', source: 'checkpoint', pluginVersion: '1', count: 1, firstSeenAt: 'a', lastSeenAt: 'b' }),
    'utf-8',
  );
  fs.writeFileSync(path.join(diagnosticsDir(), 'torn.json'), '{"eventId":', 'utf-8');
  const post = fakePost(200);
  const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl, endpointPath: '/x' });
  assert.equal(res.deleted, 2);
  assert.equal(res.sent, 1);
  assert.equal(post.calls[0].body.events.length, 1);
  assert.equal(post.calls[0].body.events[0].code, 'hook_crash');
});

test('an event nobody flushed in two weeks is swept, not sent', async (t) => {
  withHome(t);
  grantConsent();
  const old = Date.now() - MAX_EVENT_AGE_MS - 60_000;
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT }, { now: () => old });
  recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED, source: DIAGNOSTIC_SOURCES.LOGIN });
  const post = fakePost(200);
  const res = await flushDiagnostics(SESSION, { postJsonImpl: post.impl, endpointPath: '/x' });
  assert.equal(res.expired, 1);
  assert.equal(res.sent, 1);
  assert.equal(post.calls[0].body.events[0].code, 'token_refresh_failed');
});

test('isPostableEvent refuses anything the closed enums would reject', () => {
  const good = {
    eventId: 'abc', code: 'hook_crash', source: 'checkpoint', site: 'lib/x.mjs:1',
    pluginVersion: '0.7.0', count: 1, firstSeenAt: 'a', lastSeenAt: 'b',
  };
  assert.equal(isPostableEvent(good), true);
  assert.equal(isPostableEvent({ ...good, code: 'nope' }), false);
  assert.equal(isPostableEvent({ ...good, source: 'subagent_start' }), false);
  assert.equal(isPostableEvent({ ...good, site: 'C:\\Users\\me\\x.mjs:1' }), false);
  assert.equal(isPostableEvent({ ...good, site: null }), true);
  assert.equal(isPostableEvent({ ...good, count: 0 }), false);
  assert.equal(isPostableEvent(null), false);
});

// The list is pinned rather than counted: every member must exist in the DEPLOYED server's
// PluginDiagnosticSource enum, because one unrecognised source 400s the whole batch. Adding a
// member here is a wire change, so it should cost a deliberate edit to this assertion.
// `subagent_start` / `subagent_stop` stay out until BE-2's migration reaches the target
// environment, even though the enum already has them in source.
test('every source this plugin can emit exists in the deployed server enum', () => {
  assert.deepEqual(Object.keys(DIAGNOSTIC_SOURCES).map((k) => DIAGNOSTIC_SOURCES[k]).sort(), [
    'backfill', 'checkpoint', 'login', 'mcp_bridge', 'report', 'session_start',
    'stop', 'sync', 'telemetry_flush', 'unknown',
  ]);
  assert.equal(Object.keys(DIAGNOSTIC_CODES).length, 8);
});

// ─── which account a batch is sent as ─────────────────────────────────────────────────────────
//
// The event store and the consent record are machine-level, so the batch travels once rather than
// once per account — but it still needs ONE account's bearer and client id, and the choice is not
// arbitrary: a dark tenant answers 403, which this flush keeps rather than deletes, so picking one
// would hold every event on disk for nothing.

test('the batch is sent as the default account when it is still reporting', () => {
  const a = accountSession('a1b2c3d4');
  const b = accountSession('99887766');
  assert.equal(diagnosticsSession([a, b], b.key, () => true).key, b.key);
});

test('a dark default falls through to the first account that is still reporting', () => {
  const a = accountSession('a1b2c3d4');
  const b = accountSession('99887766');
  const live = (key) => key !== b.key;
  assert.equal(diagnosticsSession([a, b], b.key, live).key, a.key);
});

test('no reporting account means no batch, rather than one that will 403', () => {
  const a = accountSession('a1b2c3d4');
  assert.equal(diagnosticsSession([a], a.key, () => false), null);
  assert.equal(diagnosticsSession([], null, () => true), null);
});
