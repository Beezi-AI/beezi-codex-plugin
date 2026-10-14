// Crash/diagnostic telemetry for the Codex plugin (G-8-2): the consent record and the recorder.
//
// Every hook in this plugin swallows its own crash (`scripts/checkpoint.mjs`, `scripts/stop.mjs`,
// `scripts/session-start.mjs` all end in a bare `.catch(() => {})`), so a user whose analytics stop
// working produces no signal at all — not to them, not to us. This module is the place those
// failures go. Delivery is lib/telemetry-flush.mjs, over the authorization-free public route.
//
// Four properties are load-bearing and none of them is negotiable:
//
//   1. CONSENT IS DEFAULT-OFF AND GATED AT RECORD TIME. `recordIssue` returns false before it
//      writes anything unless the machine has explicitly granted. Gating only at send time would
//      accumulate events on disk pre-consent, so a later "on" would ship data gathered before the
//      user agreed — retroactive consent. The switch is `setCrashMode()` below.
//   2. REDACTION IS STRUCTURAL, NOT A SCRUBBER. There is deliberately no branch that can put an
//      error message, a stack, a prompt, a token or an absolute user path into a record. `errorName`
//      and `errorCode` are shaped through IDENTIFIER; `site` is only ever a plugin-relative path
//      shaped through SITE. A scrubber can be defeated by an input nobody predicted; a record that
//      has no field to carry the text cannot leak it.
//   3. IT NEVER THROWS AND IT NEVER BLOCKS. `recordIssue` is synchronous, returns a boolean, and
//      swallows its own failures — telemetry must never be the reason a hook fails.
//   4. NOTHING IS BUFFERED IN MEMORY. Every event hits disk inside the call (the F11 hard-kill
//      property: a killed hook loses nothing it had already recorded). The only module-level state
//      is the in-flight source and the reentrancy flag.
//
// The wire vocabulary is CLOSED on the server: the public route rejects an event whose code,
// source, auth state or reason its Postgres enums lack, and a source the DB enum lacks fails the
// whole batch with a 500 that the flush keeps retrying. Every frozen map below is therefore a
// subset of the public table's enums, never an extension of them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import url from 'url';
import { beeziCodexHome, telemetrySendStateFile } from './paths.mjs';
import { orDefault, removeFileSync } from './compat.mjs';
import { readJson, readJsonSalvaged, writeJsonSecure, safeFileName } from './fs-store.mjs';
import { codeOf } from './friendly-error.mjs';
import {
  currentInstallationId,
  randomUuid,
  rotateInstallationId,
  UUID_V4,
} from './installation-id.mjs';

// Only the ones with a live call site are worth emitting — do not instrument a code just because
// it exists here.
export const DIAGNOSTIC_CODES = Object.freeze({
  HOOK_CRASH: 'hook_crash',
  HOOK_UNHANDLED_REJECTION: 'hook_unhandled_rejection',
  QUEUE_FILE_QUARANTINED: 'queue_file_quarantined',
  QUEUE_FLUSH_HTTP_ERROR: 'queue_flush_http_error',
  TOKEN_REFRESH_FAILED: 'token_refresh_failed',
  TRANSCRIPT_PARSE_FAILED: 'transcript_parse_failed',
  MCP_HANDSHAKE_TIMEOUT: 'mcp_handshake_timeout',
  STATE_WRITE_FAILED: 'state_write_failed',
  // The authorization-free route's additions; mirrors the portal's PluginDiagnosticCode.
  AUTH_STATE_CHANGED: 'auth_state_changed',
  AUTH_RECOVERED: 'auth_recovered',
  LOGIN_FAILED: 'login_failed',
  LOGOUT_UNLINK_UNCONFIRMED: 'logout_unlink_unconfirmed',
  CREDENTIAL_MIGRATION_CONFLICT: 'credential_migration_conflict',
  REFRESH_INTERRUPTED: 'refresh_interrupted',
  MCP_STARTUP_FAILED: 'mcp_startup_failed',
  HOOK_IMPORT_FAILED: 'hook_import_failed',
  INSTALLATION_BINDING_FAILED: 'installation_binding_failed',
});

