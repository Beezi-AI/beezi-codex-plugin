import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';

// ── the environment switch (G-2-2) ───────────────────────────────────────────────────────────
//
// One switch, read once, consumed in exactly two namespaces: this plugin's data root
// (`beeziCodexHome()`, which every other accessor below joins onto) and the credential-store
// entry (`lib/credentials.mjs` SERVICE). NOTHING KEYED OFF IT MAY BE NAMESPACED INDEPENDENTLY.
// A build whose keyring entry says `beezi-codex-staging` but whose data root is still
// `~/.beezi-codex` holds a staging token over production cursors, and every queued segment then
// flushes to the wrong tenant.
//
// Codex's own roots (`codexHome()` and its children, further down) are NOT suffixed: they belong
// to Codex, not to this plugin, and both variants read the same transcripts.

// The only environment names that may reach a filesystem path or a PowerShell credential template.
// '' is production. An unlisted name is a broken build — never a silent fall-through to production
// (R1), and never interpolated anywhere. R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
export const KNOWN_ENVIRONMENTS = Object.freeze(['', 'dev', 'staging', 'local']);

// The variant builder (G-1-7) writes `env.json` beside package.json when it stamps a variant; the
// public build ships without one. Resolved from this module rather than from cwd, because hooks
// run with the user's repository as their working directory.
const ENV_JSON_FILE = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'env.json',
);

// Render an untrusted name for an error message. Never echo it verbatim: a value reaching this
// function has just been rejected precisely because it may be a shell or PowerShell payload, and
// an error string is copied into logs and issue reports. Everything outside a conservative
// alphabet becomes '?', so the message stays diagnosable without reproducing the input.
function describeName(value) {
  const text = typeof value === 'string' ? value : Object.prototype.toString.call(value);
  return text.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '?');
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Read the baked variant metadata.
 *
 * ABSENT IS PRODUCTION — the public plugin ships no env.json, so "no file" resolves to the
 * unsuffixed namespace. PRESENT BUT UNREADABLE IS NOT PRODUCTION: R1 forbids treating a malformed
 * variant env.json as prod, so a parse failure is reported as an error instead of being swallowed
 * into an empty object.
 *
 * `file` is only ever passed by tests, which point it at a fixture rather than write into the
 * working tree — a stray env.json there would re-namespace the whole suite.
 */
function readEnvJson(file) {
  const target = file === undefined ? ENV_JSON_FILE : file;
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf-8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, value: {} };
    return { present: true, value: {}, error: 'env.json could not be read' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, value: {}, error: 'env.json is present but is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, value: {}, error: 'env.json is present but is not a JSON object' };
  }
  return { present: true, value: parsed };
}

/**
 * Resolve the namespace and the API metadata TOGETHER, out of one record (R1).
 *
 * Pure: everything it reads arrives in `options`, so the whole matrix — absent metadata, a
 * malformed file, an unknown name, a variant missing its apiBase, an explicit override — is
 * testable without an env.json in the working tree.
 *
 *   name     `env.BEEZI_ENV` when PRESENT (presence, not truthiness: `BEEZI_ENV=''` has to be able
 *            to force the production namespace onto a variant build) → `env.json.name` → ''.
 *   apiBase  the validated `env.json.apiBase`, or null. The rung that puts `BEEZI_API_URL` in
 *            front of it lives in lib/config.mjs, the one place that also knows the release
 *            default. An explicit API override therefore cannot move the namespace: the two come
 *            out of this single resolution, and a stored environment binding is enforced
 *            separately by lib/credentials.mjs.
 *
 * Returns `{ name, suffix, apiBase, updateManifestUrl }` or `{ error }`. An error is terminal:
 * callers must refuse to name a root or an API rather than fall back to production.
 */
