// A DEFAULT import, not `import { execFileSync }`. For a core module the default binding IS the
// object tools/hermetic-env.mjs patches, so a test that reaches defaultRun below is RECORDED as an
// escape; a named binding is snapshotted at instantiation and walks straight past the guard. That
// is how `npm test` came to add a keyed keychain entry and delete the developer's own pre-0.13
// `beezi-codex/token` login while reporting zero failures.
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  legacyCredentialsFile, credentialsFile, accountDir, beeziCodexHome, environment, BEEZI_ENV,
} from './paths.mjs';
import { readJson, writeJsonDurable } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

// The OS keyring entry this plugin owns. On Windows it is the target name shown under Control
// Panel → Credential Manager → Windows Credentials, so it has to say which agent it belongs to:
// the Claude Code plugin keeps `beezi-analytics` on the same machine, and two agents sharing one
// entry would fight over refreshed tokens and over logout.
//
// The environment suffix (G-2-2) is the second half of that: `beezi-codex-staging` is a different
// Credential Manager target, a different keychain item and a different libsecret attribute set, so
// two installed variants never share a token. `envSuffix()` throws on unresolvable metadata, which
// is why a malformed variant env.json fails at THIS module's load rather than silently producing
// the production target name — and it is validated against `'' | dev | staging | local` before
// it reaches the PowerShell templates below, which interpolate SERVICE as literal script text.
export const SERVICE = `beezi-codex${environment.envSuffix()}`;

// The keyring `account` attribute a pre-0.13 install used: one entry for the whole machine. From
// 0.13 on the account KEY takes that slot, so each linked Beezi account owns an entry of its own
// and two accounts can never read each other. This name survives for the one-time migration in
// lib/accounts.mjs — and, while it is deciding which environment a ROOT belongs to,
// lib/env-migration.mjs through LEGACY_SUBJECT below. No other caller may reach it.
const LEGACY_ACCOUNT = 'token';

/**
 * The pre-0.13 machine-wide credential, named as a SUBJECT the migration functions below accept.
 *
 * lib/env-migration.mjs migrates ROOTS, and a root is in one of two shapes: pre-0.13, holding the
 * single machine-wide entry, or keyed, holding one entry per linked account. It has to be able to
 * name either, so `readRawCredential`, `deleteRawCredential`, `preserveMigrationCredential` and
 * `tombstoneMigrationCredential` take a subject — an 8-hex account key, or this.
 *
 * A Symbol, not a string: the only other way to name a subject is a key read out of accounts.json,
 * which the user can edit, so a symbol is what guarantees no edited value can ever select the
 * legacy entry. `getCredentials`/`setCredentials`/`deleteCredentials` stay keyed-only and reject it.
 */
export const LEGACY_SUBJECT = Symbol('beezi pre-0.13 credential subject');

// The keyring account attribute a subject uses, validated. LEGACY_SUBJECT is the one value that
// bypasses assertAccountKey, and it cannot be forged: see above.
function assertSubject(subject) {
  if (subject === LEGACY_SUBJECT) return LEGACY_ACCOUNT;
  return environment.assertAccountKey(subject);
}

// The environment the stored credentials were issued under, persisted alongside them.
//
// SERVICE already keeps the native keyrings apart, but `BEEZI_CODEX_HOME` is an explicit FULL-ROOT
// override: a caller who points two environments at one root shares the file store between them. R1
// requires that a mismatched binding PREVENT UPLOAD rather than proceed, so a blob whose stamp
// disagrees with the resolved environment reads as "no credentials" — getAccessToken() then returns
// null and every reporting path has no bearer token to flush with. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// An UNSTAMPED blob is the pre-G-2-2 state, and there was exactly one namespace then: it reads as
// production, so existing unsuffixed installs keep working untouched and a staging build cannot
// adopt them. The stamp never leaves this module — it is added on write and removed on read, so
// every consumer of a credentials object sees the same shape it always did.
const ENV_STAMP = 'beezi_env';