// The members of the server's PluginDiagnosticSource enum that describe a call site this plugin
// actually has. The rest of that enum is Claude-shaped (`statusline`, `pulse`, `usage_ping`,
// `stop_failure`, `track_prompt`, `refresh_worker`, `me`, `diagnostics_worker`).
//
// `subagent_start` / `subagent_stop` are deliberately still absent: the TypeScript enum has them,
// but the public table's Postgres enum does not, and one such event 500s the whole batch. Until
// the portal migrates that enum the two subagent hooks report UNKNOWN.
export const DIAGNOSTIC_SOURCES = Object.freeze({
  CHECKPOINT: 'checkpoint',
  STOP: 'stop',
  REPORT: 'report',
  SESSION_START: 'session_start',
  MCP_BRIDGE: 'mcp_bridge',
  BACKFILL: 'backfill',
  SYNC: 'sync',
  LOGIN: 'login',
  LOGOUT: 'logout',
  TELEMETRY_FLUSH: 'telemetry_flush',
  UNKNOWN: 'unknown',
});

// The portal's plugin_auth_state_enum / plugin_diagnostic_reason_enum. Claude's `storage_timeout`
// is left out: the portal enum lacks it, and an unknown reason gets the whole event rejected.
export const AUTH_STATES = Object.freeze({
  READY: 'ready',
  UNLINKED: 'unlinked',
  REFRESHING: 'refreshing',
  UNAVAILABLE: 'unavailable',
  REAUTH_REQUIRED: 'reauth_required',
});

export const AUTH_REASONS = Object.freeze({
  OK: 'ok',
  RECOVERED: 'recovered',
  NO_CREDENTIALS: 'no_credentials',
  LOGGED_OUT: 'logged_out',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  STORAGE_CONFLICT: 'storage_conflict',
  LOCK_TIMEOUT: 'lock_timeout',
  REFRESH_IN_PROGRESS: 'refresh_in_progress',
  REFRESH_TIMEOUT: 'refresh_timeout',
  REFRESH_NETWORK_ERROR: 'refresh_network_error',
  REFRESH_SERVER_ERROR: 'refresh_server_error',
  REFRESH_INTERRUPTED: 'refresh_interrupted',
  REFRESH_SPAWN_FAILED: 'refresh_spawn_failed',
  REFRESH_STORAGE_FAILED: 'refresh_storage_failed',
  VERIFICATION_UNAVAILABLE: 'verification_unavailable',
  RATE_LIMITED: 'rate_limited',
  INVALID_GRANT: 'invalid_grant',
  INVALID_CLIENT: 'invalid_client',
  MISSING_REFRESH_TOKEN: 'missing_refresh_token',
  CONSENT_REQUIRED: 'consent_required',
  FORBIDDEN: 'forbidden',
  UNAUTHORIZED: 'unauthorized',
  PROBE_UNREACHABLE: 'probe_unreachable',
  LOGIN_CANCELLED: 'login_cancelled',
  DISCOVERY_FAILED: 'discovery_failed',
  REGISTRATION_FAILED: 'registration_failed',
  EXCHANGE_FAILED: 'exchange_failed',
  BINDING_CONFLICT: 'binding_conflict',
});

// The four settings a user can pick. `on` is consent without a correlation answer; `anonymous` is
// consent with correlation explicitly declined. Both send the same anonymous reports.
export const CRASH_MODES = Object.freeze({
  CORRELATE: 'correlate',
  ON: 'on',
  ANONYMOUS: 'anonymous',
  OFF: 'off',
});

const CODE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_CODES).map((k) => DIAGNOSTIC_CODES[k]));
const SOURCE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_SOURCES).map((k) => DIAGNOSTIC_SOURCES[k]));
const AUTH_STATE_VALUES = Object.freeze(Object.keys(AUTH_STATES).map((k) => AUTH_STATES[k]));
const AUTH_REASON_VALUES = Object.freeze(Object.keys(AUTH_REASONS).map((k) => AUTH_REASONS[k]));
const CRASH_MODE_VALUES = Object.freeze(Object.keys(CRASH_MODES).map((k) => CRASH_MODES[k]));

