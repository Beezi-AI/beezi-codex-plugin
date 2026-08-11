import fs from 'node:fs';
import path from 'node:path';
import { codexSessionsDir, stateDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';

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
    try {
      if (!fs.statSync(state.transcriptPath).isFile()) continue;
    } catch {
      continue;
    }
    const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : '';
    if (!best || updatedAt > best.updatedAt) {
      best = { sessionId: file.slice(0, -'.json'.length), transcriptPath: state.transcriptPath, updatedAt };
    }
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}

// The launch cwd recorded in a rollout's session_meta (first line), or null.
function rolloutCwd(transcriptPath) {
  let content;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 8192));
      fs.readSync(fd, buf, 0, buf.length, 0);
      content = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const firstLine = content.split('\n', 1)[0];
  try {
    const rec = JSON.parse(firstLine);
    return rec?.type === 'session_meta' && typeof rec.payload?.cwd === 'string' ? rec.payload.cwd : null;
  } catch {
    return null;
  }
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
    if (rolloutCwd(full) !== cwd) continue;
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { full, mtime };
  }
  if (!best) return null;
  // The rollout name is rollout-<ISO-with-dashes>-<uuid>.jsonl; the session id is the trailing
  // UUID (its internal dashes make a greedy suffix capture wrong).
  const name = path.basename(best.full);
  const m = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(name);
  return { sessionId: m ? m[1] : null, transcriptPath: best.full };
}

// Resolve the rollout transcript for a hook invocation. Prefer the path the hook handed us
// (SessionStart / SessionEnd), then the session id (PostToolUse / Stop), then the cwd mapping
// checkpoints persisted in state. Returns { sessionId, transcriptPath } or null.
export function resolveCodexTranscript(input) {
  const sessionId = input?.session_id ?? null;
  const provided = input?.transcript_path ?? null;
  if (provided) {
    try {
      if (fs.statSync(provided).isFile()) return { sessionId, transcriptPath: provided };
    } catch { /* fall through to id resolution */ }
  }
  if (sessionId) {
    const byId = findRolloutBySessionId(sessionId);
    if (byId) return byId;
  }
  if (input?.cwd) {
    const byState = findRolloutBySessionState(input.cwd);
    if (byState) return byState;
  }
  return null;
}
