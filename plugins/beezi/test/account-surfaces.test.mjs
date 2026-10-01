import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderList, useAccount } from '../lib/accounts-cli.mjs';
import { logoutAccount, logoutAll } from '../lib/logout.mjs';
import { meLines } from '../lib/me.mjs';
import { addAccount, listAccounts, getDefaultKey } from '../lib/accounts.mjs';
import { setCredentials } from '../lib/credentials.mjs';
import { accountDir } from '../lib/paths.mjs';
import { SERVICE } from '../lib/credentials.mjs';
import { acquireLock, sharedLock } from '../lib/single-instance-lock.mjs';
import {
  makeHome, fakeKeyring, fakeCredMan, credentialBlob, entryId,
} from '../tools/account-fixtures.mjs';

// The three surfaces that let a user SEE and REMOVE the accounts login linked: `accounts`,
// `logout` and `me`. All three live in lib/ rather than in their scripts — tools/hermetic-env.mjs
// guards child_process, so a test that spawned scripts/accounts.mjs would prove the sandbox works
// and nothing else.

const KEY_A = 'a1b2c3d4';
const KEY_B = '99887766';

// The environment guard is INJECTED for the reason test/account-fanout.test.mjs states: the real
// checkEnvironment() reaches the credential store with the REAL runner, so against a fake keyring
// it cannot read the entry just written, classifies the root as unverifiable, and blocks every
// token with 'environment-blocked' — which would silently turn every server round-trip below into
// the local-only branch. The guard has its own tests; what is under test here is which ACCOUNT a
// bearer, a client id and a deletion belong to.
function makeDeps(ring, platform = 'darwin') {
  const deps = {
    run: ring.run,
    platform,
    checkEnvironment: () => ({ status: 'ok' }),
    // The server round-trip logout makes. Recorded so a test can assert it used the RIGHT account.
    unlinkMachine: async (session) => { deps.unlinked.push(session.clientId); return true; },
    unlinked: [],
  };
  return deps;
}

async function two(t, ring = fakeKeyring(), platform = 'darwin') {
  const home = makeHome(t);
  const deps = makeDeps(ring, platform);
  for (const key of [KEY_A, KEY_B]) {
    await setCredentials(key, credentialBlob({ client_id: `c-${key}` }), deps);
    await addAccount({
      key, email: `${key}@example.com`, name: key,
      tenantId: `t-${key}`, tenantName: `W-${key}`, clientId: `c-${key}`,
    });
  }
  return { home, deps, ring };
}

// A logout whose portal round-trip fails, so the revoke fallback and then the local branch are the
// ones under test. `fetchImpl` is the seam revokeAtAuthServer takes: without it these cases would
// POST to whatever token_endpoint the fixture carries, out of the hermetic sandbox.
function offlinePortal(deps, revokeOk) {
  const out = { ...deps, unlinkMachine: async () => false, revokeCalls: [] };
  out.fetchImpl = async () => {
    out.revokeCalls.push(1);
    return { ok: revokeOk, status: revokeOk ? 200 : 503 };
  };
  return out;
}

test('1. the list is numbered, marks the default, and needs no network', async (t) => {
  const { deps } = await two(t);
  // OFFLINE means two things, and only one of them is a fetch: the list must resolve no token
  // either. Both seams throw, so a renderList that reached for a bearer — a credential-store read
  // on darwin is `security`, i.e. `run` — fails here rather than merely being slow.
  const offline = {
    ...deps,
    run: () => { throw new Error('the list must not touch the credential store'); },
    fetchImpl: () => { throw new Error('the list must be offline'); },
  };
  const out = await renderList(offline);
  assert.match(out, /1\./);
  assert.match(out, /2\./);
  assert.match(out, /default/i);
  assert.match(out, new RegExp(KEY_A));
});

test('2. useAccount switches the default by position', async (t) => {
  const { deps } = await two(t);
  const result = await useAccount('2', deps);
  assert.equal(result.key, KEY_B);
  assert.equal(await getDefaultKey(), KEY_B);
});