export const isKnownAuthState = (value) => AUTH_STATE_VALUES.indexOf(value) !== -1;
export const isKnownAuthReason = (value) => AUTH_REASON_VALUES.indexOf(value) !== -1;
export const isCrashMode = (value) => CRASH_MODE_VALUES.indexOf(value) !== -1;

// New dedup keys held on disk. A repeat of a key already present still increments, so a recurring
// failure never loses its count to this cap — the cap exists to bound a machine that is failing in
// a hundred novel ways, not to throttle the signal that matters.
export const MAX_PENDING = 200;

// Events nobody delivered in two weeks are not worth the disk. prune.mjs sweeps only state/ and
// queue/, so lib/telemetry-flush.mjs runs this expiry on every flush.
export const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// The public route's inclusive @Max on an event's `count`.
const MAX_EVENT_COUNT = 100000;

// The consent RECORD stays at version 1 so every grant made before correlation existed keeps
// reading as a grant; the correlation consent the binding route is told about is versioned apart.
export const CONSENT_VERSION = 1;
export const CORRELATION_CONSENT_VERSION = 2;

// Structured vocabularies have a shape; prose does not. Anything that fails these patterns is
// dropped rather than truncated, because a truncated sentence is still a sentence.
const IDENTIFIER = /^[A-Za-z0-9_$.-]{1,64}$/;   // ENOENT, ERR_MODULE_NOT_FOUND, SyntaxError
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;  // 0.15.0, 0.15.0-dev.42 — the portal's pluginVersion shape
const OS_RELEASE = /^[A-Za-z0-9._-]{1,80}$/;    // 25.4.0, 6.8.0-45-generic, 10.0.26100
// Mirrors the portal's `site` pattern. No backslashes, no drive letters, no spaces — a Windows
// absolute path cannot satisfy it even by accident.
const SITE = /^[A-Za-z0-9_./-]+:\d+$/;

// lib/ → the plugin root. Every containment check and the version read are relative to this.
const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// The source of the hook currently in flight, published by an entry point so a source-less call
// site (token refresh, a queue drain deep in checkpoint) is attributed to the right hook instead of
// being mislabeled. Deliberately never cleared: a lazily-imported report can resolve after the hook
// body finished, and `unknown` is a worse answer than a slightly stale one.
let currentSource = DIAGNOSTIC_SOURCES.UNKNOWN;

// Reentrancy guard: a write failure INSIDE the diagnostics directory must not report, which writes,
// which fails, which reports, forever.
let recording = false;

let cachedVersion = null;

export function setCurrentSource(source) {
  if (SOURCE_VALUES.indexOf(source) !== -1) currentSource = source;
}

export function getCurrentSource() {
  return currentSource;
}

// One JSON file per dedup key while an event accumulates, `evt-<eventId>.json` once the flush has
// sealed it. Swept by the flush's own expiry, not by prune.mjs.
export function diagnosticsDir() {
  return path.join(beeziCodexHome(), 'diagnostics');
}

// Root level, NOT under state/: pruneStale() walks state/ and queue/, and a consent record that
// expires means a user who declined starts reporting again silently two weeks later.
export function diagnosticsConsentFile() {
  return path.join(beeziCodexHome(), 'telemetry.json');
}

// Returns the stored record, or null. A missing file, an unreadable file and a record written by a
// different consent version all read as null — and null is denied. The version check is what makes
// a future change to what is being consented to re-ask instead of inheriting an old answer.
export function readConsent() {
  const raw = readJson(diagnosticsConsentFile(), null);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== CONSENT_VERSION) return null;
  return raw;
}

// THE gate. Default OFF: only an explicit, current-version 'granted' is a yes.
export function isTelemetryGranted() {
  const record = readConsent();
  return !!record && record.consent === 'granted';
}

// A second, independent gate. Correlation is meaningless without diagnostics, so it reads as "no"
// whenever basic diagnostics are off — an old grant is never silently upgraded.
export function isCorrelationGranted() {
  const record = readConsent();
  return !!record && record.consent === 'granted' && record.correlation === 'granted';
}