function stampOf(obj) {
  const value = obj[ENV_STAMP];
  return typeof value === 'string' ? value : '';
}

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe`
// is resolved against the child's current directory first, so an attacker file dropped
// in a repo the user opens could be executed (and would receive the plaintext token on
// stdin). Pinning the system path closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout } so callers can fall back to the file store on any failure.
function defaultRun(file, args, input) {
  try {
    const stdout = childProcess.execFileSync(file, args, {
      input: orDefault(input, undefined),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Bound the spawn: a locked keychain / hung helper must not block the hook.
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: orDefault(stdout, '') };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──
//
// Parameterised by PATH rather than by key, because the two chains below differ in exactly that:
// a keyed account keeps its file under accounts/<key>/, while the pre-0.13 entry's file is the
// root-level credentials.json it has always been.

function fileRead(file) {
  return readJson(file);
}

function fileWrite(file, obj) {
  writeJsonDurable(file, obj);
}

function fileDelete(file) {
  try { fs.unlinkSync(file); } catch { /* already absent */ }
}

// ── backends. Each: { available(), get() -> string|null, set(token) -> boolean, delete() }.
//
// `account` is the keyring entry's account attribute — an 8-hex account key, or LEGACY_ACCOUNT for
// the pre-0.13 entry. It reaches argv and, on Windows, PowerShell script text, so every exported
// function validates it through environment.assertAccountKey() before a backend is built.

function macBackend(run, account, service = SERVICE) {
  return {
    available: () => true, // `security` ships with macOS
    get() {
      return tokenFrom(run('security', ['find-generic-password', '-s', service, '-a', account, '-w']));
    },
    set(token) {
      return run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', token]).ok
        ? 'the macOS keychain' : false;
    },
    delete() {
      run('security', ['delete-generic-password', '-s', service, '-a', account]);
    },
  };
}

function secretToolBackend(run, account, service = SERVICE) {
  const attrs = ['service', service, 'account', account];
  return {
    available: () => run('secret-tool', ['--version']).ok, // libsecret often absent
    get() {
      return tokenFrom(run('secret-tool', ['lookup', ...attrs]));
    },
    set(token) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return run('secret-tool', ['store', `--label=${service}`, ...attrs], token).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete() {
      run('secret-tool', ['clear', ...attrs]);
    },
  };
}

// Windows: the primary store is the Credential Manager, reached via a P/Invoke to advapi32
// (CredWrite/CredRead/CredDelete) — the token then appears under Control Panel → Credential
// Manager → Windows Credentials, keyed by SERVICE. The `cmdkey` CLI can *store* but not read
// a secret back, so we call the Win32 API directly through PowerShell. Should that ever fail
// (locked-down box, PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the
// ciphertext kept in the 0600 file, and finally to a plaintext 0600 file.
const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

function powershell(run, script, input) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

// ── Windows Credential Manager via advapi32 P/Invoke (the primary Windows store) ──
// The CREDENTIAL struct is shared by the read and write scripts. CharSet=Unicode marshals
// TargetName/UserName as wide strings; the secret blob is written/read as UTF-16 so it
// round-trips any character (verified against '&', '=', '.').
const CRED_STRUCT = `
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}`;

// Reads the secret from stdin (never an argv element, so it can't leak via the process list),
// writes a GENERIC credential with LOCAL_MACHINE persistence, prints 'OK' on success.
//
// `$c.TargetName` is the KEY (see credTarget below) and carries the account; `$c.UserName` is
// descriptive metadata only — it is what the user sees beside the entry in Credential Manager, and
// CredRead/CredDelete never look at it.
const CRED_WRITE = `$in=[Console]::In.ReadToEnd()
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredW {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL c, uint flags);${CRED_STRUCT}
}
"@
$bytes=[Text.Encoding]::Unicode.GetBytes($in)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object BeeziCredW+CREDENTIAL
$c.Type=1; $c.TargetName='${SERVICE}'; $c.UserName='${LEGACY_ACCOUNT}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero
// when the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const CRED_READ = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${SERVICE}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const CRED_DELETE = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${SERVICE}',1,0)`;

/**
 * The Credential Manager target name for one account.
 *
 * THE ACCOUNT HAS TO BE IN THE TARGET. A Windows generic credential is identified by TargetName +
 * Type; `UserName` is payload the API carries along, not part of the key. CredRead and CredDelete
 * take only a target, so keying by UserName would give every account on the machine one shared
 * entry: the second setCredentials() would overwrite the first, one deleteCredentials() would
 * unlink both, and an uncommitted read for account B would hand back account A's blob (the env
 * stamp is all parseCredentials checks, and both accounts share it).
 *
 * The LEGACY entry keeps the bare service name, because that is the target a pre-0.13 install
 * actually wrote — suffix it and readLegacyCredential stops finding it and the one-time migration
 * sees an unlinked machine. `assertAccountKey` bounds a real key to /^[0-9a-f]{8}$/, which cannot
 * collide with LEGACY_ACCOUNT ('token' is not hex).
 */
