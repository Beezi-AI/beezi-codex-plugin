import fs from 'fs';
import path from 'path';
import { beeziCodexHome, codexSessionsDir, queueDir, stateDir } from './paths.mjs';
import { listAccountsSync } from './accounts.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { scanRecords } from './session-name-codex.mjs';
import { orDefault } from './compat.mjs';

// Codex writes one rollout transcript per session at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
// The filename always ends with the globally-unique session id, so we can locate a session's
// transcript by id regardless of cwd drift (cd / worktree switches during the session).
//
// Only the SessionStart and SessionEnd hooks carry `transcript_path`; PostToolUse and Stop do
// not. So the checkpoint path resolves the rollout from the session id (this module) instead of
// relying on the hook payload.

// Exported: the subagent sweep walks the same tree and must agree on what a rollout file is.
export const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

function isValidSessionId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id);
}

// The strings JavaScript produces when a MISSING id is interpolated into a path or a segment id:
// `path.join(stateDir(), `${null}.json`)` is `state/null.json`, and `${null}:1-18` is a segmentId
// of `null:1-18`. Every one of them passes isValidSessionId — that is precisely how an id-less
// session became a permanent phantom session literally named "null" — so they are rejected by
// name. Lookup table with an `=== true` test rather than Object.hasOwn (Node 13.2 floor) and so
// an inherited Object.prototype key can never read as a member.
const RESERVED_ID = { null: true, undefined: true, NaN: true, true: true, false: true, '': true };

// An id safe to key DURABLE things on: the state file (state/<id>.json), the segmentId
// (<id>:<from>-<to>), the queue filename derived from it, and the sessionId on the wire.
//
// Deliberately NOT applied inside the resolvers' return value: a transcript we can locate but not
// name is still worth returning, because `liveSession` in lib/session-audit.mjs excludes the live
// session by PATH and a null id there is legitimate. The validation belongs at the entry points
// that WRITE — see lib/track-session.mjs resolveTrackTarget.
export function isUsableSessionId(id) {
  return isValidSessionId(id) && RESERVED_ID[id] !== true;
}