// Distinct from "declined" on purpose: a user who saw the one-time notice and ignored it is not
// asked again and is not reporting.
export function hasBeenAsked() {
  const record = readConsent();
  return !!record && (record.askedAt != null || record.consent != null);
}

export function hasCorrelationBeenAsked() {
  const record = readConsent();
  return !!record && record.correlationAskedAt != null;
}

export function crashMode() {
  const record = readConsent();
  if (!record || record.consent !== 'granted') return CRASH_MODES.OFF;
  if (record.correlation === 'granted') return CRASH_MODES.CORRELATE;
  return record.correlation === 'denied' ? CRASH_MODES.ANONYMOUS : CRASH_MODES.ON;
}

// A patch over whatever is on disk, so a key this build does not know survives the write.
function writeConsent(patch) {
  const existing = readConsent();
  try {
    writeJsonSecure(diagnosticsConsentFile(), { version: CONSENT_VERSION, ...(existing || {}), ...patch });
    return true;
  } catch {
    return false;
  }
}

// An answer never overwrites the moment its question was put: askedAt / correlationAskedAt are
// stamped only when still missing, so a machine asked on day 1 that answers on day 30 keeps both.
function answer(patch, now) {
  const at = new Date(now()).toISOString();
  const existing = readConsent() || {};
  const next = { ...patch };
  // Unique even when Off→On happens within one timestamp or during an outstanding request.
  if (patch.consent === 'denied') next.withdrawalId = randomUuid();
  if (patch.correlation === 'denied') next.correlationWithdrawalId = randomUuid();
  if (patch.consent !== undefined) {
    next.decidedAt = at;
    if (existing.askedAt == null) next.askedAt = at;
  }
  if (patch.correlation !== undefined) {
    next.correlationDecidedAt = at;
    if (existing.correlationAskedAt == null) next.correlationAskedAt = at;
  }
  return writeConsent(next);
}

export function markAsked(now = Date.now) {
  if (hasBeenAsked()) return false;
  return writeConsent({ askedAt: new Date(now()).toISOString() });
}

export function markCorrelationAsked(now = Date.now) {
  if (hasCorrelationBeenAsked()) return false;
  return writeConsent({ correlationAskedAt: new Date(now()).toISOString() });
}

// Keeps any correlation answer as it was; setCrashMode('on') is what withdraws a correlate grant.
export function grantConsent(now = Date.now) {
  return answer({ consent: 'granted' }, now);
}

// Complete opt-out: correlation goes with it, so re-enabling never resurrects a correlation grant.
//
// The record is written BEFORE the purge on purpose. If the write fails the machine is still
// nominally granted with an emptied queue — recoverable. The reverse order would leave a denied
// record with events still on disk and only the flush's send-time gate between them and the wire.
export function denyConsent(now = Date.now) {
  const ok = answer({ consent: 'denied', correlation: 'denied' }, now);
  purgeAllDiagnostics();
  return ok;
}

export function grantCorrelation(now = Date.now) {
  return answer({ consent: 'granted', correlation: 'granted' }, now);
}

// Keeps basic diagnostics exactly as they were; only the account link — and every report already
// stamped with it — is withdrawn.
export function denyCorrelation(now = Date.now) {
  const ok = answer({ correlation: 'denied' }, now);
  purgeCorrelatedDiagnostics();
  return ok;
}

// The one switch the settings skill drives. Returns whether the choice was saved; `purged`, when
// given, receives what On and Anonymous deleted ({ removed, idRemoved }), so a failure can say so.
//
// Two deliberate departures from the Claude plugin's switch: `on` withdraws any correlation (On
// means "without an installation ID"), and `anonymous` grants consent too, so an off machine
// choosing it is not left off.
export function setCrashMode(mode, now = Date.now, purged = null) {
  const record = (result) => { if (purged != null) Object.assign(purged, result); };
  if (mode === CRASH_MODES.OFF) return denyConsent(now);
  if (mode === CRASH_MODES.CORRELATE) return grantCorrelation(now);
  if (mode === CRASH_MODES.ANONYMOUS) {
    const ok = answer({ consent: 'granted', correlation: 'denied' }, now);
    record(purgeCorrelatedDiagnostics());
    return ok;
  }
  if (mode === CRASH_MODES.ON) {
    // The correlation decision is CLEARED (undefined drops the key), so this reads back as `on`
    // rather than `anonymous`; correlationAskedAt stays, so the one-time offer is not repeated. A
    // new correlationWithdrawalId stops a flush already in flight from sending stamped reports.
    const ok = answer({
      consent: 'granted', correlation: undefined, correlationDecidedAt: undefined,
      correlationWithdrawalId: randomUuid(),
    }, now);
    record(purgeCorrelatedDiagnostics());
    return ok;
  }
  return false;
}

