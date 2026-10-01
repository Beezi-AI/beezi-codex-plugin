import { fetchCompat } from './fetch-compat.mjs';
import { apiBase } from './config.mjs';
import { postJson as _postJson } from './http.mjs';
import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { linkedSessions as _linkedSessions, getDefaultKey as _getDefaultKey } from './accounts.mjs';
import { runCheckpoint as _runCheckpoint, flushQueue as _flushQueue } from './checkpoint.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { buildAccountSyncPayload, accountSyncPath } from './account-sync.mjs';
import { listAllRollouts as _listAllRollouts } from './transcript-index-codex.mjs';
import { acquireLock as _acquireLock, runLock, locksDir, inspectLock } from './single-instance-lock.mjs';
import {
  fetchCoverage as _fetchCoverage,
  loadCoverageCheckpoints as _loadCoverageCheckpoints,
  saveCoverageCheckpoints as _saveCoverageCheckpoints,
  recordCoverageCheckpoint,
  checkpointLineFor,
  currentBinding,
  decideReplay,
  childSweepAllowed,
  syncEndpoint,
  ReplayDecision,
  DeferReason,
} from './session-coverage.mjs';
import {
  loadLedger as _loadLedger,
  saveLedger as _saveLedger,
  isImported,
  markImported,
  markUnreadable,
  wasUnreadable,
  markComplete,
  isComplete,
  ledgerDelivered,
} from './audit-ledger.mjs';
import {
  flushBackfillChunks as _flushBackfillChunks,
  completeBackfill as _completeBackfill,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from './audit-flush.mjs';
import { computeSessionTimeline as _computeSessionTimeline } from './session-timeline-codex.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { resolveTranscriptByCwd } from './transcript-codex.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { credentialsFile, stateDir, beeziCodexHome } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import {
  readTrackingState,
  matchesIdentity,
  isLiveTrackingAllowed,
  markBackfillCompleted,
  recordWhoami,
  linkedAtMs as _linkedAtMs,
  TrackingMode,
} from './tracking.mjs';
import { UserError } from './friendly-error.mjs';
import { orDefault } from './compat.mjs';

// A rollout this big is read several times over (segments, timeline, head reads) and would put
// the process into the hundreds of MB. Report it rather than let node die mid-run.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// Error posts are single small upserts, so a little parallelism is free — but not unbounded,
// or a 200-session run opens 200 sockets at once.
const FOLLOWUP_CONCURRENCY = 4;

const AUDIT_TIMEOUT_MS = 60_000;

// A rollout touched this recently is probably an OPEN session in another window: its hooks are
// mid-flight between checkpoints, and backfilling it would re-segment the same lines on different
// boundaries than the next live report — double-counted spend. Skip and let the user rerun.
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

// How far back either history path will reach. A rollout older than this is never uploaded, in
// EITHER mode — the one-time import and the repair pass share the window so a session cannot be
// in scope for one command and out of scope for the other.
//
// This is deliberately NOT expressed as a default `--since`: `shouldFinalize` treats a non-null
// `sinceMs` as a scoped run and refuses to seal, so defaulting it would leave every login's pull
// permanently unfinalized. It is policy, applied in the candidate loop, and it stacks with an
// explicit `--since` rather than replacing it (two independent skips give `max(sinceMs, cutoff)`).
export const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// The repeatable repair pass (G-3-3). Everything that differs from the one-time import hangs off
// this one value: it never seals, it consults /sessions/coverage instead of local cursors, it
// drains the durable queue first, and it flushes to the tracking-policy-aware sync route.
export const SYNC_MODE = 'sync';

/**
 * What `reason: 'no-token'` means when the run was scoped to ONE account, and the one phrasing of
 * it — scripts/sync.mjs and scripts/backfill.mjs both print it, and a second spelling would leave
 * the sync skill relaying a sentence one of them no longer says.
 *
 * It is NOT "this machine is not linked", which is what both scripts used to print here. With a key
 * in hand the caller has already resolved it against the index (resolveAccountRef, or sync's own
 * filter over the linked rows), so the account EXISTS — auditSession returned null because
 * linkedSessions() could not produce a token for it. On a machine with a second account linked and
 * working, "not linked" is simply false, and it sends the user to link a machine that is linked.
 */
export const ACCOUNT_TOKEN_UNUSABLE =
  'Beezi: could not use the saved credentials for that account. Sign in to Beezi again as it (the login skill).';

// ONE run lock for BOTH modes, deliberately sharing a name: an import and a repair pass replaying
// the same machine's rollouts at the same time would hand the server two differently-partitioned
// copies of the same lines. R3 puts the backfill's one-time seal under a run lock; the repair pass
// has no seal but the same overlap hazard, so it takes the same lock. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
export const HISTORY_RUN_LOCK = 'backfill';

// Rank 1 (run). NOT a session lock: session locks are rank 2 and the checkpoint transaction takes
// its own, so taking one here would be an equal-rank nesting and the lock module would refuse it
// as 'lock-order' — a caller bug, not a busy lock.
//
// DEFAULT_LEASE_MS is 30s, which is shorter than one chunk's AUDIT_TIMEOUT_MS. Per-batch renewal
// cannot rescue a lease that expires mid-request, so the lease is set above the slowest single
// step this run can take and renewed on top of that.
export const RUN_LEASE_MS = 10 * 60 * 1000;

// Same shape as lib/billing-capture.mjs: a plain loop, `argv[++i]` for valued flags, UserError for
// anything malformed so the script surfaces it verbatim.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--force') out.force = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--since') out.since = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
  }
  if (out.since != null) {
    const since = String(out.since);
    if (!SINCE_FORMAT.test(since) || Number.isNaN(Date.parse(since))) {
      throw new UserError('Beezi: --since expects a date like 2026-01-31.');
    }
    out.sinceMs = Date.parse(since);
  }
  return out;
}

