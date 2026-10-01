import { auditLedgerFile } from './paths.mjs';
import { BackfillSessionStatus } from './audit-flush.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

const LEDGER_VERSION = 1;

// How long one ledger save may hold its lock. The section is a read, a merge over two small maps
// and one atomic write — never the caller's scan, which can run for minutes and must not be inside
// anybody's critical section.
const LEDGER_LOCK_LEASE_MS = 5_000;

// Which past sessions the history backfill (the last step of the Beezi login skill) has already
// handed to the server, and what the server said.
//
// This has to be durable in a way ~/.beezi-codex/state/<id>.json is not: pruneStale() deletes
// anything in state/ and queue/ older than 14 days, so a marker there expires and every old
// session looks importable again on the next run. auditLedgerFile(key) sits in the account
// directory, outside the dirs pruneStale walks.
//
// The ledger belongs to ONE ACCOUNT, and the server's pull record is per (tenant, user, tool), so
// it binds to the login that wrote it as well: a ledger recorded under another identity is
// discarded, or a logout→login into a different workspace would replay it, find zero candidates,
// and seal the new tenant's pull EMPTY (there is no reopen).
export function loadLedger(key, identity = null) {
  const raw = readJson(auditLedgerFile(key), null);
  // A ledger from a future/foreign shape is discarded rather than merged: re-sending is
  // idempotent server-side, whereas trusting an unknown shape is not.
  if (!raw || raw.version !== LEDGER_VERSION || typeof raw.sessions !== 'object' || raw.sessions === null) {
    return emptyLedger(identity);
  }
  // Only `raw.identity` has to be truthy. Requiring `identity` too meant a null one SKIPPED the
  // check rather than failing it: runAuditLocked in session-audit.mjs reads getMachineClientId() on
  // the assumption that a login primed it, and when nothing did (no credentials, an injected
  // getAccessToken, or a credentials file with no client_id) the previous login's ledger was merged
  // and its imported-session set trusted under the current one — sealing the new tenant's pull
  // empty, with no reopen. An unidentified caller now re-offers every session instead, which is the
  // safe direction: emptyLedger sets complete:false and re-sending is idempotent server-side.
  if (raw.identity && raw.identity !== identity) {
    return emptyLedger(identity);
  }
  if (!raw.identity && identity) raw.identity = identity;
  // Added after v1 shipped, so a ledger written before it has no such key. Normalised here rather
  // than guarded at every use site.
  if (!raw.unreadable || typeof raw.unreadable !== 'object') raw.unreadable = {};
  return raw;
}

function emptyLedger(identity) {
  return {
    version: LEDGER_VERSION,
    identity: orDefault(identity, null),
    sessions: {},
    unreadable: {},
    complete: false,
    updatedAt: null,
  };
}

