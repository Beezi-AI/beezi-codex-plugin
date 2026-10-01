import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TrackingMode,
  readTrackingState,
  writeTrackingState,
  isLiveTrackingAllowed,
  shouldBackfill,
  matchesIdentity,
  recordWhoami,
  markTrackingDisabled,
  markBackfillCompleted,
  clearTrackingState,
  markLinked,
  linkedAtMs,
} from '../lib/tracking.mjs';
import { trackingStateFile } from '../lib/paths.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// Every export is keyed from 0.13 on: the tracking policy belongs to a TENANT, and two linked
// workspaces disagree about it routinely.
const KEY = TEST_KEY;
const OTHER = '99887766';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-test-'));
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  linkAccount(dir, KEY);
  return dir;
}

// The gate is a UX/efficiency optimization — the server's guard is the boundary. Failing closed
// on a missing file would dark-mode every fresh install.
test('1. fail-open: missing file, null mode and a corrupt file all allow tracking', (t) => {
  const home = makeHome(t);

  assert.equal(isLiveTrackingAllowed(KEY), true, 'missing file');

  writeTrackingState(KEY, { trackingMode: null });
  assert.equal(isLiveTrackingAllowed(KEY), true, 'null mode (pre-audit server)');

  fs.writeFileSync(trackingStateFile(KEY), '{ torn wri', 'utf-8');
  assert.equal(readTrackingState(KEY), null, 'corrupt file reads as absent');
  assert.equal(isLiveTrackingAllowed(KEY), true, 'corrupt file');
  assert.ok(home);
});

test('2. both audit modes block live tracking; live allows it', (t) => {
  makeHome(t);

  writeTrackingState(KEY, { trackingMode: TrackingMode.BACKFILL_ONLY });
  assert.equal(isLiveTrackingAllowed(KEY), false);

  writeTrackingState(KEY, { trackingMode: TrackingMode.DISABLED });
  assert.equal(isLiveTrackingAllowed(KEY), false);

  writeTrackingState(KEY, { trackingMode: TrackingMode.LIVE });
  assert.equal(isLiveTrackingAllowed(KEY), true);
});

// Mirrors the server's resolveTrackingMode: everything except disabled is offered the pull until
// it completes — paid tenants included. A null mode is a pre-audit server: no pull to offer.
test('3. shouldBackfill truth table', (t) => {
  makeHome(t);

  const cases = [
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.DISABLED, backfillCompleted: false }, false],
    [{ trackingMode: null, backfillCompleted: false }, false],
    [null, false],
  ];
  for (const [state, expected] of cases) {
    // The state is the account's file now, so each case is written and then read back through the
    // key — which also proves the predicate reads the right account's file.
    if (state === null) clearTrackingState(KEY);
    else writeTrackingState(KEY, state);
    assert.equal(shouldBackfill(KEY), expected, JSON.stringify(state));
  }
});

// REWRITTEN for the keyed layout. It used to assert "tracking.json lives at the ROOT"; the file is
// now `accounts/<key>/tracking.json`, and the property it was protecting is unchanged and still
// load-bearing: pruneStale sweeps state/ and every account's queue/ at 14 days, and a tracking
// cache that expired with them would silently re-enable a dark-mode tenant.
test('4. tracking.json lives in the account directory and survives pruneStale', (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'accounts', KEY, 'queue'), { recursive: true });

  writeTrackingState(KEY, { trackingMode: TrackingMode.DISABLED });
  const fifteenDaysAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(trackingStateFile(KEY), fifteenDaysAgo, fifteenDaysAgo);

  pruneStale();

  assert.ok(fs.existsSync(trackingStateFile(KEY)));
  assert.equal(path.dirname(trackingStateFile(KEY)), path.join(home, 'accounts', KEY));
  assert.equal(isLiveTrackingAllowed(KEY), false);
});

// The server scope is per (tenant, user, tool): a state written under another login must be
// discarded, never trusted — even under the same account key, because a logout→login into a
// different workspace reuses it.
test('5. identity mismatch discards the state; missing identities stay permissive', (t) => {
  makeHome(t);

  writeTrackingState(KEY, { identity: 'client-a' });
  assert.equal(matchesIdentity(KEY, 'client-a'), true);
  assert.equal(matchesIdentity(KEY, 'client-b'), false);
  assert.equal(matchesIdentity(KEY, null), true, 'an account with no client id fails open');

  writeTrackingState(KEY, { identity: null });
  assert.equal(matchesIdentity(KEY, 'client-b'), true);

  clearTrackingState(KEY);
  assert.equal(matchesIdentity(KEY, 'client-b'), true, 'no state at all is permissive');
});

