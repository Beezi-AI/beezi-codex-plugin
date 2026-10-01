import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { machineHeaders } from '../lib/machine-identity.mjs';
import { loadLedger, saveLedger, markImported, isImported } from '../lib/audit-ledger.mjs';
import { AGENT } from '../lib/config.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// The ledger is the account's; the IDENTITY it binds to is the login's client id. These cases are
// about the second of those, so they all use one account and vary the identity.
const KEY = TEST_KEY;

// G-8-5. lib/machine-identity.mjs had zero coverage. It USED to hold one module-level variable —
// this process's OAuth client id — set by whoever loaded credentials and read by the HTTP helpers
// and by the backfill ledger, where getting it wrong is a permanent, unrecoverable outcome
// (lib/audit-ledger.mjs:15-18: a replayed ledger "would ... seal the new tenant's pull EMPTY
// (there is no reopen)").
//
// That variable is GONE as of the multi-account keying. With several accounts linked, a
// process-global would attach one account's X-Beezi-Client to another account's bearer and the
// server would bind the wrong machine row — so the id now travels with the token, as the
// { token, clientId } session lib/http.mjs demands. The tests below therefore pin two things: the
// header construction, now a pure function of its argument, and the ledger hazard, which survives
// the change because it was never about the global — it was about an identity that is null.
//
// HERMETICITY. machineHeaders() calls os.hostname(), which is real machine state and is not
// injectable — `os` is a module-level import at machine-identity.mjs:1. Every test here stubs
// os.hostname on the module object rather than reading the developer's, so no assertion in this
// file depends on the machine it runs on. The ledger test writes only under os.tmpdir().

const FAKE_HOST = 'test-host';
let savedHostname;

beforeEach(() => {
  savedHostname = os.hostname;
  os.hostname = () => FAKE_HOST;
});

afterEach(() => {
  os.hostname = savedHostname;
});

// ── 1. the X-Beezi-Client truthiness gate ───────────────────────────────────────────────────────

// There is no module state left to leak, so this is now a pure input/output assertion: the SAME
// call that omits the header for one argument carries it for another, with nothing in between.
test('1. machineHeaders omits X-Beezi-Client without an id and carries the one it is given', () => {
  const none = machineHeaders(null);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(none, 'X-Beezi-Client'),
    false,
    'an absent id must not appear as a header at all — not as null, not as ""',
  );

  assert.strictEqual(machineHeaders('client-abc')['X-Beezi-Client'], 'client-abc');
});

// `if (clientId)` is a truthiness check rather than a null check, so an empty-string client id is
// dropped as silently as an absent one. Pinned because the two are indistinguishable to the server
// and only this assertion says which values reach it.
test('1b. an empty-string client id is treated as absent', () => {
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(machineHeaders(''), 'X-Beezi-Client'),
    false,
  );
});

// The shape every un-swept call site still has while the fan-out sweep lands. It must degrade to an
// unattributed machine, never throw — a dead hook is worse than a missing bookkeeping header — and
// it must not resurrect a global, because there is none to resurrect.
test('1c. no argument at all is the same as no id', () => {
  const headers = machineHeaders();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(headers, 'X-Beezi-Client'), false);
  assert.strictEqual(headers['X-Beezi-Agent'], AGENT);
});

// Two calls with two different ids must not influence one another. This is the assertion that would
// have failed under the old module, and it is the whole reason the global was removed: one process
// now resolves a token per account and posts each with its own client id.
test('1d. two ids in one process do not contaminate each other', () => {
  const a = machineHeaders('client-a');
  const b = machineHeaders('client-b');
  assert.strictEqual(a['X-Beezi-Client'], 'client-a');
  assert.strictEqual(b['X-Beezi-Client'], 'client-b');
  assert.strictEqual(machineHeaders('client-a')['X-Beezi-Client'], 'client-a', 'and re-reading is stable');
});

// ── 2. the vendor header ────────────────────────────────────────────────────────────────────────

// A value assertion, not a shape one: the server attributes a machine and its analytics to the
// Codex client off this header and nothing else. If it ever said 'claude-code', Codex sessions
// would land in the Claude Code plugin's bucket with no other signal that anything moved.
test('2. X-Beezi-Agent is exactly "codex"', () => {
  assert.strictEqual(machineHeaders(null)['X-Beezi-Agent'], 'codex');
  assert.strictEqual(AGENT, 'codex', 'and it is the config constant, not a second literal');
  assert.strictEqual(machineHeaders(null)['X-Beezi-Agent'], AGENT);
});

