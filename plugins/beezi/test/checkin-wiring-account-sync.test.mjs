import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { accountSyncPath } from '../lib/account-sync.mjs';
import { ENDPOINTS } from '../lib/config.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The account check-in's wiring into its three triggers (G-2-1).
//
// lib/account-sync.mjs shipped with 33 tests and NOTHING CALLING IT. That is the failure this file
// exists to make loud: a module can be perfectly tested and completely inert, and no assertion in
// its own suite can tell the difference.
//
// The behavioural halves live where the seams are — test/session-start.test.mjs and
// test/login.test.mjs drive the hook and performLogin through injected deps and assert the token,
// the `force` value, the three handed-over seams and the failure isolation.
//
// What is left here is the trigger that CANNOT be driven: scripts/billing-capture.mjs is an
// executable — importing it runs it — and the hermeticity gate records every child_process call as
// a violation, so spawning it would fail whichever file did the spawning
// (tools/hermetic-env.mjs; test/heartbeat-wiring.test.mjs:18-26 makes the same trade for the hook
// scripts). These checks are therefore structural, and they assert STATEMENTS rather than the
// prose about them: an indexOf over a comment would keep passing after the call it describes was
// deleted.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const readSource = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');

// ── the route ─────────────────────────────────────────────────────────────────────────────────

test('ENDPOINTS.accountSync IS the route the module posts to, byte for byte', () => {
  // accountSyncPath() returns the ENDPOINTS entry verbatim, so the literal is asserted here rather
  // than against itself. A typo would not fail the module's own suite loudly — it would silently
  // move every check-in to a route the API does not serve.
  assert.equal(ENDPOINTS.accountSync, '/me/cli-agent/account');
  assert.equal(accountSyncPath(), '/me/cli-agent/account');
  // Vendor-generic on purpose: the server reads the vendor off X-Beezi-Agent, so scoping this
  // under /me/codex/* would split one account row into two.
  assert.equal(ENDPOINTS.accountSync.indexOf('/me/codex/'), -1);
});

// ── the triggers exist at all ─────────────────────────────────────────────────────────────────

test('all three triggers import the module — the "nothing calls it" regression guard', () => {
  for (const file of [['lib', 'session-start.mjs'], ['lib', 'login.mjs'], ['scripts', 'billing-capture.mjs']]) {
    const src = readSource(...file);
    assert.match(
      src,
      /^import \{[^}]*syncAccountIfNeeded[^}]*\} from '\.\.?\/(lib\/)?account-sync\.mjs';$/m,
      `${file.join('/')} no longer wires the account check-in`,
    );
  }
});

// ── scripts/billing-capture.mjs ───────────────────────────────────────────────────────────────

test('the capture script checks in AFTER the config it just wrote', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  const wrote = src.indexOf('writeBillingConfig(config);');
  const sync = src.indexOf('await syncAccountIfNeeded(');
  assert.ok(wrote > -1, 'the script still writes the captured config');
  assert.ok(sync > -1, 'the script still checks the account in');
  assert.ok(wrote < sync, 'a check-in before the write would report the plan the machine is leaving');
});

test('the capture script FORCES its check-in', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  // Load-bearing here, unlike at session start: the plan can change while the accountUuid and the
  // email do not, so the payload can be byte-identical to the marker's and the resync interval
  // would swallow the one check-in this command exists to send.
  // Keyed from 0.13 on: the plan is the machine's, but the row it updates belongs to one account.
  assert.match(src, /await syncAccountIfNeeded\(key, await sessionFor\(key\), \{ force: true \}\);/);
});

test('the capture script’s session keeps the index row as the client-id fallback', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  // lib/accounts.mjs states the rule and lib/login.mjs follows it: the credential blob's client_id
  // wins whenever it has one, and the stored row is the FALLBACK. A blob migrated from a pre-0.13
  // install carries none, and without the fallback this check-in posts with no X-Beezi-Client —
  // a silent misattribution to no machine row at all, which no response code reports.
  //
  // Structural, like the rest of this file: scripts/billing-capture.mjs is an executable, so
  // importing it runs it and spawning it is a hermeticity violation.
  assert.match(src, /await getAccount\(key\)/, 'the row is never read, so there is no fallback to apply');
  assert.match(src, /if \(auth\.clientId != null\) return \{ token: auth\.accessToken, clientId: auth\.clientId \};/,
    'the blob must still win whenever it names a client');
  assert.match(src, /clientId: orDefault\(\(row \|\| \{\}\)\.clientId, null\)/,
    'the row supplies the id only when the blob has none');
});

test('the capture script’s check-in is best-effort — it cannot fail a write that succeeded', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  assert.match(
    src,
    /try \{\r?\n\s*await syncAccountIfNeeded\([^\r\n]*\r?\n\s*\} catch \{/,
    'an unwrapped call would turn an offline machine into a non-zero exit for a capture that worked',
  );
});

test('the capture script’s body moved into async main(), because the await is top-level otherwise', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  // The structural constraint the check-in imposed. Top-level await is Node 14.8+, past this
  // plugin's 13.2 floor, and the ban gate rejects it — test/compat-syntax.test.mjs's "runtime
  // files stay valid on Node 13.2" is the proof that this restructure actually satisfies it.
  // Same shape scripts/me.mjs already uses.
  assert.match(src, /^async function main\(\) \{$/m);
  assert.match(src, /^main\(\)\.catch\(\(error\) => \{$/m);
  // Line-anchored searches, not indexOf: the comment above main() spells "main().catch()" out in
  // prose, and an indexOf would find THAT and cheerfully report the ordering of a sentence.
  const opened = src.search(/^async function main\(\) \{$/m);
  const sync = src.indexOf('await syncAccountIfNeeded(');
  const closed = src.search(/^main\(\)\.catch\(/m);
  assert.ok(opened < sync && sync < closed, 'the await must sit inside main(), not at module scope');
  // The old bare top-level `try` is gone: main().catch is the single error exit now.
  assert.doesNotMatch(src, /^try \{$/m);
});

test('the capture script still reports the write before it talks to the network', () => {
  const src = readSource('scripts', 'billing-capture.mjs');
  // The confirmation line is about the local write, which has already happened. Putting a bounded
  // POST in front of it would make an offline machine sit silent for the timeout before telling
  // the user their plan was recorded.
  const printed = src.indexOf('✓ Beezi billing captured:');
  const sync = src.indexOf('await syncAccountIfNeeded(');
  assert.ok(printed > -1 && printed < sync);
});
