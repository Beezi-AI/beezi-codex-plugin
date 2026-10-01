import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AccountStatus,
  newAccountKey,
  readIndex,
  listAccounts,
  getAccount,
  findByEmail,
  findByTenant,
  getDefaultKey,
  setDefault,
  addAccount,
  updateAccount,
  removeAccount,
  describeAccount,
  resolveAccountRef,
  parseAccountFlag,
} from '../lib/accounts.mjs';
import { accountsIndexFile, accountDir } from '../lib/paths.mjs';
import { makeHome, fakeKeyring } from '../tools/account-fixtures.mjs';

const row = (over = {}) => ({
  key: 'a1b2c3d4', email: 'A@Example.com', name: 'Andrii',
  tenantId: 't-1', tenantName: 'Acme', clientId: 'c-1', ...over,
});

// The credential store is INJECTED here, and must stay injected: with no index on disk, readIndex
// runs the pre-0.13 migration, and the migration's first act is to read the legacy keyring entry.
// lib/credentials.mjs reaches the OS store through a named `import { execFileSync }`, which
// tools/hermetic-env.mjs cannot wrap — so an uninjected run on a developer who still has a real
// pre-0.13 login would read it, write a keyed entry, and then DELETE the legacy one for real.
test('1. an empty root reads as no accounts', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  assert.deepEqual(await readIndex({ run: ring.run, platform: 'darwin' }),
    { version: 1, default: null, accounts: [] });
});

test('2. the first account added becomes the default and gets a directory', async (t) => {
  makeHome(t);
  await addAccount(row());
  assert.equal(await getDefaultKey(), 'a1b2c3d4');
  assert.ok(fs.existsSync(accountDir('a1b2c3d4')));
});

test('3. a second account does not steal the default', async (t) => {
  makeHome(t);
  await addAccount(row());
  await addAccount(row({ key: '99887766', email: 'b@example.com', tenantId: 't-2' }));
  assert.equal(await getDefaultKey(), 'a1b2c3d4');
  assert.equal((await listAccounts()).length, 2);
});

test('4. email lookup is case-insensitive and stored folded', async (t) => {
  makeHome(t);
  await addAccount(row());
  assert.equal((await findByEmail('a@EXAMPLE.com')).key, 'a1b2c3d4');
  assert.equal((await listAccounts())[0].email, 'a@example.com');
});

// Decision 4: fan-out into a tenant that already has an account would double-count its sessions.
test('5. tenant lookup only matches a linked account', async (t) => {
  makeHome(t);
  await addAccount(row());
  assert.equal((await findByTenant('t-1')).key, 'a1b2c3d4');
  await updateAccount('a1b2c3d4', { status: AccountStatus.REVOKED });
  assert.equal(await findByTenant('t-1'), null);
  // null and undefined both mean "leave it alone": no caller clears a field.
  await updateAccount('a1b2c3d4', { email: null, name: undefined, tenantName: 'Acme Two' });
  const kept = await getAccount('a1b2c3d4');
  assert.equal(kept.email, 'a@example.com');
  assert.equal(kept.name, 'Andrii');
  assert.equal(kept.tenantName, 'Acme Two');
});

test('6. removing an account clears the default and its directory', async (t) => {
  makeHome(t);
  await addAccount(row());
  await removeAccount('a1b2c3d4');
  assert.equal(await getDefaultKey(), null);
  assert.equal(fs.existsSync(accountDir('a1b2c3d4')), false);
  assert.equal((await listAccounts()).length, 0);
});

// A lone linked account is the default in memory, so a truncated write is never a dead end.
test('7. a lost default resolves to the only linked account', async (t) => {
  makeHome(t);
  await addAccount(row());
  const raw = JSON.parse(fs.readFileSync(accountsIndexFile(), 'utf-8'));
  raw.default = null;
  fs.writeFileSync(accountsIndexFile(), JSON.stringify(raw), 'utf-8');
  assert.equal(await getDefaultKey(), 'a1b2c3d4');
});

// Nothing is deleted on this path: a corrupt file is a reason to refuse, not to reset.
test('8. a corrupt index reads empty and refuses mutation', async (t) => {
  makeHome(t);
  fs.mkdirSync(path.dirname(accountsIndexFile()), { recursive: true });
  fs.writeFileSync(accountsIndexFile(), '{ torn wri', 'utf-8');
  assert.deepEqual((await readIndex()).accounts, []);
  await assert.rejects(() => setDefault('a1b2c3d4'), /unreadable/i);
});

test('9. refs resolve by key, email or 1-based position', async (t) => {
  makeHome(t);
  await addAccount(row());
  await addAccount(row({ key: '99887766', email: 'b@example.com', tenantId: 't-2' }));
  assert.equal(await resolveAccountRef('99887766'), '99887766');
  assert.equal(await resolveAccountRef('B@example.com'), '99887766');
  assert.equal(await resolveAccountRef('2'), '99887766');
  await assert.rejects(() => resolveAccountRef('nope'), /No linked account matches/);
});

test('10. parseAccountFlag strips the flag and resolves it', async (t) => {
  makeHome(t);
  await addAccount(row());
  const parsed = await parseAccountFlag(['--via', 'login', '--account', 'a1b2c3d4', '--force']);
  assert.equal(parsed.account, 'a1b2c3d4');
  assert.deepEqual(parsed.rest, ['--via', 'login', '--force']);
  await assert.rejects(() => parseAccountFlag(['--account']), /needs a value/);
});

test('11. newAccountKey mints 8 lowercase hex characters', () => {
  for (let i = 0; i < 50; i += 1) assert.match(newAccountKey(), /^[0-9a-f]{8}$/);
});

test('12. describeAccount degrades gracefully', () => {
  assert.match(describeAccount({ name: 'A', email: 'a@x.io', tenantName: 'Acme' }), /^A <a@x\.io>/);
  assert.equal(describeAccount({ name: null, email: null, tenantName: null }), 'linked account (no name or email recorded)');
});

// accounts.json is hand-editable, so a row can arrive carrying a type no reader expects. Degrading
// is this module's whole error story; a bare TypeError out of a hook or a login is not.
test('13. a row whose email is not a string reads back as no email, and never throws', async (t) => {
  makeHome(t);
  await addAccount(row());
  const raw = JSON.parse(fs.readFileSync(accountsIndexFile(), 'utf-8'));
  raw.accounts.push({ key: '99887766', email: 123, tenantId: 't-2', status: 'linked' });
  raw.accounts.push({ key: 'deadbeef', email: { at: 'x' }, tenantId: 't-3', status: 'linked' });
  fs.writeFileSync(accountsIndexFile(), JSON.stringify(raw), 'utf-8');

  const accounts = await listAccounts();
  assert.equal(accounts.length, 3);
  assert.equal(accounts[1].email, null);
  assert.equal(accounts[2].email, null);
  // The good row is still found, and the malformed ones simply do not match.
  assert.equal((await findByEmail('a@EXAMPLE.com')).key, 'a1b2c3d4');
  assert.equal(await findByEmail('123'), null);
  assert.equal(await findByEmail('[object Object]'), null);
  await assert.rejects(() => resolveAccountRef('nope'), /No linked account matches/);
  assert.equal(await resolveAccountRef('2'), '99887766');
});