function credTarget(service, account) {
  return account === LEGACY_ACCOUNT ? service : `${service}:${account}`;
}

// The target and the account both reach the script as literal PowerShell text inside single-quoted
// literals, so both are substituted the way the service name always was. SERVICE is validated
// against a three-name allowlist at module load and the account by environment.assertAccountKey()
// before any exported function builds a backend, so neither can carry a quote; `:` is a
// conventional Credential Manager target separator and is quote-free. The `'…'` quoting around
// LEGACY_ACCOUNT makes the UserName substitution a single unambiguous occurrence.
function credScript(template, service, account) {
  return template
    .split(SERVICE).join(credTarget(service, account))
    .split(`'${LEGACY_ACCOUNT}'`).join(`'${account}'`);
}

function credManBackend(run, account, service = SERVICE) {
  return {
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    get() {
      return tokenFrom(powershell(run, credScript(CRED_READ, service, account)));
    },
    set(token) {
      const r = powershell(run, credScript(CRED_WRITE, service, account), token);
      return r.ok && r.stdout.trim() === 'OK' ? 'the Windows Credential Manager' : false;
    },
    delete() {
      powershell(run, credScript(CRED_DELETE, service, account));
    },
  };
}

function dpapiFileBackend(run, file) {
  return {
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    get() {
      const obj = fileRead(file);
      if (!obj) return null;
      if (typeof obj.enc === 'string') return tokenFrom(powershell(run, DPAPI_DEC, obj.enc));
      return typeof obj.token === 'string' ? obj.token : null; // plaintext (DPAPI was down at set)
    },
    set(token) {
      const r = powershell(run, DPAPI_ENC, token);
      if (r.ok && r.stdout.trim()) { fileWrite(file, { enc: r.stdout.trim() }); return 'Windows DPAPI (encrypted at rest)'; }
      fileWrite(file, { token }); // DPAPI unavailable → plaintext, still 0600
      return 'a restricted local file';
    },
    delete() { fileDelete(file); },
  };
}

function fileBackend(file) {
  return {
    available: () => true,
    get() {
      const obj = fileRead(file);
      return obj && typeof obj.token === 'string' ? obj.token : null;
    },
    set(token) { fileWrite(file, { token }); return 'a restricted local file'; },
    delete() { fileDelete(file); },
  };
}

// Preferred backend chain for the platform; the plaintext file is always the tail. Everything that
// distinguishes one account from another is the pair (keyring account attribute, file-store path),
// so the keyed chain and the legacy chain share every backend implementation.
//
// Built fresh per call and closed over nothing module-level: linkedSessions() reads N accounts
// concurrently, and a memoized chain or a cached blob here would let one account's read answer
// another's.
function chainFor(deps, account, file) {
  const run = deps.run || defaultRun;
  const platform = deps.platform || process.platform;
  const tail = { name: 'file', ...fileBackend(file) };
  if (platform === 'darwin') return [{ name: 'keychain', ...macBackend(run, account) }, tail];
  if (platform === 'linux') return [{ name: 'secret-service', ...secretToolBackend(run, account) }, tail];
  if (platform === 'win32') return [{ name: 'credman', ...credManBackend(run, account) }, { name: 'dpapi-file', ...dpapiFileBackend(run, file) }, tail];
  return [tail];
}

/** Where one subject's file store lives: under accounts/<key>/, or the pre-0.13 root-level file. */
function subjectCredentialsFile(subject) {
  return subject === LEGACY_SUBJECT ? legacyCredentialsFile() : credentialsFile(subject);
}

/**
 * One subject's chain: its own keyring entry, its own file store.
 *
 * For an account key that is its entry under accounts/<key>/. For LEGACY_SUBJECT it is the single
 * machine-wide entry named 'token' beside the root-level credentials.json — buildable only by
 * readLegacyCredential/deleteLegacyCredential and the raw migration functions at the foot of this
 * module. A KEYED read must never fall back to it: that would resurrect a deleted account's token
 * under a new key.
 */