// Recursively collect rollout files under the date-partitioned sessions tree. Bounded in
// practice (one dir per day); tolerant of a missing tree (returns []).
// Exported: the history-backfill index walks the same tree and must agree on what a rollout is.
export function listRolloutFiles(root, depth = 0, out = []) {
  if (depth > 4) return out; // sessions/YYYY/MM/DD/<file>
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listRolloutFiles(full, depth + 1, out);
    } else if (ROLLOUT_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Locate a session's rollout transcript by its id. Returns { sessionId, transcriptPath } or null.
export function findRolloutBySessionId(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const suffix = `-${sessionId}.jsonl`;
  const files = listRolloutFiles(codexSessionsDir());
  // A session id is unique, but if two files somehow match (resume), prefer the newest.
  let best = null;
  for (const full of files) {
    if (!full.endsWith(suffix)) continue;
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { full, mtime };
  }
  return best ? { sessionId, transcriptPath: best.full } : null;
}

// Newest-updatedAt session state whose recorded cwd matches. Checkpoints keep state.cwd current
// as the session cd's around, so this recovers the right session's transcript even when neither
// the hook payload nor a session-id env var is available.
function findRolloutBySessionState(cwd) {
  let files;
  try {
    files = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  let best = null;
  for (const file of files) {
    const state = readJson(path.join(stateDir(), file));
    if (!state || state.cwd !== cwd || !state.transcriptPath) continue;
    // The id, not the filename it happened to be stored under. `state/null.json` is ONE file
    // shared by every id-less session in this directory, and reading its name back made every
    // later resolve from that cwd answer with the string "null" — a valid-looking id the server
    // accepts, matched on cwd alone, so it kept answering that way even for correctly-named
    // sessions. Prefer an id recorded INSIDE the file — lib/checkpoint.mjs writes `sessionId` into
    // the state it saves — fall back to the filename for state files written before that write
    // existed, and skip anything that is not a usable id so an already-poisoned file on disk can
    // never be answered with again.
    const fileId = file.slice(0, -'.json'.length);
    const id = typeof state.sessionId === 'string' ? state.sessionId : fileId;
    if (!isUsableSessionId(id)) continue;
    try {
      if (!fs.statSync(state.transcriptPath).isFile()) continue;
    } catch {
      continue;
    }
    const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : '';
    if (!best || updatedAt > best.updatedAt) {
      best = { sessionId: id, transcriptPath: state.transcriptPath, updatedAt };
    }
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}

// rollout-<ISO-with-dashes>-<uuid>.jsonl — the session id is the trailing UUID (its internal
// dashes make a greedy suffix capture wrong).
const TRAILING_UUID_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

// What a rollout's own session_meta (first line) says about itself: `{ cwd, sessionId }`, either
// field null when unusable, or null for a file with no readable session_meta at all.
//
// Both come off ONE parse. The cwd read already happened here; returning the id from the same
// record costs zero extra I/O and removes essentially every route to an id-less session — the
// filename regex used to be the only thing standing between a renamed, copied or restored-from-
// backup rollout and a state file called `null.json`.
//
// `payload.id` FIRST, not `payload.session_id`. On a SUBAGENT rollout `session_id` holds the
// PARENT's thread id while `id` is the file's own (`subagentIdentityFrom` in lib/subagent-codex.mjs
// documents and depends on exactly that), and subagent rollouts are top-level files in the same
// date tree carrying the parent's cwd — so resolveTranscriptByCwd can and does see them. Pairing a
// parent id with a child transcript would write the parent's cursor from the child's lines, which
// is worse than the null id this exists to prevent. On a normal rollout the two are equal, so the
// preference is invisible there; it also matches lib/transcript-index-codex.mjs, which has always
// read `id` alone.
//
// The read is a bounded STREAM, not a fixed head slice. session_meta is dominated by
// `base_instructions`: measured on this corpus, first lines reach 48KB, and `scanRecords` in
// lib/session-name-codex.mjs measures ~37KB for the record once dynamic_tools is counted. A slice
// that stops mid-line hands JSON.parse an unterminated string, so the file reads as "no session_meta
// at all" and drops out of the cwd scan — silently, because a parse failure and a missing file
// collapse into the same null.
//
// scanRecords is the single definition of "read records off a rollout" (it chunks at 256KB with a
// streaming decoder and carries a partial trailing line forward), so there is no second cap here to
// drift out of step with reality.
//
// Exported because it is the ONE window every one-record head read uses — rolloutMeta below,
// listAllRollouts in lib/transcript-index-codex.mjs, the sweep in lib/subagent-codex.mjs and the
// watcher's identity read all import it rather than re-spelling `512 * 1024`. It is NOT
// readRolloutHead's default: that is HEAD_BYTES (2MB) in lib/subagent-codex.mjs, sized for the
// fork-prefix scan, which reads many records rather than one. Both are passed explicitly at the
// sites that want this narrower one.
export const ROLLOUT_HEAD_BYTES = 512 * 1024;

function rolloutMeta(transcriptPath) {
  let rec = null;
  // One record is all this needs, and scanRecords is a generator — the loop breaks before a second
  // chunk is ever read on all but a pathological file.
  for (const first of scanRecords(transcriptPath, { maxBytes: ROLLOUT_HEAD_BYTES })) {
    rec = first;
    break;
  }
  if (!rec || rec.type !== 'session_meta' || !rec.payload) return null;
  const p = rec.payload;
  const id = isUsableSessionId(p.id) ? p.id : (isUsableSessionId(p.session_id) ? p.session_id : null);
  return {
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    sessionId: id,
  };
}

// The session id a rollout records for itself, or null. Used where only the path is known.
function rolloutSessionId(transcriptPath) {
  const meta = rolloutMeta(transcriptPath);
  if (meta && meta.sessionId) return meta.sessionId;
  const m = TRAILING_UUID_RE.exec(path.basename(transcriptPath));
  return m && isUsableSessionId(m[1]) ? m[1] : null;
}

// Resolve the rollout for a manual invocation (e.g. the track script) that has only process.cwd():
// prefer the cwd mapping checkpoints persist in state, then the newest rollout whose session_meta
// launch cwd matches. Returns { sessionId, transcriptPath } or null.
export function resolveTranscriptByCwd(cwd) {
  const byState = findRolloutBySessionState(cwd);
  if (byState) return byState;
  const files = listRolloutFiles(codexSessionsDir());
  let best = null;
  for (const full of files) {
    const meta = rolloutMeta(full);
    if (!meta || meta.cwd !== cwd) continue;
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { full, mtime, sessionId: meta.sessionId };
  }
  if (!best) return null;
  // session_meta first — it is the rollout's own record of its id, already parsed above for the
  // cwd — then the filename. The filename regex STAYS: it is the second source for a rollout whose
  // first line is unreadable, and removing it would lose sessions this can still name.
  //
  // sessionId may still come back null, and this must NOT become a `return null`. liveSession()
  // (`liveSession` in lib/session-audit.mjs) calls this only to exclude the currently-live session
  // from the backfill and matches on the transcript PATH; a null here is legitimate for it, and
  // refusing would stop the backfill excluding the live session and re-segment a transcript the
  // live hooks are already reporting — double-billing it. Pinned by test/session-audit.test.mjs
  // case 7. Callers that need a name for a durable key validate for themselves
  // (lib/track-session.mjs).
  const m = TRAILING_UUID_RE.exec(path.basename(best.full));
  const fromName = m && isUsableSessionId(m[1]) ? m[1] : null;
  return { sessionId: orDefault(best.sessionId, fromName), transcriptPath: best.full };
}

// Resolve the rollout transcript for a hook invocation. Prefer the path the hook handed us
// (SessionStart / SessionEnd), then the session id (PostToolUse / Stop), then the cwd mapping
// checkpoints persisted in state. Returns { sessionId, transcriptPath } or null.
export function resolveCodexTranscript(input) {
  const sessionId = orDefault((input || {}).session_id, null);
  const provided = orDefault((input || {}).transcript_path, null);
  if (provided) {
    try {
      if (fs.statSync(provided).isFile()) {
        // A hook can hand over a path with no session_id (or a junk one). The rollout knows its own
        // id, and we are already touching the file — so answer with it rather than pass the gap on.
        return {
          sessionId: isUsableSessionId(sessionId) ? sessionId : rolloutSessionId(provided),
          transcriptPath: provided,
        };
      }
    } catch { /* fall through to id resolution */ }
  }
  if (sessionId) {
    const byId = findRolloutBySessionId(sessionId);
    if (byId) return byId;
  }
  if (input && input.cwd) {
    const byState = findRolloutBySessionState(input.cwd);
    if (byState) return byState;
  }
  return null;
}

// ─── quarantine ─────────────────────────────────────────────────────────────
//
// Cleanup for state and queue entries an id-less session already wrote on a real machine. The
// resolver above no longer ANSWERS with such a file, which is what stops the phantom "null"
// session immediately and unconditionally; this moves the files out of the way so nothing else
// trips over them either — pruneStale still sweeps them at 14 days, subagent sidecars accumulate
// under `null.agents/`, and `null_1-18.json` sits in the queue waiting to be posted under a
// session id the server would accept.
//
// MOVED, NEVER DELETED. A queued report is unreported analytics: it holds real tokens, real cost
// and a real segment window, and only its session id is wrong. Deleting it destroys work that a
// human could still re-attribute from the segment identity inside it; moving it costs a directory.
//
// Only the ids JavaScript itself manufactures for a missing value are moved (RESERVED_ID), not
// everything isUsableSessionId rejects: skipping an odd id in the resolver is free, but relocating
// a file is not, and a state file with an id shape we simply have not seen is not evidence of this
// bug. The resolver's skip is the broader of the two on purpose.

// Where poisoned entries go. Under the plugin data root, beside state/ and queue/ (same volume, so
// the move is a rename), and outside both — pruneStale only sweeps state/ and queue/, so nothing
// here expires out from under an operator.
function quarantineDir() {
  return path.join(beeziCodexHome(), 'quarantine');
}

const QUARANTINE_README = [
  'Beezi quarantine',
  '================',
  '',
  'Each subdirectory is one sweep, named by the time it ran. Inside, `state/` and `queue/`',
  'mirror the layout the files were moved from (~/.beezi-codex/state, ~/.beezi-codex/queue).',
  '',
  'These files were written by sessions the plugin could not name. Their id had been',
  'interpolated from a missing value, so they were all filed under one shared name — `null`,',
  '`undefined` — and unrelated sessions overwrote each other in them. Nothing here is deleted:',
  'a queued report still holds real tokens, cost and a segment window, and only its session id',
  'is wrong.',
  '',
  'To inspect: every file is JSON. A queue file carries `segmentId`, `sessionId`, `remote`,',
  '`branch` and the usage it would have reported. A state file carries `cursor`, `cwd`,',
  '`transcriptPath` and `coveredIntervals`.',
  '',
  'To repair: identify the real session from `transcriptPath` (the rollout under',
  '~/.codex/sessions names its own id in the `session_meta` on its first line), rewrite',
  '`sessionId` and the `<id>:` prefix of `segmentId`, and move the file back into queue/. Do',
  'this only when the transcript identity actually supports the re-attribution — a shared file',
  'may hold segments from more than one session.',
  '',
  'To discard: delete a subdirectory. Nothing in the plugin reads this tree.',
  '',
  '`manifest.json` records every sweep: what moved, from where, and what failed to move.',
  '',
].join('\n');

// Poisoned entries in stateDir(): `<id>.json` written by the checkpoint and session start, plus
// the `<id>.agents/` sidecar directory subagent hooks write beside it.
function poisonedStateEntries(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    // Only the two shapes this directory holds. `writeJsonSecure` leaves `<file>.<pid>.tmp`
    // behind mid-write and matches neither, so a live writer is never raced for its temp file.
    let id = null;
    let isDir = false;
    if (name.length >= '.json'.length && name.slice(-'.json'.length) === '.json') {
      id = name.slice(0, -'.json'.length);
    } else if (name.length >= '.agents'.length && name.slice(-'.agents'.length) === '.agents') {
      id = name.slice(0, -'.agents'.length);
      isDir = true;
    }
    if (id === null || RESERVED_ID[id] !== true) continue;
    out.push({ name, isDir, area: 'state', from: path.join(dir, name) });
  }
  return out;
}

// Poisoned entries in one account's queue. A queue filename is safeFileName(segmentId), and a segmentId is
// `<sessionId>:<from>-<to>` (or `<sessionId>:<agentId>:<from>-<to>`) with `:` mapped to `_` — so a
// report from a session named `null` is exactly `null_...json`. A real session id is a UUID and
// can never produce that prefix.
function poisonedQueueEntries(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.length <= '.json'.length || name.slice(-'.json'.length) !== '.json') continue;
    const underscore = name.indexOf('_');
    if (underscore <= 0) continue;
    const id = name.slice(0, underscore);
    if (RESERVED_ID[id] !== true) continue;
    out.push({ name, isDir: false, area: 'queue', from: path.join(dir, name) });
  }
  return out;
}

