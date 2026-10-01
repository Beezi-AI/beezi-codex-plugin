// Crash/diagnostic telemetry for the Codex plugin (G-8-2).
//
// Every hook in this plugin swallows its own crash (`scripts/checkpoint.mjs`, `scripts/stop.mjs`,
// `scripts/session-start.mjs` all end in a bare `.catch(() => {})`), so a user whose analytics stop
// working produces no signal at all — not to them, not to us. This module is the place those
// failures go.
//
// Four properties are load-bearing and none of them is negotiable:
//
//   1. CONSENT IS DEFAULT-OFF AND GATED AT RECORD TIME. `recordIssue` returns false before it
//      writes anything unless the machine has explicitly granted. Gating only at send time would
//      accumulate events on disk pre-consent, so a later "on" would ship data gathered before the
//      user agreed — retroactive consent. The consent surface itself is G-9-6; the switch it flips
//      is `grantConsent()` / `denyConsent()` below.
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
// The wire vocabulary is CLOSED on the server (`plugin-diagnostics.request.dto.ts` in the
// hb-ai-agent-portal repo validates `code` and `source` with @IsEnum), so an invented value 400s
// the whole batch. Both frozen maps below are therefore subsets of the server's enums, never
// extensions of them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import url from 'url';
import { beeziCodexHome } from './paths.mjs';
import { orDefault, removeFileSync } from './compat.mjs';
import { readJson, readJsonSalvaged, writeJsonSecure, safeFileName } from './fs-store.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, sessionOf, POST_TIMEOUT_MS } from './http.mjs';
import { fetchCompat } from './fetch-compat.mjs';
import { codeOf } from './friendly-error.mjs';

// All eight are vendor-neutral and every one describes a failure this plugin can also have, so they
// port as they are. Only the ones with a live call site are worth emitting — do not instrument a
// code just because it exists here.
export const DIAGNOSTIC_CODES = Object.freeze({
  HOOK_CRASH: 'hook_crash',
  HOOK_UNHANDLED_REJECTION: 'hook_unhandled_rejection',
  QUEUE_FILE_QUARANTINED: 'queue_file_quarantined',
  QUEUE_FLUSH_HTTP_ERROR: 'queue_flush_http_error',
  TOKEN_REFRESH_FAILED: 'token_refresh_failed',
  TRANSCRIPT_PARSE_FAILED: 'transcript_parse_failed',
  MCP_HANDSHAKE_TIMEOUT: 'mcp_handshake_timeout',
  STATE_WRITE_FAILED: 'state_write_failed',
});

// The members of the server's PluginDiagnosticSource enum that describe a call site this plugin
// actually has. The rest of that enum is Claude-shaped (`statusline`, `pulse`, `usage_ping`,
// `stop_failure`, `track_prompt`).
//
// `subagent_start` / `subagent_stop` are deliberately still absent. The server enum gained them in
// BE-2, but that is a Postgres enum behind a migration and this list may only name values the
// DEPLOYED server accepts — one unrecognised source 400s the whole batch. Add them here once BE-2
// has reached the environment this plugin points at; until then those two hooks report UNKNOWN.
export const DIAGNOSTIC_SOURCES = Object.freeze({
  CHECKPOINT: 'checkpoint',
  STOP: 'stop',
  REPORT: 'report',
  SESSION_START: 'session_start',
  MCP_BRIDGE: 'mcp_bridge',
  BACKFILL: 'backfill',
  SYNC: 'sync',
  LOGIN: 'login',
  TELEMETRY_FLUSH: 'telemetry_flush',
  UNKNOWN: 'unknown',
});

const CODE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_CODES).map((k) => DIAGNOSTIC_CODES[k]));
const SOURCE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_SOURCES).map((k) => DIAGNOSTIC_SOURCES[k]));