function backends(subject, deps) {
  return chainFor(deps, assertSubject(subject), subjectCredentialsFile(subject));
}

function legacyBackends(deps) {
  return backends(LEGACY_SUBJECT, deps);
}

// Existing installations are read in place until their first successful write; thereafter the
// control record selects one backend and an older fallback can never become authoritative.
function readThrough(chain) {
  for (const b of chain) {
    if (!b.available()) continue;
    const raw = b.get();
    if (raw) return raw;
  }
  return null;
}

// The backends store an opaque string. Since the Clerk OAuth migration that
// string is a JSON credentials object: { client_id, redirect_uri,
// token_endpoint, access_token, refresh_token, expires_at }. Legacy bare
// device tokens fail to parse and read as "not linked".
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.access_token !== 'string') return null;
    // Bind credential SELECTION to the environment (R1). A stamp that disagrees is not a
    // recoverable state here — this preparatory release owns no migration — so it reads as
    // unlinked, which stops the upload instead of flushing one environment's queue with the
    // other's token.
    if (stampOf(obj) !== BEEZI_ENV) return null;
    const out = { ...obj };
    delete out[ENV_STAMP];
    return out;
  } catch {
    return null;
  }
}

const REVISION = Symbol('credential revision');
// The authority record sits beside the subject's file store: under accounts/<key>/ for an account,
// at the data root for the pre-0.13 machine-wide entry — which is where a pre-0.13 install wrote
// it, and so where that install's own reader still looks.
const controlFile = (subject) => (subject === LEGACY_SUBJECT
  ? path.join(beeziCodexHome(), 'credential-control.json')
  : path.join(accountDir(subject), 'credential-control.json'));

