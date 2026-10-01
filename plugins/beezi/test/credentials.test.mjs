// First import. SERVICE is a MODULE-LEVEL const built from envSuffix(), and it is interpolated
// into the PowerShell credential templates at load, so BEEZI_ENV has to be gone before
// lib/credentials.mjs evaluates. On a developer machine that exports it, every backend assertion
// below would exercise a suffixed service name and pass for the wrong reason.
import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getCredentials, setCredentials, deleteCredentials, SERVICE, serviceFor, preserveMigrationCredential, readRawCredential,
} from '../lib/credentials.mjs';
import { BEEZI_ENV } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';

// Point BEEZI_CODEX_HOME at a temp dir and restore it afterward.
const tmpHome = (t) => sandboxHome(t, 'creds-');

// Every credential call is keyed from 0.13 on. One account key serves the whole file: these cases
// are about the BACKENDS, not about keeping two accounts apart — test/account-credentials.test.mjs
// owns that — so the store now lives under accounts/<key>/ rather than at the data root.
const KEY = 'a1b2c3d4';
const accountPath = (dir, name) => path.join(dir, 'accounts', KEY, name);
const credsPath = (dir) => accountPath(dir, 'credentials.json');

// Minimal valid credentials object; access_token varies per test for traceability.
const creds = (accessToken) => ({
  client_id: 'cid',
  redirect_uri: 'http://127.0.0.1:49152/callback',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: accessToken,
  refresh_token: 'rt',
  expires_at: 123,
});

// Stored access_token, or null — the round-trip observable in these tests.
const storedToken = async (deps) => (await getCredentials(KEY, deps))?.access_token ?? null;

test('an inaccessible Windows credential store is not reported as a revision mismatch', async (t) => {
  tmpHome(t);
  const run = winRun();
  await setCredentials(KEY, creds('at'), { platform: 'win32', run });
  assert.throws(() => readRawCredential(KEY, {
    platform: 'win32', run: () => ({ ok: false, stdout: '' }),
  }), /Committed credentials could not be read; check access to the credential store/);
  assert.equal(JSON.parse(readRawCredential(KEY, { platform: 'win32', run })).access_token, 'at');
});

const nativeReadCases = [
  { platform: 'win32', makeRun: () => winRun(), isRead: args => args.at(-1).includes('CredRead') },
  { platform: 'darwin', makeRun: () => macRun(new Map()), isRead: args => args[0] === 'find-generic-password' },
  { platform: 'linux', makeRun: () => secretToolRun(new Map(), true), isRead: args => args[0] === 'lookup' },
  { platform: 'linux', makeRun: () => secretToolRun(new Map(), true), isRead: args => args[0] === '--version', probe: true },
];

for (const { platform, makeRun, isRead, probe } of nativeReadCases) {
for (const reader of [getCredentials, readRawCredential]) {
  for (const recover of [true, false]) {
    test(`${reader.name}: bounded ${platform} ${probe ? 'probe' : 'read'} retries, recovery=${recover}`, async (t) => {
      const dir = tmpHome(t);
      const backing = makeRun();
      await setCredentials(KEY, creds('at'), { platform, run: backing });
      const authorityPath = accountPath(dir, 'credential-control.json');
      const authority = fs.readFileSync(authorityPath, 'utf-8');
      let reads = 0;
      const waits = [];
      const deps = {
        platform, sleepImpl: ms => waits.push(ms),
        run: (file, args, input) => {
          if (isRead(args)) {
            reads++;
            if (!recover || reads < 3) return { ok: false, stdout: '' };
          }
          return backing(file, args, input);
        },
      };
      if (recover) {
        const result = await reader(KEY, deps);
        assert.equal((typeof result === 'string' ? JSON.parse(result) : result).access_token, 'at');
      } else {
        await assert.rejects(async () => reader(KEY, deps), { code: 'CREDENTIALS_UNAVAILABLE' });
      }
      assert.equal(reads, 3);
      assert.deepEqual(waits, [100, 250]);
      assert.equal(fs.readFileSync(authorityPath, 'utf-8'), authority);
      assert.equal(fs.existsSync(credsPath(dir)), false, 'never fall back to a file');
    });
  }
}
}

