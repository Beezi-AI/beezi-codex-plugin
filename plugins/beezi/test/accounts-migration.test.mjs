import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIndex, listAccounts, migrateSingleAccount } from '../lib/accounts.mjs';
import {
  accountsIndexFile, accountsMigrationJournalFile,
  trackingStateFile, queueDir, usagePendingFile,
  usageObservationsFile, accountDir,
} from '../lib/paths.mjs';
import { locksDir } from '../lib/single-instance-lock.mjs';
import { SERVICE } from '../lib/credentials.mjs';
import { ensureEnvironmentMigrated, STAGING_API_ORIGIN } from '../lib/env-migration.mjs';
import {
  makeHome, fakeKeyring, fakeCredMan, credentialBlob, entryId,
} from '../tools/account-fixtures.mjs';

// The root-level state a pre-0.13 install wrote. Separate from the keyring half so the Windows
// case can seed a credential store with a different keyspace and still start from the same files.
function legacyFiles(home) {
  fs.writeFileSync(path.join(home, 'tracking.json'),
    JSON.stringify({ version: 1, linkedAt: '2026-01-01T00:00:00.000Z', trackingMode: 'live' }), 'utf-8');
  fs.writeFileSync(path.join(home, 'audit-ledger.json'), JSON.stringify({ imported: ['s-1'] }), 'utf-8');
  fs.writeFileSync(path.join(home, 'coverage.json'), JSON.stringify({ covered: [] }), 'utf-8');
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(home, 'queue', 'seg-1.json'), '{"segmentId":"seg-1"}', 'utf-8');
  fs.writeFileSync(usageObservationsFile(), JSON.stringify({
    series: { primary: [1] },
    observedPlan: { plan: 'plus', observedAt: '2026-01-01T00:00:00.000Z' },
    pending: [{ captured_at: '2026-01-01T00:00:00.000Z' }],
  }), 'utf-8');
}

function legacyInstall(home, ring) {
  ring.store.set(entryId(SERVICE, 'token'), JSON.stringify(credentialBlob({ client_id: 'legacy-client' })));
  // A pre-0.13 install that ever committed its credential also has the authority record beside it,
  // at the data root. Nothing keyed reads that path, so it has to retire with the entry.
  fs.writeFileSync(path.join(home, 'credential-control.json'),
    JSON.stringify({ version: 1, revision: 'legacy-rev', backend: 'keychain', beezi_env: '' }), 'utf-8');
  legacyFiles(home);
}

test('1. a legacy install becomes account one, keeping its linkedAt and client id', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);

  const index = await readIndex({ run: ring.run, platform: 'darwin' });

  assert.equal(index.accounts.length, 1);
  const [row] = index.accounts;
  assert.match(row.key, /^[0-9a-f]{8}$/);
  assert.equal(row.clientId, 'legacy-client');
  assert.equal(row.linkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(row.email, null, 'nothing ever fills this in — see describeAccount in lib/accounts.mjs');
  assert.equal(index.default, row.key);
});

test('2. the root-level state files move into the account directory', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);

  const key = (await readIndex({ run: ring.run, platform: 'darwin' })).default;

  assert.equal(JSON.parse(fs.readFileSync(trackingStateFile(key), 'utf-8')).linkedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(fs.existsSync(path.join(queueDir(key), 'seg-1.json')));
  assert.equal(fs.existsSync(path.join(home, 'tracking.json')), false, 'originals are removed last');
  assert.equal(fs.existsSync(path.join(home, 'queue', 'seg-1.json')), false);
});

// The series and the observed plan outlive the queue; the pending ROWS are what a drain clears.
test('3. usage pending rows move, series and observedPlan stay machine-level', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);

  const key = (await readIndex({ run: ring.run, platform: 'darwin' })).default;

  assert.equal(JSON.parse(fs.readFileSync(usagePendingFile(key), 'utf-8')).pending.length, 1);
  const machine = JSON.parse(fs.readFileSync(usageObservationsFile(), 'utf-8'));
  assert.equal(machine.observedPlan.plan, 'plus');
  assert.deepEqual(machine.pending, [], 'rows were moved, not copied');
});

test('4. the legacy keyring entry is deleted only after the index is published', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);

  const key = (await readIndex({ run: ring.run, platform: 'darwin' })).default;

  assert.equal(ring.store.has(entryId(SERVICE, 'token')), false, 'legacy entry gone');
  assert.ok(ring.store.has(entryId(SERVICE, key)), 'keyed entry present');
  assert.equal(fs.existsSync(path.join(home, 'credential-control.json')), false,
    'the pre-0.13 authority record retires with the entry it described');
  assert.ok(fs.existsSync(path.join(accountDir(key), 'credential-control.json')),
    'the account has one of its own');
});