test('3. useAccount rejects a ref that matches nothing, leaving the default alone', async (t) => {
  const { deps } = await two(t);
  await assert.rejects(() => useAccount('nope', deps), /No linked account matches/);
  assert.equal(await getDefaultKey(), KEY_A);
});

test('4. logging out one account unlinks that account’s own client and applies the next default', async (t) => {
  const { deps } = await two(t);
  await logoutAccount(KEY_A, { nextDefault: KEY_B }, deps);

  assert.deepEqual(deps.unlinked, [`c-${KEY_A}`], 'unlinked its own client, not the other');
  assert.deepEqual((await listAccounts()).map((a) => a.key), [KEY_B]);
  assert.equal(await getDefaultKey(), KEY_B);
  assert.equal(fs.existsSync(accountDir(KEY_A)), false);
});

test('5. logoutAll empties the index but keeps machine-level files', async (t) => {
  const { home, deps } = await two(t);
  // One file from each machine-level family logout must never reach.
  fs.writeFileSync(path.join(home, 'billing.json'), '{"source":"subscription"}', 'utf-8');
  fs.writeFileSync(path.join(home, 'telemetry.json'), '{"enabled":false}', 'utf-8');
  fs.writeFileSync(path.join(home, 'repo-map.json'), '{"repos":[]}', 'utf-8');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'session.json'), '{}', 'utf-8');

  await logoutAll(deps);

  assert.deepEqual(await listAccounts(), []);
  assert.equal(await getDefaultKey(), null);
  assert.ok(fs.existsSync(path.join(home, 'billing.json')), 'billing.json is machine-level');
  assert.ok(fs.existsSync(path.join(home, 'telemetry.json')), 'telemetry.json is machine-level');
  assert.ok(fs.existsSync(path.join(home, 'repo-map.json')), 'repo-map.json is machine-level');
  assert.ok(fs.existsSync(path.join(home, 'state', 'session.json')), 'state/ is machine-level');
  assert.equal(deps.unlinked.length, 2, 'every account was unlinked server-side');
});

// The Windows credential store is keyed by TARGET NAME ALONE, which is the keyspace a
// (service, account) fake cannot model — and the one that hid a defect in Task 3. A logout that
// deleted by UserName would clear the whole machine's entry and the sibling account would lose its
// credentials as collateral.
test('6. logging out one account on Windows deletes only that account’s credential target', async (t) => {
  const ring = fakeCredMan();
  const { deps } = await two(t, ring, 'win32');
  assert.equal(ring.store.size, 2, 'the fixture wrote one target per account');

  await logoutAccount(KEY_A, {}, deps);

  const remaining = Array.from(ring.store.keys());
  assert.equal(remaining.length, 1, 'exactly one credential target survived');
  assert.ok(remaining[0].includes(KEY_B), `the surviving target belongs to ${KEY_B}: ${remaining[0]}`);
  assert.ok(!remaining[0].includes(KEY_A), 'the logged-out account’s target is gone');
});

// The darwin keyspace pinned the same way, so the two stores are checked against one another.
test('7. logging out one account on macOS deletes only that account’s keyring entry', async (t) => {
  const ring = fakeKeyring();
  const { deps } = await two(t, ring);
  assert.equal(ring.store.size, 2);

  await logoutAccount(KEY_A, {}, deps);

  assert.deepEqual(Array.from(ring.store.keys()), [entryId(SERVICE, KEY_B)]);
});

// ── the branches the outcome sentence is chosen from ─────────────────────────────────────────
//
// Every test above injects an `unlinkMachine` that succeeds, so only the first of the four
// outcomes was ever exercised. These drive the other three. They are reachable only because
// revokeAtAuthServer takes `deps.fetchImpl` — without that seam this file would POST to the
// fixture's token_endpoint from inside the hermetic sandbox.

test('16. when the portal is unreachable the grant is revoked at the authorization server', async (t) => {
  const { deps } = await two(t);
  const offline = offlinePortal(deps, true);
  const result = await logoutAccount(KEY_A, {}, offline);

  assert.equal(offline.revokeCalls.length, 1, 'the revoke fallback ran');
  assert.equal(result.revoked, true);
  assert.match(result.lines.join('\n'), /Logged out .* and access revoked\./);
  assert.match(result.lines.join('\n'), /Connections tab/);
});