// ── 3. the host header ──────────────────────────────────────────────────────────────────────────

test('3. X-Beezi-Host is truncated at 255 characters', (t) => {
  os.hostname = () => 'h'.repeat(400);
  const long = machineHeaders(null)['X-Beezi-Host'];
  assert.strictEqual(long.length, 255, 'a 400-character hostname is cut to exactly 255');
  assert.strictEqual(long, 'h'.repeat(255));

  // A short hostname is passed through untouched — the slice must not be a fixed-width pad.
  os.hostname = () => 'short-host';
  assert.strictEqual(machineHeaders(null)['X-Beezi-Host'], 'short-host');

  // String() is what keeps a non-string hostname from throwing on .slice.
  os.hostname = () => undefined;
  assert.doesNotThrow(() => machineHeaders(null));
  assert.strictEqual(machineHeaders(null)['X-Beezi-Host'], 'undefined');
  t.diagnostic('hostname stubbed throughout; the real machine name is never read');
});

test('3b. machineHeaders returns a fresh object each call', () => {
  const a = machineHeaders(null);
  a['X-Beezi-Host'] = 'mutated';
  assert.strictEqual(machineHeaders(null)['X-Beezi-Host'], FAKE_HOST, 'no shared header object');
});

// ── 4. THE LEDGER HAZARD ────────────────────────────────────────────────────────────────────────

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-identity-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  linkAccount(dir, KEY);
  return dir;
}

// The regression test for the hazard this ratchet uncovered. It was written to pin the BUG, then
// inverted in the same commit as the fix to lib/audit-ledger.mjs.
//
// It USED to be an ORDERING hazard: the client id was a global, lib/session-audit.mjs read it with
// getMachineClientId(), and the read was only safe because a write was supposed to have happened
// first. With the global gone the ordering is gone with it, but the hazard it exposed is not — an
// identity can still be null (no credentials, an injected token, or a credentials blob with no
// client_id), and that is the case this pins.
//
// The OLD guard (`raw.identity && identity && raw.identity !== identity`) needed BOTH sides truthy,
// so a null identity did not fail the check: it SKIPPED it, the foreign ledger was merged, and the
// previous tenant's imported-session set was trusted under the current login. The guard now tests
// only `raw.identity`, so an unidentified caller discards rather than inherits.
test('4. a null client id discards a foreign ledger rather than merging it', (t) => {
  makeHome(t);

  // A ledger left behind by a previous login, bound to that login's identity.
  const previous = loadLedger(KEY, 'client-a');
  markImported(previous, 'sess-1', { outcome: 'accepted', reports: 3 });
  saveLedger(KEY, previous);

  const merged = loadLedger(KEY, null);

  assert.strictEqual(
    isImported(merged, 'sess-1'),
    false,
    'another identity\'s imported sessions are not trusted under a null identity',
  );
  assert.strictEqual(merged.identity, null, 'and the foreign identity is not carried forward');
});

// The contrast: the exact same ledger, the exact same call, with a REAL identity that simply is not
// the one the ledger was bound to — and the discard fires for the other reason. Together these two
// say the guard covers both "no identity" and "a different identity".
test('4b. the same load under a different client id also discards it', (t) => {
  makeHome(t);

  const previous = loadLedger(KEY, 'client-a');
  markImported(previous, 'sess-1', { outcome: 'accepted', reports: 3 });
  saveLedger(KEY, previous);

  const fresh = loadLedger(KEY, 'client-b');

  assert.strictEqual(isImported(fresh, 'sess-1'), false, 'the foreign ledger is discarded');
  assert.strictEqual(fresh.identity, 'client-b');
});

// And the case that must NOT discard, so the two above are not passing vacuously: the same identity
// reloads its own ledger and keeps what it imported.
test('4c. a ledger reloaded under its own identity is kept', (t) => {
  makeHome(t);

  const previous = loadLedger(KEY, 'client-a');
  markImported(previous, 'sess-1', { outcome: 'accepted', reports: 3 });
  saveLedger(KEY, previous);

  const again = loadLedger(KEY, 'client-a');

  assert.strictEqual(isImported(again, 'sess-1'), true, 'an account still trusts its own ledger');
  assert.strictEqual(again.identity, 'client-a');
});
