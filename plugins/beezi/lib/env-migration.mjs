import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { apiOrigin as effectiveApiOrigin } from './config.mjs';
import {
  beeziCodexHome,
  environmentBindingFile,
  migrationMarkerFile,
  preservedStagingHome,
  BEEZI_ENV,
  environment,
} from './paths.mjs';
import { readJson, writeJsonDurable as writeJsonSecure } from './fs-store.mjs';
import { orDefault, removeFileSync } from './compat.mjs';
import { runLock, withLock, acquireLock, inspectLock } from './single-instance-lock.mjs';
import {
  readRawCredential, deleteRawCredential, serviceFor, preserveMigrationCredential,
  tombstoneMigrationCredential, subjectCredentialsPath, subjectAuthorityPath, LEGACY_SUBJECT,
} from './credentials.mjs';

// ── The production cutover guard (G-1-2, R1) ────────────────────────────────────────────────
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// Every build published before this release pointed at the staging API by default
// (lib/config.mjs RELEASE_DEFAULT), and wrote its queue, cursors, ledger and credentials into the
// UNSUFFIXED root `~/.beezi-codex` — the same root the production build now claims. Flipping the
// default without moving that data is the one change in this plan that can bill a staging
// tenant's segments to a production one, because none of the existing guards can see it:
//
//   * the credential stamp (credentials.mjs ENV_STAMP) reads an UNSTAMPED legacy blob as
//     production, which is correct for pre-G-2-2 installs and exactly wrong for this one;
//   * the cursors in state/ are line offsets into rollouts whose earlier lines were already
//     delivered to staging, so a production replay starts mid-session with no way to know;
//   * the queue holds segments captured under a staging link, addressed to nobody in particular
//     — a drain under a fresh production token posts them to the new tenant.
//
// So the cutover ships with this module or it does not ship. The contract is R1's: preserve the
// legacy root under the staging namespace, start production fresh, keep a resumable marker, and
// refuse to upload anything at all while the environment of a root is ambiguous.
//
// WHAT THIS IS NOT: it is not a general-purpose environment switcher. It runs once per machine,
// it only ever moves the unsuffixed root, and it only moves it to the staging sibling. A variant
// build (dev/staging) has its own root by construction and needs no migration — it gets a binding
// stamp and nothing else.

const BINDING_VERSION = 1;
const MIGRATION_VERSION = 1;

// The API origins this plugin has ever shipped as a default. The classifier compares the issuer
// retained in the stored credentials against these, because THE ISSUER IS THE ONLY HONEST RECORD
// of which environment a root was linked to: `BEEZI_API_URL` is not persisted, the filename is
// not evidence (R1 forbids inferring an environment from one), and the data itself carries no
// environment stamp before this release.
export const STAGING_API_ORIGIN = 'https://beezi-api-staging.azurewebsites.net';
export const PRODUCTION_API_ORIGIN = 'https://beezi-api-prod.azurewebsites.net';

// Everything else at the data root is copied. These five are excluded on purpose:
//   locks, token-refresh.lock  ephemeral, and `locks` holds the lock this migration itself runs
//                              under — copying it would hand the staging root a file describing a
//                              live holder that will never release it there.
//   hooks                      launcher scripts that name THIS plugin directory. The staging
//                              variant installs its own; a copied launcher would make the staging
//                              root look installed while pointing at the production build.
//   environment.json,          the migration's own bookkeeping. The destination gets a freshly
//   migration.json             written binding instead of a copy of the source's.
const NOT_COPIED = Object.freeze([
  'locks', 'token-refresh.lock', 'hooks', 'environment.json', 'migration.json', 'credential-control.json',
]);

// A root with any of these is a root that has been USED. Anything outside this list (an empty
// directory, a stray editor file) leaves the root eligible for a plain binding stamp, which is
// what a fresh install must get — a first run that blocked itself on migration would be a far
// worse bug than the one this module exists to prevent.
const DATA_ENTRIES = Object.freeze([
  'queue', 'state', 'diagnostics', 'quarantine', 'accounts',
  'credentials.json', 'billing.json', 'repo-map.json', 'audit-ledger.json',
  'usage-observations.json', 'tracking.json', 'account-sync.json', 'telemetry.json',
  'watcher.json', 'coverage.json', 'accounts.json', 'accounts.migration.json',
]);