for (const { platform, makeRun, isRead } of nativeReadCases.filter(c => !c.probe)) {
test(`${platform} readable revision mismatches are not retried`, async (t) => {
  tmpHome(t);
  const backing = makeRun();
  await setCredentials(KEY, creds('at'), { platform, run: backing });
  let reads = 0;
  const deps = {
    platform, sleepImpl: () => assert.fail('must not wait for a revision mismatch'),
    run: (file, args, input) => {
      const result = backing(file, args, input);
      if (isRead(args)) {
        reads++;
        result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), beezi_revision: 'stale' });
      }
      return result;
    },
  };
  assert.throws(() => readRawCredential(KEY, deps), /Credential revision mismatch/);
  await assert.rejects(getCredentials(KEY, deps), { code: 'CREDENTIALS_UNAVAILABLE' });
  assert.equal(reads, 2);
});
}

test('a readable credential with a different revision still blocks raw reads', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'unknown' };
  await setCredentials(KEY, creds('at'), deps);
  const stored = JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8'));
  const credential = JSON.parse(stored.token);
  credential.beezi_revision = 'stale';
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: JSON.stringify(credential) }));
  assert.throws(() => readRawCredential(KEY, deps), /Credential revision mismatch/);
});

// ── fake OS tools (in-memory), injected via deps.run ──────────────────────────

function macRun(store) {
  return (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === 'find-generic-password') {
      return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    }
    if (sub === 'add-generic-password') { store.set('k', args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (sub === 'delete-generic-password') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

function secretToolRun(store, installed) {
  return (file, args, input) => {
    if (file !== 'secret-tool') return { ok: false, stdout: '' };
    if (!installed) return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === '--version') return { ok: true, stdout: 'secret-tool 0.20.5\n' };
    if (sub === 'lookup') return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    if (sub === 'store') { store.set('k', input); return { ok: true, stdout: '' }; }
    if (sub === 'clear') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

// Fakes the two Windows PowerShell paths: the Credential Manager P/Invoke (CredWrite/Read/
// Delete) and the DPAPI fallback (Protect/Unprotect, modeled as reversible base64). Toggle
// each independently to exercise the backend chain: credMan → DPAPI-file → plaintext-file.
function winRun({ credMan = true, dpapi = true } = {}) {
  const credStore = new Map(); // stands in for the OS Credential Manager
  return (file, args, input) => {
    // The backend invokes PowerShell by absolute path; match on the basename.
    if (path.basename(String(file)).toLowerCase() !== 'powershell.exe') return { ok: false, stdout: '' };
    const script = args[args.indexOf('-Command') + 1];
    // Credential Manager (primary). CredWrite/CredRead/CredDelete are disjoint substrings.
    if (script.includes('CredWrite')) {
      if (!credMan) return { ok: false, stdout: '' };
      credStore.set('k', input); return { ok: true, stdout: 'OK\n' };
    }
    if (script.includes('CredDelete')) { credStore.delete('k'); return { ok: true, stdout: '' }; }
    if (script.includes('CredRead')) {
      return credMan && credStore.has('k') ? { ok: true, stdout: credStore.get('k') } : { ok: false, stdout: '' };
    }
    // DPAPI fallback. Note: 'Unprotect'.includes('Protect') is true — check Unprotect FIRST.
    if (!dpapi) return { ok: false, stdout: '' };
    if (script.includes('Unprotect')) return { ok: true, stdout: Buffer.from(input.trim(), 'base64').toString('utf-8') + '\n' };
    if (script.includes('Protect')) return { ok: true, stdout: Buffer.from(input, 'utf-8').toString('base64') + '\n' };
    return { ok: true, stdout: '' };
  };
}

// ── credentials blob semantics ────────────────────────────────────────────────

test('round-trips a credentials object through the file store', async (t) => {
  tmpHome(t);
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  await setCredentials(KEY, creds('at'), deps);
  assert.deepEqual(await getCredentials(KEY, deps), creds('at'));
});

test('legacy bare device token reads as null (not linked)', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.dirname(credsPath(dir)), { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: 'bzi_legacy' }));
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  assert.equal(await getCredentials(KEY, deps), null);
});

test('malformed stored JSON reads as null', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.dirname(credsPath(dir)), { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: '{not json' }));
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  assert.equal(await getCredentials(KEY, deps), null);
});

