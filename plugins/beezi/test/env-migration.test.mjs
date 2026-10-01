import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyRoot,
  issuerEnvironment,
  rootHasData,
  readBinding,
  ensureEnvironmentMigrated,
  rollbackMigration,
  adoptAsProduction,
  migrationStatus,
  STAGING_API_ORIGIN,
  STAGING_OAUTH_ORIGIN,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_OAUTH_ORIGIN,
} from '../lib/env-migration.mjs';
import { readRawCredential, deleteRawCredential } from '../lib/credentials.mjs';
import { runLock, withLock } from '../lib/single-instance-lock.mjs';
import { writeJsonSecure } from '../lib/fs-store.mjs';
import { credentialsFile } from '../lib/paths.mjs';

// R1's migration matrix. Every case the review names — interrupted and repeated migration,
// rollback, an existing production override, queued staging data followed by a production login,
// simultaneous installed variants, plaintext and native credential stores — plus the classifier
// that decides between them, which is pure and therefore tested without a filesystem at all.

function sandbox(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `beezi-mig-${name}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return dir;
}

/** A used data root: a queued segment, a cursor, a ledger and a credentials file. */
function legacyRoot(dir, { credential = null } = {}) {
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'seg-1.json'), JSON.stringify({ session_id: 's1', lines: 40 }));
  fs.writeFileSync(path.join(dir, 'state', 's1.json'), JSON.stringify({ cursor: 40 }));
  fs.writeFileSync(path.join(dir, 'audit-ledger.json'), JSON.stringify({ s1: { at: 1, outcome: 'accepted' } }));
  fs.writeFileSync(path.join(dir, 'tracking.json'), JSON.stringify({ trackingMode: 'live' }));
  if (credential) fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: credential }));
  return dir;
}

const stagingCredential = JSON.stringify({
  access_token: 'at-staging',
  refresh_token: 'rt-staging',
  client_id: 'c1',
  token_endpoint: `${STAGING_API_ORIGIN}/oauth/token`,
});

const productionCredential = JSON.stringify({
  access_token: 'at-prod',
  refresh_token: 'rt-prod',
  client_id: 'c1',
  token_endpoint: `${PRODUCTION_API_ORIGIN}/oauth/token`,
});

const LOCAL_API_ORIGIN = 'http://localhost:5001';
const CLERK_DEV_ORIGIN = 'https://poetic-lionfish-63.clerk.accounts.dev';
const localCredential = JSON.stringify({
  access_token: 'at-local',
  refresh_token: 'rt-local',
  client_id: 'c1',
  token_endpoint: `${CLERK_DEV_ORIGIN}/oauth/token`,
  beezi_env: 'local',
});

/** Deps that keep the migration inside two temp directories and off the real keyring. */
function depsFor(source, destination, { credential = null, onDelete = null } = {}) {
  const store = { credential };
  return {
    env: '',
    home: () => source,
    preservedHome: () => destination,
    readRawCredential: () => store.credential,
    deleteRawCredential: () => {
      store.credential = null;
      if (onDelete) onDelete();
      return true;
    },
    store,
  };
}

// ── the classifier ──────────────────────────────────────────────────────────────────────────

test('classify — a root already bound to this environment is left alone', () => {
  const r = classifyRoot({ env: '', binding: { env: '', apiOrigin: PRODUCTION_API_ORIGIN }, hasData: true, issuer: 'production' });
  assert.equal(r.verdict, 'ok');
});

test('classify — a local credential from an external OAuth issuer is left alone', () => {
  const facts = {
    env: 'local',
    binding: { env: 'local', apiOrigin: LOCAL_API_ORIGIN },
    apiOrigin: LOCAL_API_ORIGIN,
    hasData: true,
    issuer: 'unknown',
    credentialOrigin: CLERK_DEV_ORIGIN,
    credentialEnv: 'local',
  };
  assert.equal(classifyRoot(facts).verdict, 'ok');
  // The token endpoint no longer has to match the API origin: an external issuer is normal.
  assert.equal(classifyRoot({ ...facts, credentialOrigin: 'http://localhost:5002' }).verdict, 'ok');
  assert.equal(classifyRoot({ ...facts, credentialOrigin: null }).reason, 'conflicting-evidence');
  assert.equal(classifyRoot({ ...facts, credentialEnv: 'dev' }).reason, 'conflicting-evidence');
});

test('classify — a dev credential from an external OAuth issuer is left alone', () => {
  const facts = {
    env: 'dev',
    binding: { env: 'dev', apiOrigin: 'https://dev-api.beezi.example' },
    apiOrigin: 'https://dev-api.beezi.example',
    hasData: true,
    issuer: 'unknown',
    credentialOrigin: CLERK_DEV_ORIGIN,
    credentialEnv: 'dev',
  };
  assert.equal(classifyRoot(facts).verdict, 'ok');
});

test('classify — a root bound to ANOTHER environment blocks, it does not re-migrate', () => {
  const r = classifyRoot({ env: '', binding: { env: 'staging' }, hasData: true, issuer: 'staging' });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reason, 'binding-mismatch');
});

test('classify — a variant build never migrates; its root is its own by construction', () => {
  const r = classifyRoot({ env: 'staging', binding: null, hasData: true, issuer: 'unknown' });
  assert.equal(r.verdict, 'blocked');
});

test('classify — a fresh production install binds and continues', () => {
  const r = classifyRoot({ env: '', binding: null, hasData: false, issuer: 'unlinked' });
  assert.equal(r.verdict, 'bind');
});

test('classify — an existing PRODUCTION override is adopted, never moved', () => {
  // The user who already ran BEEZI_API_URL=…prod…: their data IS production data.
  const r = classifyRoot({ env: '', binding: null, hasData: true, issuer: 'production' });
  assert.equal(r.verdict, 'adopt');
});

test('classify — a legacy staging root migrates', () => {
  const r = classifyRoot({ env: '', binding: null, hasData: true, issuer: 'staging' });
  assert.equal(r.verdict, 'migrate');
  assert.equal(r.reason, 'staging');
});

test('classify — an UNLINKED legacy root migrates too: every earlier build defaulted to staging', () => {
  const r = classifyRoot({ env: '', binding: null, hasData: true, issuer: 'unlinked' });
  assert.equal(r.verdict, 'migrate');
});

// An unbound, populated unsuffixed root was written by a build from before the cutover — every later
// build binds its root at the first entry point — and every such build defaulted to staging.
// Preserving it uploads nothing, so it is decided without asking the user.
test('classify — a legacy root whose issuer is unknown is preserved, not blocked', () => {
  const r = classifyRoot({ env: '', binding: null, hasData: true, issuer: 'unknown' });
  assert.equal(r.verdict, 'migrate');
  assert.equal(r.reason, 'unknown');
});

// ── the issuer, which is the only honest record of where a root was linked ───────────────────

test('issuer — the OAuth token_endpoint names the environment', () => {
  assert.equal(issuerEnvironment(stagingCredential), 'staging');
  assert.equal(issuerEnvironment(productionCredential), 'production');
});

// Production signs in through Clerk on its own domain, so a fresh production login stores a token
// endpoint on clerk.beezi.ai rather than on the API. Staging's Clerk is a clerk.accounts.dev dev
// instance, so this host names production and nothing else.
test('issuer — production\'s Clerk token endpoint names production', () => {
  const clerk = (stamp) => JSON.stringify({ token_endpoint: `${PRODUCTION_OAUTH_ORIGIN}/oauth/token`, beezi_env: stamp });
  assert.equal(issuerEnvironment(clerk('')), 'production');
  assert.equal(issuerEnvironment(JSON.stringify({ token_endpoint: `${PRODUCTION_OAUTH_ORIGIN}/oauth/token` })), 'production');
  assert.equal(issuerEnvironment(clerk('staging')), 'unknown');
});

// Every pre-cutover login went through staging's Clerk instance and was stamped with the
// unsuffixed namespace's name, '' — the namespace production now owns. That pair is the exact
// credential the field reported as "the API it was linked to could not be established".
test('issuer — staging\'s Clerk token endpoint names staging, under the pre-cutover \'\' stamp too', () => {
  const stagingClerk = (stamp) => JSON.stringify({ token_endpoint: `${STAGING_OAUTH_ORIGIN}/oauth/token`, beezi_env: stamp });
  assert.equal(issuerEnvironment(stagingClerk('')), 'staging');
  assert.equal(issuerEnvironment(stagingClerk('staging')), 'staging');
  assert.equal(issuerEnvironment(JSON.stringify({ token_endpoint: `${STAGING_OAUTH_ORIGIN}/oauth/token` })), 'staging');
  // A dev Clerk instance is not staging's.
  assert.equal(issuerEnvironment(JSON.stringify({ token_endpoint: `${CLERK_DEV_ORIGIN}/oauth/token`, beezi_env: '' })), 'unknown');
});

test('classify — a production root linked through Clerk is not blocked', () => {
  const credential = JSON.stringify({ token_endpoint: `${PRODUCTION_OAUTH_ORIGIN}/oauth/token`, beezi_env: '' });
  const bound = { env: '', apiOrigin: PRODUCTION_API_ORIGIN };
  const facts = {
    env: '', apiOrigin: PRODUCTION_API_ORIGIN, binding: bound, hasData: true,
    issuer: issuerEnvironment(credential),
  };
  assert.equal(classifyRoot(facts).verdict, 'ok');
  // An unbound root holding a production Clerk sign-in is production data: adopted, never moved.
  assert.equal(classifyRoot({ ...facts, binding: null }).verdict, 'adopt');
});

test('issuer — a conflicting stamp blocks the endpoint, and an unknown stamp is unknown', () => {
  assert.equal(issuerEnvironment(JSON.stringify({ beezi_env: 'staging', token_endpoint: `${PRODUCTION_API_ORIGIN}/t` })), 'unknown');
  assert.equal(issuerEnvironment(JSON.stringify({ beezi_env: 'staging', token_endpoint: `${PRODUCTION_OAUTH_ORIGIN}/t` })), 'unknown');
  assert.equal(issuerEnvironment(JSON.stringify({ beezi_env: 'preview' })), 'unknown');
  // '' named the unsuffixed NAMESPACE, which talked to staging before the cutover: not a conflict.
  assert.equal(issuerEnvironment(JSON.stringify({ beezi_env: '', token_endpoint: `${STAGING_API_ORIGIN}/t` })), 'staging');
});

test('issuer — nothing stored is "unlinked"; garbage and a self-hosted API are "unknown"', () => {
  assert.equal(issuerEnvironment(null), 'unlinked');
  assert.equal(issuerEnvironment(''), 'unlinked');
  assert.equal(issuerEnvironment('not json'), 'unknown');
  assert.equal(issuerEnvironment(JSON.stringify({ token_endpoint: 'https://beezi.internal.example/oauth/token' })), 'unknown');
  assert.equal(issuerEnvironment(JSON.stringify({ access_token: 'x' })), 'unknown');
});

test('rootHasData — an empty or absent root is a fresh install, not a legacy one', (t) => {
  const dir = sandbox(t, 'empty');
  assert.equal(rootHasData(dir), false);
  assert.equal(rootHasData(path.join(dir, 'nope')), false);
  fs.writeFileSync(path.join(dir, 'README-of-the-user.txt'), 'hello');
  assert.equal(rootHasData(dir), false, 'a stray file is not plugin data');
  fs.mkdirSync(path.join(dir, 'queue'));
  assert.equal(rootHasData(dir), true);
});

// ── the migration end to end ────────────────────────────────────────────────────────────────

test('migration — the legacy root is preserved, production starts fresh, both ends are bound', (t) => {
  const source = sandbox(t, 'src');
  const destination = path.join(sandbox(t, 'dst-parent'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });

  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'migrated');

  // Preserved, byte for byte.
  assert.equal(
    fs.readFileSync(path.join(destination, 'queue', 'seg-1.json'), 'utf-8'),
    JSON.stringify({ session_id: 's1', lines: 40 }),
  );
  assert.equal(fs.readFileSync(path.join(destination, 'state', 's1.json'), 'utf-8'), JSON.stringify({ cursor: 40 }));
  assert.ok(fs.existsSync(path.join(destination, 'audit-ledger.json')));

  // Production starts fresh: R1 forbids reusing staging cursors or flushing staging payloads.
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
  assert.equal(fs.existsSync(path.join(source, 'state')), false);
  assert.equal(fs.existsSync(path.join(source, 'audit-ledger.json')), false);

  // Both roots say which environment they belong to.
  assert.equal(readBinding({ home: () => source }).env, '');
  assert.equal(readBinding({ home: () => destination }).env, 'staging');

  // The credential moved with the data and left the production namespace.
  assert.equal(deps.store.credential, null, 'the unsuffixed entry must not keep a staging token');
  const preserved = JSON.parse(fs.readFileSync(path.join(destination, 'credentials.json'), 'utf-8'));
  const blob = JSON.parse(preserved.token);
  assert.equal(blob.access_token, 'at-staging');
  assert.equal(blob.beezi_env, 'staging', 'restamped, or the staging build would reject it');
  assert.equal(result.report.credentialPreserved, true);
});

test('migration — the notice never contains the token', (t) => {
  const source = sandbox(t, 'src-notice');
  const destination = path.join(sandbox(t, 'dst-notice'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const result = ensureEnvironmentMigrated(depsFor(source, destination, { credential: stagingCredential }));
  assert.equal(result.status, 'migrated');
  assert.ok(!result.message.includes('at-staging'));
  assert.ok(!result.message.includes('rt-staging'));
});

test('migration — repeated: the second run is a no-op, not a second move', (t) => {
  const source = sandbox(t, 'src-twice');
  const destination = path.join(sandbox(t, 'dst-twice'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });

  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
  // A fresh production session writes its own queue; a second migration would carry it to staging.
  fs.mkdirSync(path.join(source, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(source, 'queue', 'prod-1.json'), '{"session_id":"p1"}');

  assert.equal(ensureEnvironmentMigrated({ ...deps, fresh: true }).status, 'ok');
  assert.equal(fs.existsSync(path.join(destination, 'queue', 'prod-1.json')), false);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'prod-1.json')));
});

test('migration — interrupted after the copy: it resumes instead of restarting', (t) => {
  const source = sandbox(t, 'src-resume');
  const destination = path.join(sandbox(t, 'dst-resume'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });

  // Simulate a process killed between the copy and the cleanup: the destination holds the copy
  // and the marker says `copied`, while the source still holds everything.
  fs.mkdirSync(path.join(destination, 'queue'), { recursive: true });
  fs.copyFileSync(path.join(source, 'queue', 'seg-1.json'), path.join(destination, 'queue', 'seg-1.json'));
  fs.writeFileSync(path.join(source, 'migration.json'), JSON.stringify({
    version: 1, phase: 'copied', from: source, to: destination, at: new Date().toISOString(),
  }));

  const result = ensureEnvironmentMigrated(depsFor(source, destination, { credential: stagingCredential }));
  assert.equal(result.status, 'migrated');
  assert.ok(fs.existsSync(path.join(destination, 'state', 's1.json')), 'the resume still verifies the whole tree');
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
});

// The archive a migration falls back to sits beside the source root, so it is cleaned up with it.
function archivesOf(t, source) {
  const parent = path.dirname(source);
  const prefix = `${path.basename(source)}-legacy-`;
  const list = () => fs.readdirSync(parent).filter(name => name.startsWith(prefix)).map(name => path.join(parent, name));
  t.after(() => { for (const dir of list()) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } });
  return list;
}

test('migration — an occupied staging root is left alone; the legacy data goes to an archive', (t) => {
  const source = sandbox(t, 'src-occupied');
  const destination = sandbox(t, 'dst-occupied');
  const archives = archivesOf(t, source);
  legacyRoot(source, { credential: stagingCredential });
  legacyRoot(destination); // the staging variant is installed and has its own analytics
  fs.writeFileSync(path.join(destination, 'queue', 'seg-1.json'), '{"staging":"own"}');
  const deps = depsFor(source, destination, { credential: stagingCredential });

  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'migrated', result.message);

  // The staging install is untouched.
  assert.equal(fs.readFileSync(path.join(destination, 'queue', 'seg-1.json'), 'utf-8'), '{"staging":"own"}');
  assert.equal(fs.existsSync(path.join(destination, 'credentials.json')), false);

  // The legacy data is in exactly one archive beside the source, byte for byte.
  const [archive] = archives();
  assert.equal(archives().length, 1);
  assert.equal(result.report.to, archive);
  assert.equal(fs.readFileSync(path.join(archive, 'queue', 'seg-1.json'), 'utf-8'), JSON.stringify({ session_id: 's1', lines: 40 }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive, 'state', 's1.json'), 'utf-8')).cursor, 40);

  // The sign-in is not planted anywhere a running build would read it: the staging variant has
  // its own, and an archive has no build. It is cleared from production, so login starts fresh.
  assert.equal(deps.store.credential, null);
  assert.equal(fs.existsSync(path.join(archive, 'credentials.json')), false);
  assert.equal(result.report.credentialPreserved, false);
  assert.equal(result.report.credentialCleared, true);

  // Production starts fresh and is bound.
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
  assert.equal(readBinding({ home: () => source }).env, '');
  assert.ok(!result.message.includes('at-staging'));

  // The next run is a no-op, not a second archive.
  assert.equal(ensureEnvironmentMigrated(deps).status, 'ok');
  assert.equal(archives().length, 1);
});

test('migration — an archive migration interrupted mid-way resumes into the SAME archive', (t) => {
  const source = sandbox(t, 'src-archive-resume');
  const destination = sandbox(t, 'dst-archive-resume');
  const archives = archivesOf(t, source);
  legacyRoot(source, { credential: stagingCredential });
  legacyRoot(destination);
  const deps = depsFor(source, destination, { credential: stagingCredential });
  let interrupted = false;
  deps.writeJsonSecure = (file, value) => {
    writeJsonSecure(file, value);
    if (!interrupted && path.basename(file) === 'migration.json' && value.phase === 'copied') {
      interrupted = true;
      throw new Error('simulated process termination');
    }
  };
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  assert.equal(interrupted, true);
  delete deps.writeJsonSecure;

  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
  assert.equal(archives().length, 1, 'a resume must not pick a fresh archive name');
  assert.equal(JSON.parse(fs.readFileSync(path.join(archives()[0], 'state', 's1.json'), 'utf-8')).cursor, 40);
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
});

test('rollback — an archive migration can be undone too', (t) => {
  const source = sandbox(t, 'src-archive-rollback');
  const destination = sandbox(t, 'dst-archive-rollback');
  archivesOf(t, source);
  legacyRoot(source, { credential: stagingCredential });
  legacyRoot(destination);
  const deps = depsFor(source, destination, { credential: stagingCredential });
  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');

  const back = rollbackMigration(deps);
  assert.equal(back.ok, true, back.reason);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
});

test('migration — a journal naming a foreign destination is refused, not followed', (t) => {
  const source = sandbox(t, 'src-foreign-journal');
  const destination = path.join(sandbox(t, 'dst-foreign-journal'), '.beezi-codex-staging');
  const elsewhere = sandbox(t, 'elsewhere');
  legacyRoot(source, { credential: stagingCredential });
  fs.writeFileSync(path.join(source, 'migration.json'), JSON.stringify({
    version: 1, phase: 'copying', from: source, to: elsewhere, at: new Date().toISOString(),
  }));
  const result = ensureEnvironmentMigrated(depsFor(source, destination, { credential: stagingCredential }));
  assert.equal(result.status, 'blocked');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
});

test('migration — a copy that cannot be verified removes nothing and keeps refusing', (t) => {
  const source = sandbox(t, 'src-verify');
  const destination = path.join(sandbox(t, 'dst-verify'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });

  // A filesystem whose copy silently drops one file: the size check is what catches it.
  const realFs = fs;
  const brokenFs = {
    ...realFs,
    copyFileSync(from, to) {
      if (String(from).indexOf('seg-1.json') !== -1) return; // "succeeds", writes nothing
      return realFs.copyFileSync(from, to);
    },
  };
  const deps = { ...depsFor(source, destination, { credential: stagingCredential }), fs: brokenFs };

  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'copy-failed');
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')), 'the original is untouched');
  assert.equal(fs.existsSync(path.join(source, 'environment.json')), false, 'and unbound, so it retries');
});

test('migration — an existing production override is adopted: the data stays where it is', (t) => {
  const source = sandbox(t, 'src-adopt');
  const destination = path.join(sandbox(t, 'dst-adopt'), '.beezi-codex-staging');
  legacyRoot(source, { credential: productionCredential });
  const deps = depsFor(source, destination, { credential: productionCredential });

  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'ok');
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
  assert.equal(fs.existsSync(destination), false, 'nothing was preserved because nothing moved');
  assert.equal(deps.store.credential, productionCredential, 'a production token is not cleared');
  const binding = readBinding({ home: () => source });
  assert.equal(binding.env, '');
  assert.equal(binding.source, 'adopted');
});

// The field report: a machine upgraded from a staging-default build, linked through staging's Clerk
// and stamped with the unsuffixed namespace's ''. It used to block login with "the API it was
// linked to could not be established"; it must migrate with nobody typing anything.
for (const [label, stamp] of [['stamped \'\'', ''], ['unstamped', undefined]]) {
  test(`migration — a pre-cutover staging-Clerk sign-in (${label}) migrates by itself`, (t) => {
    const source = sandbox(t, 'src-clerk');
    const destination = path.join(sandbox(t, 'dst-clerk'), '.beezi-codex-staging');
    const raw = JSON.stringify({
      access_token: 'at-clerk', refresh_token: 'rt-clerk', client_id: 'c1',
      token_endpoint: `${STAGING_OAUTH_ORIGIN}/oauth/token`, beezi_env: stamp,
    });
    legacyRoot(source, { credential: raw });
    const deps = depsFor(source, destination, { credential: raw });

    const result = ensureEnvironmentMigrated(deps);
    assert.equal(result.status, 'migrated', result.message);
    assert.equal(fs.existsSync(path.join(source, 'queue')), false);
    assert.equal(readBinding({ home: () => source }).env, '');
    // A staging sign-in is handed to the staging build, restamped.
    assert.equal(deps.store.credential, null);
    const blob = JSON.parse(JSON.parse(fs.readFileSync(path.join(destination, 'credentials.json'), 'utf-8')).token);
    assert.equal(blob.access_token, 'at-clerk');
    assert.equal(blob.beezi_env, 'staging');
  });
}

test('migration — an unknown issuer is preserved too, and its sign-in is not handed to staging', (t) => {
  const source = sandbox(t, 'src-unknown');
  const destination = path.join(sandbox(t, 'dst-unknown'), '.beezi-codex-staging');
  const custom = JSON.stringify({ access_token: 'x', token_endpoint: 'https://self.hosted.example/t' });
  legacyRoot(source, { credential: custom });
  const deps = depsFor(source, destination, { credential: custom });

  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'migrated', result.message);
  assert.ok(fs.existsSync(path.join(destination, 'queue', 'seg-1.json')));
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
  // Whatever that sign-in was, it is not staging's: restamping it as staging would plant a foreign
  // login in the staging namespace. It is cleared, and the destination holds a tombstone.
  assert.equal(deps.store.credential, null);
  assert.equal(fs.existsSync(path.join(destination, 'credentials.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'credential-control.json'), 'utf-8')).backend, null);
  assert.equal(result.report.credentialPreserved, false);
  assert.ok(result.message.includes('login'));
  // And it stays done.
  assert.equal(ensureEnvironmentMigrated(deps).status, 'ok');
});

test('migration — a discard interrupted after `prepared` resumes and still clears both ends', (t) => {
  const source = sandbox(t, 'src-discard-resume');
  const destination = path.join(sandbox(t, 'dst-discard-resume'), '.beezi-codex-staging');
  const custom = JSON.stringify({ access_token: 'x', token_endpoint: 'https://self.hosted.example/t' });
  legacyRoot(source, { credential: custom });
  const deps = depsFor(source, destination, { credential: custom });
  let interrupted = false;
  deps.writeJsonSecure = (file, value) => {
    writeJsonSecure(file, value);
    if (!interrupted && path.basename(file) === 'migration.json' && value.phase === 'prepared') {
      interrupted = true;
      throw new Error('simulated process termination');
    }
  };
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  assert.equal(interrupted, true);
  assert.equal(deps.store.credential, custom, 'killed before the delete');
  delete deps.writeJsonSecure;

  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
  assert.equal(deps.store.credential, null);
  assert.equal(fs.existsSync(path.join(destination, 'credentials.json')), false);
  assert.equal(fs.existsSync(path.join(source, 'queue')), false);
});

test('migration — a legacy bare token (not JSON) migrates instead of failing inspection', (t) => {
  const source = sandbox(t, 'src-bare');
  const destination = path.join(sandbox(t, 'dst-bare'), '.beezi-codex-staging');
  legacyRoot(source, { credential: 'bare-device-token' });
  const deps = depsFor(source, destination, { credential: 'bare-device-token' });
  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'migrated', result.message);
  assert.equal(deps.store.credential, null);
});

test('migration — --adopt still refuses a sign-in that is not production\'s', (t) => {
  const source = sandbox(t, 'src-manual-adopt');
  const custom = JSON.stringify({ access_token: 'x', token_endpoint: 'https://self.hosted.example/t' });
  legacyRoot(source, { credential: custom });
  const deps = { env: '', home: () => source, readRawCredential: () => custom, deleteRawCredential: () => true };

  assert.equal(adoptAsProduction(deps).ok, false);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
});

test('migration — a variant build binds its own root and never looks for a legacy one', (t) => {
  const source = sandbox(t, 'src-variant');
  legacyRoot(source, { credential: stagingCredential });
  let credentialReads = 0;
  const result = ensureEnvironmentMigrated({
    env: 'staging', apiOrigin: STAGING_API_ORIGIN,
    home: () => source,
    readRawCredential: () => { credentialReads += 1; return stagingCredential; },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(credentialReads, 1);
  assert.equal(readBinding({ home: () => source }), null);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
});

test('migration — a local variant remains usable after login stores its stamped credential', (t) => {
  const source = sandbox(t, 'src-local-linked');
  fs.writeFileSync(path.join(source, 'environment.json'), JSON.stringify({
    version: 1,
    env: 'local',
    apiOrigin: LOCAL_API_ORIGIN,
  }));

  const result = ensureEnvironmentMigrated({
    env: 'local',
    apiOrigin: LOCAL_API_ORIGIN,
    home: () => source,
    readRawCredential: () => localCredential,
  });

  assert.equal(result.status, 'ok');
});

test('migration — a root bound to staging refuses to serve a production build', (t) => {
  const source = sandbox(t, 'src-mismatch');
  legacyRoot(source);
  fs.writeFileSync(path.join(source, 'environment.json'), JSON.stringify({ version: 1, env: 'staging', apiOrigin: STAGING_API_ORIGIN }));
  // readRawCredential is stubbed even though the binding alone decides this verdict: unstubbed it
  // reads the DEVELOPER'S OWN keychain, which is what tools/hermetic-env.mjs now records.
  const result = ensureEnvironmentMigrated({ env: '', home: () => source, readRawCredential: () => null });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'binding-mismatch');
});

// ── contention ──────────────────────────────────────────────────────────────────────────────

test('migration — a second process finds the lock held and DEFERS rather than racing it', (t) => {
  const source = sandbox(t, 'src-lock');
  const destination = path.join(sandbox(t, 'dst-lock'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = {
    ...depsFor(source, destination, { credential: stagingCredential }),
    withLock: () => ({ ok: false, skipped: true, reason: 'held', holder: { pid: 999 } }),
  };
  const result = ensureEnvironmentMigrated(deps);
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'held');
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')), 'a deferred run touches nothing');
});

// ── rollback ────────────────────────────────────────────────────────────────────────────────

test('rollback — the preserved copy comes back, minus the credential', (t) => {
  const source = sandbox(t, 'src-rollback');
  const destination = path.join(sandbox(t, 'dst-rollback'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });
  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');

  const back = rollbackMigration(deps);
  assert.equal(back.ok, true);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
  assert.ok(fs.existsSync(path.join(source, 'state', 's1.json')));
  assert.equal(fs.existsSync(path.join(source, 'credentials.json')), false,
    'the sign-in stayed with staging; production re-links');
  assert.equal(readBinding({ home: () => source }).env, 'staging');
});

test('rollback — refuses when production has already written into the root', (t) => {
  const source = sandbox(t, 'src-rollback-dirty');
  const destination = path.join(sandbox(t, 'dst-rollback-dirty'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });
  ensureEnvironmentMigrated(deps);
  fs.mkdirSync(path.join(source, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(source, 'queue', 'prod-1.json'), '{}');

  const back = rollbackMigration(deps);
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'root-not-empty');
});

test('rollback — refuses when there is no completed migration to undo', (t) => {
  const source = sandbox(t, 'src-rollback-none');
  assert.equal(rollbackMigration({ env: '', home: () => source }).reason, 'no-completed-migration');
});

// ── status ──────────────────────────────────────────────────────────────────────────────────

test('status — reports the binding and the migration, and never a token', (t) => {
  const source = sandbox(t, 'src-status');
  const destination = path.join(sandbox(t, 'dst-status'), '.beezi-codex-staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });
  ensureEnvironmentMigrated(deps);

  const status = migrationStatus(deps);
  assert.equal(status.env, '');
  assert.equal(status.service, 'beezi-codex');
  assert.equal(status.bound, '');
  assert.equal(status.migration.phase, 'done');
  assert.equal(status.migration.to, destination);
  assert.ok(!JSON.stringify(status).includes('at-staging'));
});

// ── the REAL credential store, not the injected one ─────────────────────────────────────────
//
// Every case above injects readRawCredential/deleteRawCredential so the suite never touches a
// keyring. These two do not: R1 asks for the plaintext and native stores to be exercised, and the
// hand-off is the one step whose failure is silent and expensive — a staging token left in the
// production namespace is adopted, unstamped, by the production build.

// Forces the file backend: no native helper answers, which is also the real shape on a box with
// no libsecret. The file it reads and writes is this account's credentialsFile(<key>), inside the
// hermetic sandbox.
const FILE_STORE_DEPS = { platform: 'linux', run: () => ({ ok: false, stdout: '' }) };
const ACCOUNT_KEY = 'a1b2c3d4';
const storeFile = () => credentialsFile(ACCOUNT_KEY);

function withStoredCredential(t, raw) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify({ token: raw }));
  t.after(() => { try { fs.rmSync(storeFile(), { force: true }); } catch { /* gone */ } });
}

test('credentials — the real reader returns the blob unparsed, stamp and all', (t) => {
  withStoredCredential(t, stagingCredential);
  const raw = readRawCredential(ACCOUNT_KEY, FILE_STORE_DEPS);
  assert.equal(raw, stagingCredential);
  // The point of reading it raw: issuerEnvironment must see token_endpoint, which
  // getCredentials() would have filtered away by stamp long before this.
  assert.equal(issuerEnvironment(raw), 'staging');
});

test('credentials — the real delete works INSIDE the migration run lock (lock order, rank 1 → 4)', (t) => {
  // handOffCredential runs inside withLock(runLock('env-migration')), and deleteRawCredential
  // takes the credential lock in turn. If that nesting were an ordering violation, acquireLock
  // would refuse, mutateCredentials would throw, and the catch would report credentialCleared:
  // false — leaving the staging token exactly where it must not be. Asserted, not assumed.
  withStoredCredential(t, stagingCredential);
  const outcome = withLock(runLock('env-migration'), { leaseMs: 30_000 }, () => (
    deleteRawCredential(ACCOUNT_KEY, FILE_STORE_DEPS)
  ));
  assert.equal(outcome.skipped, false, 'the run lock itself must be free in a fresh sandbox');
  assert.equal(outcome.value, true, 'the credential must be gone, and reported gone');
  assert.equal(readRawCredential(ACCOUNT_KEY, FILE_STORE_DEPS), null);
});

for (const record of ['environment.json', 'credentials.json', 'credential-control.json']) {
  test(`corrupt ${record} blocks migration without replacing evidence`, t => {
    const source = sandbox(t, 'corrupt');
    fs.writeFileSync(path.join(source, record), '{broken');
    const result = ensureEnvironmentMigrated(depsFor(source, path.join(source, '..', 'unused-destination')));
    assert.equal(result.status, 'blocked');
    assert.equal(fs.readFileSync(path.join(source, record), 'utf8'), '{broken');
  });
}

test('an unsuffixed-namespace stamp plus staging issuer is a pre-cutover staging root: it migrates', t => {
  const source = sandbox(t, 'conflicting');
  const destination = path.join(sandbox(t, 'conflicting-dst'), 'staging');
  const raw = JSON.stringify({ ...JSON.parse(stagingCredential), beezi_env: '' });
  legacyRoot(source, { credential: raw });
  const deps = depsFor(source, destination, { credential: raw });
  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
  assert.equal(deps.store.credential, null);
  assert.ok(fs.existsSync(path.join(destination, 'credentials.json')), 'handed to staging');
});

// A user who deleted ~/.beezi-codex to get past the old block still has the pre-cutover sign-in in
// the OS keyring, which lives outside that directory. The empty root binds to production, and the
// next run finds a staging sign-in in it. Login is guarded too, so a block here had no way out.
test('a production-BOUND root holding a leftover staging sign-in clears it and proceeds', t => {
  const source = sandbox(t, 'bound-stale');
  const destination = path.join(sandbox(t, 'bound-stale-dst'), 'staging');
  const raw = JSON.stringify({
    access_token: 'at-old', refresh_token: 'rt-old', client_id: 'c1',
    token_endpoint: `${STAGING_OAUTH_ORIGIN}/oauth/token`, beezi_env: '',
  });
  fs.writeFileSync(path.join(source, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PRODUCTION_API_ORIGIN }));
  const deps = depsFor(source, destination, { credential: raw });
  assert.equal(ensureEnvironmentMigrated(deps).status, 'ok');
  assert.equal(deps.store.credential, null, 'a staging token has no place in the production namespace');
  assert.equal(ensureEnvironmentMigrated(deps).status, 'ok');
  assert.equal(fs.existsSync(path.join(destination, 'queue')), false, 'nothing was migrated');
});

// Only a sign-in KNOWN to be staging's is cleared. An unrecognised one may be production's under an
// issuer this module does not know yet — 236a9e0 was that bug — and clearing it would log every
// production user out on every run.
test('a production-BOUND root holding an unrecognised sign-in still blocks and keeps it', t => {
  const source = sandbox(t, 'bound-conflict');
  const raw = JSON.stringify({ access_token: 'x', token_endpoint: 'https://new-issuer.example/oauth/token', beezi_env: '' });
  fs.writeFileSync(path.join(source, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PRODUCTION_API_ORIGIN }));
  const deps = depsFor(source, path.join(sandbox(t, 'bound-conflict-dst'), 'staging'), { credential: raw });
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  assert.equal(deps.store.credential, raw);
});

test('a production-BOUND root whose staging sign-in cannot be deleted blocks, then recovers', t => {
  const source = sandbox(t, 'bound-stale-fail');
  const raw = JSON.stringify({ access_token: 'x', token_endpoint: `${STAGING_OAUTH_ORIGIN}/oauth/token`, beezi_env: '' });
  fs.writeFileSync(path.join(source, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PRODUCTION_API_ORIGIN }));
  const deps = depsFor(source, path.join(sandbox(t, 'bound-stale-fail-dst'), 'staging'), { credential: raw });
  const remove = deps.deleteRawCredential;
  deps.deleteRawCredential = () => false;
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  deps.deleteRawCredential = remove;
  assert.equal(ensureEnvironmentMigrated(deps).status, 'ok');
});

test('failed credential deletion is not a completed migration and can resume', t => {
  const source = sandbox(t, 'delete-failure');
  const destination = path.join(sandbox(t, 'delete-dst'), 'staging');
  legacyRoot(source, { credential: stagingCredential });
  const deps = depsFor(source, destination, { credential: stagingCredential });
  const remove = deps.deleteRawCredential;
  deps.deleteRawCredential = () => false;
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  assert.equal(readBinding(deps), null);
  assert.ok(fs.existsSync(path.join(source, 'queue', 'seg-1.json')));
  deps.deleteRawCredential = remove;
  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
});

test('failed source cleanup preserves the journal and revalidates the destination on restart', t => {
  const source = sandbox(t, 'cleanup-failure');
  const destination = path.join(sandbox(t, 'cleanup-dst'), 'staging');
  legacyRoot(source);
  const deps = depsFor(source, destination);
  deps.fs = { ...fs, unlinkSync: file => {
    if (file === path.join(source, 'queue', 'seg-1.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.unlinkSync(file);
  } };
  assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
  assert.equal(readBinding(deps), null);
  delete deps.fs;
  assert.equal(ensureEnvironmentMigrated(deps).status, 'migrated');
});

test('overlapping migration roots are rejected before creating destination files', t => {
  const source = sandbox(t, 'overlap');
  legacyRoot(source);
  assert.equal(ensureEnvironmentMigrated(depsFor(source, path.join(source, 'staging'))).status, 'blocked');
  assert.equal(fs.existsSync(path.join(source, 'staging')), false);
});

for (const phase of ['copying', 'copied', 'prepared', 'cleared', 'done']) {
  test(`restart after durable migration phase ${phase}`, t => {
    const source = sandbox(t, 'phase-' + phase);
    const destination = path.join(sandbox(t, 'phase-dst'), 'staging');
    legacyRoot(source, { credential: stagingCredential });
    const deps = depsFor(source, destination, { credential: stagingCredential, onDelete: () => {
      try { fs.unlinkSync(path.join(source, 'credentials.json')); } catch {}
      writeJsonSecure(path.join(source, 'credential-control.json'), { version: 1, revision: 'deleted', backend: null, beezi_env: '' });
    } });
    let interrupted = false;
    deps.writeJsonSecure = (file, value) => {
      writeJsonSecure(file, value);
      if (!interrupted && path.basename(file) === 'migration.json' && value.phase === phase) {
        interrupted = true;
        throw new Error('simulated process termination');
      }
    };
    assert.equal(ensureEnvironmentMigrated(deps).status, 'blocked');
    assert.equal(interrupted, true);
    delete deps.writeJsonSecure;
    const resumed = ensureEnvironmentMigrated(deps);
    assert.ok(['migrated', 'ok'].includes(resumed.status), resumed.message);
    assert.equal(fs.existsSync(path.join(source, 'queue', 'seg-1.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'state', 's1.json'))).cursor, 40);
    assert.equal(readBinding(deps).env, '');
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'credential-control.json'))).backend, null);
  });
}
