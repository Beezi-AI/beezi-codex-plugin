import { fetchCompat } from './fetch-compat.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { coverageFile, BEEZI_ENV } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';

// Coverage reconciliation for Codex history (G-3-3, under the corrections in REVIEW.md §R2).
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// WHY `if (!seen && isImported(ledger, id)) continue` IS UNSAFE — three facts, all load-bearing:
//   1. lib/audit-ledger.mjs records `{at, outcome, reports}` and NOTHING about which lines were
//      delivered, and `runAuditLocked` marks a REJECTED session imported. Ledger membership is
//      evidence about a past request, never proof of coverage.
//   2. Per-session cursors under state/ are pruned at 14 days (`pruneStale` in lib/prune.mjs), so
//      "no cursor" means "old", not "never delivered".
//   3. The server's coverage number is a CONTIGUOUS PARENT-LINE PREFIX, not a maximum:
//      `analytics.repository.ts` stops extending it at the first gap and excludes subagent rows.
//      So `coverage === 0` does NOT mean "nothing is stored" — the headline G-3-3 case (hooks
//      trusted midway through a session) stores lines 200-500 and still answers 0. Replaying from
//      0 re-sends those lines under NEW segment ids and double-counts the spend.
//
// THE REPLAY PROTOCOL: APPEND ONLY, NEVER OVERLAP. A segment id is `${scope}:${fromLine}-${toLine}`
// (`runLockedCheckpoint` in lib/checkpoint.mjs), so a replay partitioned differently from the live
// run produces DIFFERENT ids for the same lines and the server cannot supersede one with the other.
// The only safe replay starts at exactly the confirmed prefix boundary, so its first segment begins
// at prefix+1. Overlap is not reconciled, it is FORBIDDEN: a boundary we cannot prove is deferred
// with a visible status and retried, never downgraded to a scan from zero.
//
// UNAVAILABLE IS NOT ZERO. fetchCoverage returns `null`, never an empty Map, for an old server, a
// transport failure, a non-2xx, an unparseable body, or a 2xx that is not the documented shape.
// Null means "we could not ask" and every session defers; an empty-but-present Map means the server
// answered and holds no prefix. Confusing the two turns one network blip into every linked machine
// re-uploading its whole history at once.
//
// DURABLE STATE: `accounts/<key>/coverage.json` — PER ACCOUNT, because the prefix it records is
// one server's idea of what this machine delivered to THAT tenant, and outside state/ and queue/,
// the only two directories lib/prune.mjs sweeps. It is bound to `{identity, environment,
// apiBase}` and a mismatch DISCARDS the record, which is safe only because this file is a cache of
// a server-derived fact and never the only copy of an analytics payload; that is why the R6
// quarantine rule does not apply to it.

// The batch size Claude's reference client uses against the same route.
export const MAX_COVERAGE_IDS = 200;

// postJson defaults to 3s to protect the 10s hook budget. Coverage is only ever reached from a
// foreground command with no hook budget behind it, and the server answers over a session table.
const COVERAGE_TIMEOUT_MS = 60_000;

const COVERAGE_FILE_VERSION = 1;

export function syncEndpoint() {
  return ENDPOINTS.sessionsSync;
}

// ── The wire ────────────────────────────────────────────────────────────────────────────────

// A stored-line count has to be a whole, non-negative number. `null`/`undefined` for a requested
// id is the server's way of saying "nothing", which is a legitimate answer and reads as 0.
// Anything else — a string, an object, a negative, a float — is a server we do not understand,
// and understanding it wrongly is what produces a duplicate upload. Reported separately so the
// caller can turn the whole run unavailable rather than silently reading garbage as zero.
function readLineCount(value) {
  if (value === null || value === undefined) return { ok: true, lines: 0 };
  if (typeof value !== 'number' || !isFinite(value)) return { ok: false, lines: 0 };
  if (!Number.isInteger(value) || value < 0) return { ok: false, lines: 0 };
  return { ok: true, lines: value };
}