test('17. when neither the portal nor the auth server answers, the logout is local only', async (t) => {
  const { deps } = await two(t);
  const offline = offlinePortal(deps, false);
  const result = await logoutAccount(KEY_A, {}, offline);

  assert.equal(result.serverUnlinked, false);
  assert.equal(result.revoked, false);
  assert.match(result.lines.join('\n'), /Logged out .* locally\./);
  assert.match(result.lines.join('\n'), /Could not reach the server/);
  assert.deepEqual((await listAccounts()).map((a) => a.key), [KEY_B], 'the account left anyway');
});

// An account whose grant the SERVER already killed: getAuthentication deletes the credentials on
// invalid_grant and marks the row revoked, so there is no session and nothing to revoke. Blaming
// the network for that is the misdiagnosis this branch exists to prevent.
test('18. an already-revoked account is not reported as a network failure', async (t) => {
  makeHome(t);
  const deps = makeDeps(fakeKeyring());
  await addAccount({ key: KEY_A, email: 'gone@example.com', name: 'Gone', status: 'revoked' });
  const result = await logoutAccount(KEY_A, {}, { ...deps, fetchImpl: async () => { throw new Error('no network'); } });

  const out = result.lines.join('\n');
  assert.match(out, /already been revoked, so there was nothing left to unlink/);
  assert.doesNotMatch(out, /Could not reach the server/);
  assert.deepEqual(await listAccounts(), []);
});

test('19. logging out the default with two accounts left says no default is set', async (t) => {
  const { deps } = await two(t);
  const KEY_C = '55443322';
  await setCredentials(KEY_C, credentialBlob({ client_id: `c-${KEY_C}` }), deps);
  await addAccount({ key: KEY_C, email: `${KEY_C}@example.com`, name: KEY_C, clientId: `c-${KEY_C}` });

  const result = await logoutAccount(KEY_A, {}, deps);

  assert.equal(await getDefaultKey(), null, 'two linked rows left, so nothing is auto-elected');
  assert.match(result.lines.join('\n'), /No default account is set/);
});

// setDefault checks index membership only, and normalize() auto-elects solely when the default is
// MISSING — never when it is revoked. So an unqualified "analytics now read from" would promise
// reporting the account cannot do.
test('20. handing the default to a revoked account says it cannot report', async (t) => {
  makeHome(t);
  const deps = makeDeps(fakeKeyring());
  await setCredentials(KEY_A, credentialBlob({ client_id: `c-${KEY_A}` }), deps);
  await addAccount({ key: KEY_A, email: `${KEY_A}@example.com`, name: KEY_A, clientId: `c-${KEY_A}` });
  await addAccount({ key: KEY_B, email: `${KEY_B}@example.com`, name: KEY_B, status: 'revoked' });

  const result = await logoutAccount(KEY_A, { nextDefault: KEY_B }, deps);

  assert.equal(await getDefaultKey(), KEY_B);
  const out = result.lines.join('\n');
  assert.match(out, /Analytics now read from/);
  assert.match(out, /access was revoked, so it cannot report/);
});

test('21. useAccount says so when the account chosen is revoked', async (t) => {
  makeHome(t);
  const deps = makeDeps(fakeKeyring());
  await addAccount({ key: KEY_A, email: `${KEY_A}@example.com`, name: KEY_A });
  await addAccount({ key: KEY_B, email: `${KEY_B}@example.com`, name: KEY_B, status: 'revoked' });

  const result = await useAccount('2', deps);

  assert.equal(result.key, KEY_B);
  assert.match(result.lines.join('\n'), /access was revoked, so it cannot report/);
});