function resolveEnvironment(options) {
  const opts = options || {};
  const file = opts.envJson || { present: false, value: {} };
  const env = opts.env || {};
  if (file.error) return { error: file.error };

  const baked = file.value.name;
  const bakedPresent = baked !== undefined && baked !== null;

  // The baked name is validated even when an override replaces it. Forcing the production
  // namespace onto a *staging* build is a supported developer move; silently forcing it onto a
  // build whose metadata we could not understand is the exact fall-through R1 bans.
  if (bakedPresent && KNOWN_ENVIRONMENTS.indexOf(baked) === -1) {
    return { error: `env.json declares an unknown environment name '${describeName(baked)}'` };
  }

  const override = env.BEEZI_ENV;
  let name;
  if (override !== undefined && override !== null) name = override;
  else if (bakedPresent) name = baked;
  else name = '';

  if (KNOWN_ENVIRONMENTS.indexOf(name) === -1) {
    return {
      error: `unknown Beezi environment '${describeName(name)}'`
        + ` — expected one of ${KNOWN_ENVIRONMENTS.map((known) => `'${known}'`).join(', ')}`,
    };
  }

  const bakedApi = file.value.apiBase;
  let apiBase = null;
  if (bakedApi !== undefined && bakedApi !== null) {
    if (!isHttpUrl(bakedApi)) return { error: 'env.json apiBase is not an absolute http(s) URL' };
    apiBase = bakedApi;
  }
  // A NAMED VARIANT must carry its own API: missing required metadata in a named variant is an
  // error that prevents upload (R1), while missing metadata in the unsuffixed build follows the
  // release default. The test is the *baked* name, so `BEEZI_ENV=staging` on a build with no
  // env.json still moves the namespace — that is how G-2-2 ships standalone, before any variant
  // exists.
  if (bakedPresent && baked !== '' && apiBase === null) {
    return { error: `env.json declares environment '${describeName(baked)}' but no apiBase` };
  }

  // Published from a tested schema for G-8-4 and read by `environmentManifestUrl()` in
  // lib/update-check.mjs. Validating it here is what stops a variant shipping a key nothing can
  // use.
  const manifest = file.value.updateManifestUrl;
  let updateManifestUrl = null;
  if (manifest !== undefined && manifest !== null) {
    if (!isHttpUrl(manifest)) {
      return { error: 'env.json updateManifestUrl is not an absolute http(s) URL' };
    }
    updateManifestUrl = manifest;
  }

  return {
    name,
    suffix: name === '' ? '' : `-${name}`,
    apiBase,
    updateManifestUrl,
  };
}

// Resolved ONCE, at module load. lib/credentials.mjs interpolates the suffixed SERVICE into its
// PowerShell template literals at its own module load, so the switch has to be frozen by then —
// which is also why mutating BEEZI_ENV after an import has no effect, and why the environment
// matrix runs a fresh child process per configuration (R6).
const ENVIRONMENT = Object.freeze(
  resolveEnvironment({ envJson: readEnvJson(), env: process.env }),
);

/** The resolved environment name ('' for production), or null when the metadata is unusable. */
export const BEEZI_ENV = ENVIRONMENT.error ? null : ENVIRONMENT.name;

/** The validated apiBase baked into this variant, or null. Consumed by lib/config.mjs. */
export const ENV_API_BASE = ENVIRONMENT.error ? null : ENVIRONMENT.apiBase;

/** Why the environment could not be resolved, or null. Never throws. */
function environmentError() {
  return ENVIRONMENT.error ? ENVIRONMENT.error : null;
}

/**
 * Refuse to continue on an unresolvable environment.
 *
 * Deliberately unconditional — an explicit BEEZI_CODEX_HOME does not rescue it, because a root we
 * cannot attribute to an environment is a root we must not write analytics into. Every path
 * accessor, the credential SERVICE and apiBase() all fail loudly through here instead of quietly
 * choosing production.
 */
function assertEnvironment() {
  if (!ENVIRONMENT.error) return;
  const err = new Error(`Beezi environment could not be resolved: ${ENVIRONMENT.error}`);
  err.code = 'BEEZI_ENV_INVALID';
  throw err;
}

/** '' | '-dev' | '-staging' | '-local'. The single suffix, applied in exactly two places. */
function envSuffix() {
  assertEnvironment();
  return ENVIRONMENT.suffix;
}