function chunkIds(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Ask the server how far each session already reaches.
 *
 * @returns a `Map<sessionId, storedPrefixLines>` when the whole run was answered, or `null` when
 *          coverage is UNAVAILABLE. An id that was asked about and is absent from a returned Map
 *          is a confirmed zero, not an unknown. A failure in ANY batch makes the whole run null:
 *          availability is a run-level fact, so a caller never has to reason about a half-known
 *          map.
 */
export async function fetchCoverage(sessionIds, session, deps = {}, options = {}) {
  const ids = Array.isArray(sessionIds)
    ? sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  const coverage = new Map();
  if (ids.length === 0) return coverage;

  const postJsonImpl = orDefault(deps.postJsonImpl, postJson);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const timeoutMs = orDefault(options.timeoutMs, COVERAGE_TIMEOUT_MS);
  const url = `${apiBase()}${ENDPOINTS.sessionsCoverage}`;

  for (const batch of chunkIds([...new Set(ids)], MAX_COVERAGE_IDS)) {
    let res;
    try {
      res = await postJsonImpl(url, session, { sessionIds: batch }, { fetchImpl, timeoutMs });
    } catch {
      return null;
    }
    if (!res || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) return null;
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      return null;
    }
    // The documented shape, checked before anything is read out of it. A 2xx from an older build
    // that answers `{}` or `{ok:true}` is an UNAVAILABLE route, not a machine with no history.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const table = parsed.coverage;
    if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
    for (const sessionId of batch) {
      const read = readLineCount(table[sessionId]);
      if (!read.ok) return null;
      if (read.lines > 0) coverage.set(sessionId, read.lines);
    }
  }
  return coverage;
}

// ── Durable coverage checkpoints ────────────────────────────────────────────────────────────

// Named by lib/paths.mjs like every other per-account file — see the DURABLE STATE note above.
export { coverageFile };

// Everything a stored answer is only meaningful under. `apiBase()` asserts the environment first,
// so a variant whose env.json could not be read never reaches a checkpoint file at all.
export function currentBinding(identity) {
  return {
    identity: orDefault(identity, null),
    environment: orDefault(BEEZI_ENV, 'unknown'),
    apiBase: apiBase(),
  };
}

function emptyRecord(binding) {
  return {
    version: COVERAGE_FILE_VERSION,
    identity: orDefault(binding.identity, null),
    environment: orDefault(binding.environment, 'unknown'),
    apiBase: orDefault(binding.apiBase, null),
    sessions: {},
    updatedAt: null,
  };
}

function bindingMatches(record, binding) {
  if (!record || typeof record !== 'object') return false;
  if (record.version !== COVERAGE_FILE_VERSION) return false;
  if (record.identity !== orDefault(binding.identity, null)) return false;
  if (record.environment !== orDefault(binding.environment, 'unknown')) return false;
  if (record.apiBase !== orDefault(binding.apiBase, null)) return false;
  return !!record.sessions && typeof record.sessions === 'object';
}

/**
 * Load this machine's coverage checkpoints for one identity/environment/API binding.
 *
 * A record written under a different machine client id, a different environment, or a different
 * API base is DISCARDED rather than migrated: it describes another server's idea of what landed,
 * and acting on it is how a staging cursor ends up steering a production upload.
 */
export function loadCoverageCheckpoints(key, binding, deps = {}) {
  const read = orDefault(deps.readJsonImpl, readJson);
  let stored = null;
  try {
    stored = read(coverageFile(key), null);
  } catch {
    stored = null;
  }
  if (!bindingMatches(stored, binding)) return emptyRecord(binding);
  return stored;
}