// Nothing is printed until logoutAll returns, so a throw partway through used to discard the
// outcome lines for every account already gone and leave the caller with an error alone — which
// the skill then relayed as "nothing was unlinked". mutate() is an immediate-fail lock, so any
// concurrent index write is enough to cause it; holding the lock here reproduces exactly that.
test('22. logoutAll reports every account even when the index write is refused', async (t) => {
  const { deps } = await two(t);
  const held = acquireLock(sharedLock('accounts-index'), { leaseMs: 30_000 });
  assert.equal(held.ok, true, 'the test holds the lock logoutAll needs');
  t.after(() => held.handle.release());

  const result = await logoutAll(deps);

  assert.deepEqual(result.failed, [KEY_A, KEY_B], 'it continued past the first failure');
  const out = result.lines.join('\n');
  assert.match(out, new RegExp(`✗ .*${KEY_A}`), 'the first account is named');
  assert.match(out, new RegExp(`✗ .*${KEY_B}`), 'and so is the second');
  assert.match(out, /2 of 2 accounts could not be fully logged out/);
  assert.equal((await listAccounts()).length, 2, 'the index ROWS survived — nothing else did');
});

// THE POINT OF THE SENTENCE. The index lock blocks removeAccount and nothing before it: the portal
// unlink, the revoke and the credential delete have all committed by then. A closing line saying
// those accounts "are still linked" was false in every particular except the row, and it sent the
// user to the portal to remove machines that were already gone.
test('23. a refused index write happens AFTER the accounts are signed out everywhere else', async (t) => {
  const { deps, ring } = await two(t);
  assert.equal(ring.store.size, 2);
  const held = acquireLock(sharedLock('accounts-index'), { leaseMs: 30_000 });
  t.after(() => held.handle.release());

  const result = await logoutAll(deps);

  assert.deepEqual(deps.unlinked, [`c-${KEY_A}`, `c-${KEY_B}`], 'both were unlinked at the portal');
  assert.equal(ring.store.size, 0, 'both credential entries were deleted');
  const out = result.lines.join('\n');
  assert.doesNotMatch(out, /still linked/, 'the accounts are NOT still linked');
  assert.match(out, /was signed out, but its row could not be removed/);
  assert.match(out, /Run the command again to finish/);
});