function originOf(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Which environment issued the credentials sitting in a legacy root?
 *
 * `raw` is the credential blob exactly as a backend stored it — NOT the parsed object
 * credentials.mjs hands out, because that one is filtered by the very stamp this function exists
 * to compensate for. A blob that is already stamped answers directly; otherwise the OAuth
 * `token_endpoint` names the issuer, and lib/token.mjs proves it is authoritative by refreshing
 * against it.
 *
 * Returns one of: 'staging' | 'production' | 'unlinked' | 'unknown'.
 */
export function issuerEnvironment(raw) {
  if (raw === null || raw === undefined || raw === '') return 'unlinked';
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  if (!obj || typeof obj !== 'object') return 'unknown';

  const origin = originOf(obj.token_endpoint);
  const issuer = origin === STAGING_API_ORIGIN ? 'staging'
    : origin === PRODUCTION_API_ORIGIN ? 'production' : 'unknown';
  const stamped = obj.beezi_env;
  if (typeof stamped === 'string') {
    const stamp = stamped === '' ? 'production'
      : stamped === 'staging' || stamped === 'dev' ? 'staging' : 'unknown';
    return issuer !== 'unknown' && issuer === stamp ? issuer : 'unknown';
  }

  // A self-hosted or dev API the plugin has never shipped as a default already resolved to
  // 'unknown' above. R1: stop, do not guess.
  return issuer;
}

// ── whose credentials this root holds ───────────────────────────────────────────────────────
//
// A root is migrated whole, but from 0.13 on a credential belongs to an ACCOUNT. accounts.json is
// what says which shape a root is in: present with rows means the keyed layout and one subject per
// row; absent means the pre-0.13 layout and the single machine-wide entry. BOTH shapes occur here —
// the environment guard runs before the accounts migration (spec decision 10), so the first run
// after an upgrade still meets the legacy one.
//
// strictRecord, not a tolerant read: a corrupt accounts.json on a root that still holds accounts/
// would otherwise fall back to the legacy subject and silently leave every keyed entry behind. It
// is ambiguous evidence, and R1's answer to ambiguity is to stop.
function credentialSubjects(deps) {
  const index = strictRecord(path.join(homeOf(deps), 'accounts.json'), deps);
  if (!index || typeof index !== 'object' || !Array.isArray(index.accounts)) return [LEGACY_SUBJECT];
  const keys = index.accounts
    .filter(row => row && typeof row.key === 'string' && /^[0-9a-f]{8}$/.test(row.key))
    .map(row => row.key);
  return keys.length ? keys : [LEGACY_SUBJECT];
}

function readSubjectRaw(subject, deps) {
  return orDefault(deps.readRawCredential, readRawCredential)(subject, deps);
}

/** Every subject this root holds, paired with the blob it is holding (or null). */
function readSubjects(deps) {
  return credentialSubjects(deps).map(subject => ({ subject, raw: readSubjectRaw(subject, deps) }));
}

/**
 * One issuer verdict for the whole root.
 *
 * Every subject that holds something has to name the same environment. Two that disagree make the
 * root ambiguous, and ambiguity blocks (R1) — preserving half a machine into staging and leaving
 * the other half pointed at production is the outcome this module exists to prevent. A subject that
 * holds nothing does not vote.
 */
function rootIssuer(records) {
  let verdict = 'unlinked';
  for (const record of records) {
    const issuer = issuerEnvironment(record.raw);
    if (issuer === 'unlinked') continue;
    if (verdict === 'unlinked') verdict = issuer;
    else if (verdict !== issuer) return 'unknown';
  }
  return verdict;
}

// A subject's two files as inventory() spells them: relative to the root, '/'-separated.
//
// BOTH are rewritten at the destination — the blob by the hand-off and the authority record by the
// hand-off or the tombstone loop, each with a fresh revision — so neither can be hashed against the
// source. inventory() only skips NOT_COPIED at the TOP level, so an account's
// accounts/<key>/credential-control.json is inventoried and copied like any other nested file; the
// pre-0.13 subject's is at the root, where inventory() already skips it and this is a no-op.
function subjectRels(root, subject) {
  return [subjectCredentialsPath(root, subject), subjectAuthorityPath(root, subject)]
    .map(file => path.relative(root, file).split(path.sep).join('/'));
}

// The subjects a migration step should act on. A resumed run whose source has already been cleaned
// read none, so it falls back to the pre-0.13 single subject — which is what such a journal means.
function credentialRecords(facts) {
  if (Array.isArray(facts.credentials) && facts.credentials.length) return facts.credentials;
  return [{ subject: LEGACY_SUBJECT, raw: orDefault(facts.raw, null) }];
}

// The journal records a subject as its key, or null for the pre-0.13 one: a Symbol is not JSON.
function subjectFromJournal(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value) ? value : LEGACY_SUBJECT;
}

function subjectToJournal(subject) {
  return subject === LEGACY_SUBJECT ? null : subject;
}