// The session this command is running inside. It is already tracked, and its hooks own
// ~/.beezi-codex/state/<id>.json concurrently — auditing it would race them over the cursor.
// Codex sets no session-id env var, so the cwd mapping is the only handle; the sessionId can be
// null when neither the rollout's session_meta nor the filename regex could name it, which is why
// the transcript path is matched too.
//
// That null tolerance is load-bearing and must not be "fixed" by making the resolver reject: this
// caller matches on the PATH, and a resolver that returned null for a locatable-but-unnameable
// transcript would stop the backfill excluding the live session — re-segmenting a transcript the
// live hooks are already reporting, on different boundaries, and double-counting the spend. The
// strict id check belongs at the writing entry point instead (lib/track-session.mjs
// resolveTrackTarget). test/session-audit.test.mjs case 7 pins the tolerance.
function liveSession(deps) {
  try {
    const resolve = orDefault(deps.resolveTranscriptByCwdImpl, resolveTranscriptByCwd);
    return orDefault(resolve(process.cwd()), null);
  } catch {
    return null;
  }
}

// When live tracking is on, everything after the machine link was (or will be) tracked live —
// re-sending it through the audit would re-segment the same transcript lines on different
// boundaries once the per-session cursor has been pruned, and double-count the spend.
//
// The link instant comes from tracking.json, stamped by login. The credentials file's mtime stays
// as the fallback for links made before the stamp existed — but it is only written by the
// plaintext fallback store, so on a keyring machine (CredMan, Keychain, secret-tool) it does not
// exist and this returns null; the per-session cursor check in runAudit covers that hole.
function linkedAtMs(key, deps) {
  const stamped = _linkedAtMs(key, deps);
  if (stamped != null) return stamped;
  const statImpl = orDefault(deps.statImpl, (p) => fs.statSync(p));
  try {
    return orDefault(statImpl(credentialsFile(key)).mtimeMs, null);
  } catch {
    return null;
  }
}

/**
 * Which linked account this run uploads to.
 *
 * `options.key` names one explicitly — that is where the `--account` flag lands when Task 10 wires
 * it up. With no key the DEFAULT account is used, falling back to the only linked one, so the
 * existing scripts keep working unchanged on a single-account machine.
 *
 * One account per run, deliberately: the scan parses every rollout on the machine, and running it
 * once per linked workspace would re-parse them all N times inside one command. A caller that
 * wants every account uploads to each in turn.
 */
async function auditSession(deps, options) {
  const listSessions = orDefault(deps.linkedSessions, _linkedSessions);
  let sessions;
  try { sessions = await listSessions(deps); } catch { return null; }
  if (!sessions || sessions.length === 0) return null;
  if (options.key != null) {
    return orDefault(sessions.find((s) => s.key === options.key), null);
  }
  const getDefaultKey = orDefault(deps.getDefaultKey, _getDefaultKey);
  let def = null;
  try { def = await getDefaultKey(deps); } catch { def = null; }
  const chosen = def === null ? undefined : sessions.find((s) => s.key === def);
  return orDefault(chosen, sessions[0]);
}

// A persisted state cursor > 0 is direct evidence the live hooks already reported this session.
// Only trustworthy on a LIVE-mode tenant: under dark mode the hooks advanced cursors while the
// server 403-dropped every report, so there the cursor means the opposite — never delivered.
function liveCursorOf(sessionId, deps) {
  const read = orDefault(deps.readStateImpl, (id) => readJson(path.join(stateDir(), `${id}.json`), null));
  const state = read(sessionId);
  return Number.isInteger((state || {}).cursor) && state.cursor > 0 ? state.cursor : 0;
}

