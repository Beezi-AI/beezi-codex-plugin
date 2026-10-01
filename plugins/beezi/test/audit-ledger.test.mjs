import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, isImported, markImported, saveLedger } from '../lib/audit-ledger.mjs';
import { auditLedgerFile } from '../lib/paths.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// The ledger belongs to ONE ACCOUNT from 0.13 on: the server's pull record is per (tenant, user,
// tool), and two linked workspaces each get their own one-time import.
const KEY = TEST_KEY;
const OTHER = '99887766';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  linkAccount(dir, KEY);
  return dir;
}

test('1. an empty ledger reports nothing as imported', (t) => {
  makeHome(t);
  const ledger = loadLedger(KEY);

  assert.equal(isImported(ledger, 'sess-1'), false);
  assert.deepEqual(ledger.sessions, {});
});

test('2. round-trips a marked session through disk', (t) => {
  makeHome(t);
  const ledger = loadLedger(KEY);
  markImported(ledger, 'sess-1', { outcome: 'stored', reports: 12 });
  saveLedger(KEY, ledger);

  const reloaded = loadLedger(KEY);

  assert.equal(isImported(reloaded, 'sess-1'), true);
  assert.equal(reloaded.sessions['sess-1'].outcome, 'stored');
  assert.equal(reloaded.sessions['sess-1'].reports, 12);
  assert.ok(reloaded.updatedAt);
});

// A repository that was never connected to Beezi rejects every one of its reports and always
// will, so resending it on each run is pure waste.
test('3. a rejected session counts as imported', (t) => {
  makeHome(t);
  const ledger = loadLedger(KEY);
  markImported(ledger, 'sess-1', { outcome: 'rejected', reports: 3 });
  saveLedger(KEY, ledger);

  assert.equal(isImported(loadLedger(KEY), 'sess-1'), true);
});

test('4. a ledger with an unknown version is discarded, not merged', (t) => {
  makeHome(t);
  fs.writeFileSync(
    auditLedgerFile(KEY),
    JSON.stringify({ version: 99, sessions: { 'sess-1': {} } }),
    'utf-8',
  );

  assert.equal(isImported(loadLedger(KEY), 'sess-1'), false);
});

test('5. a corrupt ledger file falls back to empty instead of throwing', (t) => {
  makeHome(t);
  fs.mkdirSync(path.dirname(auditLedgerFile(KEY)), { recursive: true });
  fs.writeFileSync(auditLedgerFile(KEY), 'not json at all', 'utf-8');

  assert.deepEqual(loadLedger(KEY).sessions, {});
});

// The regression that matters: pruneStale wipes 14-day-old files in state/ and queue/, which is
// exactly why the ledger must not live in either.
test('6. survives pruneStale — the ledger is outside state/ and queue/', (t) => {
  const home = makeHome(t);
  const ledger = loadLedger(KEY);
  markImported(ledger, 'sess-1', { outcome: 'stored', reports: 1 });
  saveLedger(KEY, ledger);

  // Age the ledger well past the prune horizon, and give prune real dirs to walk.
  const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(auditLedgerFile(KEY), ancient, ancient);
  for (const sub of ['state', path.join('accounts', KEY, 'queue')]) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
    const stale = path.join(home, sub, 'stale.json');
    fs.writeFileSync(stale, '{}', 'utf-8');
    fs.utimesSync(stale, ancient, ancient);
  }

  pruneStale(Date.now());

  assert.equal(fs.existsSync(path.join(home, 'state', 'stale.json')), false, 'prune ran');
  assert.equal(isImported(loadLedger(KEY), 'sess-1'), true, 'ledger survived');
});

// REWRITTEN for the keyed layout: the ledger moved from the machine root into the account
// directory, and the property being pinned — that it is outside state/ and queue/, the only two
// trees pruneStale sweeps — is unchanged.
test('7. the ledger file sits in the account directory, outside the pruned trees', (t) => {
  const home = makeHome(t);

  assert.equal(auditLedgerFile(KEY), path.join(home, 'accounts', KEY, 'audit-ledger.json'));
  assert.notEqual(auditLedgerFile(KEY), auditLedgerFile(OTHER));
});

import { markComplete, isComplete } from '../lib/audit-ledger.mjs';

test('7. the complete flag round-trips and survives a reload', (t) => {
  makeHome(t);
  const ledger = loadLedger(KEY, 'client-1');
  assert.equal(isComplete(ledger), false);

  markComplete(ledger);
  saveLedger(KEY, ledger);

  const reloaded = loadLedger(KEY, 'client-1');
  assert.equal(isComplete(reloaded), true);
});

// The ledger is machine-global but the pull is per (tenant, user, tool): a ledger written under
// another login must read as EMPTY, or a workspace switch would replay it, find zero candidates
// and seal the new tenant's pull with nothing in it.
test('8. a foreign-identity ledger is discarded on load', (t) => {
  makeHome(t);
  const original = loadLedger(KEY, 'client-a');
  markImported(original, 'sess-1', { outcome: 'accepted', reports: 3 });
  markComplete(original);
  saveLedger(KEY, original);

  const foreign = loadLedger(KEY, 'client-b');

  assert.equal(isImported(foreign, 'sess-1'), false);
  assert.equal(isComplete(foreign), false);
  assert.equal(foreign.identity, 'client-b');

  // The same identity still sees its own ledger.
  const same = loadLedger(KEY, 'client-a');
  assert.equal(isImported(same, 'sess-1'), true);
  assert.equal(isComplete(same), true);
});

// A legacy ledger written before identity binding carries none — adopt it for the current login
// rather than discarding real progress.
test('9. an identity-less ledger is adopted by the first identified load', (t) => {
  makeHome(t);
  const legacy = loadLedger(KEY);
  markImported(legacy, 'sess-1', { outcome: 'accepted' });
  saveLedger(KEY, legacy);

  const adopted = loadLedger(KEY, 'client-a');
  assert.equal(isImported(adopted, 'sess-1'), true);
  assert.equal(adopted.identity, 'client-a');
});