// ── macOS ─────────────────────────────────────────────────────────────────────

test('macOS — security keychain round-trip; nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await setCredentials(KEY, creds('mac-tok'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await storedToken(deps), 'mac-tok');
  await deleteCredentials(KEY, deps);
  assert.equal(await storedToken(deps), null);
});

// ── Linux ──────────────────────────────────────────────────────────────────────

test('Linux — secret-tool round-trip when libsecret is installed', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), true) };
  await setCredentials(KEY, creds('lin-tok'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await storedToken(deps), 'lin-tok');
  await deleteCredentials(KEY, deps);
  assert.equal(await storedToken(deps), null);
});

test('Linux — no secret-tool → falls back to the 0600 file', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), false) };
  await setCredentials(KEY, creds('lin-file'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), true, 'file fallback written');
  const raw = JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token;
  assert.equal(JSON.parse(raw).access_token, 'lin-file');
  assert.equal(await storedToken(deps), 'lin-file');
});

// ── Windows ─────────────────────────────────────────────────────────────────────

test('Windows — Credential Manager round-trip (primary); nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun() };
  const where = await setCredentials(KEY, creds('win-cred'), deps);
  assert.equal(where, 'the Windows Credential Manager');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'Credential Manager used, no file');
  assert.equal(await storedToken(deps), 'win-cred');
  await deleteCredentials(KEY, deps);
  assert.equal(await storedToken(deps), null);
});

test('Windows — Credential Manager unavailable → DPAPI encrypts at rest (no plaintext in file)', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) };
  await setCredentials(KEY, creds('win-tok'), deps);
  const raw = fs.readFileSync(credsPath(dir), 'utf-8');
  const obj = JSON.parse(raw);
  assert.ok(obj.enc, 'ciphertext stored under "enc"');
  assert.equal(obj.token, undefined, 'no plaintext token field');
  assert.ok(!raw.includes('win-tok'), 'plaintext token absent from file');
  assert.equal(await storedToken(deps), 'win-tok', 'decrypts on read');
});

test('Windows — Credential Manager + DPAPI unavailable → plaintext 0600 file fallback', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: false }) };
  await setCredentials(KEY, creds('win-plain'), deps);
  const raw = JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token;
  assert.equal(JSON.parse(raw).access_token, 'win-plain');
  assert.equal(await storedToken(deps), 'win-plain');
});

test('Windows — legacy DPAPI-file credentials still read when Credential Manager is empty', async (t) => {
  tmpHome(t);
  // Simulate a user who linked before the Credential Manager backend existed: credentials live
  // in the DPAPI file only. A later session (credMan present but empty) must still find them.
  await setCredentials(KEY, creds('legacy-dpapi'), { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) });
  assert.equal(await storedToken({ platform: 'win32', run: winRun({ credMan: true, dpapi: true }) }), 'legacy-dpapi');
});

// ── cross-cutting ────────────────────────────────────────────────────────────────

test('unknown platform → file store round-trip', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };
  await setCredentials(KEY, creds('generic'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), true);
  assert.equal(await storedToken(deps), 'generic');
});

test('keychain empty but file credentials exist → file fallback on read', async (t) => {
  tmpHome(t);
  await setCredentials(KEY, creds('legacy-file'), { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) }); // file
  const deps = { platform: 'darwin', run: macRun(new Map()) };                                                // empty keychain
  assert.equal(await storedToken(deps), 'legacy-file');
});

test('no credentials anywhere → null, never throws', async (t) => {
  tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await assert.doesNotReject(() => getCredentials(KEY, deps));
  assert.equal(await getCredentials(KEY, deps), null);
});