function entriesOf(dir, deps) {
  const fsImpl = orDefault(deps.fs, fs);
  try {
    return fsImpl.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Has this root ever been written to by the plugin? */
export function rootHasData(dir, deps = {}) {
  const names = entriesOf(dir, deps);
  for (const name of names) {
    if (DATA_ENTRIES.indexOf(name) !== -1) return true;
  }
  return false;
}

/**
 * The decision, as a pure function. Every input arrives in `facts`, so the whole matrix — fresh
 * install, already-bound root, a legacy staging root, a root somebody explicitly pointed at
 * production, an unreadable credential — is testable without a filesystem.
 *
 *   env        the resolved environment name ('' = production)
 *   binding    the parsed environment.json, or null
 *   hasData    whether the root holds plugin data
 *   issuer     issuerEnvironment() of the raw credential blob
 *
 * Verdicts:
 *   'ok'          nothing to do; the root already belongs to this environment
 *   'bind'        stamp the root and continue (fresh install, or a variant's own root)
 *   'migrate'     preserve the legacy root under the staging namespace, then start fresh
 *   'adopt'       a legacy root that was already linked to production — stamp, never move
 *   'blocked'     the environment of this root cannot be established; stop uploading (R1)
 */
export function classifyRoot(facts) {
  const f = facts || {};
  const env = f.env;
  const binding = f.binding;

  const expected = env === '' ? 'production' : 'staging';
  const api = f.apiOrigin || (env === '' ? PRODUCTION_API_ORIGIN : STAGING_API_ORIGIN);
  if ((env === '' && api !== PRODUCTION_API_ORIGIN)
    || (env === 'staging' && api !== STAGING_API_ORIGIN)) {
    return { verdict: 'blocked', reason: 'api-mismatch' };
  }

  if (binding && typeof binding === 'object' && typeof binding.env === 'string') {
    if (binding.env === env) {
      // The cutover classifier can identify only the two API origins the public plugin has
      // shipped. Dev and local credentials therefore have issuer='unknown', but a named
      // variant still carries exact environment evidence in the credential stamp written by
      // setCredentials(). The token endpoint only has to be PRESENT, not to match the API:
      // OAuth discovery legitimately puts it on an external issuer such as Clerk, so comparing
      // it with the Beezi API origin made a fresh local login block every later operation.
      // The root's own origin is still verified independently by the `binding.apiOrigin !== api`
      // test below, so the credential is only ever asked for its environment.
      const matchingNamedCredential = env !== ''
        && typeof f.credentialOrigin === 'string'
        && f.credentialEnv === env;
      if (binding.apiOrigin !== api || (f.issuer !== 'unlinked' && f.issuer !== expected
        && !matchingNamedCredential)) {
        return { verdict: 'blocked', reason: 'conflicting-evidence' };
      }
      return { verdict: 'ok' };
    }
    return {
      verdict: 'blocked',
      reason: 'binding-mismatch',
      detail: `this data root is bound to the ${describeEnv(binding.env)} environment,`
        + ` but this build resolves to ${describeEnv(env)}`,
    };
  }

  // A selected variant is not evidence of ownership of a populated custom root.
  if (env !== '') return f.hasData
    ? { verdict: 'blocked', reason: 'populated-unbound-root' } : { verdict: 'bind' };

  if (!f.hasData) return { verdict: 'bind' };

  if (f.issuer === 'production') return { verdict: 'adopt' };
  // 'unlinked' is decidable, not ambiguous: an unlinked legacy root was necessarily captured
  // under the release default of the build that wrote it, and every build before this release
  // defaulted to staging. Preserving it costs nothing (it was never delivered anywhere) and
  // leaves production with the fresh state R1 requires.
  if (f.issuer === 'staging' || f.issuer === 'unlinked') {
    return { verdict: 'migrate', reason: f.issuer };
  }
  return {
    verdict: 'blocked',
    reason: 'unknown-issuer',
    detail: 'this data root holds analytics from an earlier install, and the environment it was'
      + ' linked to could not be established from its stored credentials',
  };
}

function describeEnv(name) {
  if (name === '') return 'production';
  if (typeof name === 'string' && name !== '') return name;
  return 'an unnamed';
}

// ── binding + marker records ────────────────────────────────────────────────────────────────

// Every path below is derived from ONE root — deps.home when a caller injects it, the resolved
// data root otherwise — so a test that redirects the root cannot end up with a binding written
// beside the real one. The bindingFile/markerFile seams remain for the destination's own records.
function homeOf(deps) {
  return orDefault(deps.home, beeziCodexHome)();
}

function bindingPathOf(deps) {
  if (deps.bindingFile) return deps.bindingFile();
  if (deps.home) return path.join(homeOf(deps), 'environment.json');
  return environmentBindingFile();
}

function markerPathOf(deps) {
  if (deps.markerFile) return deps.markerFile();
  if (deps.home) return path.join(homeOf(deps), 'migration.json');
  return migrationMarkerFile();
}

export function readBinding(deps = {}) {
  const obj = strictRecord(bindingPathOf(deps), deps);
  if (obj === null) return null;
  if (!obj || obj.version !== BINDING_VERSION || typeof obj.env !== 'string'
    || !originOf(obj.apiOrigin)) throw new Error('Invalid environment binding');
  if (obj.root && obj.root !== path.resolve(path.dirname(bindingPathOf(deps)))) throw new Error('Binding root mismatch');
  return obj;
}

function strictRecord(file, deps) {
  if (deps.readJson) return deps.readJson(file, null);
  try { return JSON.parse(orDefault(deps.fs, fs).readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeBinding(record, deps = {}) {
  const write = orDefault(deps.writeJsonSecure, writeJsonSecure);
  const now = orDefault(deps.now, Date.now);
  write(bindingPathOf(deps), {
    version: BINDING_VERSION,
    root: path.resolve(path.dirname(bindingPathOf(deps))),
    env: record.env,
    apiOrigin: orDefault(record.apiOrigin, null),
    source: orDefault(record.source, 'fresh'),
    at: new Date(now()).toISOString(),
  });
}

function readMarker(deps) {
  const obj = strictRecord(markerPathOf(deps), deps);
  if (obj === null) return null;
  if (!obj || obj.version !== MIGRATION_VERSION) throw new Error('Invalid migration journal');
  return obj;
}

function writeMarker(record, deps) {
  const write = orDefault(deps.writeJsonSecure, writeJsonSecure);
  const now = orDefault(deps.now, Date.now);
  const previous = strictRecord(markerPathOf(deps), deps);
  const merged = { ...(previous || {}), version: MIGRATION_VERSION, env: '', apiOrigin: PRODUCTION_API_ORIGIN,
    at: new Date(now()).toISOString() };
  for (const key of Object.keys(record)) merged[key] = record[key];
  write(markerPathOf(deps), merged);
  return merged;
}

// ── the copy ────────────────────────────────────────────────────────────────────────────────
//
// Hand-rolled rather than fs.cpSync: that landed in Node 16.7 and this plugin's floor is 13.2
// (test/compat-syntax.test.mjs). Directories are created 0700 and files keep 0600 through
// copyFileSync, which preserves the source mode — the legacy root's credentials.json is already
// written that way by writeJsonSecure.

function copyTreeSync(from, to, deps) {
  const fsImpl = orDefault(deps.fs, fs);
  const stat = fsImpl.lstatSync(from);
  if (stat.isDirectory()) {
    fsImpl.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of fsImpl.readdirSync(from)) {
      copyTreeSync(path.join(from, name), path.join(to, name), deps);
    }
    return;
  }
  // Symlinks are not followed: nothing this plugin writes is a link, and a link in the legacy
  // root is either a user's own arrangement or something hostile. Skipping keeps the copy a copy.
  if (!stat.isFile()) throw new Error('Unsupported link or special file in migration');
  fsImpl.copyFileSync(from, to);
  const fd = fsImpl.openSync(to, 'r+');
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}

function removeTreeSync(target, deps) {
  const fsImpl = orDefault(deps.fs, fs);
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of fsImpl.readdirSync(target)) {
      removeTreeSync(path.join(target, name), deps);
    }
    fsImpl.rmdirSync(target);
    return;
  }
  fsImpl.unlinkSync(target);
}

/**
 * Every file under `dir`, relative to it, with its size. The verification evidence: the source is
 * only deleted once every entry it held is present at the destination at the same size.
 */
function inventory(dir, deps, prefix = '') {
  const fsImpl = orDefault(deps.fs, fs);
  const out = [];
  const names = fsImpl.readdirSync(dir);
  for (const name of names) {
    const full = path.join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (prefix === '' && NOT_COPIED.indexOf(name) !== -1) continue;
    const stat = fsImpl.lstatSync(full);
    if (stat.isDirectory()) {
      for (const entry of inventory(full, deps, rel)) out.push(entry);
    } else if (stat.isFile()) {
      out.push({ rel, size: stat.size, hash: crypto.createHash('sha256').update(fsImpl.readFileSync(full)).digest('hex') });
    } else throw new Error('Unsupported link or special file in migration');
  }
  return out;
}

function verifyCopy(from, to, deps) {
  const fsImpl = orDefault(deps.fs, fs);
  const missing = [];
  for (const entry of inventory(from, deps)) {
    const target = path.join(to, entry.rel.split('/').join(path.sep));
    let stat;
    try { stat = fsImpl.statSync(target); } catch { missing.push(entry.rel); continue; }
    if (stat.size !== entry.size
      || crypto.createHash('sha256').update(fsImpl.readFileSync(target)).digest('hex') !== entry.hash) missing.push(entry.rel);
  }
  return missing;
}

// ── the credential hand-off ─────────────────────────────────────────────────────────────────
//
// Clear one subject from the SOURCE namespace: a hard delete when its blob was preserved at the
// destination, a tombstone when it was retained where it is.
function clearSubject(subject, retained, deps) {
  if (retained) return orDefault(deps.tombstoneMigrationCredential, tombstoneMigrationCredential)(subject, deps);
  return orDefault(deps.deleteRawCredential, deleteRawCredential)(subject, deps);
}

// Commit destination credentials and their authority before clearing the source authority.
// Protected credentials use a native destination or remain protected behind a tombstone;
// only an existing plaintext file may be handed off as plaintext.
function handOffCredential(subject, raw, destination, deps) {
  const write = orDefault(deps.writeJsonSecure, writeJsonSecure);
  const read = orDefault(deps.readJson, readJson);
  const journalled = subjectToJournal(subject);
  const target = subjectCredentialsPath(destination, subject);
  const sourceFile = strictRecord(subjectCredentialsPath(homeOf(deps), subject), deps);
  const sourceControl = strictRecord(subjectAuthorityPath(homeOf(deps), subject), deps);
  // Native and DPAPI stores must never become plaintext as a side effect of migration.
  if (!sourceFile || sourceFile.token !== raw || (sourceControl && sourceControl.backend !== 'file')) {
    const preserved = orDefault(deps.preserveMigrationCredential, preserveMigrationCredential)(subject, raw, destination, deps);
    const credential = { subject: journalled, preserved, retained: !preserved, cleared: false };
    writeMarker({ phase: 'prepared', from: homeOf(deps), to: destination, credential }, deps);
    credential.cleared = clearSubject(subject, !preserved, deps);
    return credential;
  }

  let preserved = false;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      obj.beezi_env = 'staging';
      obj.beezi_revision = crypto.randomBytes(16).toString('hex');
      write(target, { token: JSON.stringify(obj) });
      const back = read(target, null);
      preserved = !!(back && typeof back.token === 'string'
        && back.token === JSON.stringify(obj));
      // The authority record goes beside the credential it describes, in the DESTINATION's own
      // layout — accounts/<key>/ for an account, the root for the pre-0.13 subject. Write it at the
      // destination root for a keyed subject and no keyed reader ever finds it.
      if (preserved) write(subjectAuthorityPath(destination, subject), {
        version: 1, revision: obj.beezi_revision, backend: 'file', beezi_env: 'staging',
      });
    }
  } catch {
    preserved = false;
  }

  // Whether or not the copy took, the production namespace must not keep it — and a copy that did
  // not verify must stop the migration here rather than travel back as a verdict the caller has to
  // re-judge. Same message the caller raises when a hand-off comes back uncleared.
  if (!preserved) throw new Error('Credential hand-off was not verified');
  writeMarker({ phase: 'prepared', from: homeOf(deps), to: destination,
    credential: { subject: journalled, preserved: true, cleared: false } }, deps);
  let cleared = true;
  try { cleared = orDefault(deps.deleteRawCredential, deleteRawCredential)(subject, deps); } catch { cleared = false; }
  return { subject: journalled, preserved, cleared };
}