// The shape of a Beezi account key: 8 lowercase hex characters, nothing else.
const ACCOUNT_KEY_RE = /^[0-9a-f]{8}$/;

// The key names keyring entries and is interpolated into the PowerShell templates in
// lib/credentials.mjs, so its shape is a security invariant. Validated on every use rather than
// once at mint time: a key can arrive from accounts.json, which a user can edit.
function assertAccountKey(key) {
  if (typeof key !== 'string' || !ACCOUNT_KEY_RE.test(key)) {
    throw new Error(
      `invalid Beezi account key '${describeName(key)}' — expected 8 lowercase hex characters`,
    );
  }
  return key;
}

/**
 * The environment reader, grouped rather than exported as loose functions.
 *
 * That grouping is load-bearing, not cosmetic. test/hermetic.test.mjs's L2 sweep takes EVERY
 * function this module exports, calls it (with a probe account key where one is required) and
 * asserts the result is a path inside the test sandbox — which is the direct evidence that a run
 * never writes to the real ~/.codex or ~/.beezi-codex. A reader is not a root: `envSuffix()`
 * returns '', `readEnvJson()` returns an object and `assertAccountKey()` returns a key, so
 * exporting any of them as a bare function would make that sweep fail on a value it was never
 * meant to inspect. Every FUNCTION exported from lib/paths.mjs is a path accessor; anything else
 * lives in here.
 */
export const environment = Object.freeze({
  KNOWN_ENVIRONMENTS,
  readEnvJson,
  resolveEnvironment,
  environmentError,
  assertEnvironment,
  envSuffix,
  assertAccountKey,
});

// This plugin's own data root — deliberately NOT `~/.beezi`, and deliberately not overridable via
// `BEEZI_HOME`. The Claude Code plugin owns `~/.beezi` on the same machine and writes the same
// filenames there: `queue/`, `state/`, `billing.json`, `repo-map.json`, `credentials.json`. Sharing
// them means one agent's queued segments flushed under the other's identity, and whichever plugin
// captured a subscription plan last winning `billing.json` for both. Same reasoning as the
// `beezi-codex` keyring entry — one store per agent, no exceptions.
//
// The environment suffix is applied here, so a dev or staging install gets `~/.beezi-codex-staging`
// and cannot see production's state. `BEEZI_CODEX_HOME` remains an explicit FULL-ROOT override — a
// caller running two environments must supply two distinct roots. Sharing one is caught by the
// environment stamp lib/credentials.mjs binds to the stored credentials, which withholds the
// token and so prevents the upload rather than letting it proceed across the binding (R1).
export function beeziCodexHome() {
  const suffix = envSuffix(); // asserts first: an unresolved environment names no root at all
  return process.env.BEEZI_CODEX_HOME || path.join(os.homedir(), `.beezi-codex${suffix}`);
}

export function stateDir() {
  return path.join(beeziCodexHome(), 'state');
}

// Persisted known-repo-root map (dir→root resolution cache/seed). One JSON for the machine.
export function repoMapFile() {
  return path.join(beeziCodexHome(), 'repo-map.json');
}

// The PRE-0.13 credential file, at the machine root. It is not an account's file and never gains
// a key: lib/credentials.mjs resolves the legacy subject here so the one-time migration can still
// find what a single-account install left behind, and nothing else may write it.
export function legacyCredentialsFile() {
  return path.join(beeziCodexHome(), 'credentials.json');
}

export function billingConfigFile() {
  return path.join(beeziCodexHome(), 'billing.json');
}

// Rate-limit observations pulled off the rollout, plus the per-limit_id debounce baseline that
// decides which ones are worth sending. Root-level, NOT under state/: pruneStale() sweeps that at
// 14 days, and losing the baseline would make the next scan re-emit a first-observation row for
// every series.
export function usageObservationsFile() {
  return path.join(beeziCodexHome(), 'usage-observations.json');
}

