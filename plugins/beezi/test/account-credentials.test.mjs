// First import. SERVICE is a MODULE-LEVEL const built from envSuffix() and interpolated into the
// PowerShell templates at load, so BEEZI_ENV has to be gone before lib/credentials.mjs evaluates.
import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE,
  getCredentials,
  setCredentials,
  deleteCredentials,
  readLegacyCredential,
} from '../lib/credentials.mjs';
// Beside tools/suite-fixtures.mjs, not under test/: Node's default patterns collect and COUNT
// every .mjs under test/, and test/hermetic.test.mjs fails the suite over a non-test file there.
import {
  makeHome, fakeKeyring, fakeCredMan, credentialBlob, entryId,
} from '../tools/account-fixtures.mjs';

test('1. two accounts occupy two entries and never read each other', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };

  await setCredentials('a1b2c3d4', credentialBlob({ access_token: 'first' }), deps);
  await setCredentials('99887766', credentialBlob({ access_token: 'second' }), deps);

  assert.equal((await getCredentials('a1b2c3d4', deps)).access_token, 'first');
  assert.equal((await getCredentials('99887766', deps)).access_token, 'second');
  assert.equal(ring.store.size, 2, 'one keyring entry per account');
});

test('2. deleting one account leaves the other linked', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await setCredentials('a1b2c3d4', credentialBlob(), deps);
  await setCredentials('99887766', credentialBlob(), deps);

  await deleteCredentials('a1b2c3d4', deps);

  assert.equal(await getCredentials('a1b2c3d4', deps), null);
  assert.notEqual(await getCredentials('99887766', deps), null);
});

test('3. an invalid key is refused before it reaches a backend', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await assert.rejects(() => getCredentials("a1b2'c3d", deps), /account key/i);
  assert.equal(ring.calls.length, 0, 'no backend was spawned for a bad key');
});

// linkedSessions() reads every account at once. On Windows each read is a PowerShell spawn with a
// 5s kill timeout, so the module must hold no per-call shared state that concurrent reads corrupt.
test('4. concurrent reads of different accounts do not interfere', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await setCredentials('a1b2c3d4', credentialBlob({ access_token: 'first' }), deps);
  await setCredentials('99887766', credentialBlob({ access_token: 'second' }), deps);

  const [a, b, missing] = await Promise.all([
    getCredentials('a1b2c3d4', deps),
    getCredentials('99887766', deps),
    getCredentials('deadbeef', deps),
  ]);

  assert.equal(a.access_token, 'first');
  assert.equal(b.access_token, 'second');
  assert.equal(missing, null, 'an unlinked key resolves to null, not a throw');
});

// The pre-0.13 entry. Only the migration reads it; nothing else may.
test('5. the legacy token entry is readable only through readLegacyCredential', async (t) => {
  makeHome(t);
  const ring = fakeKeyring({
    [entryId(SERVICE, 'token')]: JSON.stringify(credentialBlob({ access_token: 'legacy' })),
  });
  const deps = { run: ring.run, platform: 'darwin' };

  assert.equal(await getCredentials('a1b2c3d4', deps), null, 'a keyed read must not find the legacy entry');
  assert.equal((await readLegacyCredential(deps)).access_token, 'legacy');
});

// ── Windows: the Credential Manager keys on the TARGET NAME ───────────────────────────────────
//
// Tests 1-5 run on darwin, where `security` keys on (service, account) and fakeKeyring models that
// faithfully. advapi32 does not: a generic credential is identified by TargetName + Type, and
// CredRead/CredDelete never look at UserName. Putting the key in the UserName alone therefore
// passes every case above while every account on the machine shares ONE entry — so tests 1, 2 and 5
// are repeated here against a fake that keys on the target and nothing else.

test('6. on Windows two accounts occupy two Credential Manager targets', async (t) => {
  makeHome(t);
  const credman = fakeCredMan();
  const deps = { run: credman.run, platform: 'win32' };

  await setCredentials('a1b2c3d4', credentialBlob({ access_token: 'first' }), deps);
  await setCredentials('99887766', credentialBlob({ access_token: 'second' }), deps);

  assert.equal((await getCredentials('a1b2c3d4', deps)).access_token, 'first');
  assert.equal((await getCredentials('99887766', deps)).access_token, 'second');
  assert.equal(credman.store.size, 2, 'one Credential Manager target per account');
  assert.deepEqual(
    [...credman.store.keys()].sort(),
    [`${SERVICE}:99887766`, `${SERVICE}:a1b2c3d4`],
    'the account key is part of the target, not just the UserName',
  );
});

test('7. on Windows deleting one account leaves the other linked', async (t) => {
  makeHome(t);
  const credman = fakeCredMan();
  const deps = { run: credman.run, platform: 'win32' };
  await setCredentials('a1b2c3d4', credentialBlob(), deps);
  await setCredentials('99887766', credentialBlob(), deps);

  await deleteCredentials('a1b2c3d4', deps);

  assert.equal(await getCredentials('a1b2c3d4', deps), null);
  assert.notEqual(await getCredentials('99887766', deps), null);
  assert.deepEqual([...credman.store.keys()], [`${SERVICE}:99887766`]);
});

// The pre-0.13 target has NO key suffix — suffix it and the one-time migration sees an unlinked
// machine and publishes an empty index over a real login.
test('8. on Windows the legacy target is the bare service name, and keyed reads never reach it', async (t) => {
  makeHome(t);
  const credman = fakeCredMan({
    [SERVICE]: JSON.stringify(credentialBlob({ access_token: 'legacy' })),
  });
  const deps = { run: credman.run, platform: 'win32' };

  assert.equal(await getCredentials('a1b2c3d4', deps), null, 'a keyed read must not find the legacy entry');
  assert.equal((await readLegacyCredential(deps)).access_token, 'legacy');
});