// The pull was sealed server-side (we finalized it, or a chunk answered ALREADY_COMPLETED).
export function markComplete(ledger, { at = new Date() } = {}) {
  ledger.complete = true;
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function isComplete(ledger) {
  return (ledger || {}).complete === true;
}

// Rejected sessions count as imported. A repository that was never connected to Beezi rejects
// every one of its reports and always will, so resending it each run is pure waste; --force is the
// escape hatch when the repo has since been connected.
export function isImported(ledger, sessionId) {
  return Object.prototype.hasOwnProperty.call((ledger && ledger.sessions) || {}, sessionId);
}

// The ledger's outcome for a session, as EVIDENCE rather than as a verdict. R2's whole point is
// that ledger membership does not prove coverage — but a recorded ACCEPTED/PARTIAL delivery does
// contradict a coverage answer of "nothing stored", and that contradiction is what tells a
// mid-session gap apart from a session that never landed. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// A REJECTED entry is deliberately NOT delivery: a repository that was never connected to Beezi
// rejects every report it sends, and must replay IN FULL the moment it is connected (R2). That is
// the opposite of isImported() above, which counts REJECTED as imported so a run does not resend
// it — two different questions about the same row, which is why both live here rather than being
// re-derived at a call site. lib/session-audit.mjs and lib/rollout-watcher.mjs each once carried
// their own private copy; this is the one.
export function ledgerDelivered(ledger, sessionId) {
  const sessions = (ledger || {}).sessions;
  if (!sessions || typeof sessions !== 'object') return false;
  const entry = sessions[sessionId];
  if (!entry || typeof entry !== 'object') return false;
  return entry.outcome === BackfillSessionStatus.ACCEPTED || entry.outcome === BackfillSessionStatus.PARTIAL;
}

export function markImported(ledger, sessionId, { outcome, reports = 0, at = new Date() } = {}) {
  ledger.sessions[sessionId] = { at: at.toISOString(), outcome, reports };
  // A session that read fine this time is not unreadable any more; leaving the marker would make
  // wasUnreadable() answer yes forever for a session that has since imported.
  if (ledger.unreadable) delete ledger.unreadable[sessionId];
  ledger.updatedAt = at.toISOString();
  return ledger;
}

// A transcript that could not be read. Deliberately NOT in `sessions`: the session stays eligible,
// so the next run parses it again. It only records that we already gave it one chance, which is
// what lets the pull seal on the second attempt instead of blocking forever on a file that fails
// deterministically (a permission error reads exactly like a transient one).
export function markUnreadable(ledger, sessionId, { at = new Date() } = {}) {
  ledger.unreadable[sessionId] = { at: at.toISOString() };
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function wasUnreadable(ledger, sessionId) {
  return Object.prototype.hasOwnProperty.call((ledger && ledger.unreadable) || {}, sessionId);
}

// The on-disk record, or null when there is nothing mergeable there. Same shape gate as
// loadLedger, minus the identity substitution — a merge must see the identity exactly as written.
function readLedgerRaw(key) {
  const raw = readJson(auditLedgerFile(key), null);
  if (!raw || raw.version !== LEDGER_VERSION) return null;
  if (typeof raw.sessions !== 'object' || raw.sessions === null) return null;
  return raw;
}

function laterOf(a, b) {
  if (!a) return orDefault(b, null);
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

// Fold whatever is on disk into `ledger`. Both sides are the same shape and describe the same
// question — which sessions the pull has already handed over — so every field has an answer that
// cannot lose information:
//
//   identity  a truthy on-disk identity that DIFFERS from ours belongs to another login. It is
//             discarded whole rather than merged, exactly as loadLedger discards it: merging across
//             identities is what would replay one tenant's imported set under another and seal the
//             new tenant's one-time pull empty, with no reopen.
//   sessions  union; ours wins a collision, because a markImported we are holding is newer than
//             the row that was on disk when we loaded.
//   unreadable  union, then MINUS every key present in the merged sessions — markImported's own
//             invariant. A naive union would resurrect an `unreadable` marker for a session that
//             has since imported, and wasUnreadable() would answer yes forever.
//   complete  logical OR. The seal is one-time and irreversible; a save must never un-seal one.
//   updatedAt the later of the two.
function mergeLedger(ledger, disk) {
  if (!disk) return ledger;
  // Byte-for-byte the rule loadLedger:34 applies, including the null case: an UNIDENTIFIED caller
  // must not adopt an identified ledger either, or a logout→login into another workspace would
  // merge the previous tenant's imported set under the new one.
  if (disk.identity && disk.identity !== orDefault(ledger.identity, null)) return ledger;

  const sessions = { ...disk.sessions, ...ledger.sessions };
  const diskUnreadable = disk.unreadable && typeof disk.unreadable === 'object' ? disk.unreadable : {};
  const mineUnreadable = ledger.unreadable && typeof ledger.unreadable === 'object' ? ledger.unreadable : {};
  const unreadable = { ...diskUnreadable, ...mineUnreadable };
  for (const id of Object.keys(unreadable)) {
    if (Object.prototype.hasOwnProperty.call(sessions, id)) delete unreadable[id];
  }

  ledger.sessions = sessions;
  ledger.unreadable = unreadable;
  ledger.complete = ledger.complete === true || disk.complete === true;
  ledger.updatedAt = laterOf(ledger.updatedAt, disk.updatedAt);
  return ledger;
}

// 0600 — the ledger records which projects the user worked on, by session id only, but the file
// lives alongside credentials.json and follows the same rule.
//
// ONE rank-3 `shared:audit-ledger-<key>` lock around a re-read, a merge and the write (G-8-3 / R3)
// — the name carries the key, so two accounts' ledgers never serialise against each other across
// processes. Within one process they must still be saved SERIALLY: two rank-3 locks under
// different names at once is refused as 'lock-order'. Every fan-out caller loops accounts in turn.
//
// the last-writer-wins hazard G-8-3 opens with. writeJsonSecure already makes each write atomic,
// so the file is never TORN; what it is not is safe against two backfill runs that each loaded the
// ledger minutes ago and now save their own in-memory copy over the top. Run A's markImported
// entries vanish, already-uploaded sessions look importable again, and in the worst case both runs
// reach finalize() and both POST /sessions/backfill/complete — sealing a one-time pull that has no
// reopen while the other run still holds unledgered candidates.
//
// The re-read is what closes it, and it has to be INSIDE the lock or it is the same race one step
// smaller. The lock deliberately does NOT span the caller's `loadLedger` at the top of its run:
// that span is a full scan of ~/.codex/sessions, minutes long, and holding a rank-3 lock across it
// would block every hook on the machine — and would be refused outright the moment the scan's own
// per-session checkpoint reached for its rank-2 session lock.
//
// The merged result is written back into `ledger`, so the caller's in-memory copy stops being the
// stale one and its later `isImported` checks see the other run's rows too.
export function saveLedger(key, ledger) {
  const run = withLock(
    sharedLock(`audit-ledger-${key}`),
    { leaseMs: LEDGER_LOCK_LEASE_MS },
    () => writeJsonSecure(auditLedgerFile(key), mergeLedger(ledger, readLedgerRaw(key))),
  );
  // 'held'/'contended' is another run mid-save; this one's rows are still in memory and its next
  // save (there is always one — the caller saves per chunk and again at finalize) carries them.
  // 'lock-order' is a caller bug that will fail identically forever, so it is reported, not folded
  // into the same "we'll get it next time" bucket.
  return run.ok
    ? { written: true, skipped: false, reason: null }
    : { written: false, skipped: true, reason: run.reason };
}
