import fs from 'fs';
import path from 'path';
import { queueDir, naming } from './paths.mjs';
import { readJsonSalvaged, writeJsonDurable, safeFileName } from './fs-store.mjs';
import { isMultiTenant, readSessionWorkspace, resolveTargets, tenantsOf, QUEUE_HOLD_MS } from './workspace.mjs';

import { createRouteContext, routeForDir, routeForRemote } from './workspace-rules.mjs';

const { tenantTag } = naming;

const QUEUE_VERSION = 1;
const HOLD_ASK = 'ask';
// Envelopes never end in .json: an older build's drain lists only .json and would post an envelope
// as the report body, take the 400 and delete it (a Codex window can keep running the old watcher).
const ENVELOPE_EXT = '.qjson';
const ASK_SUFFIX = `__ask${ENVELOPE_EXT}`;
// Written by pre-release builds of this format; still read and released.
const LEGACY_ASK_SUFFIX = '__ask.json';
// Longest name is <base>__<36-char tenant uuid>.qjson = 160 + 44 = 204, within the 205 a 200-char raw name uses.
const SEGMENT_NAME_MAX = 160;
// A raw payload keeps the exact name origin/dev gives it.
const RAW_NAME_MAX = 200;

// safeFileName, not a targeted replace: a subagent segmentId embeds an agent id off a hook payload.
function segmentName(payload) {
  return safeFileName(payload.segmentId, { max: SEGMENT_NAME_MAX });
}

function tenantCopyName(seg, tenantId) {
  return `${seg}__${tenantTag(tenantId)}${ENVELOPE_EXT}`;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}

// A queued report: a raw payload (.json) or an envelope (.qjson).
export function isQueueFile(name) {
  return name.endsWith('.json') || name.endsWith(ENVELOPE_EXT);
}

export function isAskFile(name) {
  return name.endsWith(ASK_SUFFIX) || name.endsWith(LEGACY_ASK_SUFFIX);
}

// Multi-workspace copies are <seg>__<tenantTag>.qjson envelopes; everything else is the raw payload
// at <seg>.json, byte for byte what origin/dev writes.
export function enqueue(key, payload, tenantId = null, { multi = false } = {}) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  if (multi && tenantId != null) {
    writeJsonDurable(path.join(queueDir(key), tenantCopyName(segmentName(payload), tenantId)), { version: QUEUE_VERSION, tenantId, payload });
    return;
  }
  writeJsonDurable(path.join(queueDir(key), `${safeFileName(payload.segmentId, { max: RAW_NAME_MAX })}.json`), payload);
}

// The Ask portion, held until the session answers: <seg>__ask.qjson.
export function enqueueHeld(key, payload, askTenants, routing = null) {
  const file = path.join(queueDir(key), `${segmentName(payload)}${ASK_SUFFIX}`);
  writeJsonDurable(file, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: stringIds(askTenants) || [], routing, payload });
}

// Queue files are { version, tenantId, payload[, hold, askTenants] } envelopes; any other object is a legacy raw payload.
// Anything that is not an object comes back with payload null, which the drain quarantines as .corrupt.
export function unwrapQueueFile(value) {
  if (!isPlainObject(value)) return { tenantId: null, payload: null, hold: null, askTenants: null };
  if (isPlainObject(value.payload)) {
    return {
      tenantId: typeof value.tenantId === 'string' ? value.tenantId : null,
      payload: value.payload,
      hold: value.hold === HOLD_ASK ? HOLD_ASK : null,
      askTenants: stringIds(value.askTenants),
      routing: value.routing,
    };
  }
  return { tenantId: null, payload: value, hold: null, askTenants: null };
}

// Held = an ask hold, or an unstamped file on a multi-workspace account (askTenants null = every current workspace).
function isHeld(entry, row) {
  return entry.hold === HOLD_ASK || (entry.tenantId == null && isMultiTenant(row));
}