// ── the guard ───────────────────────────────────────────────────────────────────────────────

/**
 * Run before login, before any checkpoint, before a queue drain and before a token refresh — at
 * the MCP and CLI/hook entry points, which is where every one of those begins.
 *
 * Never throws. Returns:
 *   { status: 'ok' }                       proceed
 *   { status: 'migrated', report }         proceed; the legacy root was preserved this run
 *   { status: 'deferred', reason }         another process holds the migration lock — do no work
 *   { status: 'blocked', reason, message } stop: uploading would cross an environment boundary
 *
 * A 'deferred' is a skip, not a failure: the hook that gets it has no right to wait on another
 * process, and its work is picked up by the next invocation once the migration completes.
 */
export function ensureEnvironmentMigrated(deps = {}) {
  try { return ensureEnvironmentMigratedImpl(deps); }
  catch (error) {
    return { status: 'blocked', reason: 'inspection-or-migration-failed', message: `Beezi: environment verification failed (${error.message}). No uploads are permitted.` };
  }
}

function ensureEnvironmentMigratedImpl(deps) {
  try {
    environment.assertEnvironment();
  } catch (err) {
    return {
      status: 'blocked',
      reason: 'environment-invalid',
      message: err.message,
    };
  }

  const env = orDefault(deps.env, BEEZI_ENV);
  const binding = readBinding(deps);
  const root = homeOf(deps);
  const credentialFile = strictRecord(path.join(root, 'credentials.json'), deps);
  const control = strictRecord(path.join(root, 'credential-control.json'), deps);
  if (credentialFile !== null && (!credentialFile || (typeof credentialFile.token !== 'string'
    && typeof credentialFile.enc !== 'string'))) throw new Error('Invalid credential file');
  if (control !== null && (!control || control.version !== 1 || typeof control.revision !== 'string'
    || (control.backend !== null && typeof control.backend !== 'string'))) throw new Error('Invalid credential authority');
  const apiOrigin = orDefault(deps.apiOrigin, effectiveApiOrigin());

  const facts = {
    env,
    apiOrigin,
    binding,
    hasData: rootHasData(root, deps),
    issuer: 'unlinked',
  };
  // Only read the credentials when the answer can change the verdict: a bound root and a fresh
  // root both decide without them, and on Windows each read costs a PowerShell spawn.
  if (facts.hasData || binding) {
    const records = readSubjects(deps);
    const holder = records.find(record => record.raw) || null;
    if (!holder && credentialFile && !(control && control.backend === null)) throw new Error('Stored credentials could not be read');
    facts.issuer = rootIssuer(records);
    facts.credentials = records;
    facts.raw = holder ? holder.raw : null;
    if (holder) {
      const credential = JSON.parse(holder.raw);
      facts.credentialOrigin = originOf(credential.token_endpoint);
      facts.credentialEnv = credential.beezi_env;
    }
  }

  const marker = readMarker(deps);
  if (marker && marker.phase !== 'done') return runMigration(facts, deps);

  const decision = classifyRoot(facts);

  if (decision.verdict === 'ok') {
    if (orDefault(deps.fs, fs).existsSync(path.join(root, 'locks', 'migration-barrier.lock'))) {
      return withMigrationRoots(deps, () => ({ status: 'ok' }));
    }
    return { status: 'ok' };
  }

  if (decision.verdict === 'blocked') {
    return {
      status: 'blocked',
      reason: decision.reason,
      message: recoveryMessage(decision, env),
    };
  }

  if (decision.verdict === 'bind' || decision.verdict === 'adopt') {
    writeBinding({
      env,
      apiOrigin,
      source: decision.verdict === 'adopt' ? 'adopted' : 'fresh',
    }, deps);
    return { status: 'ok' };
  }

  return runMigration(facts, deps);
}

