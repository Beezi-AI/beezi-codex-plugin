import fs from 'fs';
import path from 'path';
import { orDefault } from './compat.mjs';

// Read + parse a JSON file, or return `fallback` on any read/parse failure.
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Returns the text of the first complete JSON object in `raw`, or null. Scans for the brace that
// closes the opening one, honoring strings and escapes. Deliberately not driven by the position
// in a JSON.parse error message: that wording is a V8 detail that has changed between Node
// versions, and this runs as far back as Node 13.2.
function firstJsonObject(raw) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(0, i + 1);
    }
  }
  return null;
}

// Read + parse, falling back to the first complete JSON object when the file has trailing
// wreckage. Codex's first release wrote these files with a bare writeFileSync (0e9e421; renameSync
// arrived in 865bceb), and writeFileSync opens with O_TRUNC before it writes — so two writers
// landing on one path leave the shorter payload followed by the longer one's tail. That prefix is
// intact data, and dropping it throws away a session's analytics.
//
// Returns { value, salvaged, unreadable }:
//   value      — the parsed object, or null when nothing is recoverable;
//   salvaged   — true only when the prefix scan, not JSON.parse, produced it;
//   unreadable — true when the file could not be READ at all (ENOENT, or a transient EACCES from
//                an AV scanner). Claude does not draw this distinction; Codex must, because the
//                queue drain quarantines on the strength of this answer and quarantining a file
//                that was merely unreadable this instant permanently removes a good payload.
export function readJsonSalvaged(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { value: null, salvaged: false, unreadable: true };
  }
  try {
    return { value: JSON.parse(raw), salvaged: false, unreadable: false };
  } catch {
    /* trailing wreckage, or genuinely unparseable — try the prefix */
  }
  const prefix = firstJsonObject(raw);
  if (prefix == null) return { value: null, salvaged: false, unreadable: false };
  try {
    return { value: JSON.parse(prefix), salvaged: true, unreadable: false };
  } catch {
    return { value: null, salvaged: false, unreadable: false };
  }
}

const RENAME_ATTEMPTS = 4;

// A real blocking sleep in synchronous code. Every caller of writeJsonSecure is sync and runs inside
// a hook budget, so a busy-wait would burn the very milliseconds it is waiting out.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SharedArrayBuffer unavailable — proceed without the pause */ }
}

// The only errnos a rename retry can clear. Everything else — ENOSPC, a vanished temp, a
// read-only volume — is settled the moment it is raised, and spinning on it costs 30ms of the
// hook budget and then reports "held open by another process" for a cause that is not that.
const RETRYABLE_RENAME = { EPERM: true, EBUSY: true, EACCES: true };

// Write JSON to a 0600 file, creating parent dirs.
//
// Written to a temp file and renamed so a reader sees either the old file or the new one, never
// half of each. A torn write is the failure that matters here: readJson falls back to its default
// on a parse error, and for session state that default is `{cursor: 0}` — the whole session gets
// re-reported. The hazard is not new (an AV scanner or the indexer can hold any of these files
// open), but subagent hooks running alongside the parent's checkpoint widened it.
//
// The temp name carries the pid so two writers never collide on it.
//
// `deps` is an additive FOURTH parameter, after the existing options object, so none of the
// existing call sites change. It exists because `fs` is a module-level import: without it the
// retry loop, the errno filter and the temp cleanup cannot be exercised by a test at all.
export function writeJsonSecure(filePath, obj, { dirMode = 0o700 } = {}, deps = {}) {
  const fsImpl = orDefault(deps.fs, fs);
  const sleep = orDefault(deps.sleepImpl, sleepSync);
  // Deliberately NOT compat's removeFileSync: that unlinks through compat.mjs's own module-level
  // `fs` import, so an injected fsImpl would never see the call and a test could not observe the
  // cleanup it is asserting.
  const discard = (p) => {
    try { fsImpl.unlinkSync(p); } catch { /* already gone */ }
  };

  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: dirMode });
  const json = JSON.stringify(obj);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
    // writeFileSync only applies `mode` on creation, so chmod is forced (no-op on Windows).
    try { fsImpl.chmodSync(tmp, 0o600); } catch { /* no-op on Windows */ }
  } catch (error) {
    // Never leave a half-written temp behind for the queue drain or prune to trip over. The
    // original error propagates: a full disk must not be reported as contention.
    discard(tmp);
    throw error;
  }

  // On Windows, MoveFileEx fails with EPERM/EBUSY while another process holds the target open
  // without FILE_SHARE_DELETE — an AV scanner or the search indexer, not another Node process
  // (libuv opens with share-delete). It clears in milliseconds, so retry briefly.
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    if (attempt) sleep(5 * attempt);
    try {
      fsImpl.renameSync(tmp, filePath);
      return;
    } catch (error) {
      // `(error && error.code) || ''` rather than `error?.code ?? ''`, and a lookup table rather
      // than Object.hasOwn — both are on the Node 13.2 ban list.
      const code = (error && error.code) || '';
      if (RETRYABLE_RENAME[code] !== true) {
        discard(tmp);
        throw error;
      }
    }
  }

  // Still contended. Throw rather than fall back to a direct overwrite: that overwrite is exactly
  // the torn write this function exists to prevent, attempted in the one case where contention on
  // the target is proven rather than hypothetical. Every caller treats a write failure as
  // best-effort, and the failure modes are not symmetric — a skipped state save re-reports one
  // window that the server upserts idempotently, while a torn one sends readJson to its
  // `{cursor: 0}` fallback and re-bills the whole session.
  discard(tmp);
  throw new Error(`could not atomically replace ${filePath} (file is held open by another process)`);
}

// Critical transaction records must survive process termination before publication proceeds.
export function writeJsonDurable(filePath, obj) {
  writeJsonSecure(filePath, obj);
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

// A single path component derived from untrusted input — an id off a hook payload, a segment id.
// Allowlist rather than denylist: anything outside this set becomes '_', so the result can never
// contain a separator, a drive letter or a traversal, and is bounded for filesystems with name
// limits. A mangled-but-stable name still identifies its owner; a traversal writes wherever the
// payload said to.
export function safeFileName(value, { max = 120, fallback = 'unknown' } = {}) {
  return String(orDefault(value, '')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || fallback;
}