// A hook cannot prompt, so the one-time ask names the skill that answers it and is stamped the
// moment it is shown. It covers correlation too, so the standalone correlation offer never repeats it.
export function consentPrompt(now = Date.now) {
  if (hasBeenAsked()) return null;
  markAsked(now);
  markCorrelationAsked(now);
  return 'Beezi can send crash reports about the plugin itself — versions, OS, which plugin file '
    + 'failed, and whether it was signed in. Never your code, prompts, or file paths. It helps us '
    + 'fix bugs we would otherwise never see. Recommended: turn on crash reports with account '
    + 'correlation in the settings skill — the same reports plus a random installation ID, so '
    + 'support can find yours and tell you when it is fixed. Prefer to stay anonymous? Choose On '
    + 'there to send the reports without that ID, or Off to decline everything.';
}

// Offered once to a machine that already sends anonymous reports. Declining changes nothing:
// anonymous reporting continues either way, so the offer never blocks it.
export function correlationPrompt(now = Date.now) {
  if (!isTelemetryGranted()) return null;
  if (hasCorrelationBeenAsked()) return null;
  markCorrelationAsked(now);
  return 'Beezi diagnostics are on. Optionally, a random installation ID can associate a failure '
    + 'with a Beezi account so support can find your report. When binding is needed, it uses the '
    + 'default usable account, otherwise the first usable account. Changing the default does not '
    + 'rebind an existing ID. Correlation is '
    + 'off unless you turn it on: choose Correlate under Crash reports in the settings skill to '
    + 'allow it, or ignore this — anonymous reporting continues either way.';
}

// Unlink every pending and sealed event. The events-only half of a purge.
export function discardPendingDiagnostics() {
  let deleted = 0;
  for (const file of listEventFiles()) {
    removeFileSync(path.join(diagnosticsDir(), file));
    deleted += 1;
  }
  return deleted;
}

// The user said no: what was recorded, the send backoff and the correlation identity all go.
export function purgeAllDiagnostics() {
  const deleted = discardPendingDiagnostics();
  removeFileSync(telemetrySendStateFile());
  rotateInstallationId();
  return deleted;
}

// Withdrawing correlation only: reports stamped with the installation ID go, the anonymous ones
// stay, and the identity itself is dropped so later events are anonymous. Returns what actually
// went: `removed` counts only files confirmed gone, `idRemoved` only an ID that existed.
export function purgeCorrelatedDiagnostics() {
  let removed = 0;
  for (const file of listEventFiles()) {
    const filePath = path.join(diagnosticsDir(), file);
    const { value } = readJsonSalvaged(filePath);
    if (value != null && value.installationId != null) {
      removeFileSync(filePath);
      if (!fs.existsSync(filePath)) removed += 1;
    }
  }
  return { removed, idRemoved: rotateInstallationId() };
}

function listEventFiles() {
  let files;
  try {
    files = fs.readdirSync(diagnosticsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) if (file.endsWith('.json')) out.push(file);
  return out;
}

function shaped(value, pattern) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return pattern.test(text) ? text : null;
}