/**
 * The migration itself, under the run lock.
 *
 * Phases are recorded in the marker BEFORE the step they describe, so an interrupted run resumes
 * rather than restarts: `copying` re-copies (idempotent — the copy overwrites), `copied` skips
 * straight to verification, `cleared` skips the credential hand-off. The source is never removed
 * until verifyCopy() returns empty, which is R1's "do not delete the preserved copy until
 * migration completion is verified" read from the only side that matters — the copy is the thing
 * being preserved, so the ORIGINAL is what must wait.
 */
function runMigration(facts, deps) {
  return withMigrationRoots(deps, permit => runMigrationLocked(facts, { ...deps, migrationPermit: permit }));
}

function withMigrationRoots(deps, fn) {
  const roots = [homeOf(deps), orDefault(deps.preservedHome, preservedStagingHome)()].map(p => path.resolve(p)).sort();
  for (const root of roots) {
    let current = root;
    while (true) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Migration paths cannot contain links'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const [from, to] of [[roots[0], roots[1]], [roots[1], roots[0]]]) {
    const relative = path.relative(from, to);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Migration roots overlap');
    }
  }
  const handles = [];
  try {
    for (const root of roots) {
      const file = path.join(root, 'locks', 'migration-barrier.lock');
      const acquired = acquireLock({ name: 'migration-barrier', kind: 'migration', file }, { leaseMs: 120000 });
      if (!acquired.ok) return { status: 'deferred', reason: 'migration-barrier' };
      handles.push(acquired.handle);
    }
    for (const root of roots) {
      const dir = path.join(root, 'locks');
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.lock') || name === 'migration-barrier.lock' || name.startsWith('election-')) continue;
        const seen = inspectLock({ name, file: path.join(dir, name), kind: 'shared' });
        if (seen.held && !seen.takeoverReady) return { status: 'deferred', reason: 'active-writer' };
      }
    }
    const verify = () => {
      if (handles.some(h => !h.verify().ok)) throw new Error('Migration barrier ownership lost');
    };
    verify();
    deps.verifyMigration = verify;
    return fn(handles.find(h => path.dirname(path.dirname(h.file)) === path.resolve(homeOf(deps))).token);
  } finally { for (const handle of handles.reverse()) handle.release(); }
}