// New dedup keys held on disk. A repeat of a key already present still increments, so a recurring
// failure never loses its count to this cap — the cap exists to bound a machine that is failing in
// a hundred novel ways, not to throttle the signal that matters.
export const MAX_PENDING = 200;

// Events nobody flushed in two weeks are not worth the disk. Claude gets this from pruneStale();
// this plugin's prune.mjs sweeps only state/ and queue/, so the sweep lives here instead.
export const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// One batch is 50 events. The route caps the array server-side and a bigger body buys nothing.
const MAX_PER_BATCH = 50;

export const CONSENT_VERSION = 1;

// `errorName` and `errorCode` come off an Error object, so they are attacker-adjacent in the sense
// that matters here: a message can hold a path or a token, and `error.code` is only conventionally
// an errno. Anything that is not a short bare identifier is dropped rather than truncated.
const IDENTIFIER = /^[A-Za-z0-9_$.-]{1,64}$/;

// Mirrors the portal's `plugin-diagnostics.request.dto.ts` shape for `site`. No backslashes, no
// drive letters, no spaces — a Windows absolute path cannot satisfy it even by accident.
const SITE = /^[A-Za-z0-9_./-]+:\d+$/;

// lib/ → the plugin root. Every containment check and the version read are relative to this.
const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// The source of the hook currently in flight, published by an entry point so a source-less call
// site (token refresh, a queue drain deep in checkpoint) is attributed to the right hook instead of
// being mislabeled. Deliberately never cleared: a lazily-imported report can resolve after the hook
// body finished, and `unknown` is a worse answer than a slightly stale one.
let currentSource = DIAGNOSTIC_SOURCES.UNKNOWN;

// Reentrancy guard. A follow-up wires STATE_WRITE_FAILED into fs-store's throw paths; without this
// flag a write failure INSIDE the diagnostics directory reports, which writes, which fails, which
// reports, forever. Claude carries the same flag and a dedicated regression test for the loop.
let recording = false;

let cachedVersion = null;

export function setCurrentSource(source) {
  if (SOURCE_VALUES.indexOf(source) !== -1) currentSource = source;
}

export function getCurrentSource() {
  return currentSource;
}

// One JSON file per dedup key. Root-adjacent rather than under state/ is not required here (these
// are disposable), but the directory is swept by this module's own flush, not by prune.mjs.
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

// Distinct from "declined" on purpose. A hook cannot prompt, so G-9-6's session-start notice stamps
// this the moment it is shown; a user who ignored it is not asked again and is not reporting.
export function hasBeenAsked() {
  const record = readConsent();
  return !!record && (record.askedAt != null || record.consent != null);
}

function writeConsent(patch) {
  const existing = readConsent();
  const next = { version: CONSENT_VERSION };
  if (existing) {
    if (existing.askedAt != null) next.askedAt = existing.askedAt;
    if (existing.consent != null) next.consent = existing.consent;
    if (existing.decidedAt != null) next.decidedAt = existing.decidedAt;
  }
  for (const key of Object.keys(patch)) next[key] = patch[key];
  try {
    writeJsonSecure(diagnosticsConsentFile(), next);
    return true;
  } catch {
    return false;
  }
}

export function markAsked(now = Date.now) {
  if (hasBeenAsked()) return false;
  return writeConsent({ askedAt: new Date(now()).toISOString() });
}

// An answer never overwrites the moment the question was put. A machine notified on day 1 that
// answers on day 30 keeps both timestamps; folding them together would tell G-9-6's surface that
// the notice and the decision happened at once.
function decide(consent, now) {
  const at = new Date(now()).toISOString();
  const existing = readConsent();
  const patch = { consent, decidedAt: at };
  if (!existing || existing.askedAt == null) patch.askedAt = at;
  return writeConsent(patch);
}

export function grantConsent(now = Date.now) {
  return decide('granted', now);
}