export function saveCoverageCheckpoints(key, record) {
  try {
    writeJsonSecure(coverageFile(key), { ...record, updatedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

// The highest parent line this machine has confirmed delivered for a session, or null when we
// have no confirmation. Never a guess: only a server-accepted upload writes one.
export function checkpointLineFor(record, sessionId) {
  if (!record || !record.sessions) return null;
  const entry = record.sessions[sessionId];
  if (!entry || typeof entry !== 'object') return null;
  if (!Number.isInteger(entry.line) || entry.line < 0) return null;
  return entry.line;
}

// Monotonic by construction: a later run that delivered fewer lines (a scoped or interrupted one)
// must not walk the confirmation backwards.
export function recordCoverageCheckpoint(record, sessionId, line, at) {
  if (!record || !record.sessions) return record;
  if (typeof sessionId !== 'string' || !sessionId) return record;
  if (!Number.isInteger(line) || line < 0) return record;
  const previous = checkpointLineFor(record, sessionId);
  if (previous !== null && previous >= line) return record;
  record.sessions[sessionId] = {
    line,
    at: orDefault(at, new Date().toISOString()),
    source: 'delivered',
  };
  return record;
}

// ── The eligibility decision ────────────────────────────────────────────────────────────────

export const ReplayDecision = Object.freeze({
  REPLAY: 'replay',
  DEFER: 'defer',
});

export const DeferReason = Object.freeze({
  // We could not ask the server. Retry later; NEVER downgrade this to a scan from zero.
  UNAVAILABLE: 'coverage-unavailable',
  // The server answered, and its answer contradicts what this machine believes it delivered. The
  // stored data is therefore not a clean prefix, so no start line can be proven not to overlap.
  GAP: 'coverage-gap',
  // The engine handed back segments below the boundary we asked it to start at. Belt and braces
  // against a runCheckpoint that does not honour startCursor; see the note in lib/session-audit.
  OVERLAP: 'overlap',
});

/**
 * Choose a replay start line for one session, or refuse to choose one.
 *
 * @param coverage       the Map from fetchCoverage, or null when coverage is unavailable.
 * @param checkpointLine our own durable confirmation, or null.
 * @param localCursor    the persisted per-session cursor (0 when absent or pruned).
 * @param ledgerDelivered true when the ledger records a DELIVERED outcome (accepted/partial) for
 *                        this session. A REJECTED ledger entry is not delivery and must be passed
 *                        as false — that is what lets a once-unconnected repository replay in full
 *                        the moment it is connected.
 */
export function decideReplay(sessionId, facts = {}) {
  const coverage = orDefault(facts.coverage, null);
  const checkpointLine = orDefault(facts.checkpointLine, null);
  const localCursor = Number.isInteger(facts.localCursor) && facts.localCursor > 0 ? facts.localCursor : 0;
  const ledgerDelivered = facts.ledgerDelivered === true;

  if (coverage === null) {
    return { decision: ReplayDecision.DEFER, reason: DeferReason.UNAVAILABLE, startCursor: null };
  }

  const stored = coverage.has(sessionId) ? coverage.get(sessionId) : 0;

  if (stored > 0) {
    // Our own confirmation runs ahead of the server's prefix: something we delivered is stored
    // beyond a gap, so lines above `stored` are NOT all free. Nothing here can prove a boundary.
    if (checkpointLine !== null && stored < checkpointLine) {
      return { decision: ReplayDecision.DEFER, reason: DeferReason.GAP, startCursor: null, stored };
    }
    return { decision: ReplayDecision.REPLAY, reason: null, startCursor: stored, stored };
  }

  // stored === 0. This is the ambiguous case R2 is about: it is the clean "never delivered"
  // answer AND the answer for a session whose stored rows all sit past a gap. Three independent
  // pieces of evidence say the second reading applies; any one of them defers.
  if (checkpointLine !== null && checkpointLine > 0) {
    return { decision: ReplayDecision.DEFER, reason: DeferReason.GAP, startCursor: null, stored };
  }
  if (localCursor > 0) {
    return { decision: ReplayDecision.DEFER, reason: DeferReason.GAP, startCursor: null, stored };
  }
  if (ledgerDelivered) {
    return { decision: ReplayDecision.DEFER, reason: DeferReason.GAP, startCursor: null, stored };
  }
  // Nothing stored, nothing confirmed, no local progress, nothing delivered: the untrusted-hooks
  // case this gap exists for. A full replay from line 0 overlaps nothing.
  return { decision: ReplayDecision.REPLAY, reason: null, startCursor: 0, stored };
}

// ── The child repair policy ─────────────────────────────────────────────────────────────────
//
// STATED SEPARATELY FROM PARENT COVERAGE ON PURPOSE. The coverage query excludes agent_id /
// is_subagent rows (`analytics.repository.ts` in the hb-ai-agent-portal repo), and a subagent's
// segments are scoped `${sessionId}:${agentId}` over its OWN rollout's line space — an unrelated
// coordinate system from the parent's. So a parent prefix of N says exactly nothing about which
// children landed, and there is no server answer that could be asked for them.
//
// No parent boundary authorizes replay of children. Historical child repair remains deferred
// until agent-scoped coverage is available. Live capture keeps its durable child cursors.
export function childSweepAllowed(startCursor) {
  // Parent coverage never establishes child coverage, including a zero parent prefix.
  return false;
}