test('5. the migration is idempotent and reuses the journalled key', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);

  const first = (await readIndex({ run: ring.run, platform: 'darwin' })).default;
  fs.rmSync(accountsIndexFile(), { force: true });          // a crash after the copy
  legacyInstall(home, ring);                                 // the legacy entry is back
  const second = (await readIndex({ run: ring.run, platform: 'darwin' })).default;

  assert.equal(second, first, 'the journal pins the key across a retry');
  assert.equal(JSON.parse(fs.readFileSync(accountsMigrationJournalFile(), 'utf-8')).key, first);
  assert.equal((await listAccounts()).length, 1, 'no orphan second account');
});

// Never publish an empty index over a login we simply could not read this time.
test('6. an unreadable credential store aborts instead of publishing', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);
  const failing = { run: () => { throw new Error('keychain locked'); }, platform: 'darwin' };

  await assert.rejects(() => readIndex(failing), /temporarily unavailable/i);
  assert.equal(fs.existsSync(accountsIndexFile()), false, 'nothing was published');
  assert.ok(ring.store.has(entryId(SERVICE, 'token')), 'the legacy login survived');
});

test('7. no legacy entry and no index simply reads as no accounts, and journals nothing', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const index = await readIndex({ run: ring.run, platform: 'darwin' });
  assert.deepEqual(index.accounts, []);
  assert.equal(fs.existsSync(accountsIndexFile()), false);
  // accounts.migration.json is in env-migration's DATA_ENTRIES: a journal written for a machine
  // with nothing to migrate would make its root read as USED, and a used unbound root takes a
  // production cutover it never needed.
  assert.equal(fs.existsSync(accountsMigrationJournalFile()), false, 'nothing to migrate, nothing journalled');
});

test('8. a lock-loser waits for the winner index rather than migrating twice', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);
  const deps = { run: ring.run, platform: 'darwin' };

  const [a, b] = await Promise.all([readIndex(deps), readIndex(deps)]);

  assert.equal(a.default, b.default);
  assert.equal((await listAccounts()).length, 1);
  assert.equal(fs.readdirSync(path.join(home, 'accounts')).length, 1);
});

// Test 6 injects a THROWING run, which defaultRun cannot produce: it collapses every backend
// failure to { ok: false } and then to null, byte-identical to "never linked". This is the shape a
// locked keychain actually has in production, and the authority record is what tells the two apart
// — a committed backend answering with nothing is a failure, so the migration must refuse rather
// than read it as an unlinked machine and let the next login publish an index over it.
//
// The blind run here fails only READS: the entry is still in the store, which is exactly the
// locked-keychain shape.
test('9. a committed store that reads as null is unavailable, not unlinked', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);
  const blind = {
    platform: 'darwin',
    run: (file, args, input) => (args[0] === 'find-generic-password'
      ? { ok: false, stdout: '' }
      : ring.run(file, args, input)),
  };

  await assert.rejects(() => migrateSingleAccount(blind), /temporarily unavailable/i);
  await assert.rejects(() => readIndex(blind), /temporarily unavailable/i);
  assert.equal(fs.existsSync(accountsIndexFile()), false, 'nothing was published');
  assert.equal(fs.existsSync(accountsMigrationJournalFile()), false, 'and no key was pinned');
  assert.ok(ring.store.has(entryId(SERVICE, 'token')), 'the legacy login is untouched');
  assert.ok(fs.existsSync(path.join(home, 'tracking.json')), 'and so is the state beside it');
});

// The residue the signal does NOT cover, pinned so it is on the record rather than implied: an
// install that never committed its credential has no authority record, so there is nothing to say
// which backend should have answered. Unreadable and never-linked are genuinely indistinguishable
// there, and the safe reading is the one that publishes nothing and deletes nothing.
test('9b. without an authority record the two are indistinguishable, and nothing is touched', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);
  fs.rmSync(path.join(home, 'credential-control.json'), { force: true }); // a pre-commit install
  const blind = {
    platform: 'darwin',
    run: (file, args, input) => (args[0] === 'find-generic-password'
      ? { ok: false, stdout: '' }
      : ring.run(file, args, input)),
  };

  assert.deepEqual(await migrateSingleAccount(blind), { version: 1, default: null, accounts: [] });
  assert.deepEqual((await readIndex(blind)).accounts, []);
  assert.equal(fs.existsSync(accountsIndexFile()), false, 'nothing was published');
  assert.equal(fs.existsSync(accountsMigrationJournalFile()), false, 'and no key was pinned');
  assert.ok(ring.store.has(entryId(SERVICE, 'token')), 'the legacy login is untouched');
  assert.ok(fs.existsSync(path.join(home, 'tracking.json')), 'and so is the state beside it');
});