// The re-run the message above tells the user to make. It must not invent a network failure: there
// is nothing left to reach the server about, and the portal row the old wording sent them to
// delete was removed by the first run.
test('24. re-running after a partial logout does not report a network failure', async (t) => {
  const { deps } = await two(t);
  const held = acquireLock(sharedLock('accounts-index'), { leaseMs: 30_000 });
  await logoutAll(deps);
  held.handle.release();
  deps.unlinked.length = 0;

  const again = await logoutAll(deps);

  const out = again.lines.join('\n');
  assert.deepEqual(again.failed, [], 'the second run finishes the job');
  assert.match(out, /no usable credentials for it here, so Beezi was not contacted/);
  assert.doesNotMatch(out, /Could not reach the server/, 'no network failure is invented');
  // REWRITTEN. This used to assert the Connections-tab remedy was ABSENT, on the reasoning that
  // the first run had already unlinked. That reasoning only holds when the first run's unlink
  // SUCCEEDED — and this machine cannot tell: an offline first run deletes the credentials and
  // leaves the portal row live, reaching this very branch. The old assertion pinned my own false
  // claim, so it is replaced by the conditional remedy that is true either way.
  assert.match(out, /If this account is still listed in the portal's Connections tab/);
  assert.deepEqual(await listAccounts(), []);
  assert.deepEqual(deps.unlinked, [], 'nothing was left to unlink');
});

test('25. logging out a key that is not in the index is refused, not half-done', async (t) => {
  const { deps } = await two(t);
  await assert.rejects(() => logoutAccount('deadbeef', {}, deps), /No linked account matches/);
  assert.equal((await listAccounts()).length, 2);
});

// The `--account X --next-default Y` partial. I previously reported this as untestable because the
// lock interleaving has no seam — true of the CAUSE, not of the branch: setDefault raises the same
// UserError for a key that is not in the index as for a row a concurrent process just removed, so
// one call reaches the catch with no production change at all.
test('26. a next-default that cannot be applied does not discard the logout that already happened', async (t) => {
  const { deps } = await two(t);
  const result = await logoutAccount(KEY_A, { nextDefault: 'deadbeef' }, deps);

  const out = result.lines.join('\n');
  assert.match(out, /Logged out/, 'the logout is still reported');
  assert.match(out, /the new default could not be set/);
  assert.deepEqual((await listAccounts()).map((a) => a.key), [KEY_B], 'and it really happened');
  assert.deepEqual(deps.unlinked, [`c-${KEY_A}`]);
});

// ── the three states whose sentence used to lie about them ───────────────────────────────────
//
// Found by RUNNING the branch table over its reachable states rather than reading it. Each of
// these produced a ✓ sentence that was true of the state it was written for and false of the
// state that actually reached it.

// lib/credentials.mjs states the rule in capitals: "UNREADABLE" AND "NEVER LINKED" MUST NOT LOOK
// THE SAME. A locked keychain throws CREDENTIALS_UNAVAILABLE; collapsing that to null told the
// user nothing was stored — while the credentials sat on disk and the grant stayed live.
test('27. a store that cannot be read is not reported as a store that was never written', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const base = { run: ring.run, platform: 'darwin', checkEnvironment: () => ({ status: 'ok' }) };
  await setCredentials(KEY_A, credentialBlob({ client_id: `c-${KEY_A}` }), base);
  await addAccount({ key: KEY_A, email: `${KEY_A}@example.com`, name: KEY_A, clientId: `c-${KEY_A}` });

  const unlinked = [];
  const locked = {
    ...base,
    // The entry is there; reading it fails. The control file still names a committed backend, so
    // lib/credentials.mjs raises rather than answering "absent".
    run: (file, args, input) => (args[0] === 'find-generic-password' ? { ok: false, stdout: '' } : ring.run(file, args, input)),
    unlinkMachine: async (s) => { unlinked.push(s.clientId); return true; },
    fetchImpl: async () => { throw new Error('the auth server must not be reached either'); },
  };
  const result = await logoutAccount(KEY_A, {}, locked);

  const out = result.lines.join('\n');
  assert.match(out, /saved credentials could not be read, so Beezi was not contacted/);
  assert.doesNotMatch(out, /No usable credentials|no usable credentials/, 'it does not claim nothing was stored');
  assert.match(out, /If this account is still listed in the portal's Connections tab/, 'the remedy survives');
  assert.deepEqual(unlinked, [], 'nothing was attempted, so nothing may be claimed about the portal');
});

// The unlink and the revoke are both best-effort, so removeAccount can fail with NOTHING signed
// out anywhere. "was signed out" then sent the user past a portal cleanup that had never happened.
test('28. a refused index write with an offline portal does not claim the account was signed out', async (t) => {
  const { deps } = await two(t);
  const offline = offlinePortal(deps, false);
  const held = acquireLock(sharedLock('accounts-index'), { leaseMs: 30_000 });
  t.after(() => held.handle.release());

  const result = await logoutAll(offline);

  const out = result.lines.join('\n');
  assert.equal(deps.unlinked.length, 0, 'the portal was never successfully contacted');
  assert.match(out, /could not be signed out at Beezi, and its row could not be removed/);
  assert.doesNotMatch(out, /was signed out, but its row/, 'the grant is alive — do not say it was signed out');
  assert.match(out, /2 of 2 accounts could not be fully logged out/);
});

// The row says revoked, but the credentials are readable, so the unlink AND the revoke both ran
// and both failed. Claiming "there was nothing left to unlink" after trying twice is the same
// family of falsehood; the branch is now guarded on whether anything was attempted.
test('29. a revoked row whose unlink was attempted and failed reports the failure, not "nothing to unlink"', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const base = { run: ring.run, platform: 'darwin', checkEnvironment: () => ({ status: 'ok' }) };
  await setCredentials(KEY_A, credentialBlob({ client_id: `c-${KEY_A}` }), base);
  await addAccount({ key: KEY_A, email: `${KEY_A}@example.com`, name: KEY_A, clientId: `c-${KEY_A}`, status: 'revoked' });

  const result = await logoutAccount(KEY_A, {}, {
    ...base, unlinkMachine: async () => false, fetchImpl: async () => ({ ok: false, status: 503 }),
  });

  const out = result.lines.join('\n');
  assert.match(out, /Could not reach the server/);
  assert.doesNotMatch(out, /nothing left to unlink/, 'it tried twice — it cannot say there was nothing to try');
});