function httpStatusOf(value) {
  const n = Number(value);
  if (!isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 100 && i <= 599 ? i : null;
}

// Never let a correlation lookup be the reason a diagnostic is lost.
function installationIdOrNull() {
  try {
    return currentInstallationId();
  } catch {
    return null;
  }
}

// Read once, from the package manifest inside the plugin root — the Codex marketplace manifest
// carries no version field (G-8-4). The portal refuses anything but a version shape or `unknown`.
function pluginVersion() {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = 'unknown';
  const pkg = readJson(path.join(PLUGIN_ROOT, 'package.json'), null);
  if (pkg && typeof pkg.version === 'string' && VERSION.test(pkg.version)) cachedVersion = pkg.version;
  return cachedVersion;
}

// The `(<file>:<line>:<col>)` tail of a frame whose path begins at `index`, as [file, line].
function frameTail(line, index) {
  const match = /^(.+):(\d+):\d+\)?\s*$/.exec(line.slice(index));
  return match ? [match[1], match[2]] : null;
}

// `<file>:<line>` for the FIRST stack frame that lies inside the plugin, rendered relative to the
// plugin root, or null.
//
// Sites come from `at` frames only, never the message line — a message can contain anything,
// including something that looks like a path plus a line:col. A frame is located by where the
// plugin root (or its file:// URL, which ESM frames use and which percent-encodes a space) begins,
// so a space inside the root cannot fracture the match. The containment check after path.relative
// is the actual guarantee; SITE then drops anything that still does not look like `lib/x.mjs:42`.
export function siteFrom(error, pluginRoot = PLUGIN_ROOT) {
  const stack = error == null || typeof error.stack !== 'string' ? '' : error.stack;
  let rootUrl = null;
  try {
    rootUrl = url.pathToFileURL(pluginRoot).href;
  } catch { /* the plain-path form below still applies */ }
  for (const line of stack.split('\n')) {
    if (!/^\s*at\s/.test(line)) continue;
    let file = null;
    let lineNo = null;
    const urlIndex = rootUrl === null ? -1 : line.indexOf(rootUrl);
    if (urlIndex !== -1) {
      const tail = frameTail(line, urlIndex);
      if (!tail) continue;
      try {
        file = url.fileURLToPath(tail[0]);
      } catch {
        continue;
      }
      lineNo = tail[1];
    } else {
      const index = line.indexOf(pluginRoot);
      if (index === -1) continue;
      const tail = frameTail(line, index);
      if (!tail) continue;
      file = tail[0];
      lineNo = tail[1];
    }
    const relative = path.relative(pluginRoot, file);
    if (!relative || relative.indexOf('..') === 0 || path.isAbsolute(relative)) continue;
    const site = `${relative.split(path.sep).join('/')}:${lineNo}`;
    return SITE.test(site) ? site : null;
  }
  return null;
}