test('deleteCredentials clears both keychain and any file copy', async (t) => {
  const dir = tmpHome(t);
  // Seed a stale file copy AND a keychain copy.
  await setCredentials(KEY, creds('file-one'), { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });
  const store = new Map();
  const deps = { platform: 'darwin', run: macRun(store) };
  await setCredentials(KEY, creds('key-one'), deps);
  await deleteCredentials(KEY, deps);
  assert.equal(store.has('k'), false, 'keychain cleared');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'file cleared');
  assert.equal(await getCredentials(KEY, deps), null);
});

test('file store uses restricted 0600 permissions (posix only)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmpHome(t);
  await setCredentials(KEY, creds('x'), { platform: 'linux', run: secretToolRun(new Map(), false) });
  const mode = fs.statSync(credsPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the keyring entry names this agent, not the shared Beezi one', () => {
  // On Windows this string is the target the user sees in Credential Manager, and the Claude Code
  // plugin keeps `beezi-analytics` on the same machine — one entry for both would mean each
  // refresh and each logout stepping on the other.
  assert.equal(SERVICE, 'beezi-codex');
  assert.ok(!SERVICE.includes('analytics'));
});

test('every backend keys off that one name', () => {
  const calls = [];
  const run = (file, args) => { calls.push([file, ...args].join(' ')); return { ok: false, stdout: '' }; };
  for (const platform of ['darwin', 'linux', 'win32']) {
    getCredentials(KEY, { run, platform }).catch(() => {});
  }
  const text = calls.join('\n');
  assert.ok(text.includes(SERVICE), 'the service name reaches the keyring commands');
  assert.ok(!text.includes('beezi-analytics'), 'no backend still uses the old name');
});

// ── environment binding (G-2-2) ──────────────────────────────────────────────────

test('every native backend passes the exact service name through, argv by argv', async (t) => {
  // The in-memory fakes above key on 'k' and ignore the service name entirely, so they cannot see
  // a backend that suffixed one namespace and not the other. This one records its argv.
  const calls = [];
  const run = (file, args, input) => { calls.push({ file, args, input }); return { ok: false, stdout: '' }; };
  tmpHome(t);

  await getCredentials(KEY, { platform: 'darwin', run });
  const mac = calls.find((c) => c.file === 'security');
  assert.equal(mac.args[mac.args.indexOf('-s') + 1], SERVICE, 'macOS -s carries the service name');

  calls.length = 0;
  await setCredentials(KEY, creds('mac'), { platform: 'darwin', run });
  const macSet = calls.find((c) => c.args[0] === 'add-generic-password');
  assert.equal(macSet.args[macSet.args.indexOf('-s') + 1], SERVICE);

  tmpHome(t); // each platform starts with a legacy, uncommitted store
  calls.length = 0;
  await getCredentials(KEY, { platform: 'linux', run: (f, a, i) => {
    calls.push({ file: f, args: a, input: i });
    return f === 'secret-tool' && a[0] === '--version' ? { ok: true, stdout: 'x' } : { ok: false, stdout: '' };
  } });
  const lookup = calls.find((c) => c.args[0] === 'lookup');
  assert.equal(lookup.args[lookup.args.indexOf('service') + 1], SERVICE, 'secret-tool service attr');

  calls.length = 0;
  await setCredentials(KEY, creds('lin'), { platform: 'linux', run: (f, a, i) => {
    calls.push({ file: f, args: a, input: i });
    return f === 'secret-tool' && a[0] === '--version' ? { ok: true, stdout: 'x' } : { ok: false, stdout: '' };
  } });
  const store = calls.find((c) => c.args[0] === 'store');
  assert.equal(store.args[store.args.indexOf('service') + 1], SERVICE);
  assert.ok(store.args.includes(`--label=${SERVICE}`), 'the libsecret label carries it too');
});