function runMigrationLocked(facts, deps) {
  const destinationOf = orDefault(deps.preservedHome, preservedStagingHome);
  const source = homeOf(deps);
  const destination = destinationOf();
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const relative = path.relative(sourcePath, destinationPath);
  const reverse = path.relative(destinationPath, sourcePath);
  if (!relative || !relative.startsWith('..') || !reverse.startsWith('..')) {
    throw new Error('Migration roots must be separate and non-overlapping');
  }
  for (const root of [sourcePath, destinationPath]) {
    try { if (orDefault(deps.fs, fs).lstatSync(root).isSymbolicLink()) throw new Error('Linked migration root'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const lock = orDefault(deps.withLock, withLock);
  const descriptor = { ...runLock('env-migration'), file: path.join(source, 'locks', 'run-env-migration.lock') };
  const result = lock(descriptor, { leaseMs: 120_000, migrationPermit: deps.migrationPermit }, () => {
    // Re-read inside the lock: another process may have completed the whole migration between
    // our classification and our acquisition, and the binding it wrote is the proof.
    const current = readBinding(deps);
    const fsImpl = orDefault(deps.fs, fs);
    const existing = readMarker(deps);
    if (!existing || existing.phase === 'done') {
      const probed = readSubjects(deps);
      const probedHolder = probed.find(record => record.raw) || null;
      facts = { ...facts,
        credentials: probed,
        raw: probedHolder ? probedHolder.raw : null,
        issuer: rootIssuer(probed),
        binding: current,
        hasData: rootHasData(source, deps) };
      const decision = classifyRoot(facts);
      if (decision.verdict === 'ok') return { status: 'ok' };
      if (!facts.forced && decision.verdict !== 'migrate') {
        return { status: 'deferred', reason: 'environment-evidence-changed' };
      }
    }
    if (existing && (path.resolve(existing.from) !== sourcePath || path.resolve(existing.to) !== destinationPath
      || ['copying', 'copied', 'prepared', 'cleared', 'done'].indexOf(existing.phase) === -1)) throw new Error('Conflicting migration journal');
    let phase = existing && typeof existing.phase === 'string' ? existing.phase : 'start';

    // The cutover journal records ONE credential hand-off, and a root that can still reach this
    // path holds one: the guard binds every root at its first entry point, long before an account
    // can be linked there. A root that nevertheless holds two live logins cannot be preserved
    // faithfully by this journal, so it is refused whole rather than half-moved — nothing is
    // copied, nothing is cleared and nothing is uploaded, which is this module's failure posture.
    if (credentialRecords(facts).filter(record => record.raw).length > 1) {
      return {
        status: 'blocked',
        reason: 'multi-account-root',
        message: 'Beezi: this machine has more than one account linked, and the one-time switch to\n'
          + 'the production API can only hand over one sign-in. Nothing was moved and nothing is\n'
          + 'being uploaded. Log out all but one account, then run any Beezi command again.',
      };
    }

    // A destination that already holds a staging install is not ours to overwrite. This is the
    // "simultaneous installed variants" case from R1's matrix: the machine runs the staging
    // variant AND is now upgrading the production build.
    if (phase === 'start' && rootHasData(destination, deps)) {
      return {
        status: 'blocked',
        reason: 'destination-occupied',
        message: 'Beezi: this machine already has a staging install holding its own analytics at\n'
          + `  ${destination}\n`
          + 'so the legacy production-namespace data could not be preserved there. Nothing was\n'
          + 'moved and nothing is being uploaded. Move or remove that directory, then run any\n'
          + 'Beezi command again.',
      };
    }

    // The copy runs on every phase up to the hand-off, including a resumed `copied`: it is an
    // idempotent overwrite, and a run interrupted BETWEEN the copy and its verification left a
    // partial tree with the marker already advanced. Re-copying is cheap; refusing forever
    // because a previous process died mid-write is not a recovery path at all.
    if (phase === 'start' || phase === 'copying' || phase === 'copied') {
      writeMarker({ phase: 'copying', from: source, to: destination }, deps);
      try {
        fsImpl.mkdirSync(destination, { recursive: true, mode: 0o700 });
        for (const name of fsImpl.readdirSync(source)) {
          if (NOT_COPIED.indexOf(name) !== -1) continue;
          copyTreeSync(path.join(source, name), path.join(destination, name), deps);
        }
      } catch (err) {
        writeMarker({ phase: 'copying', from: source, to: destination, error: String(err && err.message) }, deps);
        return {
          status: 'blocked',
          reason: 'copy-failed',
          message: 'Beezi: could not preserve this machine\'s earlier analytics data before\n'
            + 'switching to the production API, so nothing is being uploaded. The data is\n'
            + `untouched at ${source}. Check that the disk is writable and run any Beezi command\n`
            + 'again; the migration resumes where it stopped.',
        };
      }
      phase = 'copied';
      // Every subject's credential file AND authority record are left out of the durable
      // verification: the destination copies of both are rewritten with a fresh revision.
      const handedOff = [];
      for (const record of credentialRecords(facts)) {
        for (const rel of subjectRels(source, record.subject)) handedOff.push(rel);
      }
      writeMarker({ phase, from: source, to: destination,
        verification: inventory(source, deps).filter(entry => handedOff.indexOf(entry.rel) === -1) }, deps);
    }

    // Verify against the source. inventory() — which verifyCopy walks — already skips the
    // top-level NOT_COPIED entries, so what comes back is only what was meant to be copied.
    const missing = phase === 'cleared' || phase === 'prepared' ? [] : verifyCopy(source, destination, deps);
    if (missing.length) {
      writeMarker({ phase: 'copying', from: source, to: destination, missing: missing.slice(0, 20) }, deps);
      return {
        status: 'blocked',
        reason: 'verify-failed',
        message: 'Beezi: the copy of this machine\'s earlier analytics data could not be verified,\n'
          + 'so nothing was removed and nothing is being uploaded. Run any Beezi command again to\n'
          + 'retry the copy.',
      };
    }

    writeBinding({ env: 'staging', apiOrigin: STAGING_API_ORIGIN, source: 'migrated' }, {
      ...deps,
      bindingFile: () => path.join(destination, 'environment.json'),
    });

    let credential = existing && existing.credential || { preserved: false, cleared: true };
    const records = credentialRecords(facts);
    const holder = records.find(record => record.raw) || null;
    if (phase === 'copied') {
      // An authoritative logout must not revive a copied fallback credential in staging. Each
      // subject that handed nothing over gets its own tombstone, beside where the destination will
      // look for that subject's authority.
      for (const record of records) {
        if (record.raw) continue;
        orDefault(deps.writeJsonSecure, writeJsonSecure)(subjectAuthorityPath(destination, record.subject), {
          version: 1, revision: crypto.randomBytes(16).toString('hex'), backend: null, beezi_env: 'staging',
        });
      }
    }
    if (phase === 'prepared' || (phase !== 'cleared' && holder)) {
      credential = phase === 'prepared'
        ? { ...credential,
          cleared: clearSubject(subjectFromJournal(credential.subject), credential.retained, deps) }
        : handOffCredential(holder.subject, holder.raw, destination, deps);
      if (!credential.cleared || (!credential.preserved && !credential.retained)) throw new Error('Credential hand-off was not verified');
      phase = 'cleared';
      writeMarker({ phase, from: source, to: destination, credential }, deps);
    }
    const journal = readMarker(deps);
    if (!Array.isArray(journal.verification)) throw new Error('Missing durable copy verification');
    for (const entry of journal.verification) {
      const target = path.resolve(destination, entry.rel);
      if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error('Invalid inventory path');
      if (crypto.createHash('sha256').update(fsImpl.readFileSync(target)).digest('hex') !== entry.hash) {
        throw new Error('Preserved data failed content verification');
      }
    }
    if (phase !== 'cleared') {
      phase = 'cleared';
      writeMarker({ phase, from: source, to: destination, credential }, deps);
    }

    // Only now does the source lose the data it handed over. Production starts fresh: R1 is
    // explicit that staging cursors must not be reused, and the cheapest way to guarantee that is
    // to leave nothing for a production run to read.
    for (const name of fsImpl.readdirSync(source)) {
      if (NOT_COPIED.indexOf(name) !== -1) continue;
      deps.verifyMigration();
      removeTreeSync(path.join(source, name), deps);
    }
    if (fsImpl.readdirSync(source).some(name => NOT_COPIED.indexOf(name) === -1)) throw new Error('Source cleanup incomplete');

    writeBinding({ env: facts.env, apiOrigin: PRODUCTION_API_ORIGIN, source: 'post-migration' }, deps);
    const marker = writeMarker({
      phase: 'done', from: source, to: destination, credential, preservedEntries: true,
    }, deps);

    return {
      status: 'migrated',
      report: {
        from: source,
        to: destination,
        credentialPreserved: credential.preserved,
        credentialCleared: credential.cleared,
        at: marker.at,
      },
      message: migrationNotice(destination, credential),
    };
  }, deps);

  if (result.skipped) {
    return { status: 'deferred', reason: orDefault(result.reason, 'held') };
  }
  return result.value;
}

function migrationNotice(destination, credential) {
  const lines = [
    'Beezi now reports to the production API.',
    '',
    'This machine\'s earlier data was captured against the staging API, so it was preserved',
    `at ${destination} rather than uploaded to your production tenant. Production analytics`,
    'start fresh from this session.',
  ];
  if (credential.preserved) {
    lines.push('', 'Your previous staging sign-in was moved there too; the staging build picks it up.');
  } else if (credential.retained) {
    lines.push('', 'Protected credentials were retained behind a tombstone. Sign in again in the staging build.');
  } else if (credential.cleared) {
    lines.push('', 'Your previous sign-in could not be moved and was cleared. Run /beezi:login to');
    lines.push('link this machine to production.');
  }
  lines.push('', 'To roll back: node scripts/migrate-env.mjs --rollback');
  return lines.join('\n');
}

function recoveryMessage(decision, env) {
  if (decision.reason === 'binding-mismatch') {
    return 'Beezi: this data root belongs to a different environment than the build that is\n'
      + `running (${decision.detail}). Nothing is being uploaded. Point BEEZI_CODEX_HOME at a\n`
      + 'separate root per environment, or remove the root you no longer need.';
  }
  if (decision.reason === 'unknown-issuer') {
    return 'Beezi: this machine holds analytics from an earlier install, and the API it was\n'
      + 'linked to could not be established, so nothing is being uploaded — sending it to the\n'
      + 'wrong tenant is worse than sending nothing. Recover with one of:\n'
      + '  node scripts/migrate-env.mjs --preserve   keep the old data aside, start fresh\n'
      + '  node scripts/migrate-env.mjs --adopt      the old data IS production data\n'
      + `(resolved environment: ${describeEnv(env)})`;
  }
  return `Beezi: ${orDefault(decision.detail, 'the environment could not be resolved')}.`
    + ' Nothing is being uploaded.';
}

// ── explicit recovery surfaces ──────────────────────────────────────────────────────────────
//
// The two answers a blocked 'unknown-issuer' root can be given, plus the rollback R1 requires.
// They are functions rather than prose in a release note because a user who has to hand-move a
// credential store will not do it correctly, and a note cannot be tested.

/** Treat the legacy root as production data after all: stamp it, move nothing. */
export function adoptAsProduction(deps = {}) {
  const env = orDefault(deps.env, BEEZI_ENV);
  if (env !== '') return { ok: false, reason: 'not-production' };
  return withMigrationRoots(deps, () => {
    if (['unlinked', 'production'].indexOf(rootIssuer(readSubjects(deps))) === -1) return { ok: false, reason: 'credential-conflict' };
    // Called for its side effect only: readBinding throws on a malformed or conflicting
    // environment.json, and adopting a root whose binding cannot be read is exactly what must not
    // happen. The value is unused — the binding being written below replaces it.
    readBinding(deps);
    if (orDefault(deps.apiOrigin, effectiveApiOrigin()) !== PRODUCTION_API_ORIGIN) return { ok: false, reason: 'api-mismatch' };
    deps.verifyMigration();
    writeBinding({ env, apiOrigin: PRODUCTION_API_ORIGIN, source: 'adopted-manually' }, deps);
    return { ok: true };
  });
}

/** Force the preserve-and-start-fresh path on a root the classifier could not decide. */
export function preserveAndReset(deps = {}) {
  const env = orDefault(deps.env, BEEZI_ENV);
  if (env !== '') return { ok: false, reason: 'not-production' };
  let records = [];
  try { records = readSubjects(deps); } catch { records = []; }
  const holder = records.find(record => record.raw) || null;
  return runMigration({ env, credentials: records, raw: holder ? holder.raw : null, forced: true }, deps);
}

/**
 * Undo a completed migration: bring the preserved copy back to the unsuffixed root.
 *
 * Only ever run by hand, and only against a marker this module wrote. The credential is NOT
 * restored — it was handed to the staging namespace, and re-adopting it into production is the
 * failure mode the whole module exists to prevent. A rollback therefore ends with a re-login.
 */
export function rollbackMigration(deps = {}) {
  return withMigrationRoots(deps, permit => rollbackMigrationLocked({ ...deps, migrationPermit: permit }));
}

function rollbackMigrationLocked(deps) {
  const source = homeOf(deps);
  const marker = readMarker(deps);
  if (!marker || marker.phase !== 'done') return { ok: false, reason: 'no-completed-migration' };
  const destination = typeof marker.to === 'string' ? marker.to : null;
  if (!destination) return { ok: false, reason: 'no-preserved-copy' };
  if (path.resolve(destination) !== path.resolve(orDefault(deps.preservedHome, preservedStagingHome)())
    || path.resolve(marker.from) !== path.resolve(source)) return { ok: false, reason: 'journal-root-conflict' };

  const lock = orDefault(deps.withLock, withLock);
  const result = lock({ ...runLock('env-migration'), file: path.join(source, 'locks', 'run-env-migration.lock') },
    { leaseMs: 120_000, migrationPermit: deps.migrationPermit }, () => {
    const fsImpl = orDefault(deps.fs, fs);
    if (rootHasData(source, deps)) return { ok: false, reason: 'root-not-empty' };
    let names;
    try { names = fsImpl.readdirSync(destination); } catch { return { ok: false, reason: 'no-preserved-copy' }; }
    for (const name of names) {
      if (NOT_COPIED.indexOf(name) !== -1) continue;
      if (name === 'credentials.json') continue; // stays with staging; production re-links
      deps.verifyMigration();
      copyTreeSync(path.join(destination, name), path.join(source, name), deps);
    }
    writeBinding({ env: 'staging', apiOrigin: STAGING_API_ORIGIN, source: 'rolled-back' }, deps);
    const remove = orDefault(deps.removeFileSync, removeFileSync);
    remove(markerPathOf(deps));
    return { ok: true, from: destination, to: source };
  }, deps);

  if (result.skipped) return { ok: false, reason: 'busy' };
  return result.value;
}

/** Status for `me` / diagnostics. Never contains a token. */
export function migrationStatus(deps = {}) {
  const binding = readBinding(deps);
  const marker = readMarker(deps);
  return {
    env: orDefault(deps.env, BEEZI_ENV),
    service: serviceFor(orDefault(deps.env, BEEZI_ENV)),
    bound: binding ? binding.env : null,
    boundAt: binding ? orDefault(binding.at, null) : null,
    source: binding ? orDefault(binding.source, null) : null,
    migration: marker ? { phase: marker.phase, to: orDefault(marker.to, null), at: marker.at } : null,
  };
}