// Run `worker` over `items` with at most `limit` in flight.
async function mapLimited(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Seal only when a re-run could not improve the outcome, and only when the run covered
// everything: any retryable failure, unattributable chunk, whole-chunk rejection, halt or scope
// flag leaves the pull open. Per-item errors[] (unconnected repos on platform tenants) and
// oversize/unreadable transcripts deliberately do NOT block — a re-run cannot help them, and
// blocking would deadlock the seal forever.
export function shouldFinalize(result, options = {}) {
  if (!result.ok) return false;
  // The repair pass NEVER seals, in either direction. Sealing the one-time pull from the command a
  // user runs to repair history would lock them out of the very command they just ran, and R2
  // forbids a historical replay from sealing or reopening the one-time backfill at all.
  if (options.mode === SYNC_MODE) return false;
  if (options.dryRun === true) return false;
  if (options.sinceMs != null) return false;
  if (result.halt !== null) return false;
  if (result.reportsFailed > 0) return false;
  if (result.unattributed > 0) return false;
  if (result.permanentRejections > 0) return false;
  // A transcript we could not read is a retryable failure like any other, and sealing over it
  // loses that session for good — the seal is one-time per account and tool, and --force skips
  // only the LOCAL caches, never the server's verdict. So the first failure holds the pull open.
  //
  // Only the FIRST failure, though: a permission error is indistinguishable from transient I/O at
  // the call site, so gating on every occurrence would let one permanently unreadable file block
  // the seal forever and tell the user to re-run login on a loop.
  //
  // `empty` and `noRemote` never block: the first has nothing to upload, and the second can never
  // succeed (a rollout with no recorded cwd will have none on the next run either).
  if (result.retriableUnreadable > 0) return false;
  return true;
}

// Backfill every past Codex session on this machine into Beezi via the chunked backfill route,
// then seal the one-time pull. Timelines ride IN the chunk payload (the tracking-gated standalone
// timeline route is unreachable for audit tenants); only rate-limit error reports remain a
// live-only follow-up — and only for sessions the server judged accepted, so a failed session
// stays fully retryable.
//
// ONE ACCOUNT per run, named by `options.key` and defaulting to the default account — see
// auditSession. It travels in `options` beside `mode`, `force` and `since` rather than as a
// positional argument because it is the same kind of thing they are: a caller-driven choice,
// parsed off argv, not a seam.
export async function runAudit(deps = {}, options = {}) {
  const acquire = orDefault(deps.acquireLockImpl, _acquireLock);
  let lock;
  try {
    lock = acquire(runLock(HISTORY_RUN_LOCK), { leaseMs: RUN_LEASE_MS });
  } catch (error) {
    const failed = emptyAuditResult(options);
    failed.reason = 'lock-failed';
    failed.lastError = orDefault((error || {}).message, 'could not take the history run lock');
    return failed;
  }
  if (!lock.ok) {
    const refused = emptyAuditResult(options);
    // 'lock-order' is NOT a busy lock. The lock module's header is explicit: it is a defect in this
    // process's own acquisition sequence and retrying it will fail forever, so it is surfaced as an
    // error. 'held' and 'contended' are transient and mean a real concurrent run — a benign skip.
    if (lock.reason === 'lock-order') {
      refused.reason = 'lock-order';
      refused.lastError = orDefault(lock.detail, 'lock order violated');
      return refused;
    }
    refused.ok = true;
    refused.reason = 'run-in-progress';
    return refused;
  }
  try {
    // The run gate excludes new checkpoints. Existing session holders must finish first.
    let names;
    try { names = fs.readdirSync(locksDir()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    for (const name of names.filter(n => n.startsWith('session-') && n.endsWith('.lock'))) {
      const seen = inspectLock({ name, kind: 'session', file: path.join(locksDir(), name) });
      if (seen.held && !seen.takeoverReady) return { ...emptyAuditResult(options), ok: true, reason: 'active-writer' };
    }
    return await runAuditLocked(lock.handle, deps, options);
  } finally {
    // The release verdict is not swallowed silently by accident: a 'lost' release means the run
    // executed while another party owned the lock, and the seal path already re-checks ownership
    // with verify() before committing anything irreversible.
    try { lock.handle.release(); } catch { /* best-effort */ }
  }
}

// Every field runAudit can report, in one place, so the lock-refusal paths above and the run
// itself cannot drift apart on shape.
function emptyAuditResult(options = {}) {
  return {
    ok: false,
    reason: null,
    // 'backfill' (the one-time import) or 'sync' (the repeatable repair pass).
    mode: options.mode === SYNC_MODE ? SYNC_MODE : 'backfill',
    halt: null,
    scanned: 0,
    live: 0,
    active: 0,
    liveTracked: 0,
    alreadyImported: 0,
    oversize: 0,
    candidates: 0,
    plannedChunks: 0,
    // Reports built and handed to the flush — in a dry run, what WOULD have been sent. Counted in
    // both modes so "stored" has something to be compared against: without it a server that
    // quietly stores fewer than it was sent is undetectable.
    plannedReports: 0,
    sessionsImported: 0,
    // Candidates that produced no report, split by cause — every one of these used to vanish
    // between `candidates` and `sessionsImported` with nothing printed, which is why the totals
    // never added up. `empty` is the benign one: the transcript genuinely carries no usage.
    empty: 0,
    noRemote: 0,
    emitFailed: 0,
    // A transcript we could not read, whether the throw escaped runCheckpoint or was caught
    // inside it — the user-visible fact is the same, so it is one number.
    unreadable: 0,
    // Unreadable sessions this run is willing to hold the pull open for: the ones we had not
    // already tried. A file that fails on the retry too is deterministic (a permission error is
    // indistinguishable from a transient one at the call site), and blocking on it forever would
    // trade the old silent-loss bug for a pull that can never seal.
    retriableUnreadable: 0,
    // Sessions, not reports: reportsRejected counts reports and was never printed at all.
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    itemErrors: 0,
    reportsRejected: 0,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
    finalized: false,
    // Set when the server said the pull is sealed AND the workspace has no live tracking — the
    // audit window is the only reason to run again, so the summary points at an upgrade.
    upgradeAdvised: false,
    followupsAllowed: true,
    timelines: 0,
    // Client-side twin of `timelines` (which is purely the server's number), so a gap between
    // what we sent and what landed is attributable instead of a bare unexplained difference.
    timelinesOffered: 0,
    timelinesDropped: 0,
    sessionErrors: 0,
    // ── Sync-mode reconciliation (G-3-3) ──────────────────────────────────────────────────────
    // TRI-STATE, and the distinction is the whole point: `true` = the server answered, `false` =
    // we could not ask (so nothing was replayed and nothing is missing), `null` = coverage was
    // never consulted because this was not a sync run. "Could not ask" must never read as
    // "nothing to do".
    coverageKnown: null,
    // Queued reports delivered before reconciliation, so the coverage answer reflects them.
    pendingDrained: 0,
    // Sessions whose history this run deliberately did not touch because it could not prove a
    // non-overlapping start line. Visible, retryable, and never silently downgraded to a scan
    // from zero.
    // Rollouts older than MAX_SESSION_AGE_MS. Never uploaded, never retried by a re-run.
    tooOld: 0,
    deferred: 0,
    deferredUnavailable: 0,
    deferredGap: 0,
    deferredOverlap: 0,
    // Sessions replayed from above line 0, whose subagent segments were therefore NOT swept.
    // See the child repair policy in lib/session-coverage.mjs.
    childrenDeferred: 0,
    lastError: null,
  };
}

async function runAuditLocked(lockHandle, deps = {}, options = {}) {
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  const listRollouts = orDefault(deps.listRollouts, _listAllRollouts);
  const runCheckpoint = orDefault(deps.runCheckpointImpl, _runCheckpoint);
  const flushBackfillChunks = orDefault(deps.flushBackfillChunksImpl, _flushBackfillChunks);
  const completeBackfill = orDefault(deps.completeBackfillImpl, _completeBackfill);
  const loadLedger = orDefault(deps.loadLedgerImpl, _loadLedger);
  const saveLedger = orDefault(deps.saveLedgerImpl, _saveLedger);
  const computeSessionTimeline = orDefault(deps.computeSessionTimelineImpl, _computeSessionTimeline);
  const postSessionError = orDefault(deps.postSessionErrorImpl, _postSessionError);
  const readTracking = orDefault(deps.readTrackingStateImpl, readTrackingState);
  const markCompleted = orDefault(deps.markBackfillCompletedImpl, markBackfillCompleted);
  const whoamiImpl = orDefault(deps.whoamiImpl, _whoami);
  const recordWhoamiImpl = orDefault(deps.recordWhoamiImpl, recordWhoami);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const onProgress = orDefault(deps.onProgress, () => {});
  const now = orDefault(deps.now, () => Date.now());
  const fetchCoverage = orDefault(deps.fetchCoverageImpl, _fetchCoverage);
  const loadCoverage = orDefault(deps.loadCoverageCheckpointsImpl, _loadCoverageCheckpoints);
  const saveCoverage = orDefault(deps.saveCoverageCheckpointsImpl, _saveCoverageCheckpoints);
  const flushQueue = orDefault(deps.flushQueueImpl, _flushQueue);
  const postJson = orDefault(deps.postJsonImpl, _postJson);
  const readChatgptAuth = orDefault(deps.readChatgptAuthImpl, _readChatgptAuth);
  const readBillingConfig = orDefault(deps.readBillingConfigImpl, _readBillingConfig);

  const syncMode = options.mode === SYNC_MODE;
  const result = emptyAuditResult(options);

  let session = await auditSession(deps, options);
  if (!session) {
    result.reason = 'no-token';
    return result;
  }
  const key = session.key;

  // The binding key for the ledger and the tracking cache. It used to be a process-global primed
  // by getAccessToken; that global is gone, because with several accounts linked it would bind one
  // account's ledger under another's id. It is this account's own client id, carried on the
  // session the token resolution produced.
  //
  // It can still be NULL — lib/accounts.mjs's sessionFor falls back to the stored row, and a row
  // migrated from a pre-0.13 install whose credential blob carried no client_id has none. A null
  // identity makes matchesIdentity fail open, which is the posture the whole tracking cache takes:
  // the server's guard is the boundary, and a ledger read under an unknown identity re-offers
  // every session rather than trusting one (lib/audit-ledger.mjs loadLedger).
  const identity = orDefault(session.clientId, null);
  const tracking = readTracking(key, deps);
  const trackingValid = matchesIdentity(key, identity, deps);

  // The repair pass rides the tracking-policy-aware sync route and must NOT be a way around an
  // audit-only tenant's restrictions. Checked locally first so the run refuses cleanly instead of
  // taking one 403 per chunk; a server that refuses anyway still halts on FORBIDDEN below.
  if (syncMode && trackingValid && !isLiveTrackingAllowed(key, deps)) {
    result.ok = true;
    result.reason = 'audit-only';
    result.upgradeAdvised = true;
    return result;
  }

  // ── Drain durable pending reports BEFORE reconciliation (R2) ──────────────────────────────
  // Anything sitting in queue/ is history this machine already built and the server has not seen.
  // Asking for coverage over it would get an answer that is stale by exactly those segments, and
  // replaying against that answer is how a narrow live segment and a wide replayed one end up
  // stored side by side. Drain first, then ask.
  //
  // A drain that does not finish stops the run: undelivered reports mean coverage cannot be
  // trusted, and this is a deferral, not a failure — the files stay on disk and the next run
  // retries them.
  if (syncMode) {
    try {
      if (fs.readdirSync(path.join(beeziCodexHome(), 'checkpoint-transactions')).some(name => name.endsWith('.json'))) {
        return { ...result, ok: true, reason: 'pending-transaction' };
      }
    } catch (error) { if (error.code !== 'ENOENT') return { ...result, ok: true, reason: 'pending-unreadable' }; }
    const drained = await flushQueue(key, session, { fetchImpl });
    result.pendingDrained = orDefault(drained.flushed, 0);
    if (drained.trackingDisabled === true) {
      result.ok = true;
      result.reason = 'audit-only';
      result.upgradeAdvised = true;
      return result;
    }
    if (drained.lockSkipped || orDefault(drained.unreadable, 0) > 0
      || orDefault(drained.failed, 0) > 0 || orDefault(drained.deferred, 0) > 0) {
      result.ok = true;
      result.reason = 'pending-not-drained';
      result.lastError = orDefault(drained.lastError, 'queued reports could not be delivered');
      return result;
    }
  }

  // Fast path: the local cache already knows the pull is sealed. --force skips the LOCAL
  // caches only — the server verdict below is never bypassed.
  //
  // All three seal short-circuits are !syncMode-guarded. The one-time import being finished is
  // exactly the state a user runs the repair pass in, and R2 forbids the replay from either
  // honouring or reopening that seal.
  if (!syncMode && !options.force && trackingValid && (tracking || {}).backfillCompleted === true) {
    result.ok = true;
    result.reason = 'already-completed';
    result.upgradeAdvised = tracking.trackingMode != null && tracking.trackingMode !== TrackingMode.LIVE;
    return result;
  }

  // The server is the authority on "has this pull been used": local caches can be deleted (or
  // a reinstall never had them), and without this check a re-run would re-parse every
  // transcript only to be 403'd on its first chunk. Offline/old servers answer null — proceed;
  // the chunk-level ALREADY_COMPLETED guard still stands behind us.
  const who = await whoamiImpl(session, { fetchImpl }).catch(() => null);
  if (who && who.valid) {
    try { recordWhoamiImpl(key, who, identity); } catch { /* best-effort */ }
    if (!syncMode && who.backfillCompleted === true) {
      try { markCompleted(key); } catch { /* best-effort */ }
      result.ok = true;
      result.reason = 'already-completed';
      result.upgradeAdvised = who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE;
      return result;
    }
    // The server's own verdict on the tenant's tracking policy, which the local cache may predate.
    // Same refusal as above: the repair pass must not become the audit-only bypass.
    if (syncMode && who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE) {
      result.ok = true;
      result.reason = 'audit-only';
      result.upgradeAdvised = true;
      return result;
    }
  }

  const ledger = loadLedger(key, identity);
  if (!syncMode && !options.force && isComplete(ledger)) {
    result.ok = true;
    result.reason = 'already-completed';
    return result;
  }

  const live = liveSession(deps);
  const all = listRollouts();
  result.scanned = all.length;

  // Live-tracking tenants: everything since the machine link was tracked live; re-sending it
  // would double-count once its per-session cursor was pruned. Dark-mode tenants never tracked
  // live, so every transcript is fair game.
  const liveMode = trackingValid && (tracking || {}).trackingMode === TrackingMode.LIVE;
  const linkCutoffMs = liveMode ? linkedAtMs(key, deps) : null;
  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;
  const ageCutoffMs = now() - MAX_SESSION_AGE_MS;

  const candidates = [];
  for (const entry of all) {
    if (live && (entry.sessionId === live.sessionId || entry.transcriptPath === live.transcriptPath)) {
      result.live += 1;
      continue;
    }
    // Kept in BOTH modes: a rollout still being written is an open session in another window, and
    // R2 requires reconciliation to coordinate with live writers rather than race them.
    if (entry.mtimeMs > activeCutoffMs) { result.active += 1; continue; }
    // The three exclusions below are all "we believe this was already delivered" heuristics, and
    // every one of them is exactly backwards under sync: a session the live hooks started and the
    // server never received is the PRIME repair candidate. In sync they do not exclude anything —
    // the cursor and the ledger become inputs to the coverage decision below instead.
    if (!syncMode && linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs) { result.liveTracked += 1; continue; }
    // Keyring machines have no credentials-file mtime to fall back on, so a pre-stamp link
    // leaves linkCutoffMs null there — the persisted cursor is the remaining evidence that live
    // tracking already owns this session (it survives 14 days before pruneStale takes it).
    if (!syncMode && liveMode && linkCutoffMs == null && liveCursorOf(entry.sessionId, deps) > 0) {
      result.liveTracked += 1;
      continue;
    }
    if (!syncMode && !options.force && isImported(ledger, entry.sessionId)) { result.alreadyImported += 1; continue; }
    // The 30-day window (MAX_SESSION_AGE_MS). Counted, not silently dropped: `candidates === 0`
    // otherwise prints "nothing new to upload" on a machine that plainly has older history.
    if (entry.mtimeMs < ageCutoffMs) { result.tooOld += 1; continue; }
    if (options.sinceMs != null && entry.mtimeMs < options.sinceMs) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) { result.oversize += 1; continue; }
    candidates.push(entry);
  }

  // ── Reconciliation (sync only) ────────────────────────────────────────────────────────────
  // Ask the server how far each candidate already reaches, then decide per session whether a
  // non-overlapping start line can be PROVEN. Sessions where it cannot are dropped from the run
  // with a visible, retryable status — never replayed from zero on a guess.
  const startCursors = new Map();
  // Loaded in BOTH modes. The one-time import delivering a session is exactly as much proof of
  // what the server holds as a repair pass delivering one, and recording it during the import is
  // what gives the FIRST repair pass something to detect a gap against.
  const coverageBinding = currentBinding(identity);
  const coverageRecord = loadCoverage(key, coverageBinding);
  let coverageDirty = false;
  if (syncMode && candidates.length > 0) {
    const coverage = await fetchCoverage(
      candidates.map((entry) => entry.sessionId),
      session,
      { fetchImpl },
      { timeoutMs: AUDIT_TIMEOUT_MS },
    ).catch(() => null);
    result.coverageKnown = coverage !== null;
    const eligible = [];
    for (const entry of candidates) {
      const verdict = decideReplay(entry.sessionId, {
        coverage,
        checkpointLine: checkpointLineFor(coverageRecord, entry.sessionId),
        localCursor: liveCursorOf(entry.sessionId, deps),
        ledgerDelivered: ledgerDelivered(ledger, entry.sessionId),
      });
      if (verdict.decision === ReplayDecision.DEFER) {
        result.deferred += 1;
        if (verdict.reason === DeferReason.UNAVAILABLE) result.deferredUnavailable += 1;
        else result.deferredGap += 1;
        continue;
      }
      startCursors.set(entry.sessionId, verdict.startCursor);
      if (!childSweepAllowed(verdict.startCursor)) result.childrenDeferred += 1;
      eligible.push(entry);
    }
    candidates.length = 0;
    for (const entry of eligible) candidates.push(entry);
  }
  result.candidates = candidates.length;

  // Historical reports can only resolve their account foreign key after this account has been
  // registered for the linked tenant. One snapshot serves both the registration and every report,
  // so an auth refresh cannot split attribution during a long import. The body is the same
  // check-in shape lib/account-sync.mjs sends (billing.json first, ~/.codex/auth.json second),
  // but unlike the best-effort check-in the reply is verified: history is not uploaded against
  // an account the server did not link.
  let account = null;
  try { account = readChatgptAuth(); } catch { /* best-effort */ }
  let billingConfig = null;
  try { billingConfig = readBillingConfig(); } catch { /* best-effort */ }
  const registration = buildAccountSyncPayload({ config: billingConfig, account, now: now() });
  const accountUuid = orDefault(registration.accountUuid, null);
  const subscriptionIdentity = accountUuid ? { account_uuid: accountUuid } : {};

  if (accountUuid && !options.dryRun) {
    const register = (as) => postJson(
      `${apiBase()}${accountSyncPath()}`,
      as,
      registration,
      { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS },
    );

    let response;
    try {
      response = await register(session);
      if (response.status === 401) {
        // Keyed: this account's token, never "the" token. Only the bearer moves on a refresh, so
        // the client id rides through unchanged.
        const renewed = await getAccessToken(key, {}, { forceRefresh: true }).catch(() => null);
        if (renewed) {
          session = { ...session, token: renewed };
          response = await register(session);
        }
      }
      const reply = response.ok ? await response.json().catch(() => null) : null;
      if (!response.ok || !reply || reply.accountLinked !== true) {
        result.reason = 'account-registration-failed';
        result.lastError = response.ok ? 'account was not linked' : `HTTP ${response.status}`;
        return result;
      }
    } catch {
      result.reason = 'account-registration-failed';
      result.lastError = 'network';
      return result;
    }
  }

  const finalize = async () => {
    if (!shouldFinalize(result, options)) return;
    // Ownership is re-checked immediately before the ONE irreversible act in this file. A run that
    // lost its lock has been overlapped by another run whose progress this one cannot see, and
    // sealing on top of that would close the one-time pull over sessions nobody uploaded.
    const owned = lockHandle.verify();
    if (!owned.ok) {
      result.lastError = `history run lock ${owned.reason} — the pull was not sealed`;
      return;
    }
    const sealed = await completeBackfill(session, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    if (sealed.completed || sealed.code === 'BACKFILL_ALREADY_COMPLETED') {
      result.finalized = true;
      markComplete(ledger);
      try { saveLedger(key, ledger); } catch { /* best-effort */ }
      try { markCompleted(key); } catch { /* best-effort */ }
    } else {
      result.lastError = orDefault(sealed.reason, result.lastError);
    }
  };

  if (candidates.length === 0) {
    result.ok = true;
    // A previous run delivered everything but its finalize POST was lost: retry the seal here,
    // or the pull stays IN_PROGRESS forever while every rerun early-returns.
    await finalize();
    return result;
  }

  // Rate-limit error follow-ups hit a tracking-gated route: a dark-mode tenant would take one
  // 403 per session. Timelines are exempt — they ride inside the backfill chunks themselves.
  const followupsAllowed = !trackingValid || isLiveTrackingAllowed(key, deps);
  result.followupsAllowed = followupsAllowed;

  // Accumulated but not yet delivered. Bounded by the same caps the request planner uses, so
  // peak memory stays at roughly one request's worth of payloads regardless of session count.
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  // sessionId → what the follow-up phase needs once the server confirms the session landed.
  const followups = new Map();
  let processed = 0;
  let halted = false;

  const dispatchBatch = async (batch) => {
    result.plannedReports += batch.reduce((sum, g) => sum + g.reports.length, 0);
    if (options.dryRun) {
      const chunks = planChunks(batch);
      result.plannedChunks += chunks.length;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }

    // Renewed once per batch, before the network work rather than after it: the lease has to
    // outlive the request that is about to start. A renew that reports 'lost' means another run
    // took the lock while this one was parsing, so this batch is ABANDONED unsent — its sessions
    // stay unledgered and eligible, exactly like the halt path.
    const renewed = lockHandle.renew({ leaseMs: RUN_LEASE_MS });
    if (!renewed.ok && renewed.reason !== 'contended') {
      result.halt = BackfillHalt.LOCK_LOST;
      halted = true;
      result.lastError = `history run lock ${renewed.reason}`;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }

    const flushed = await flushBackfillChunks(
      batch,
      key,
      session,
      { fetchImpl },
      // The historical replay goes to the tracking-policy-aware sync route, never to the one-time
      // backfill route: /sessions/backfill is what the seal governs, and R2 forbids the repair
      // pass from consuming or reopening it.
      syncMode
        ? { timeoutMs: AUDIT_TIMEOUT_MS, endpoint: syncEndpoint() }
        : { timeoutMs: AUDIT_TIMEOUT_MS },
    );
    result.plannedChunks += flushed.chunks;
    result.timelinesDropped += orDefault(flushed.timelinesDropped, 0);
    result.reportsStored += flushed.stored;
    result.reportsSkipped += flushed.skipped;
    result.timelines += flushed.timelines;
    result.itemErrors += flushed.itemErrors;
    result.unattributed += flushed.unattributed;
    result.permanentRejections += flushed.permanentRejections;
    if (flushed.lastError) result.lastError = flushed.lastError;

    // Follow-ups only for sessions the server accepted — a failed one must stay unledgered so a
    // re-run retries it, and posting a timeline for it would create a session row with no usage.
    const landed = [];
    for (const group of batch) {
      const verdict = flushed.bySession.get(group.sessionId);
      const status = orDefault((verdict || {}).status, BackfillSessionStatus.FAILED);
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        result.sessionsImported += 1;
        landed.push(group.sessionId);
        // The durable coverage checkpoint, and the ONLY thing that writes one: a parent line the
        // server has now accepted from this machine. Written for both modes — it is the evidence
        // that later tells a mid-session coverage gap apart from a session that never landed, and
        // it is what makes ledger membership unnecessary as a coverage claim. It lives outside
        // state/ and queue/, the only directories prune.mjs sweeps, so it outlives the 14-day
        // cursor window that R2 says no age ceiling can stand in for.
        //
        // ACCEPTED ONLY, and PARTIAL is excluded deliberately. `parentMaxLine` is the highest line
        // this run SENT for the session, and it is a true statement about what the server holds
        // only when every report for that session was accepted. PARTIAL means some were not
        // (audit-flush.mjs mergeChunkResponse: some-but-not-all segments named in errors[]) — the
        // common trigger being a session that spans a connected and an unconnected repository.
        // Recording a line the server refused would put the checkpoint permanently AHEAD of the
        // real prefix, and every later run would then read that contradiction as a coverage gap
        // and defer the session forever, silently. A missing checkpoint only costs one re-read.
        if (
          status === BackfillSessionStatus.ACCEPTED
          && coverageRecord
          && Number.isInteger(group.parentMaxLine)
          && group.parentMaxLine > 0
        ) {
          recordCoverageCheckpoint(coverageRecord, group.sessionId, group.parentMaxLine);
          coverageDirty = true;
        }
      }
      if (status === BackfillSessionStatus.REJECTED) {
        result.reportsRejected += group.reports.length;
        result.sessionsRejected += 1;
      }
      if (status === BackfillSessionStatus.FAILED) result.reportsFailed += group.reports.length;
      // Anything the server judged is ledgered, including a rejection: an unconnected repository
      // will reject on every future run too. Failures and unattributed chunks stay eligible.
      if (
        status === BackfillSessionStatus.ACCEPTED ||
        status === BackfillSessionStatus.PARTIAL ||
        status === BackfillSessionStatus.REJECTED
      ) {
        markImported(ledger, group.sessionId, { outcome: status, reports: group.reports.length });
      } else {
        followups.delete(group.sessionId);
      }
    }
    // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
    try { saveLedger(key, ledger); } catch { /* best-effort */ }
    if (coverageDirty) {
      saveCoverage(key, coverageRecord);
      coverageDirty = false;
    }

    if (flushed.halt) {
      result.halt = flushed.halt;
      halted = true;
      // The seal is the one-time import's, so only the import may record it. A sync run that
      // somehow provoked this halt must leave the local caches exactly as it found them.
      if (!syncMode && flushed.halt === BackfillHalt.ALREADY_COMPLETED) {
        markComplete(ledger);
        try { saveLedger(key, ledger); } catch { /* best-effort */ }
        try { markCompleted(key); } catch { /* best-effort */ }
      }
      return;
    }

    if (followupsAllowed) {
      await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
        const followup = followups.get(sessionId);
        followups.delete(sessionId);
        if (!followup) return;
        for (const errorPayload of followup.sessionErrors) {
          const { reported } = await postSessionError(errorPayload, session, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
          if (reported) result.sessionErrors += 1;
        }
      });
    }

    onProgress({ processed, total: candidates.length, ...result });
  };

  // One-deep pipeline: at most one batch in flight while the loop parses the next sessions —
  // the run used to alternate CPU-bound parsing (network idle) with awaiting the upload (CPU
  // idle). Dispatches stay strictly sequential (await the previous flight before starting the
  // next), so the ledger writes and the never-two-POSTs invariant are untouched, and peak
  // memory grows by exactly one pending batch.
  let inFlight = null;
  const dispatch = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    if (inFlight) await inFlight;
    // A halt discovered by the previous flight drops this batch — its sessions stay
    // unledgered and eligible, exactly like the loop break below.
    if (halted) return;
    inFlight = dispatchBatch(batch);
  };

  // First failure earns a retry and holds the pull open; a second one does not, so a permanently
  // unreadable file costs one extra login rather than sealing the pull never.
  let unreadableDirty = false;
  const noteUnreadable = (sessionId) => {
    if (!wasUnreadable(ledger, sessionId)) result.retriableUnreadable += 1;
    markUnreadable(ledger, sessionId);
    unreadableDirty = true;
  };

  // Parsing itself stays strictly sequential. computeDelta reads and JSON.parses the whole
  // transcript, so parsing sessions in parallel multiplies peak memory with no gain on a
  // single thread.
  for (const entry of candidates) {
    if (halted) break;
    const reports = [];
    let sessionErrors = [];
    let skipped = null;
    let agents = {};
    // Backfill has no coverage answer and never had one: persistState:false already starts it at
    // line 0, which is the whole-history read the one-time import is for.
    const startCursor = syncMode ? orDefault(startCursors.get(entry.sessionId), 0) : 0;
    try {
      // transcript_path is passed through so runCheckpoint's resolver takes it as-is instead of
      // walking the whole rollout tree per session; cwd rode in on the discovery head-read.
      const checkpoint = await runCheckpoint(
        {
          session_id: entry.sessionId,
          transcript_path: entry.transcriptPath,
          cwd: orDefault(entry.cwd, null),
        },
        // gitImpl rides along so the audit's checkpoint resolves repo roots through whatever the
        // caller handed in. Unforwarded it was the one reader the audit could not steer, and the
        // suite's only protection against `git` running against the developer's own repository is
        // that seam — tools/hermetic-env.mjs records the spawn but does not stop it.
        { linkedSessions: async () => [session], fetchImpl, gitImpl: deps.gitImpl, recoveryPermit: lockHandle.token },
        {
          sink: (payload) => reports.push({ ...payload, ...subscriptionIdentity }),
          skipFlush: true,
          collectSessionErrors: true,
          persistState: false,
          // The server is the authority on what actually landed: a local cursor can sit at EOF
          // while the upload was lost, and it can sit at 0 for a session the server holds in full.
          // A non-zero value here means "start immediately after the confirmed contiguous prefix",
          // which is what makes the replay append-only. 0 in backfill mode is today's behaviour.
          startCursor,
          recovery: syncMode,
          // Past sessions' hook sidecars are pruned at 14 days — the rollout-tree sweep is the
          // only way their subagents are found and billed. Under sync the sweep is governed by the
          // CHILD REPAIR POLICY instead (lib/session-coverage.mjs childSweepAllowed): parent
          // coverage excludes agent rows entirely, so a partial parent replay can say nothing
          // about which children landed and must not re-send them.
          sweepSubagents: !syncMode || childSweepAllowed(startCursor),
          skipLiveTrackingGate: true,
        },
      );
      sessionErrors = orDefault((checkpoint || {}).sessionErrors, []);
      skipped = orDefault((checkpoint || {}).skipped, null);
      if (!checkpoint || checkpoint.outcome !== 'committed') {
        reports.length = 0;
        if (!skipped || (!skipped.deltaFailed && !skipped.noRemote && !skipped.emitFailed)) {
          skipped = { ...(skipped || {}), emitFailed: 1 };
        }
      }
      agents = orDefault((checkpoint || {}).agents, {});
    } catch {
      // One unreadable transcript must not end the run — but it is no longer silent.
      result.unreadable += 1;
      noteUnreadable(entry.sessionId);
      processed += 1;
      continue;
    }
    processed += 1;
    if (reports.length === 0) {
      // Classify rather than drop on the floor. `empty` is the only benign outcome, so it is the
      // fallback ONLY once every reason worth reporting has been ruled out — telling a user that
      // a session we failed to upload "held no usage data" is the silent loss this exists to end.
      if (skipped && skipped.deltaFailed) {
        result.unreadable += 1;
        noteUnreadable(entry.sessionId);
      } else if (orDefault((skipped || {}).emitFailed, 0) > 0) result.emitFailed += 1;
      else if (orDefault((skipped || {}).noRemote, 0) > 0) result.noRemote += 1;
      else result.empty += 1;
      continue;
    }

    // ── The overlap ban, enforced on the built payloads ────────────────────────────────────
    // A segment id encodes `fromLine-toLine`, so a replay partitioned differently from the live
    // run produces new ids for lines the server already holds and the two cannot supersede each
    // other. The replay protocol is therefore APPEND ONLY, and this is the check that it held:
    // every parent segment must begin strictly after the confirmed prefix. If any does not — the
    // engine ignored startCursor, or the transcript was re-anchored underneath us — the whole
    // session is dropped unsent and deferred. Overlap is never reconciled, only refused.
    //
    // Subagent payloads are exempt by construction: their line numbers index their OWN rollout,
    // an unrelated coordinate system from the parent's, and the child repair policy has already
    // decided whether they may be swept at all.
    const parentReports = reports.filter((payload) => payload && payload.is_subagent !== true);
    const overlaps = parentReports.some(
      (payload) => Number.isInteger(payload.from_line) && payload.from_line <= startCursor,
    );
    if (startCursor > 0 && overlaps) {
      result.deferred += 1;
      result.deferredOverlap += 1;
      continue;
    }
    let parentMaxLine = startCursor;
    for (const payload of parentReports) {
      if (Number.isInteger(payload.to_line) && payload.to_line > parentMaxLine) parentMaxLine = payload.to_line;
    }

    // Timeline travels with the session's own chunk. Best-effort: a timeline that fails to
    // compute never blocks the usage upload. The agent map is handed over rather than re-read —
    // the checkpoint's sweep entries are ones the (possibly pruned) sidecars would not show.
    let timeline = null;
    try {
      const computed = computeSessionTimeline(entry.transcriptPath, entry.sessionId, {
        readAgents: () => agents,
      });
      if (
        computed &&
        (computed.periods.length > 0 || computed.subagents.length > 0 || computed.plan_events.length > 0)
      ) {
        timeline = { sessionId: entry.sessionId, ...computed };
        result.timelinesOffered += 1;
      }
    } catch { /* best-effort */ }

    followups.set(entry.sessionId, { sessionErrors });
    pending.push({ sessionId: entry.sessionId, reports, timeline, parentMaxLine });
    pendingBytes += Buffer.byteLength(JSON.stringify({ reports, timeline }), 'utf-8');
    pendingItems += reports.length;
    if (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS) await dispatch();
  }
  await dispatch();
  if (inFlight) await inFlight;

  // A run can hit unreadable transcripts and dispatch nothing at all, so this cannot ride on the
  // per-dispatch save — without it the retry marker is lost and the next run blocks again.
  if (unreadableDirty) {
    try { saveLedger(key, ledger); } catch { /* best-effort */ }
  }
  if (coverageDirty) {
    saveCoverage(key, coverageRecord);
    coverageDirty = false;
  }

  // A run whose lock was taken away mid-flight reports what it managed to deliver and stops. It
  // must not seal: another run owns the machine's history now and this one cannot see its work.
  if (result.halt === BackfillHalt.LOCK_LOST) {
    result.ok = true;
    return result;
  }

  result.ok = true;
  await finalize();
  return result;
}