test('the Windows PowerShell templates carry the service name as literal script text', async (t) => {
  // SERVICE is interpolated into CRED_WRITE / CRED_READ / CRED_DELETE at module load. That is the
  // reason envSuffix() validates against a three-name allowlist BEFORE anything reaches here, and
  // the reason the suffixed variants of these assertions run in a fresh child process.
  const scripts = [];
  const run = (file, args, input) => {
    if (args.indexOf('-Command') !== -1) scripts.push(args[args.indexOf('-Command') + 1]);
    return { ok: false, stdout: '', input };
  };
  tmpHome(t);
  await getCredentials(KEY, { platform: 'win32', run });
  await setCredentials(KEY, creds('w'), { platform: 'win32', run });
  await deleteCredentials(KEY, { platform: 'win32', run });

  const credMan = scripts.filter((s) => /Cred(Read|Write|Delete)/.test(s));
  assert.ok(credMan.length >= 3, 'all three Credential Manager scripts were exercised');
  // The target is `<service>:<key>` since the store became keyed — a generic credential is
  // identified by TargetName, so the account has to be in it and not only in the UserName.
  for (const script of credMan) {
    assert.ok(script.includes(`'${SERVICE}:${KEY}'`), `a CredMan script lost the target name:
${script}`);
  }
});

test('the stored blob is stamped with its environment, and readers never see the stamp', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  await setCredentials(KEY, creds('stamped'), deps);
  const stored = JSON.parse(JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token);
  assert.equal(stored.beezi_env, BEEZI_ENV, 'the environment binding is persisted');
  // Stripped on read: every consumer (token.mjs, login.mjs, logout.mjs) sees the shape it always
  // saw, and the refresh path's `{ ...creds }` re-stamps through setCredentials.
  assert.deepEqual(await getCredentials(KEY, deps), creds('stamped'));
});

test('credentials stamped for another environment read as absent, so no token is issued', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  // Exactly what a staging install writes into a BEEZI_CODEX_HOME root shared with production.
  fs.mkdirSync(path.dirname(credsPath(dir)), { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({
    token: JSON.stringify({ ...creds('staging-token'), beezi_env: 'staging' }),
  }));
  assert.equal(await getCredentials(KEY, deps), null, 'a crossed binding produced a usable token');
});

test('a pre-G-2-2 unstamped blob reads as production, so existing installs keep working', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  fs.mkdirSync(path.dirname(credsPath(dir)), { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: JSON.stringify(creds('legacy')) }));
  assert.equal(BEEZI_ENV, '', 'this process is the production namespace');
  assert.deepEqual(await getCredentials(KEY, deps), creds('legacy'));
});

test('the libsecret label follows the service argument, not the module constant', (t) => {
  // secretToolBackend takes `service` so a caller can address a keyring entry other than this
  // process's own — preserveMigrationCredential is that caller, and it addresses the STAGING
  // entry while running in the production namespace. The `--label=` on `store` is what a user
  // sees in Seahorse, so it has to name the entry that was actually written.
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-preserve-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));

  const calls = [];
  const backing = secretToolRun(new Map(), true);
  const run = (file, args, input) => {
    calls.push({ file, args, input });
    return backing(file, args, input);
  };

  const preserved = preserveMigrationCredential(
    KEY, JSON.stringify(creds('to-preserve')), destination, { platform: 'linux', run },
  );
  assert.equal(preserved, true, 'the staging credential must round-trip through libsecret');

  const store = calls.find((c) => c.args[0] === 'store');
  const service = store.args[store.args.indexOf('service') + 1];
  assert.equal(service, serviceFor('staging'), 'the attrs address the staging entry');
  assert.ok(
    store.args.includes(`--label=${service}`),
    `the label must name the entry that was written, got ${JSON.stringify(store.args)}`,
  );

  // The authority record must land where the DESTINATION install's readControl(key) will look for
  // it — under that root's accounts/<key>/, not at its root. Split the two and the preserved
  // install falls through to the uncommitted read path, silently losing the revision check and the
  // tombstone. Proved by pointing the data root at the destination and reading the preserved
  // credential back through the committed path.
  assert.ok(
    fs.existsSync(path.join(destination, 'accounts', KEY, 'credential-control.json')),
    `the authority is not beside the destination account: ${JSON.stringify(fs.readdirSync(destination))}`,
  );
  const previousHome = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = destination;
  try {
    const raw = readRawCredential(KEY, { platform: 'linux', run });
    assert.equal(JSON.parse(raw).access_token, 'to-preserve',
      'the destination could not read its own committed credential');
    assert.equal(JSON.parse(raw).beezi_env, 'staging');
  } finally {
    process.env.BEEZI_CODEX_HOME = previousHome;
  }
});