// Denial discards whatever is already pending. A user who says no must not have events they never
// agreed to sent later by a flush that only checks the flag at send time.
//
// The record is written BEFORE the discard on purpose. If the write fails (read-only volume, a full
// disk) the machine is still nominally granted with an emptied queue — recoverable, and the user
// loses nothing they wanted. The reverse order would leave a denied record with events still on
// disk, and only the flush's send-time gate standing between them and the wire. That gate exists
// and would hold, but a privacy boundary should not depend on its second line of defence.
export function denyConsent(now = Date.now) {
  const ok = decide('denied', now);
  discardPendingDiagnostics();
  return ok;
}

// Unlink every pending event. Used by denial and available to G-9-6's surface.
export function discardPendingDiagnostics() {
  let deleted = 0;
  for (const file of listEventFiles()) {
    removeFileSync(path.join(diagnosticsDir(), file));
    deleted += 1;
  }
  return deleted;
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

// Anything that is not a short bare identifier becomes null rather than being truncated into
// something that still carries a fragment of whatever it was.
function identifier(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return IDENTIFIER.test(text) ? text : null;
}

function httpStatusOf(value) {
  const n = Number(value);
  if (!isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 100 && i <= 599 ? i : null;
}

// The plugin's own version, for the record and for the dedup key. Read once, from the package
// manifest inside the plugin root — the Codex marketplace manifest carries no version field
// (G-8-4), so this is the only self-describing number available.
function pluginVersion() {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = 'unknown';
  const pkg = readJson(path.join(PLUGIN_ROOT, 'package.json'), null);
  if (pkg && typeof pkg.version === 'string' && IDENTIFIER.test(pkg.version)) cachedVersion = pkg.version;
  return cachedVersion;
}

// `<file>:<line>` for the FIRST stack frame that lies inside the plugin, rendered relative to the
// plugin root, or null.
//
// This is the only field derived from free text, so it is the only real leak surface in the record
// and it is fenced twice: a `path.relative` containment check drops every frame outside the plugin
// (the user's home, a global Node install, a sandbox path), and the SITE pattern drops anything
// that still does not look like `lib/x.mjs:42`. Separators are normalized to `/` because SITE
// rejects a backslash — without that every Windows site would silently be null and a redaction
// test would pass for the wrong reason.
export function siteFrom(error, pluginRoot = PLUGIN_ROOT) {
  const stack = (error || {}).stack;
  if (typeof stack !== 'string') return null;
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = /([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    let file = match[1];
    if (file.indexOf('file://') === 0) {
      try {
        file = url.fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!path.isAbsolute(file)) continue;
    let relative;
    try {
      relative = path.relative(pluginRoot, file);
    } catch {
      continue;
    }
    if (!relative || relative.indexOf('..') === 0 || path.isAbsolute(relative)) continue;
    const site = `${relative.split(path.sep).join('/')}:${match[2]}`;
    if (SITE.test(site)) return site;
  }
  return null;
}

// One file per distinct failure shape. The version is in the key so an upgrade does not fold a new
// build's failures into the old build's count.
function dedupKey(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// The whole record, and the whole of what can ever reach the wire. Fifteen keys, every one either a
// closed-vocabulary value, a shaped identifier, a number or a timestamp.
//
// `claudeCodeVersion` is deliberately ABSENT. The field is Claude-named but it is the server's
// schema, not something to work around; it is optional-nullable there, so omitting it is safe and
// inventing a `codexVersion` sibling would 400 the whole batch under forbidNonWhitelisted.
function buildRecord(key, fields, at) {
  return {
    eventId: key + Date.now().toString(36),
    code: fields.code,
    source: fields.source,
    site: fields.site,
    errorName: fields.errorName,
    errorCode: fields.errorCode,
    httpStatus: fields.httpStatus,
    pluginVersion: fields.version,
    nodeVersion: process.version,
    os: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    count: 1,
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

// Record one failure. Returns true when something was written or incremented, false otherwise —
// it never throws, and a false is never worth branching on at a call site.
//
// issue: { code, source?, error?, httpStatus? }
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
  // Consent first, before anything is computed and long before anything is written. G-9-6 flips
  // this; until it does, and on any machine that has not answered, this is where every call stops.
  if (!isTelemetryGranted()) return false;

  const now = orDefault(deps.now, Date.now);
  const write = orDefault(deps.write, writeJsonSecure);

  const code = (issue || {}).code;
  if (CODE_VALUES.indexOf(code) === -1) return false;

  const requested = (issue || {}).source;
  // An explicit source outside the vocabulary is a programming error and is dropped rather than
  // silently relabeled — the wire would refuse it, and hiding that behind `unknown` buries the bug.
  if (requested !== null && requested !== undefined && SOURCE_VALUES.indexOf(requested) === -1) return false;
  const source = orDefault(requested, currentSource);

  const error = (issue || {}).error;
  const fields = {
    code,
    source,
    site: siteFrom(error),
    errorName: identifier(error && error.constructor ? error.constructor.name : null),
    errorCode: identifier(codeOf(error)),
    httpStatus: httpStatusOf((issue || {}).httpStatus),
    version: pluginVersion(),
  };

  const key = dedupKey([
    fields.code, fields.source, fields.site, fields.errorName, fields.errorCode, fields.version,
  ]);
  const file = path.join(diagnosticsDir(), `${safeFileName(key, { max: 32 })}.json`);
  const at = new Date(now()).toISOString();

  const existing = readJson(file, null);
  if (existing && typeof existing === 'object' && existing.code === fields.code
    && typeof existing.count === 'number' && isFinite(existing.count)) {
    // A repeat is an increment in place, never a second file — and it is exempt from MAX_PENDING,
    // because a recurring failure is exactly the one whose count must not be capped away.
    existing.count = Math.trunc(existing.count) + 1;
    existing.lastSeenAt = at;
    write(file, existing);
    return true;
  }

  // Anything else already at this path is junk: a record from a schema that no longer exists, or a
  // half-written file. It is REPLACED, and the replacement is exempt from MAX_PENDING because it is
  // not a new key — the cap counts distinct failures, and this one is already counted.
  if (existing === null && listEventFiles().length >= MAX_PENDING) return false;
  write(file, buildRecord(key, fields, at));
  return true;
}

// Every field the route requires, validated locally. One malformed event 400s the WHOLE batch under
// forbidNonWhitelisted, so anything failing this is unlinked rather than sent — the same bytes would
// be refused forever.
export function isPostableEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.eventId !== 'string' || event.eventId === '') return false;
  if (CODE_VALUES.indexOf(event.code) === -1) return false;
  if (SOURCE_VALUES.indexOf(event.source) === -1) return false;
  if (typeof event.pluginVersion !== 'string' || event.pluginVersion === '') return false;
  if (typeof event.count !== 'number' || !isFinite(event.count) || event.count < 1) return false;
  if (typeof event.firstSeenAt !== 'string' || typeof event.lastSeenAt !== 'string') return false;
  if (event.site !== null && !(typeof event.site === 'string' && SITE.test(event.site))) return false;
  return true;
}

// Ship what is on disk. Returns { sent, deleted, expired, failed, skipped }.
//
// Deliberately records nothing about its own failures: telemetry about telemetry is a loop that
// feeds itself. It has no retry loop and no token renewal — the events stay on disk and the next
// checkpoint tries again.
//
// `deps.timeoutMs` exists because this plugin's checkpoint runs against a real hook budget, unlike
// Claude's: an unbounded 3s POST would eat 40% of the budget before a single analytics segment is
// sent. The caller shrinks it to whatever the budget has left.
/**
 * Which account a diagnostics batch is sent as, when one has to be chosen.
 *
 * The event store and the consent record are MACHINE-level — a crash is a fact about this install,
 * not about a tenant — so the batch travels once, under one bearer, rather than once per linked
 * account. The default account when it is still reporting, otherwise the first one that is: a
 * tenant whose tracking has gone dark answers 403, which this flush keeps rather than deletes, so
 * choosing one would hold every event on disk for nothing.
 *
 * Pure, and `isLive` is handed in rather than imported, so the choice is assertable without a
 * tracking file on disk. Returns null when no linked account is reporting.
 */
export function diagnosticsSession(sessions, defaultKey, isLive) {
  const live = (sessions || []).filter((session) => isLive(session.key));
  if (live.length === 0) return null;
  const preferred = live.find((session) => session.key === defaultKey);
  return preferred === undefined ? live[0] : preferred;
}

export async function flushDiagnostics(session, deps = {}) {
  const result = { sent: 0, deleted: 0, expired: 0, failed: 0, skipped: null };
  const postJsonImpl = orDefault(deps.postJsonImpl, postJson);
  const fetchImpl = orDefault(deps.fetchImpl, fetchCompat);
  const now = orDefault(deps.now, Date.now);

  if (!session) {
    result.skipped = 'no-token';
    return result;
  }
  // Validated HERE, before anything is read off disk. postJson would raise the same TypeError one
  // batch later, but by then the events have been read and a caller that swallows the throw would
  // have lost nothing visible — the bare-token call site would stay invisible, which is the whole
  // point of the guard. Same posture as lib/whoami.mjs.
  sessionOf(session);
  // Redundant against the record-time gate by design. It is the direct assertion that nothing
  // leaves this machine without consent, rather than a property inherited from another function.
  if (!isTelemetryGranted()) {
    result.skipped = 'no-consent';
    return result;
  }

  // ENDPOINTS is read, never extended from here. The route is `/cli-agent/plugin-diagnostics`,
  // defined as `pluginDiagnostics` in lib/config.mjs; with no entry the flush is a no-op rather
  // than a guess at a URL.
  const endpointPath = 'endpointPath' in deps ? deps.endpointPath : ENDPOINTS.pluginDiagnostics;
  if (endpointPath === null || endpointPath === undefined || endpointPath === '') {
    result.skipped = 'no-endpoint';
    return result;
  }

  const dir = diagnosticsDir();
  const batch = [];
  const files = [];
  const cutoff = now() - MAX_EVENT_AGE_MS;

  for (const name of listEventFiles()) {
    if (batch.length >= MAX_PER_BATCH) break;
    const file = path.join(dir, name);
    const salvage = readJsonSalvaged(file);
    // Unreadable this instant (an AV scanner holding the handle) is not the same as unpostable:
    // leave it for the next pass rather than deleting a signal that is merely busy.
    if (salvage.unreadable) continue;
    const event = salvage.value;
    if (!isPostableEvent(event)) {
      removeFileSync(file);
      result.deleted += 1;
      continue;
    }
    if (Date.parse(event.lastSeenAt) < cutoff) {
      removeFileSync(file);
      result.expired += 1;
      continue;
    }
    batch.push(event);
    files.push(file);
  }

  if (batch.length === 0) {
    result.skipped = 'empty';
    return result;
  }

  let res;
  try {
    res = await postJsonImpl(
      `${apiBase()}${endpointPath}`,
      session,
      { events: batch },
      { fetchImpl, timeoutMs: orDefault(deps.timeoutMs, POST_TIMEOUT_MS) },
    );
  } catch {
    result.failed = batch.length;
    return result;
  }

  const status = Number((res || {}).status);
  if (status >= 200 && status < 300) {
    for (const file of files) removeFileSync(file);
    result.sent = batch.length;
    return result;
  }
  // 401 and 403 are kept: authentication is not a verdict on the payload, and an audit-mode tenant
  // can convert. Every other 4xx is permanent — the same bytes will be refused forever.
  if (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)) {
    for (const file of files) removeFileSync(file);
    result.deleted += batch.length;
    return result;
  }
  result.failed = batch.length;
  return result;
}
