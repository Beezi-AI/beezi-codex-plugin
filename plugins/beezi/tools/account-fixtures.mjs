import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A sandbox data root per test. Every account suite uses this rather than touching process.env by
// hand, so a forgotten cleanup cannot leak one test's accounts into the next.
export function makeHome(t, prefix = 'accounts-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// The account key most suites use when they need exactly one. Eight lowercase hex characters, the
// only shape lib/paths.mjs accepts.
export const TEST_KEY = 'a1b2c3d4';

/**
 * One linked account in the index, written DIRECTLY rather than through lib/accounts.mjs.
 *
 * A fixture must not depend on the module under test — addAccount takes a lock, can run the
 * one-time migration and is itself something suites assert on — and every fan-out site in lib/
 * reads this same file, so writing it is enough to make a sandbox "linked".
 *
 * Returns the session object the sweep passes around: `{ key, token, clientId, ... }`. The token
 * is a placeholder; a test that cares injects its own.
 */
export function linkAccount(home, key = TEST_KEY, over = {}) {
  fs.mkdirSync(path.join(home, 'accounts', key), { recursive: true, mode: 0o700 });
  const file = path.join(home, 'accounts.json');
  let index = { version: 1, default: null, accounts: [] };
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (stored && stored.version === 1 && Array.isArray(stored.accounts)) index = stored;
  } catch { /* absent or unreadable — start from an empty index */ }
  const row = {
    key,
    email: `${key}@example.com`,
    name: key,
    tenantId: `t-${key}`,
    tenantName: `W-${key}`,
    clientId: `c-${key}`,
    linkedAt: new Date().toISOString(),
    status: 'linked',
    ...over,
  };
  index.accounts = index.accounts.filter((a) => a.key !== key).concat([row]);
  if (index.default == null) index.default = key;
  fs.writeFileSync(file, JSON.stringify(index), { encoding: 'utf-8', mode: 0o600 });
  return { key: row.key, token: 'test-token', clientId: row.clientId,
    email: row.email, name: row.name, tenantName: row.tenantName };
}

// What linkedSessions() hands every fan-out site: the bearer and the client id inseparably, plus
// the index row's labels so a caller can name the workspace in a message. A bare token string is
// refused by lib/http.mjs by design, so every test that posts needs one of these.
export function accountSession(key = TEST_KEY, token = 'test-token') {
  return {
    key,
    email: `${key}@example.com`,
    name: key,
    tenantName: `W-${key}`,
    token,
    clientId: `c-${key}`,
  };
}

// The separator between service and account in the fake store's keys. A NUL can never appear in
// either half, so a collision is impossible and a test can assert which ENTRY was touched — which
// is the whole point of keying: two accounts must never share one.
const SEP = String.fromCharCode(0);

export function entryId(service, account) {
  return `${service}${SEP}${account}`;
}

// An in-memory stand-in for security / secret-tool / PowerShell, injected as `run`.
//
// The argv indices follow macBackend in lib/credentials.mjs, which the task brief says to match
// rather than to reshape. `find`/`delete` are `[sub, '-s', service, '-a', account, ...]`, so the
// service and account sit at 2 and 4; `add` carries a `-U` before `-s`
// (`[sub, '-U', '-s', service, '-a', account, '-w', secret]`), which shifts them to 3, 5 and 7.
export function fakeKeyring(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  return {
    store,
    calls,
    entryId,
    run(file, args, input) {
      calls.push({ file, args, input });
      if (file === 'security' && args[0] === 'find-generic-password') {
        const value = store.get(entryId(args[2], args[4]));
        return value == null ? { ok: false, stdout: '' } : { ok: true, stdout: `${value}\n` };
      }
      if (file === 'security' && args[0] === 'add-generic-password') {
        store.set(entryId(args[3], args[5]), args[7]);
        return { ok: true, stdout: '' };
      }
      if (file === 'security' && args[0] === 'delete-generic-password') {
        store.delete(entryId(args[2], args[4]));
        return { ok: true, stdout: '' };
      }
      return { ok: false, stdout: '' };
    },
  };
}

// An in-memory stand-in for the Windows Credential Manager, injected as `run`.
//
// Keyed by TARGET NAME ALONE, and that is the whole point of it. `fakeKeyring` above models the
// store as a (service, account) map, which is faithful to `security` and `secret-tool` and exactly
// the wrong keyspace for advapi32: a generic credential is identified by TargetName + Type, and
// CredRead/CredDelete never see UserName. An account whose key reached only the UserName would pass
// every darwin case and still share one entry with every other account on the machine.
export function fakeCredMan(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  const targetOf = (script, pattern) => {
    const match = script.match(pattern);
    return match ? match[1] : null;
  };
  return {
    store,
    calls,
    run(file, args, input) {
      calls.push({ file, args, input });
      const at = args.indexOf('-Command');
      if (at === -1) return { ok: false, stdout: '' };
      const script = args[at + 1];
      // CredWrite / CredRead / CredDelete are disjoint substrings; 'Unprotect'.includes('Protect')
      // is the trap in the DPAPI fakes, and none of these three collide.
      if (script.includes('CredWrite')) {
        const target = targetOf(script, /\$c\.TargetName='([^']*)'/);
        if (target === null) return { ok: false, stdout: '' };
        store.set(target, input);
        return { ok: true, stdout: 'OK\n' };
      }
      if (script.includes('CredDelete')) {
        const target = targetOf(script, /CredDelete\('([^']*)'/);
        if (target !== null) store.delete(target);
        return { ok: true, stdout: '' };
      }
      if (script.includes('CredRead')) {
        const target = targetOf(script, /CredRead\('([^']*)'/);
        const value = target === null ? undefined : store.get(target);
        return value == null ? { ok: false, stdout: '' } : { ok: true, stdout: value };
      }
      return { ok: false, stdout: '' };
    },
  };
}

export function credentialBlob(overrides = {}) {
  return {
    access_token: 'at',
    refresh_token: 'rt',
    client_id: 'client-1',
    token_endpoint: 'https://example.invalid/token',
    expires_at: Date.now() + 3600000,
    ...overrides,
  };
}
