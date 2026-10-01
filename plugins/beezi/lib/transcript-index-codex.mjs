import fs from 'fs';
import path from 'path';
import { codexSessionsDir } from './paths.mjs';
import { isUsableSessionId, listRolloutFiles, ROLLOUT_HEAD_BYTES } from './transcript-codex.mjs';
import { readRolloutHead, subagentIdentityFrom } from './subagent-codex.mjs';
import { orDefault } from './compat.mjs';

// Enumerate every past TOP-LEVEL Codex session on this machine for the history backfill.
//
// Codex writes subagent rollouts as their own top-level files in the same date tree
// (`thread_source: "subagent"` in their session_meta), so a bare walk would surface each agent
// as a session of its own — and the parent's checkpoint sweep would then bill it a second time.
// The discriminator here is subagentIdentityFrom() on the first record: EXACTLY the check
// findSubagentRollouts trusts when claiming children, so parent and child classification can
// never disagree.
//
// The same single-record head read also yields the session id and launch cwd, so the audit
// never has to re-open the file for either.
//
// Everything is best-effort: an unreadable tree yields [], an unreadable entry is skipped —
// discovery must never break the backfill.

// rollout-<ISO-with-dashes>-<uuid>.jsonl — the session id is the trailing UUID (its internal
// dashes make a greedy suffix capture wrong). Same regex as resolveTranscriptByCwd.
const TRAILING_UUID_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// List every importable top-level session, oldest-first so an interrupted import advances
// chronologically. Returns [{ sessionId, transcriptPath, cwd, mtimeMs, size }].
export function listAllRollouts({ sessionsDir = null } = {}) {
  const root = sessionsDir === undefined || sessionsDir === null ? codexSessionsDir() : sessionsDir;
  const bySession = new Map();

  for (const full of listRolloutFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // One record is enough for all three answers: is it a subagent, what session is it, where
    // was it launched. ROLLOUT_HEAD_BYTES is the shared one-record window.
    const [first] = readRolloutHead(full, { maxBytes: ROLLOUT_HEAD_BYTES, maxRecords: 1 });
    if (!first) continue;
    if (subagentIdentityFrom([first])) continue;

    const meta = first.type === 'session_meta' ? first.payload : null;
    // `id`, never `session_id`: on a subagent rollout the latter holds the PARENT's thread id
    // (`subagentIdentityFrom` in lib/subagent-codex.mjs), and this entry names THIS file.
    //
    // Both sources are validated rather than merely non-empty. An id that is one of the strings
    // JavaScript makes from a missing value — `null`, `undefined` — is not a session: keyed on it,
    // every id-less rollout would import as one shared phantom session and accrete unrelated
    // segments. Skipping costs one unimportable file; accepting corrupts an account's numbers.
    const metaId = str((meta || {}).id);
    const nameId = orDefault((TRAILING_UUID_RE.exec(path.basename(full)) || [])[1], null);
    const sessionId = isUsableSessionId(metaId)
      ? metaId
      : (isUsableSessionId(nameId) ? nameId : null);
    if (!sessionId) continue;

    const entry = {
      sessionId,
      transcriptPath: full,
      cwd: str((meta || {}).cwd),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };

    // Codex resume can leave two rollouts carrying the same trailing session id. The ledger
    // dedupes only across runs, so without collapsing here one session would be parsed — and
    // billed — twice in a single run. Keep the newest file: a resumed rollout replays the
    // original's records, so it supersedes the older one.
    const existing = bySession.get(sessionId);
    if (!existing || entry.mtimeMs > existing.mtimeMs) bySession.set(sessionId, entry);
  }

  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}
