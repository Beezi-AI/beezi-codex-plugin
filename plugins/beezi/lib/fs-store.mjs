import fs from 'node:fs';
import path from 'node:path';

// Read + parse a JSON file, or return `fallback` on any read/parse failure.
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Write JSON to a 0600 file, creating parent dirs.
//
// Written to a temp file and renamed so a reader sees either the old file or the new one, never
// half of each. A torn write is the failure that matters here: readJson falls back to its default
// on a parse error, and for session state that default is `{cursor: 0}` — the whole session gets
// re-reported. The hazard is not new (an AV scanner or the indexer can hold any of these files
// open), but subagent hooks running alongside the parent's checkpoint widened it.
//
// The temp name carries the pid so two writers never collide on it.
const RENAME_ATTEMPTS = 4;

// A real blocking sleep in synchronous code. Every caller of writeJsonSecure is sync and runs inside
// a hook budget, so a busy-wait would burn the very milliseconds it is waiting out.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SharedArrayBuffer unavailable — proceed without the pause */ }
}

export function writeJsonSecure(filePath, obj, { dirMode = 0o700 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: dirMode });
  const json = JSON.stringify(obj);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync only applies `mode` on creation, so chmod is forced (no-op on Windows).
  try { fs.chmodSync(tmp, 0o600); } catch { /* no-op on Windows */ }

  // On Windows, MoveFileEx fails with EPERM/EBUSY while another process holds the target open
  // without FILE_SHARE_DELETE — an AV scanner or the search indexer, not another Node process
  // (libuv opens with share-delete). It clears in milliseconds, so retry briefly.
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    if (attempt) sleepSync(5 * attempt);
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch { /* contended; retry */ }
  }

  // Still contended. Throw rather than fall back to a direct overwrite: that overwrite is exactly
  // the torn write this function exists to prevent, attempted in the one case where contention on
  // the target is proven rather than hypothetical. Every caller treats a write failure as
  // best-effort, and the failure modes are not symmetric — a skipped state save re-reports one
  // window that the server upserts idempotently, while a torn one sends readJson to its
  // `{cursor: 0}` fallback and re-bills the whole session.
  try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  throw new Error(`could not atomically replace ${filePath} (file is held open by another process)`);
}

// A single path component derived from untrusted input — an id off a hook payload, a segment id.
// Allowlist rather than denylist: anything outside this set becomes '_', so the result can never
// contain a separator, a drive letter or a traversal, and is bounded for filesystems with name
// limits. A mangled-but-stable name still identifies its owner; a traversal writes wherever the
// payload said to.
export function safeFileName(value, { max = 120, fallback = 'unknown' } = {}) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || fallback;
}
