// First import. SERVICE is a MODULE-LEVEL const in lib/credentials.mjs, built from envSuffix() and
// interpolated into the PowerShell templates at load, so BEEZI_ENV has to be gone before
// lib/login.mjs pulls that module in.
import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performLogin } from '../lib/login.mjs';
import { addAccount, listAccounts, getDefaultKey, AccountStatus } from '../lib/accounts.mjs';
import { setCredentials, getCredentials } from '../lib/credentials.mjs';
// Beside tools/account-fixtures.mjs, not under test/: Node's default patterns collect and COUNT
// every .mjs under test/, and test/hermetic.test.mjs fails the suite over a non-test file there.
import { makeHome, fakeKeyring, fakeCredMan, credentialBlob } from '../tools/account-fixtures.mjs';

function loginDeps(ring, answer, over = {}) {
  const unlinked = [];
  return {
    run: ring.run, platform: 'darwin',
    exchange: async () => credentialBlob({ access_token: 'new', client_id: 'c-new' }),
    whoami: async () => answer,
    unlinkMachine: async (session) => { unlinked.push(session.clientId); return true; },
    openBrowser: async () => true,
    unlinked,
    ...over,
  };
}

const ANSWER = { valid: true, email: 'a@example.com', name: 'Andrii', tenantId: 't-1', tenantName: 'Acme' };

test('1. the first login mints a key and becomes the default', async (t) => {
  makeHome(t);
  const result = await performLogin(loginDeps(fakeKeyring(), ANSWER));

  assert.equal(result.outcome, 'linked');
  assert.match(result.key, /^[0-9a-f]{8}$/);
  assert.equal(await getDefaultKey(), result.key);
  assert.equal((await listAccounts())[0].tenantName, 'Acme');
});

test('2. a second, different account does not become the default', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials('a1b2c3d4', credentialBlob(), { run: ring.run, platform: 'darwin' });
  await addAccount({ key: 'a1b2c3d4', email: 'first@example.com', tenantId: 't-0', clientId: 'c-0' });

  const result = await performLogin(loginDeps(ring, ANSWER));

  assert.equal(result.outcome, 'linked');
  assert.equal(await getDefaultKey(), 'a1b2c3d4');
  assert.equal(result.defaultKey, 'a1b2c3d4');
});

// Decision 6: a new client would move linkedAt and break "live tracking owns everything after".
test('3. re-login of a healthy account keeps the old credentials and unlinks the new client', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await setCredentials('a1b2c3d4', credentialBlob({ access_token: 'old', client_id: 'c-old' }), deps);
  await addAccount({ key: 'a1b2c3d4', email: 'a@example.com', tenantId: 't-1', clientId: 'c-old' });

  const d = loginDeps(ring, ANSWER);
  const result = await performLogin(d);

  assert.equal(result.outcome, 'already-linked');
  assert.equal((await getCredentials('a1b2c3d4', deps)).access_token, 'old');
  assert.deepEqual(d.unlinked, ['c-new']);
});

test('4. a revoked account is re-armed in place, keeping its key and linkedAt', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await addAccount({
    key: 'a1b2c3d4', email: 'a@example.com', tenantId: 't-1', clientId: 'c-old',
    linkedAt: '2026-01-01T00:00:00.000Z', status: AccountStatus.REVOKED,
  });

  const result = await performLogin(loginDeps(ring, ANSWER));

  assert.equal(result.outcome, 'relinked');
  assert.equal(result.key, 'a1b2c3d4');
  assert.equal(result.account.linkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.account.status, AccountStatus.LINKED);
  assert.equal((await getCredentials('a1b2c3d4', deps)).access_token, 'new');
});

// Decision 4: two users of one tenant would double-count that tenant's sessions.
test('5. a second user of an already linked tenant is refused', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials('a1b2c3d4', credentialBlob(), { run: ring.run, platform: 'darwin' });
  await addAccount({ key: 'a1b2c3d4', email: 'first@example.com', tenantId: 't-1', clientId: 'c-0' });

  const d = loginDeps(ring, { ...ANSWER, email: 'second@example.com' });
  const result = await performLogin(d);

  assert.equal(result.outcome, 'refused-same-tenant');
  assert.equal(result.key, null);
  assert.equal((await listAccounts()).length, 1, 'nothing was stored');
  assert.deepEqual(d.unlinked, ['c-new']);
});

// Against a portal older than ADO PR #3893 the refusal simply cannot fire.
test('6. a null tenantId skips the same-tenant check', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials('a1b2c3d4', credentialBlob(), { run: ring.run, platform: 'darwin' });
  await addAccount({ key: 'a1b2c3d4', email: 'first@example.com', tenantId: null, clientId: 'c-0' });

  const result = await performLogin(loginDeps(ring, { ...ANSWER, email: 'second@example.com', tenantId: null }));

  assert.equal(result.outcome, 'linked');
  assert.equal((await listAccounts()).length, 2);
});

// The re-arm branch must come BEFORE the tenant refusal. A revoked account whose tenant still has
// a live row is the exact case the two branches disagree about: re-ordered, the user who owns that
// row would be refused a repair of their own account.
test('7. a revoked account is repaired even while its tenant has another linked row', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { run: ring.run, platform: 'darwin' };
  await setCredentials('99887766', credentialBlob(), deps);
  await addAccount({ key: '99887766', email: 'colleague@example.com', tenantId: 't-1', clientId: 'c-1' });
  await addAccount({
    key: 'a1b2c3d4', email: 'a@example.com', tenantId: 't-1', clientId: 'c-old',
    status: AccountStatus.REVOKED,
  });

  const d = loginDeps(ring, ANSWER);
  const result = await performLogin(d);

  assert.equal(result.outcome, 'relinked');
  assert.equal(result.key, 'a1b2c3d4');
  assert.deepEqual(d.unlinked, [], 'a repair never throws away the grant it just minted');
});

// Windows keys a generic credential on its TARGET NAME — CredRead and CredDelete never see
// UserName. A login that let the key reach only the UserName would pass every darwin case above
// and still hand two accounts one shared entry.
test('8. on Windows each login lands under its own Credential Manager target', async (t) => {
  makeHome(t);
  const credman = fakeCredMan();
  const over = { run: credman.run, platform: 'win32' };

  const first = await performLogin(loginDeps(credman, ANSWER, over));
  const second = await performLogin(loginDeps(
    credman,
    { ...ANSWER, email: 'b@example.com', tenantId: 't-2', tenantName: 'Beta' },
    over,
  ));

  assert.notEqual(first.key, second.key);
  assert.equal(credman.store.size, 2, 'one Credential Manager target per account');
  const targets = [...credman.store.keys()];
  assert.ok(targets.some((t2) => t2.indexOf(first.key) !== -1), 'the first account key names its target');
  assert.ok(targets.some((t2) => t2.indexOf(second.key) !== -1), 'the second account key names its target');
});