// Which environment this data root belongs to, written once and then enforced on every run
// (lib/env-migration.mjs). Before this file existed there was one namespace and one default API,
// so an UNBOUND root is not "production" — it is a root whose environment has to be established
// from the issuer retained in its credentials. Root-level, like the ledger: pruneStale() sweeps
// state/ and queue/ at 14 days, and a binding that expired would re-open the question it settles.
export function environmentBindingFile() {
  return path.join(beeziCodexHome(), 'environment.json');
}

// The resumable record of an in-flight production cutover. Lives in the SOURCE root, so a run
// interrupted between the copy and the cleanup finds it again on the next invocation.
export function migrationMarkerFile() {
  return path.join(beeziCodexHome(), 'migration.json');
}

// Where the legacy staging data is preserved when the unsuffixed root is handed to production.
// Derived from the resolved root rather than from the home directory, so it lands beside whatever
// root is actually in use — including an explicit BEEZI_CODEX_HOME — and matches the root the
// staging variant resolves for itself when that root is the default one.
export function preservedStagingHome() {
  return `${beeziCodexHome()}-staging`;
}

// Codex's config root — `~/.codex`, relocatable via CODEX_HOME. Single source for the dirs
// the plugin reads out of Codex (session rollout transcripts, auth store).
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Codex writes one rollout transcript per session under a date-partitioned tree:
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
export function codexSessionsDir() {
  return path.join(codexHome(), 'sessions');
}

// The Codex auth store. Holds the ChatGPT tokens; the id_token carries the plan claim we read
// for subscription attribution (no secret leaves the machine — only the plan tier string).
export function codexAuthFile() {
  return path.join(codexHome(), 'auth.json');
}

// Codex's session index — one JSONL record per session { id, thread_name, updated_at }. The
// thread_name is the user-facing session title we surface in analytics.
export function codexSessionIndexFile() {
  return path.join(codexHome(), 'session_index.jsonl');
}

// Codex's user-level hook registry. Plugin-bundled hooks are not loaded by Codex (the
// `plugin_hooks` feature is `removed`), so Beezi's lifecycle hooks have to be installed here.
export function codexHooksFile() {
  return path.join(codexHome(), 'hooks.json');
}

// Where the installer writes its launcher scripts. Each is a single-token executable so the
// `command` field never depends on how Codex splits arguments or resolves `node` on PATH.
export function hookLauncherDir() {
  return path.join(beeziCodexHome(), 'hooks');
}

// ── the per-account layout ────────────────────────────────────────────────────────────────────
//
// Every identity-bound file lives under `accounts/<key>/`; only the index and its migration
// journal stay at the machine root, because they are what names the keys in the first place.

export function accountsIndexFile() {
  return path.join(beeziCodexHome(), 'accounts.json');
}

export function accountsMigrationJournalFile() {
  return path.join(beeziCodexHome(), 'accounts.migration.json');
}

export function accountsDir() {
  return path.join(beeziCodexHome(), 'accounts');
}

export function accountDir(key) {
  return path.join(accountsDir(), assertAccountKey(key));
}

export function credentialsFile(key) {
  return path.join(accountDir(key), 'credentials.json');
}

// Cached tenant tracking policy (trackingMode / backfillCompleted / linkedAt), per account. It
// sits in the account directory rather than under state/ or queue/ for the same prune-survival
// reason it used to sit at the root: pruneStale() sweeps those two at 14 days, and an expiring
// gate would silently re-enable a dark-mode tenant.
export function trackingStateFile(key) {
  return path.join(accountDir(key), 'tracking.json');
}

// Durable record of which past sessions the one-time history import has delivered TO THIS ACCOUNT.
// Outside state/ and queue/ for the prune reason above: an expired ledger would make every old
// session look importable again.
export function auditLedgerFile(key) {
  return path.join(accountDir(key), 'audit-ledger.json');
}

export function accountSyncStateFile(key) {
  return path.join(accountDir(key), 'account-sync.json');
}

export function coverageFile(key) {
  return path.join(accountDir(key), 'coverage.json');
}

export function usagePendingFile(key) {
  return path.join(accountDir(key), 'usage-pending.json');
}

export function queueDir(key) {
  return path.join(accountDir(key), 'queue');
}