// Move every poisoned state/queue entry into the quarantine tree. Best-effort and idempotent: a
// clean machine touches nothing and creates no directory, and a repeat run finds nothing left to
// move. Returns { moved: [...], failed: [...], dir }.
export function quarantinePoisonedSessionState(deps = {}) {
  const now = orDefault(deps.now, Date.now);
  const result = { moved: [], failed: [], dir: null };
  // Every account's queue, and the one machine-level state directory. The quarantine tree itself
  // stays machine-level: a poisoned report is a plugin defect, not a tenant's business, and an
  // operator repairing one wants them in one place. listAccountsSync keeps this synchronous and
  // keeps a quarantine sweep from triggering the one-time migration.
  let entries = poisonedStateEntries(stateDir());
  try {
    for (const account of listAccountsSync()) {
      entries = entries.concat(poisonedQueueEntries(queueDir(account.key)));
    }
  } catch { /* an unreadable index quarantines no queue file, which moves nothing */ }
  if (entries.length === 0) return result;

  // One directory per sweep, so a second poisoned `null.json` can never overwrite the first one
  // quarantined — the whole point is that nothing here is lost.
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const root = path.join(quarantineDir(), `${stamp}-${process.pid}`);
  result.dir = root;

  for (const entry of entries) {
    const to = path.join(root, entry.area, entry.name);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      // rename, not copy: same volume, atomic, and it works for the `.agents/` directory too.
      // A cross-device failure is recorded rather than worked around — the file stays where it
      // is, and the resolver already refuses to answer with it, so nothing is broken by leaving
      // it. Node 13.2 has no fs.cpSync to fall back to.
      fs.renameSync(entry.from, to);
      result.moved.push({ from: entry.from, to });
    } catch (error) {
      result.failed.push({ from: entry.from, to, error: String((error && error.message) || error) });
    }
  }

  // The marker: a durable, append-only record of every sweep, so a repeat run is visibly a no-op
  // and an operator has one place that says what was taken and from where.
  try {
    const readme = path.join(quarantineDir(), 'README.txt');
    if (!fs.existsSync(readme)) {
      fs.mkdirSync(quarantineDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(readme, QUARANTINE_README, { encoding: 'utf-8', mode: 0o600 });
    }
    const manifestPath = path.join(quarantineDir(), 'manifest.json');
    const manifest = readJson(manifestPath, null);
    const sweeps = manifest && Array.isArray(manifest.sweeps) ? manifest.sweeps : [];
    sweeps.push({
      at: new Date(now()).toISOString(),
      dir: root,
      moved: result.moved,
      failed: result.failed,
    });
    writeJsonSecure(manifestPath, { version: 1, sweeps });
  } catch { /* best-effort: the files are already safe, the bookkeeping is not worth a throw */ }

  return result;
}