// Windows keys a generic credential by TARGET NAME alone, and the legacy entry's target is the bare
// service name. fakeKeyring models (service, account) and would pass whatever the target said, so
// this case is the only one that can see the migration reading or writing the wrong entry.
test('10. on Windows the bare-service legacy target is replaced by a keyed target', async (t) => {
  const home = makeHome(t);
  const cred = fakeCredMan();
  cred.store.set(SERVICE, JSON.stringify(credentialBlob({ client_id: 'legacy-client' })));
  legacyFiles(home);

  const index = await readIndex({ run: cred.run, platform: 'win32' });

  const key = index.default;
  assert.match(key, /^[0-9a-f]{8}$/);
  assert.equal(index.accounts[0].clientId, 'legacy-client');
  assert.equal(cred.store.has(SERVICE), false, 'the machine-wide target is gone');
  assert.ok(cred.store.has(`${SERVICE}:${key}`), 'the account owns a target of its own');
});

// Spec decision 10: the environment guard runs first, and while its barrier is up the root's files
// are about to MOVE. Copying them now would copy them out from under it.
test('11. the environment-migration barrier defers the accounts migration', async (t) => {
  const home = makeHome(t);
  const ring = fakeKeyring();
  legacyInstall(home, ring);
  fs.mkdirSync(locksDir(), { recursive: true });
  fs.writeFileSync(path.join(locksDir(), 'migration-barrier.lock'),
    JSON.stringify({ v: 1, token: 'barrier', host: 'h', pid: 1, acquiredAt: Date.now(), renewedAt: Date.now(), leaseMs: 120000, expiresAt: Date.now() + 120000 }), 'utf-8');

  await assert.rejects(() => readIndex({ run: ring.run, platform: 'darwin' }), /environment migration/i);
  assert.equal(fs.existsSync(accountsIndexFile()), false, 'nothing was published');
  assert.ok(ring.store.has(entryId(SERVICE, 'token')), 'and nothing was moved');
  assert.ok(fs.existsSync(path.join(home, 'tracking.json')));
});

// ── the keyed layout, handed on to the environment migration ────────────────────────────────
//
// Every case in test/env-migration.test.mjs and test/cutover-corrections.test.mjs starts from a
// pre-0.13 root, so the shape THIS migration produces is the one shape the cutover has no coverage
// for — and it is reachable: `migrate-env.mjs --preserve` forces the verdict on any root, and a
// keyed root whose only account is logged out classifies as `unlinked`, which migrates too.
//
// realpathSync, because withMigrationRoots refuses a root with a symlink anywhere in its parent
// chain and macOS resolves os.tmpdir() under /var, which is a symlink to private/var.
test('12. a keyed root survives the environment migration, authority record and all', (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'accounts-keyed-'));
  const source = path.join(base, 'production');
  const destination = path.join(base, 'staging');
  fs.mkdirSync(source, { recursive: true });
  const previous = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = source;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const key = 'a1b2c3d4';
  const raw = JSON.stringify({
    access_token: 'at-staging', refresh_token: 'rt-staging', client_id: 'c-1',
    token_endpoint: `${STAGING_API_ORIGIN}/oauth/token`,
    beezi_env: 'staging', beezi_revision: 'source-rev',
  });
  fs.mkdirSync(path.join(source, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(source, 'queue', 'seg-1.json'), '{"segmentId":"seg-1"}');
  fs.writeFileSync(path.join(source, 'accounts.json'), JSON.stringify({
    version: 1,
    default: key,
    accounts: [{ key, email: null, name: null, tenantId: null, tenantName: null, clientId: 'c-1', linkedAt: null, status: 'linked' }],
  }));
  fs.mkdirSync(path.join(source, 'accounts', key), { recursive: true });
  fs.writeFileSync(path.join(source, 'accounts', key, 'credentials.json'), JSON.stringify({ token: raw }));
  fs.writeFileSync(path.join(source, 'accounts', key, 'credential-control.json'),
    JSON.stringify({ version: 1, revision: 'source-rev', backend: 'file', beezi_env: 'staging' }));

  const result = ensureEnvironmentMigrated({
    env: '', home: () => source, preservedHome: () => destination,
    platform: 'linux', run: () => ({ ok: false, stdout: '' }),
  });

  assert.equal(result.status, 'migrated', result.message);
  // The blob and the authority record both land where the DESTINATION's KEYED reader looks.
  const moved = JSON.parse(fs.readFileSync(path.join(destination, 'accounts', key, 'credentials.json'), 'utf-8'));
  const authority = JSON.parse(fs.readFileSync(path.join(destination, 'accounts', key, 'credential-control.json'), 'utf-8'));
  assert.equal(JSON.parse(moved.token).beezi_env, 'staging');
  assert.equal(authority.beezi_env, 'staging');
  assert.equal(authority.revision, JSON.parse(moved.token).beezi_revision, 'the authority names the blob beside it');
  assert.ok(fs.existsSync(path.join(destination, 'queue', 'seg-1.json')), 'and the analytics came too');
  // Production starts fresh: the account directory goes with everything else.
  assert.equal(fs.existsSync(path.join(source, 'accounts')), false);
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
});