// One file per distinct failure shape. The version is in the key so an upgrade does not fold a new
// build's failures into the old build's count, and the installation ID is, so withdrawing
// correlation can delete the stamped events without taking anonymous occurrences with them.
function dedupKey(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// The whole record, and the whole of what can ever reach the wire. Every key is either a
// closed-vocabulary value, a shaped identifier, a number or a timestamp.
//
// `claudeCodeVersion` is deliberately ABSENT. It is Claude-named but optional-nullable on the
// server, so omitting it is safe, and inventing a `codexVersion` sibling would get the event refused.
function buildRecord(fields, at, osRelease) {
  return {
    eventId: randomUuid(),
    code: fields.code,
    source: fields.source,
    site: fields.site,
    errorName: fields.errorName,
    errorCode: fields.errorCode,
    httpStatus: fields.httpStatus,
    authState: fields.authState,
    reason: fields.reason,
    // Stamped once, at record time. An event keeps the identity it was recorded under even if the
    // machine later rotates it, so a report is never re-attributed after the fact.
    installationId: fields.installationId,
    pluginVersion: fields.version,
    nodeVersion: process.version,
    os: process.platform,
    osRelease: shaped(osRelease(), OS_RELEASE),
    arch: process.arch,
    count: 1,
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

// Record one failure. Returns true when something was written or incremented, false otherwise —
// it never throws, and a false is never worth branching on at a call site.
//
// issue: { code, source?, error?, httpStatus?, authState?, reason? }
export function recordIssue(issue, deps = {}) {
  if (recording) return false;
  recording = true;
  try {
    return writeIssue(issue, deps);
  } catch {
    // Telemetry must never be the reason a hook fails.
    return false;
  } finally {
    recording = false;
  }
}

function writeIssue(issue, deps) {
  // Consent first, before anything is computed and long before anything is written.
  if (!isTelemetryGranted()) return false;

  const now = orDefault(deps.now, Date.now);
  const write = orDefault(deps.write, writeJsonSecure);
  const osRelease = orDefault(deps.osRelease, os.release);
  const input = issue || {};

  const code = input.code;
  if (CODE_VALUES.indexOf(code) === -1) return false;

  const requested = input.source;
  // An explicit source outside the vocabulary is a programming error and is dropped rather than
  // silently relabeled — the wire would refuse it, and hiding that behind `unknown` buries the bug.
  if (requested !== null && requested !== undefined && SOURCE_VALUES.indexOf(requested) === -1) return false;
  const source = orDefault(requested, currentSource);

  const error = input.error;
  const fields = {
    code,
    source,
    site: siteFrom(error),
    errorName: shaped(error && error.constructor ? error.constructor.name : null, IDENTIFIER),
    errorCode: shaped(codeOf(error), IDENTIFIER),
    httpStatus: httpStatusOf(input.httpStatus),
    // Unknown vocabulary is dropped rather than sent: the route refuses an event whose value its
    // enum lacks, and a refused event is deleted rather than retried.
    authState: isKnownAuthState(input.authState) ? input.authState : null,
    reason: isKnownAuthReason(input.reason) ? input.reason : null,
    installationId: installationIdOrNull(),
    version: pluginVersion(),
  };

  const key = dedupKey([
    fields.code, fields.source, fields.site, fields.errorName, fields.errorCode, fields.version,
    fields.authState, fields.reason, fields.installationId,
  ]);
  const file = path.join(diagnosticsDir(), `${safeFileName(key, { max: 32 })}.json`);
  const at = new Date(now()).toISOString();

  const existing = readJson(file, null);
  if (existing && typeof existing === 'object' && existing.code === fields.code
    && typeof existing.count === 'number' && isFinite(existing.count)) {
    // A repeat is an increment in place, never a second file — and it is exempt from MAX_PENDING,
    // because a recurring failure is exactly the one whose count must not be capped away. The
    // count itself stops at the route's @Max, past which the event is rejected and deleted.
    existing.count = Math.min(Math.trunc(existing.count) + 1, MAX_EVENT_COUNT);
    existing.lastSeenAt = at;
    write(file, existing);
    return true;
  }

  // Anything else already at this path is junk: a record from a schema that no longer exists, or a
  // half-written file. It is REPLACED, and the replacement is exempt from MAX_PENDING because it is
  // not a new key — the cap counts distinct failures, and this one is already counted.
  if (existing === null && listEventFiles().length >= MAX_PENDING) return false;
  write(file, buildRecord(fields, at, osRelease));
  return true;
}

// Every field the route requires, validated locally against this build's vocabulary.
export function isPostableEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.eventId !== 'string' || event.eventId === '') return false;
  if (CODE_VALUES.indexOf(event.code) === -1) return false;
  if (SOURCE_VALUES.indexOf(event.source) === -1) return false;
  if (typeof event.pluginVersion !== 'string' || event.pluginVersion === '') return false;
  if (typeof event.count !== 'number' || !isFinite(event.count) || event.count < 1) return false;
  if (typeof event.firstSeenAt !== 'string' || typeof event.lastSeenAt !== 'string') return false;
  if (event.site !== null && !(typeof event.site === 'string' && SITE.test(event.site))) return false;
  if (event.authState != null && !isKnownAuthState(event.authState)) return false;
  if (event.reason != null && !isKnownAuthReason(event.reason)) return false;
  if (event.installationId != null
    && !(typeof event.installationId === 'string' && UUID_V4.test(event.installationId))) return false;
  return true;
}

// Which linked account binds the installation ID: the default when it has a live token, else the
// first. `sessions` are the live ones already — nothing here filters on tracking.
export function diagnosticsSession(sessions, defaultKey = null) {
  if (!sessions || sessions.length === 0) return null;
  const preferred = sessions.find((session) => session.key === defaultKey);
  return preferred === undefined ? sessions[0] : preferred;
}
