import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountsIndexFile,
  accountsMigrationJournalFile,
  accountDir,
  trackingStateFile,
  queueDir,
  environment,
} from '../lib/paths.mjs';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-accounts-'));
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('1. the index and journal sit at the machine root', (t) => {
  const home = makeHome(t);
  assert.equal(accountsIndexFile(), path.join(home, 'accounts.json'));
  assert.equal(accountsMigrationJournalFile(), path.join(home, 'accounts.migration.json'));
});

test('2. keyed accessors live under accounts/<key>/', (t) => {
  const home = makeHome(t);
  assert.equal(accountDir('a1b2c3d4'), path.join(home, 'accounts', 'a1b2c3d4'));
  assert.equal(trackingStateFile('a1b2c3d4'), path.join(home, 'accounts', 'a1b2c3d4', 'tracking.json'));
  assert.equal(queueDir('a1b2c3d4'), path.join(home, 'accounts', 'a1b2c3d4', 'queue'));
});

// The guarantee that a missed call site fails loudly instead of writing to a root-level file.
test('3. a keyed accessor throws without a key', (t) => {
  makeHome(t);
  for (const fn of [accountDir, trackingStateFile, queueDir]) {
    assert.throws(() => fn(), /account key/i, `${fn.name}() must refuse a missing key`);
    assert.throws(() => fn(''), /account key/i, `${fn.name}('') must refuse an empty key`);
  }
});

// The key is interpolated into PowerShell single-quoted literals in lib/credentials.mjs, so a
// quote or a path separator getting through is a command-injection bug, not a formatting one.
test('4. a key outside the 8-hex shape is refused', (t) => {
  makeHome(t);
  const bad = ['A1B2C3D4', 'a1b2c3d', 'a1b2c3d45', "a1b2'c3d", '../etc', 'a1b2c3d/'];
  for (const value of bad) {
    assert.throws(() => environment.assertAccountKey(value), /account key/i, `${value} must be refused`);
  }
  assert.equal(environment.assertAccountKey('a1b2c3d4'), 'a1b2c3d4');

  // Through an ACCESSOR, not only through the assert directly. The accessors are where a key
  // becomes a path, so a future refactor that inlined a path.join and forgot the assert would pass
  // the case above and still let `../etc` out of the account directory.
  assert.throws(() => queueDir('../etc'), /account key/i);
  assert.throws(() => trackingStateFile("a1b2'c3d"), /account key/i);
  assert.throws(() => accountDir('a1b2c3d/'), /account key/i);
});