test('6. recordWhoami persists the policy fields bound to the identity', (t) => {
  makeHome(t);

  recordWhoami(
    KEY,
    { valid: true, tenantTier: 'audit', trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false },
    'client-1',
  );

  const state = readTrackingState(KEY);
  assert.equal(state.trackingMode, TrackingMode.BACKFILL_ONLY);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.backfillCompleted, false);
  assert.equal(state.identity, 'client-1');
  assert.ok(state.fetchedAt);

  // An invalid or absent whoami must never overwrite the recorded state.
  recordWhoami(KEY, { valid: false }, 'client-1');
  recordWhoami(KEY, null, 'client-1');
  assert.equal(readTrackingState(KEY).trackingMode, TrackingMode.BACKFILL_ONLY);
});

test('7. markTrackingDisabled flips the mode and keeps the rest; markBackfillCompleted seals', (t) => {
  makeHome(t);

  recordWhoami(
    KEY,
    { valid: true, tenantTier: 'audit', trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false },
    'client-1',
  );
  markTrackingDisabled(KEY, 'server said so');

  let state = readTrackingState(KEY);
  assert.equal(state.trackingMode, TrackingMode.DISABLED);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.reason, 'server said so');

  markBackfillCompleted(KEY);
  state = readTrackingState(KEY);
  assert.equal(state.backfillCompleted, true);

  clearTrackingState(KEY);
  assert.equal(readTrackingState(KEY), null);
});

// The audit's "already tracked live" cutoff reads this stamp. It used to read the credentials
// file's mtime, which the CredMan/Keychain/secret-tool backends never write — so on most machines
// the cutoff was null and every transcript, live-tracked or not, was a backfill candidate.
test('8. markLinked stamps the link instant and survives later whoami refreshes', (t) => {
  makeHome(t);

  assert.equal(linkedAtMs(KEY), null, 'no stamp before login');

  const before = Date.now();
  markLinked(KEY);
  const stamped = linkedAtMs(KEY);
  assert.ok(stamped >= before, 'stamp is the link instant');

  recordWhoami(
    KEY,
    { valid: true, tenantTier: 'pro', trackingMode: TrackingMode.LIVE, backfillCompleted: false },
    'client-1',
  );
  assert.equal(linkedAtMs(KEY), stamped, 'whoami refresh keeps the stamp');
  assert.equal(readTrackingState(KEY).trackingMode, TrackingMode.LIVE, 'verdict still wins');

  markTrackingDisabled(KEY, 'server said so');
  assert.equal(linkedAtMs(KEY), stamped, 'dark-mode flip keeps the stamp');
});

test('9. linkedAtMs ignores a missing or unparseable stamp', (t) => {
  makeHome(t);

  assert.equal(linkedAtMs(KEY), null, 'no state at all');
  writeTrackingState(KEY, {});
  assert.equal(linkedAtMs(KEY), null, 'state with no stamp');
  writeTrackingState(KEY, { linkedAt: 'not-a-date' });
  assert.equal(linkedAtMs(KEY), null);
  writeTrackingState(KEY, { linkedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(linkedAtMs(KEY), Date.parse('2026-08-10T00:00:00.000Z'));
});

// The reason every export above takes a key. One tenant in audit mode beside one tracking live is
// the ordinary case, not an edge case, and a machine-wide file made the last whoami win for both.
test('10. two accounts hold independent policies, and one going dark leaves the other live', (t) => {
  const home = makeHome(t);
  linkAccount(home, OTHER);

  writeTrackingState(KEY, { trackingMode: TrackingMode.LIVE });
  writeTrackingState(OTHER, { trackingMode: TrackingMode.LIVE });

  markTrackingDisabled(OTHER, 'the server darkened this tenant');

  assert.equal(isLiveTrackingAllowed(KEY), true, 'the untouched account still reports');
  assert.equal(isLiveTrackingAllowed(OTHER), false);
  assert.notEqual(trackingStateFile(KEY), trackingStateFile(OTHER));
});