function unavailable(message, code = 'CREDENTIALS_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readControl(key) {
  let raw;
  try { raw = fs.readFileSync(controlFile(key), 'utf-8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unavailable('Credential control record cannot be read');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw unavailable('Invalid credential control record'); }
  if (!value || value.version !== 1 || typeof value.revision !== 'string'
    || (value.backend !== null && typeof value.backend !== 'string')) {
    throw unavailable('Invalid credential control record');
  }
  return value;
}

export function credentialRevision(creds) {
  return creds && creds[REVISION] || null;
}

// Retry only an already committed OS store; fresh installs should not wait
// for an entry that does not exist. The environment guard requires sync reads.
function readCommittedCredential(backend, deps) {
  const read = () => backend.available() ? backend.get() : null;
  let raw = read();
  if (!['credman', 'keychain', 'secret-service'].includes(backend.name)) return raw;
  const sleep = deps.sleepImpl || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (const delay of [100, 250]) {
    if (raw) break;
    sleep(delay);
    raw = read();
  }
  return raw;
}

export async function getCredentials(key, deps = {}) {
  environment.assertAccountKey(key);
  const control = readControl(key);
  if (control) {
    if (control.beezi_env !== BEEZI_ENV || control.backend === null) return null;
    const backend = backends(key, deps).find(b => b.name === control.backend);
    if (!backend) throw unavailable('Committed credential backend unavailable');
    const raw = readCommittedCredential(backend, deps);
    const creds = raw && parseCredentials(raw);
    if (!creds || creds.beezi_revision !== control.revision) {
      throw unavailable('Committed credentials temporarily unavailable');
    }
    delete creds.beezi_revision;
    Object.defineProperty(creds, REVISION, { value: control.revision });
    return creds;
  }
  const raw = readThrough(backends(key, deps));
  return raw ? parseCredentials(raw) : null;
}

// The one read-modify-write wrapper for the credential store: rank-4 `credential` lock, an
// optimistic revision check, and a fresh revision handed to the mutation.
function mutateCredentials(key, options, fn) {
  const result = withLock({ ...sharedLock('credentials'), kind: 'credential' }, { migrationPermit: options.migrationPermit }, lock => {
    const control = readControl(key);
    if ('expectedRevision' in options && options.expectedRevision !== (control && control.revision || null)) {
      throw unavailable('Credentials changed during refresh', 'CREDENTIALS_SUPERSEDED');
    }
    const revision = crypto.randomBytes(16).toString('hex');
    return fn(revision, lock);
  });
  if (!result.ok) throw unavailable('Credential store is busy');
  return result.value;
}

// Returns a human-readable description of where the credentials were actually stored, so the caller
// can report accurately (keychain vs a local file) instead of always claiming the keychain.
export async function setCredentials(key, creds, deps = {}, options = {}) {
  environment.assertAccountKey(key);
  return mutateCredentials(key, options, (revision, lock) => {
    const raw = JSON.stringify({ ...creds, [ENV_STAMP]: BEEZI_ENV, beezi_revision: revision });
    for (const b of backends(key, deps)) {
      if (!b.available()) continue;
      const where = b.set(raw);
      if (!where) continue;
      if (!lock.verify().ok) throw unavailable('Credential lock was lost');
      writeJsonDurable(controlFile(key), { version: 1, revision, backend: b.name, beezi_env: BEEZI_ENV });
      return where;
    }
    throw unavailable('No credential backend accepted the write');
  });
}

export async function deleteCredentials(key, deps = {}, options = {}) {
  environment.assertAccountKey(key);
  return mutateCredentials(key, options, (revision) => {
    // A tombstone prevents stale native-store copies or delayed refreshes reviving a logout.
    writeJsonDurable(controlFile(key), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
    for (const b of backends(key, deps)) {
      if (b.available()) { try { b.delete(); } catch { /* ignore */ } }
    }
  });
}

/**
 * The pre-0.13 entry, read through the legacy chain.
 *
 * Read by the one-time migration in lib/accounts.mjs and by nothing else: a keyed caller that fell
 * back to this would resurrect a deleted account's token under a new key. The environment stamp is
 * still enforced, so a staging-issued legacy blob is not adopted by the production namespace.
 *
 * "UNREADABLE" AND "NEVER LINKED" MUST NOT LOOK THE SAME HERE. defaultRun collapses a locked
 * keychain, an absent secret-tool and a killed spawn all to { ok: false } and then to null, which is
 * byte-identical to an unlinked machine — and the migration reads that null as "nothing to migrate",
 * returns an empty index, and the next login publishes one. From then on readIndex short-circuits on
 * the published index, the migration never runs again, and the legacy entry is stranded for good.
 * Nothing is deleted, but the login this whole task exists to preserve is orphaned.
 *
 * The authority record is what closes it, exactly as it does for a keyed subject in
 * readRawCredential below: an install that ever committed its credential has a record naming the
 * backend that holds it, so a committed backend answering with nothing is a failure, not an absence.
 * An install that predates the record still cannot tell the two apart — that residue is real and is
 * covered in test/accounts-migration.test.mjs.
 */
export async function readLegacyCredential(deps = {}) {
  const control = readControl(LEGACY_SUBJECT);
  if (control) {
    // A tombstone is an authoritative logout, which IS "not linked".
    if (control.backend === null) return null;
    const backend = legacyBackends(deps).find(b => b.name === control.backend);
    if (!backend) throw unavailable('Committed credential backend unavailable');
    const raw = readCommittedCredential(backend, deps);
    if (!raw) throw unavailable('Saved Beezi authorization could not be read; check access to the credential store and try again later');
    return parseCredentials(raw);
  }
  const raw = readThrough(legacyBackends(deps));
  return raw ? parseCredentials(raw) : null;
}

export async function deleteLegacyCredential(deps = {}) {
  for (const backend of legacyBackends(deps)) backend.delete();
}


/**
 * The stored blob EXACTLY as a backend holds it — unparsed, unstamped, unfiltered.
 *
 * The one caller is lib/env-migration.mjs, and the reason it cannot use getCredentials() is the
 * ENV_STAMP filter above: a legacy blob reads as production there, which is the assumption the
 * migration exists to test rather than inherit. The control record is not consulted either — a
 * pre-cutover install predates it, and this is exactly the blob such an install would send.
 *
 * Synchronous, because the guard that calls it runs before anything else in a hook and has no
 * business awaiting. Every backend get() is synchronous already.
 */
export function readRawCredential(subject, deps = {}) {
  assertSubject(subject);
  const control = readControl(subject);
  if (control) {
    if (control.backend === null) return null;
    const backend = backends(subject, deps).find(b => b.name === control.backend);
    if (!backend) throw unavailable('Committed credential backend unavailable');
    const raw = readCommittedCredential(backend, deps);
    if (!raw) throw unavailable('Committed credentials could not be read; check access to the credential store and try again later');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw unavailable('Invalid committed credentials'); }
    if (!parsed || parsed.beezi_revision !== control.revision) throw unavailable('Credential revision mismatch');
    return raw;
  }
  return readThrough(backends(subject, deps));
}

/**
 * Clear the stored blob from every backend, reporting whether it is actually gone.
 *
 * deleteCredentials() is best-effort by design (logout must not fail because a keychain was
 * locked). The migration needs the stronger answer: a staging token left in the unsuffixed
 * keyring after the production cutover is adopted, unstamped, by the production build.
 *
 * It goes THROUGH mutateCredentials rather than around it: a native copy that a delayed refresh
 * could revive is the same hazard here as at logout, and the tombstone revision is what closes
 * it.
 */
export function deleteRawCredential(subject, deps = {}) {
  assertSubject(subject);
  try {
    mutateCredentials(subject, { migrationPermit: deps.migrationPermit }, (revision) => {
      writeJsonDurable(controlFile(subject), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
      for (const b of backends(subject, deps)) {
        if (b.available()) { try { b.delete(); } catch { /* try the rest, then verify */ } }
      }
    });
  } catch {
    return false;
  }
  for (const b of backends(subject, deps)) {
    if (b.available() && b.get()) return false;
  }
  return true;
}

/** The keyring entry name for an environment. Status output only — never a path. */
export function serviceFor(env) {
  const suffix = env === undefined || env === null || env === '' ? '' : `-${env}`;
  return `beezi-codex${suffix}`;
}

/**
 * Where ANOTHER root keeps one subject's file store / authority record.
 *
 * Both are derived from the live accessors rather than re-spelled as 'accounts/<key>/…', so the
 * per-account layout stays defined in exactly one place (lib/paths.mjs) and a later rename cannot
 * leave a hardcoded copy pointing at a directory nothing reads. lib/env-migration.mjs composes the
 * source and destination sides of the cutover through these.
 */
export function subjectCredentialsPath(root, subject) {
  return path.join(root, path.relative(beeziCodexHome(), subjectCredentialsFile(subject)));
}

export function subjectAuthorityPath(root, subject) {
  return path.join(root, path.relative(beeziCodexHome(), controlFile(subject)));
}

// Destination credential and authority are committed together while both migration barriers
// are held. Native credentials never fall back to plaintext here.
//
// The authority goes where the DESTINATION install's readControl() will look for it — under that
// root's accounts/<key>/ for an account, at its root for the pre-0.13 subject. Put it anywhere else
// and the preserved install falls through to the uncommitted read path, silently losing the
// revision and tombstone protection.
export function preserveMigrationCredential(subject, raw, destination, deps = {}) {
  const account = assertSubject(subject);
  const run = deps.run || defaultRun;
  const platform = deps.platform || process.platform;
  const revision = crypto.randomBytes(16).toString('hex');
  const token = JSON.stringify({ ...JSON.parse(raw), beezi_env: 'staging', beezi_revision: revision });
  const backend = platform === 'darwin' ? { name: 'keychain', ...macBackend(run, account, serviceFor('staging')) }
    : platform === 'linux' ? { name: 'secret-service', ...secretToolBackend(run, account, serviceFor('staging')) }
      : platform === 'win32' ? { name: 'credman', ...credManBackend(run, account, serviceFor('staging')) } : null;
  const authority = subjectAuthorityPath(destination, subject);
  if (!backend || !backend.available() || !backend.set(token) || backend.get() !== token) {
    writeJsonDurable(authority, {
      version: 1, revision, backend: null, beezi_env: 'staging',
    });
    return false;
  }
  writeJsonDurable(authority, {
    version: 1, revision, backend: backend.name, beezi_env: 'staging',
  });
  return true;
}

export function tombstoneMigrationCredential(subject, deps = {}) {
  assertSubject(subject);
  return mutateCredentials(subject, { migrationPermit: deps.migrationPermit }, revision => {
    writeJsonDurable(controlFile(subject), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
    return readControl(subject).backend === null;
  });
}