function heldSegment(filePath) {
  const base = path.basename(filePath);
  for (const suffix of [ASK_SUFFIX, LEGACY_ASK_SUFFIX, ENVELOPE_EXT, '.json']) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

// The session's route: its bound state, else the rule for the session's directory, else none (New folders).
function sessionState(row, state, sessionDir, ctx) {
  if (state != null || sessionDir == null) return state;
  const rule = routeForDir(row, sessionDir, ctx);
  return rule == null ? null : { route: { [row.key]: rule } };
}

// Copies a held or unstamped file to each target it may reach, then drops it once nothing is pending; returns { written: [file names], deleted, expired }.
// Its own directory's rule decides first (its own repo's, by the payload's remote, when it recorded no directory), then the session's route (`state`, else `sessionDir`'s rule), then New folders.
// An unstamped file (queued before the account had several workspaces) is routed before its age is judged, and one still waiting becomes a held file of the same age.
export function releaseHeldFile(filePath, row, state, sessionDir = null) {
  const none = { written: [], deleted: false, expired: false };
  if (!isMultiTenant(row)) return none;
  const salvage = readJsonSalvaged(filePath);
  if (salvage.unreadable) return none;
  const value = salvage.value;
  const entry = unwrapQueueFile(value);
  const askFile = isAskFile(filePath);
  if (!isHeld(entry, row) && !askFile) return none;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return none; }
  const expired = Date.now() - stat.mtimeMs > QUEUE_HOLD_MS;
  const expire = () => {
    try { fs.unlinkSync(filePath); return { written: [], deleted: true, expired: true }; } catch { return none; }
  };
  const unstamped = entry.hold !== HOLD_ASK && !askFile;
  if (expired && !unstamped) return expire();
  if (entry.payload == null) return none;

  const routing = isPlainObject(entry.routing) && entry.routing.version === 1 ? entry.routing : null;
  const ownDir = routing != null && typeof routing.dir === 'string' && path.isAbsolute(routing.dir) ? routing.dir : null;
  const ctx = createRouteContext();
  // Without a recorded directory, the payload's remote is the only trace of its own repo.
  const own = ownDir == null ? routeForRemote(row, entry.payload.remote, ctx) : routeForDir(row, ownDir, ctx);
  const resolved = resolveTargets(row, own == null ? sessionState(row, state, sessionDir, ctx) : { route: { [row.key]: own } });
  const eligible = entry.askTenants == null ? tenantsOf(row).map((t) => t.id) : entry.askTenants;
  const due = resolved.targets.filter((t) => t != null && eligible.indexOf(t) !== -1);
  const dir = path.dirname(filePath);
  const seg = typeof entry.payload.segmentId === 'string' && entry.payload.segmentId !== '' ? segmentName(entry.payload) : heldSegment(filePath);
  const written = [];
  // Tenants whose copy could not be written stay in the hold for the next release.
  const unwritten = [];
  for (const tenantId of due) {
    const name = tenantCopyName(seg, tenantId);
    const target = path.join(dir, name);
    // An existing copy may carry a newer payload.
    if (fs.existsSync(target)) continue;
    try {
      writeJsonDurable(target, { version: QUEUE_VERSION, tenantId, payload: entry.payload });
      written.push(name);
    } catch { unwritten.push(tenantId); }
  }

  const remaining = eligible.filter((t) => due.indexOf(t) === -1 || unwritten.indexOf(t) !== -1);
  // A rule, send or none settles it: what is not due now never will be.
  if (unwritten.length === 0 && (!resolved.pendingAsk || remaining.length === 0)) {
    try { fs.unlinkSync(filePath); return { written, deleted: true, expired: false }; } catch { return { written, deleted: false, expired: false }; }
  }
  if (unstamped) {
    // A copy that could not be written is retried from the file as it is.
    if (unwritten.length > 0) return { written, deleted: false, expired: false };
    if (expired) return expire();
    const held = path.join(dir, `${seg}${ASK_SUFFIX}`);
    try {
      // An existing hold for the same segment is newer; this file only has to go.
      if (!fs.existsSync(held)) {
        writeJsonDurable(held, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: remaining, routing: { version: 1, dir: null }, payload: entry.payload });
        // Keeps the original age so the hold window is not extended.
        fs.utimesSync(held, stat.atime, stat.mtime);
      }
      fs.unlinkSync(filePath);
    } catch { /* left as is; the next release retries */ }
    return { written, deleted: false, expired: false };
  }
  const changed = entry.hold !== HOLD_ASK || entry.askTenants == null || remaining.length !== entry.askTenants.length;
  if (changed) {
    try {
      // A flush may have deleted it meanwhile; rewriting would resurrect it.
      if (fs.existsSync(filePath)) {
        writeJsonDurable(filePath, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: remaining, routing: entry.routing, payload: entry.payload });
        // Keeps the original age so the hold window is not extended.
        fs.utimesSync(filePath, stat.atime, stat.mtime);
      }
    } catch { /* left as is; the next release retries */ }
  }
  return { written, deleted: false, expired: false };
}

// Releases every held file of this session on the account; returns how many copies were written.
export function releaseHeldQueue(row, sessionId) {
  if (row == null || sessionId == null || !isMultiTenant(row)) return 0;
  let dir;
  let files;
  try {
    dir = queueDir(row.key);
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const state = readSessionWorkspace(sessionId);
  let count = 0;
  for (const file of files) {
    if (!isQueueFile(file)) continue;
    const filePath = path.join(dir, file);
    const value = readJsonSalvaged(filePath).value;
    if (value == null) {
      if (isAskFile(file)) releaseHeldFile(filePath, row, state);
      continue;
    }
    const entry = unwrapQueueFile(value);
    if (entry.payload == null || entry.payload.sessionId !== sessionId || !isHeld(entry, row)) continue;
    count += releaseHeldFile(filePath, row, state).written.length;
  }
  return count;
}