// ── me ───────────────────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: KEY_A, email: `${KEY_A}@example.com`, name: 'Ada', tenantId: `t-${KEY_A}`,
    tenantName: 'Acme', clientId: `c-${KEY_A}`, status: 'linked' },
  { key: KEY_B, email: null, name: null, tenantId: null,
    tenantName: null, clientId: null, status: 'linked' },
];

function meDeps(over = {}) {
  return {
    apiBase: 'https://api.test',
    listAccounts: async () => ROWS,
    getDefaultKey: async () => KEY_A,
    getAuthentication: async (key) => (key === KEY_A
      ? { state: 'ready', accessToken: 'tok', clientId: `c-${KEY_A}` }
      : { state: 'unlinked', accessToken: null, clientId: null }),
    whoami: async () => ({ valid: true, email: `${KEY_A}@example.com`, name: 'Ada',
      tenantName: 'Acme', tenantTier: 'pro', trackingMode: 'live', backfillCompleted: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['session-start'], broken: [] }),
    ensureHooks: () => ({ repaired: false, launcherRefreshed: false, before: 'installed' }),
    ...over,
  };
}

test('8. me heads the report with the account count and names the default once', async (t) => {
  makeHome(t);
  const out = (await meLines(meDeps())).join('\n');
  assert.match(out, /2 accounts linked/);
  assert.match(out, /reads from the default/);
  assert.equal(out.match(/hooks are installed/gi).length, 1, 'the hook verdict is machine-level');
});

test('9. me marks the default, names the plan and mode, and keeps an unnamed account readable', async (t) => {
  makeHome(t);
  const out = (await meLines(meDeps())).join('\n');
  assert.match(out, /Ada <a1b2c3d4@example\.com> - Acme/);
  assert.match(out, /default/i);
  assert.match(out, /pro/);
  assert.match(out, /live/);
  // A pre-0.13 row migrated into the index has no email yet.
  assert.match(out, /linked account \(no name or email recorded\)/);
});

test('10. me tells an expired account apart from a revoked one', async (t) => {
  makeHome(t);
  const rows = [
    { ...ROWS[0], status: 'revoked' },
    { ...ROWS[1], email: 'b@example.com', name: 'Bee' },
  ];
  const out = (await meLines(meDeps({
    listAccounts: async () => rows,
    getAuthentication: async () => ({ state: 'unlinked', accessToken: null, clientId: null }),
  }))).join('\n');
  // Same authState for both rows — only the index row's status tells them apart, which is exactly
  // why markAccountRevoked writes it: it deletes the credentials first, so the token layer answers
  // 'no credentials' for a revoked grant and for a never-stored one alike.
  assert.match(out, /revoked/i);
  assert.match(out, /expired/i);
});

test('11. me falls back to the unlinked message when nothing is linked', async (t) => {
  makeHome(t);
  const out = (await meLines(meDeps({ listAccounts: async () => [], getDefaultKey: async () => null }))).join('\n');
  assert.match(out, /not linked to Beezi/);
  assert.doesNotMatch(out, /accounts linked/);
});

// ── the skill contracts, two-sided ───────────────────────────────────────────────────────────
//
// Both skills branch on OUTPUT TEXT the scripts produce and nothing else, so a reworded line on
// either side silently re-labels one outcome as another. Each row asserts BOTH halves: the script
// still prints the fragment AND the skill still carries the phrase it branches on. Either
// assertion alone passes happily while the contract is broken — the shape
// test/login-surface.test.mjs uses.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');

test('12. accounts skill — every shape scripts/accounts.mjs prints is branched on', () => {
  const skill = read('skills', 'accounts', 'SKILL.md');
  const outcomes = [
    [['lib', 'accounts-cli.mjs'], 'No Beezi accounts are linked on this machine.', /No Beezi accounts are linked on this machine/],
    [['lib', 'accounts-cli.mjs'], 'linked. The default is the account', /linked\. The default is the account/],
    [['lib', 'accounts-cli.mjs'], 'Analytics now read from', /Analytics now read from/],
    [['lib', 'accounts-cli.mjs'], 'access was revoked, so it cannot report', /access was revoked, so it cannot report/],
    [['scripts', 'accounts.mjs'], 'Usage: accounts.mjs [list|use <account>]', /Usage: accounts\.mjs \[list\|use <account>\]/],
    [['scripts', 'accounts.mjs'], '✗ ${friendlyMessage(error)}', /✗/],
  ];
  for (const [file, fragment, inSkill] of outcomes) {
    assert.ok(read(...file).includes(fragment),
      `${file.join('/')} should still print "${fragment}" — the accounts skill branches on it`);
    assert.match(skill, inSkill, `skills/accounts/SKILL.md should still branch on "${fragment}"`);
  }
});

// The logout skill no longer enumerates outcomes — it relays them. So this table shrank to the
// THREE fragments it still quotes, and that is the whole contract now.
//
// Every row removed here was removed because the skill stopped quoting the sentence, never because
// it failed: a two-sided pin whose skill half no longer exists pins nothing, and keeping the source
// half alone is exactly the one-sided assertion test/login-surface.test.mjs warns passes happily
// while the contract is broken. The outcome sentences themselves are pinned by BEHAVIOUR now —
// tests 16-18, 23, 24, 27-29 assert what each one says about the state that produced it, which is
// a stronger check than asserting a string appears in two files.
test('13. logout skill — the fragments it still quotes are the ones the surface still prints', () => {
  const skill = read('skills', 'logout', 'SKILL.md');
  const outcomes = [
    // The conditional remedy and the re-run instruction: the skill names both as the two remedies
    // the command prints for itself, which is the reason it adds none of its own.
    // The fragment stops before the apostrophe — the source spells it `portal\'s` inside a
    // single-quoted string, so an includes() of the rendered text would never match — and before
    // the skill's own line wrap.
    [['lib', 'logout.mjs'], 'If this account is still listed in the portal', /If this account is still listed in the portal's Connections tab, remove it/],
    [['lib', 'logout.mjs'], 'Run the command again to finish.', /Run the command again to finish\./],
    [['scripts', 'logout.mjs'], '✗ ${friendlyMessage(error)}', /✗/],
  ];
  for (const [file, fragment, inSkill] of outcomes) {
    assert.ok(read(...file).includes(fragment),
      `${file.join('/')} should still print "${fragment}" — the logout skill quotes it`);
    assert.match(skill, inSkill, `skills/logout/SKILL.md should still quote "${fragment}"`);
  }
});

// The subtraction has to STAY subtracted. Each of these is a sentence the skill once explained and
// got wrong; re-adding any of them re-opens the drift this round closed.
test('13b. the logout skill does not interpret outcomes', () => {
  const skill = read('skills', 'logout', 'SKILL.md');
  const banned = [
    'The account is unlinked from Beezi',
    'and access revoked',
    'Logged out {who} locally',
    'nothing left to unlink',
    'no usable credentials for it here',
    'saved credentials could not be read',
    'was signed out, but its row',
    'could not be signed out at Beezi',
    'could not be fully logged out',
    'No default account is set',
  ];
  for (const sentence of banned) {
    assert.ok(!skill.includes(sentence),
      `skills/logout/SKILL.md quotes "${sentence}" again — it relays outcomes, it does not explain them`);
  }
  assert.match(skill, /Relay every line the command prints, verbatim, and add nothing/);
});

// The same guard for the neighbouring skills, which keep their enumerations but lost four claims
// that probing showed were false. A ban list is the right shape here for the same reason it is in
// 13b: each of these was verified false against a real run, none is pinned two-sided by anything
// else, and a regression would be silent prose rather than a failing behaviour.
test('13c. the me and accounts skills do not re-acquire the claims probing disproved', () => {
  const me = read('skills', 'me', 'SKILL.md');
  const accounts = read('skills', 'accounts', 'SKILL.md');
  const logout = read('skills', 'logout', 'SKILL.md');

  // `me` runs ensureHooks whenever an account is linked: on a machine with none installed, one run
  // writes ~/.codex/hooks.json and the launcher, and says so in its own last line.
  assert.ok(!me.includes('Changes nothing'), 'me: it installs analytics hooks — it is not read-only');
  // LinkState.UNREACHABLE covers environment-blocked, credential-store, refresh-in-progress,
  // refresh-lock-lost and refresh-failed. Four of the five make no request at all.
  assert.ok(!me.includes('the API was unreachable'), 'me: UNREACHABLE is not only a network verdict');

  for (const [name, skill] of [['me', me], ['accounts', accounts]]) {
    assert.ok(!skill.includes('details on next session'), `${name}: that string is gone from lib/accounts.mjs`);
    // Still banned, for a narrower reason than when it was written: a migrated row IS filled in
    // now, by lib/session-start.mjs and lib/login.mjs's resolveAnonymousRows — but only when that
    // row can still produce a token and the portal answers with an email, so an unconditional
    // promise is still a claim neither call site establishes.
    assert.ok(!skill.includes('fills in on its next'), `${name}: the fill is conditional, not promised`);
  }
  // renderList goes through readIndex, which runs the one-time pre-0.13 migration: it writes the
  // index, re-keys the keyring and moves root-level state, and throws when the store is locked.
  for (const [name, skill] of [['accounts', accounts], ['logout', logout]]) {
    assert.ok(!skill.includes('works even when the link itself is broken'), `${name}: it can throw on a locked store`);
    assert.ok(!skill.includes('read-only and offline'), `${name}: listing can migrate a legacy install`);
  }
  // CONNECTIONS_REMEDY prints exactly where the command CANNOT know; the one branch printing no
  // remedy is serverUnlinked, which knows most. Round 4's own inverted claim.
  assert.ok(!logout.includes('it prints none'), 'logout: the remedy rule was stated backwards');
});

// Two callers print it — the script's own zero-account check and logoutAll's — and the skill
// branches on it. Two spellings and the skill matches one of them, reading the other as an
// unexplained empty answer. Same discipline as refusedSameTenantMessage in the login surface.
test('15. the sentences two surfaces share have exactly one definition each', () => {
  // [the sentence, the module that owns it, the exported name, the module that must import it]
  const shared = [
    ['this machine is not linked. Nothing to do.', 'logout.mjs', 'NOTHING_TO_DO', ['scripts', 'logout.mjs']],
    // Reached by `accounts use <revoked>` AND by `logout --next-default <revoked>`, and branched on
    // by both skills — so a second spelling leaves one of them relaying text nothing prints.
    ['access was revoked, so it cannot report', 'accounts-cli.mjs', 'REVOKED_DEFAULT_NOTE', ['lib', 'logout.mjs']],
  ];
  for (const [sentence, owner, exported, importer] of shared) {
    assert.match(read('lib', owner), new RegExp(`export const ${exported}`));
    assert.match(read(...importer), new RegExp(exported));
    for (const dir of ['lib', 'scripts']) {
      for (const name of fs.readdirSync(path.join(pluginRoot, dir))) {
        if (!name.endsWith('.mjs')) continue;
        if (dir === 'lib' && name === owner) continue;
        assert.ok(
          !read(dir, name).includes(sentence),
          `${dir}/${name} spells "${sentence}" out itself instead of importing ${exported}`,
        );
      }
    }
  }
});

// The old single-account script resolved its bearer with an un-keyed getAccessToken(), which on a
// multi-account machine would unlink whatever account the call happened to land on. The logic is
// in lib/logout.mjs now, and the script must not grow a token read of its own again.
test('14. scripts/logout.mjs resolves no token of its own', () => {
  const script = read('scripts', 'logout.mjs');
  assert.ok(!/getAccessToken/.test(script), 'the script must not resolve a bearer itself');
  assert.ok(!/getCredentials/.test(script), 'the script must not read the credential store itself');
  assert.match(script, /from '\.\.\/lib\/logout\.mjs'/);
});
