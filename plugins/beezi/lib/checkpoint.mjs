import { fetchCompat } from './fetch-compat.mjs';
import fs from 'fs';
import { orDefault } from './compat.mjs';
import path from 'path';
import { computeDelta as _computeDelta } from './delta-codex.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { linkedSessions as _linkedSessions } from './accounts.mjs';
import { queueDir, stateDir, beeziCodexHome } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { resolveCodexTranscript, isUsableSessionId } from './transcript-codex.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, POST_TIMEOUT_MS } from './http.mjs';
import { HOOK_TIMEOUT_SEC } from './hooks-install.mjs';
import { postSessionError } from './session-error-report.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline-codex.mjs';
import { recordRateLimitObservations } from './rate-limits-codex.mjs';
import { readChatgptIdentity } from './chatgpt-identity.mjs';
import { drainRateLimitSnapshots as _drainRateLimitSnapshots } from './usage-report-codex.mjs';
import { isApiKeyBillingEvidence, isSubscriptionBillingEvidence } from './billing.mjs';
import {
  readBillingConfig,
  writeBillingConfig,
  resolveBilling,
  recordApiKeyEvidence,
  recordSubscriptionEvidence,
} from './billing-config.mjs';
import { resolveSessionName as _resolveSessionName, sanitizeSessionName } from './session-name-codex.mjs';
import { readJson, readJsonSalvaged, writeJsonDurable, safeFileName } from './fs-store.mjs';
import { isLiveTrackingAllowed, markTrackingDisabled } from './tracking.mjs';
import { acquireLock, withLockAsync, sessionLock, sharedLock } from './single-instance-lock.mjs';
// Static, and verified acyclic before it was added: diagnostics' full import closure is
// paths / compat / fs-store / config / http / machine-identity / fetch-compat / friendly-error,
// none of which reaches back here, so there is no cycle to lazy-import around.
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { mergeIntervals, subtractIntervals, totalMs, claimIntervals } from './active-time.mjs';
import { probeProjectInstructions } from './project-instructions.mjs';
import { readAgents as _readAgents, writeAgent as _writeAgent } from './subagent-state.mjs';
import {
  inspectSubagentRollout as _inspectSubagentRollout,
  findSubagentRollouts as _findSubagentRollouts,
  rolloutStartedAt as _rolloutStartedAt,
  canonicalizeAgents,
} from './subagent-codex.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {
    cursor: 0,
    sentSessionName: null,
    anchor: null,
  });
}

function saveState(id, state) {
  writeJsonDurable(path.join(stateDir(), `${id}.json`), state);
}

// ONE payload, one copy per account that is allowed to receive it.
//
// The delta is computed once and the same bytes are written into every allowed account's queue,
// because the work happened once and every linked workspace is owed the same account of it. The
// copies then live independent lives: each drains under its own bearer, and one tenant's 403 or
// 404 is a verdict on that tenant's copy alone.
//
// `keys` is the ALLOWED set, not the linked set — an account whose tracking policy is dark gets
// nothing enqueued at all, which is what keeps a dark tenant's queue from growing for three days
// only to expire (see QUEUE_HOLD_MS).
export function enqueue(keys, payload) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  //
  // safeFileName, not a targeted replace: a subagent segmentId embeds an agent id that arrived on a
  // hook payload, so this name is partly untrusted input.
  const name = `${safeFileName(payload.segmentId, { max: 200 })}.json`;
  for (const key of keys) writeJsonDurable(path.join(queueDir(key), name), payload);
}

const transactionFile = id => path.join(beeziCodexHome(), 'checkpoint-transactions', `${safeFileName(id)}.json`);

function readTransaction(id) {
  let raw;
  try { raw = fs.readFileSync(transactionFile(id), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const tx = JSON.parse(raw);
  if (!tx || tx.version !== 1 || tx.sessionId !== id || !Array.isArray(tx.payloads)
    || !Array.isArray(tx.children) || !tx.state) throw new Error('Invalid checkpoint transaction');
  return tx;
}

function commitTransaction(tx, lock, emit, deps, durable) {
  const own = () => { if (!stillOwnsSession(lock)) throw new Error('Checkpoint ownership lost'); };
  own();
  for (const payload of tx.payloads) { own(); emit(payload); }
  if (durable) {
    for (const child of tx.children) {
      own();
      orDefault(deps.writeAgent, _writeAgent)(tx.sessionId, child.agentId, child.state);
    }
    own();
    orDefault(deps.saveState, saveState)(tx.sessionId, tx.state);
    own();
    fs.unlinkSync(transactionFile(tx.sessionId));
  }
  return { parent: tx.state.cursor, children: tx.children.map(c => ({ agentId: c.agentId, cursor: c.state.cursor })) };
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// Server-side DTO caps (`session-report.request.dto.ts` in the hb-ai-agent-portal repo). One
// over-long field 400s the whole request, and flushQueue treats a 400 as permanent: it deletes that
// queue file and moves on, so the segment is gone rather than retried. `branch` is required, so it
// is truncated rather than dropped — a truncated ref still names the work recognisably, an empty
// one fails validation too.
//
// `remote` stays unclamped on purpose: a truncated remote would fabricate a repo key that matches
// nothing server-side, which is worse than the 400. Do not extend this by copy-paste.
const BRANCH_MAX = 255;
const clamp = (value, max) =>
  (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    return orDefault(Intl.DateTimeFormat().resolvedOptions().timeZone, null);
  } catch {
    return null;
  }
}

// How long a checkpoint run may spend before it must be finished. Codex kills a hook at the
// timeout it registered and reports the kill as a failed hook — which is what "Stop hook failed
// (exit code 1)" alongside perfectly good analytics means: the work landed, the process was still
// running. The margin covers what is not network here (git shell-outs, transcript parsing, state
// writes) plus node's own startup.
export const HOOK_BUDGET_MS = HOOK_TIMEOUT_SEC * 1000 - 2500;

// Lease for the per-session checkpoint transaction. Comfortably above HOOK_BUDGET_MS so a hook
// never has to renew, and short enough that a hard-killed hook does not block the next tool call
// for long — a dead holder is evicted the moment its lease lapses, because the liveness probe
// answers "gone" rather than buying it the extra grace a live one gets.
//
// It is deliberately NOT sized for the manual `track` path, which passes no budget and drains the
// whole queue with no deadline. That work happens AFTER the state write and cannot be raced into
// anything, so an expiry there is harmless; what protects the state write itself is the ownership
// check immediately before it, not the length of the lease.
export const SESSION_LOCK_LEASE_MS = 60_000;

// Lease for one queue drain. The drain is a serial loop of network posts, so this is the one lease
// that has to cover real latency; the CLI path can exceed it, and the same reasoning applies —
// nobody evicts a holder that is still alive, and release re-reads its own generation before it
// unlinks anything.
const QUEUE_LOCK_LEASE_MS = 60_000;

// Do we still own the session lock, and may this transaction commit?
//
// Three outcomes from the primitive, and collapsing any two of them is a bug:
//   ok        — the record on disk is this acquisition's. Commit.
//   'expired' — still ours, just past our own lease. Nobody took it (a takeover would have replaced
//               the generation), so renew and commit. The manual `track` path has no budget and
//               routinely outlives a lease while draining a backlog.
//   'lost'    — a different generation is on disk: somebody else owns this session and is mid
//               transaction. ABORT the commit, per the module contract.
function stillOwnsSession(lock) {
  const seen = lock.verify();
  if (seen.ok) return true;
  if (seen.reason !== 'expired') return false;
  return lock.renew({ leaseMs: SESSION_LOCK_LEASE_MS }).ok;
}

// Bill every subagent of this session, from the parent's own checkpoint.
//
// One process does all of it on purpose. The alternative — each SubagentStop hook billing its own
// agent — has N+1 processes read-modify-writing the same coverage ledger at the moment a fan-out
// ends, and whichever loses the race silently drops its claim. Here the union is computed in a single
// pass with a deterministic order, and the hooks are reduced to recording identity (see
// scripts/subagent-stop.mjs).
//
// Agents come from two places: the sidecars the hooks wrote, and — on turn ends only — a bounded
// sweep of the rollout tree, which is what keeps this working on a machine where the hooks were never
// trusted and on the hookless `track` path.
// Returns { apiErrorEvents, agents } — `agents` is the merged sidecar+sweep map, handed back so the
// timeline can build its spans from it instead of re-reading the same directory.
function ingestSubagents({
  sessionId, parentTranscriptPath, computeDelta, resolvers, enqueueSegments, sweep, persist = true, recovery = false, deps = {},
}) {
  const readAgents = orDefault(deps.readAgents, _readAgents);
  // Not a fallback: runCheckpoint always injects one (it redirects the child write into the
  // transaction it is about to commit), so a default here would only ever mask a miswired caller.
  const writeAgent = deps.writeAgent;
  const inspectRollout = orDefault(deps.inspectSubagentRollout, _inspectSubagentRollout);
  const findRollouts = orDefault(deps.findSubagentRollouts, _findSubagentRollouts);
  const startedAt = orDefault(deps.rolloutStartedAt, _rolloutStartedAt);
  const apiErrorEvents = [];
  let childDeferred = false;

  let agents;
  try { agents = readAgents(sessionId); } catch { agents = {}; }

  if (sweep) {
    try {
      // The parent's own start bounds the scan: a subagent cannot predate the session that spawned
      // it. Without it this walks every rollout the machine has ever written.
      const since = startedAt(parentTranscriptPath);
      for (const { agentId, path: rolloutPath } of findRollouts(sessionId, { sinceMs: since })) {
        if (!agents[agentId]) agents[agentId] = { agent_id: agentId };
        if (agents[agentId].transcriptPath === undefined || agents[agentId].transcriptPath === null) {
          agents[agentId].transcriptPath = rolloutPath;
        }
      }
    } catch { /* best-effort: the sidecars are still authoritative */ }
  }

  // Deterministic order so the coverage union is reproducible across runs.
  const ordered = Object.entries(agents).sort((a, b) => {
    const at = Date.parse(orDefault((a[1] || {}).started_at, '')) || 0;
    const bt = Date.parse(orDefault((b[1] || {}).started_at, '')) || 0;
    return at - bt || String(a[0]).localeCompare(String(b[0]));
  });

  // Canonicalize before billing: one entry per rollout FILE, keyed by the id the rollout states
  // about itself. A sidecar and the sweep can key the SAME file differently — Codex documents
  // `agent_id` only as "Identifier for the subagent" — and two keys mean two cursors and two
  // non-colliding segment ids, which the server `segmentId::model` upsert cannot collapse. This
  // also folds in the skips the loop used to do inline: no transcript path, unreadable, not a
  // subagent, or a fork whose replayed prefix could not be delimited. See canonicalizeAgents.
  for (const { agentId, record, rolloutPath, inspected } of canonicalizeAgents(ordered, inspectRollout)) {
    if (recovery && (!persist || !Number.isInteger(record.cursor))) {
      childDeferred = true;
      continue;
    }
    // The import ignores stored cursors on purpose: a dark-mode tenant's live hooks advanced
    // them while every report was 403-dropped, so honoring them would bill only session tails.
    const from = persist && Number.isInteger((record || {}).cursor) ? record.cursor : inspected.forkBoundaryLine;
    let delta;
    try {
      delta = computeDelta(rolloutPath, from, resolvers);
    } catch { throw new Error('Child transcript could not be read'); }

    // segmentId is scoped by agent id because the server's idempotency key is `segmentId::model` and
    // does NOT include agent_id. Two agents both starting at their own fork boundary produce
    // identical line windows, so without this scope the second would overwrite the first.
    enqueueSegments(delta.segments, `${sessionId}:${agentId}`, {
      is_subagent: true,
      agent_id: String(agentId).slice(0, 200),
      agent_type: record && record.agent_type ? String(record.agent_type).slice(0, 100) : null,
      agent_name: inspected.agentNickname ? String(inspected.agentNickname).slice(0, 200) : null,
      // Omitted rather than nulled when it is not a non-negative integer — the field is optional and
      // the clamp keeps a malformed value out of the payload entirely.
      ...(Number.isInteger(inspected.spawnDepth) && inspected.spawnDepth >= 0
        ? { spawn_depth: inspected.spawnDepth }
        : {}),
    });

    // An agent that dies on an API error never ends the parent's turn, so no Stop fires for it and
    // its own rollout is the only record that the failure happened.
    apiErrorEvents.push(...orDefault(delta.apiErrorEvents, []));

    if (persist && delta.nextCursor !== from) {
      writeAgent(sessionId, agentId, { cursor: delta.nextCursor, transcriptPath: rolloutPath });
    }
  }

  return { apiErrorEvents, agents, childDeferred };
}

// Cap on error reports carried forward in session state. An error whose POST missed the hook
// budget is unrecoverable once the cursor advances, so it is parked rather than dropped — but a
// machine that can never reach the server must not grow its state file forever. Newest wins.
const MAX_PENDING_ERRORS = 20;

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush, sessionErrors, skipped, rateLimits, agents } — flush is the flushQueue
// summary (or null when it never ran), and rateLimits is { posted, deferred } from the rate-limit
// drain (or null when that never ran). A checkpoint that could not take its session lock returns
// { lockSkipped: true, lockReason } instead of doing any work.
// `options.budgetMs` bounds the network work: hooks pass it, the CLI (track.mjs) does not, because
// a user waiting at a terminal would rather see the whole queue drained than a partial flush.
export async function runCheckpoint(input, deps = {}, options = {}) {
  // RAW, and used exactly once — to derive `sessionId` below. Every DURABLE key here comes from
  // that one instead: state/<id>.json, the segmentId, the queue filename that segmentId becomes,
  // and the sessionId on the wire. `${null}.json` is `state/null.json`, ONE file shared by every
  // id-less session on the machine, and `${null}:1-18` is a segmentId the server accepts under a
  // phantom session literally named "null". See G-3-1.
  const { session_id, cwd } = input;
  const now = orDefault(deps.now, Date.now);
  const deadline = options.budgetMs ? now() + options.budgetMs : null;
  const timeLeft = () => (deadline === null ? null : deadline - now());
  const collectedErrors = [];
  // Why segments did not become reports. A caller that gets zero reports cannot otherwise tell a
  // session that genuinely holds no usage (a transcript with no assistant tokens — nothing to
  // upload, and nothing wrong) from one we dropped for a reason worth reporting. Only the
  // problem cases are counted: "no usage" is the absence of all of them.
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false };
  const emptyResult = () => ({ outcome: 'deferred', reason: 'not-checkpointed', committedBoundaries: null, enqueued: 0, flush: null, sessionErrors: collectedErrors, skipped });
  // PostToolUse / Stop hooks don't carry `transcript_path`; resolve the rollout from the session
  // id (or the cwd mapping in state). SessionEnd does provide it — resolveCodexTranscript prefers
  // the given path when present. No resolvable transcript → nothing to checkpoint.
  const resolveTranscript = orDefault(deps.resolveTranscript, resolveCodexTranscript);
  const resolved = resolveTranscript(input);
  if (!resolved) return emptyResult();
  const transcript_path = resolved.transcriptPath;
  // The hook's own id FIRST, the resolver's second — that order is load-bearing and not
  // interchangeable. resolveCodexTranscript falls through to findRolloutBySessionState, which
  // matches on `cwd` ALONE (lib/transcript-codex.mjs), so `resolved.sessionId` can name a PREVIOUS
  // session that ran in this directory. Preferring it over a perfectly usable hook id would bill
  // this session's segments, state file and wire id under that older session — a cross-session
  // mis-attribution strictly worse than the null-id bug being closed here. The resolver only gets
  // to answer when the hook did not, which is exactly the poisoned path.
  const sessionId = isUsableSessionId(session_id)
    ? session_id
    : (isUsableSessionId(resolved.sessionId) ? resolved.sessionId : null);
  // Refuse rather than write under a name we do not have. This is the WRITING entry point, so the
  // strict check belongs here — never in the resolver, whose null tolerance liveSession()
  // (lib/session-audit.mjs) depends on to exclude the live session by path. Reported as a distinct
  // outcome, not as a silent empty result, so a caller with zero reports can tell "no usage" from
  // "we refused to name it".
  if (sessionId === null) return { ...emptyResult(), unnamedSession: true };

  // ── The per-session checkpoint transaction (G-8-3 / R3) ───────────────────────────────────────
  // Taken HERE, the first instruction after the session id is known, and held through the state
  // write at the bottom. Everything between is one transaction — read the cursor, compute the
  // delta, enqueue the segments, advance the cursor — and R3 requires EVERY writer of it to hold
  // this lock, not just the ones that persist: PostToolUse, Stop, the manual track path and the
  // history backfill all enter through this function, so this single acquisition covers all four.
  //
  // It is taken even when `options.persistState === false`. The backfill does not write
  // state/<id>.json, but it still runs the SAME delta through the same sink, and two passes
  // enqueueing one window is the duplicate this lock exists to prevent.
  //
  // Keyed on the ROOT session id by construction: subagents are billed from their parent's
  // checkpoint under `${sessionId}:${agentId}` (see ingestSubagents), so no caller ever asks for a
  // second rank-2 lock — which the primitive refuses outright, deliberately.
  //
  // Acquire-and-finally rather than withLockAsync: this function has a dozen early returns and
  // wrapping four hundred lines in a closure to gain the same guarantee would bury the diff.
  const borrowed = deps.sessionHandle && deps.sessionHandle.name === sessionLock(sessionId).name
    && stillOwnsSession(deps.sessionHandle);
  const acquired = borrowed ? { ok: true, handle: deps.sessionHandle }
    : acquireLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS, recoveryPermit: deps.recoveryPermit });
  if (!acquired.ok) {
    // 'held' and 'contended' are somebody else mid-transaction on this same session: defer, and the
    // next hook picks the window up with nothing lost.
    //
    // 'lock-order' is NOT that. It means this process already holds a lock of equal or finer rank,
    // which is a defect in its own acquisition sequence — retrying it fails identically forever, so
    // it must never be folded into the same "we'll get it next time" bucket. `lockReason` on the
    // return is the assertable surfacing; this is the one that survives the process.
    //
    // STATE_WRITE_FAILED is the closest member of a CLOSED server vocabulary, and it is accurate
    // rather than convenient: the consequence of this refusal is precisely that the session's state
    // write does not happen. Inventing a lock-shaped code would 400 the whole diagnostics batch.
    // Unreachable by construction today — the only locks coarser than this one are rank 0 and 1,
    // held by scripts/mcp.mjs and the backfill run, and both are legal above rank 2.
    if (acquired.reason === 'lock-order') {
      recordIssue({
        code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED,
        source: DIAGNOSTIC_SOURCES.CHECKPOINT,
      });
    }
    return { ...emptyResult(), lockSkipped: true, lockReason: acquired.reason };
  }
  try {
    return await runLockedCheckpoint(acquired.handle, {
      deps, options, sessionId, transcript_path, cwd, now, deadline, timeLeft,
      collectedErrors, skipped, emptyResult,
    });
  } catch {
    return { ...emptyResult(), outcome: 'failed', reason: 'checkpoint-failed' };
  } finally {
    // Unconditional: a section that threw still has to hand the lock back, or the next checkpoint
    // on this session waits out the whole lease for nothing.
    if (!borrowed) acquired.handle.release();
  }
}

// Keep the session writer excluded from the drain through coverage and checkpoint commit.
//
// EVERY REPORTING account has to be clean before the caller's boundary decision runs, not just
// one: the question this answers is "does the server already hold everything this machine built
// for this session", and one account with an undrained queue makes that answer wrong for that
// tenant. The accounts are drained SERIALLY — flushQueue takes `shared:queue-<key>`, rank 3, and
// two of those at once in one process is a 'lock-order' refusal rather than a wait.
//
// REPORTING, not linked. The filter is the same one runLockedCheckpoint applies to build its
// `targets`, and it is here rather than at the caller so every future caller inherits it — the
// invariant it protects ("an account whose tracking policy is dark gets nothing enqueued at all",
// stated at `enqueue` above) is broken by this function's own transaction-resume path otherwise.
// A dark account also cannot answer the drain question at all: it receives no payloads, so its
// queue is HELD rather than drained and flushQueue reports `trackingDisabled` unconditionally,
// which read as "not drained" lets one dark workspace stop the live one beside it from ever being
// established. The filtered list is handed to `fn` as well, so the caller's own per-account work
// cannot reach for the unfiltered one by accident.
export async function reconcileSession(sessionId, sessions, fn, deps = {}) {
  const liveAllowed = orDefault(deps.isLiveTrackingAllowed, isLiveTrackingAllowed);
  // Fail OPEN on an unreadable policy, the posture lib/tracking.mjs documents: the server's guard
  // is the real boundary, and treating an unreadable cache as dark would stop reporting outright.
  const reporting = sessions.filter((session) => {
    try { return liveAllowed(session.key, deps) !== false; } catch { return true; }
  });
  // Nothing is reporting, so there is no boundary to establish — and the transaction below must
  // NOT be read: committing it would emit its payloads into zero queues and then unlink it, which
  // is the one way this function could destroy work. runLockedCheckpoint returns `gated` before
  // its own transaction read for exactly the same reason.
  if (reporting.length === 0) return { outcome: 'deferred', reason: 'tracking-disabled' };

  const acquired = acquireLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS });
  if (!acquired.ok) return { outcome: 'deferred', reason: 'session-busy' };
  try {
    const keys = reporting.map((s) => s.key);
    const pending = readTransaction(sessionId);
    if (pending) {
      commitTransaction(pending, acquired.handle, (payload) => enqueue(keys, payload), deps, true);
      return { outcome: 'deferred', reason: 'transaction-resumed' };
    }
    const flush = orDefault(deps.flushQueue, flushQueue);
    for (const session of reporting) {
      const drained = await flush(session.key, session, deps);
      if (!drained || drained.lockSkipped || drained.trackingDisabled || drained.deferred || drained.unreadable) {
        return { outcome: 'deferred', reason: 'pending-not-drained' };
      }
      // A 404/405 is the ROUTE being absent, not a verdict on the payload: drainQueue keeps those
      // files and still counts them in `failed`, so the user is told — but they must not block
      // reconciliation. A server with no report route holds no coverage for those segments to be
      // stale against, and on an ACTIVE machine the live account keeps writing fresh queue files,
      // so the 14-day prune never arrives and this session would never be established again.
      // `routeAbsent` is why the emptiness check below is skipped too: those files are on disk by
      // design, and the line above has already established that nothing else failed.
      const routeAbsent = orDefault(drained.routeAbsent, 0);
      if (orDefault(drained.failed, 0) - routeAbsent > 0) {
        return { outcome: 'deferred', reason: 'pending-not-drained' };
      }
      if (routeAbsent > 0) continue;
      let files;
      try { files = fs.readdirSync(queueDir(session.key)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      if (files.length) return { outcome: 'deferred', reason: 'pending-not-drained' };
    }
    if (!stillOwnsSession(acquired.handle)) return { outcome: 'deferred', reason: 'ownership-lost' };
    return await fn(acquired.handle, reporting);
  } catch { return { outcome: 'deferred', reason: 'reconciliation-unavailable' }; }
  finally { acquired.handle.release(); }
}

// The body of the transaction, running under the session lock its caller holds. Split out only so
// that acquire/release can be a try/finally around it; the parameters are the locals runCheckpoint
// had already computed before the lock was taken.
async function runLockedCheckpoint(lock, ctx) {
  const {
    deps, options, sessionId, transcript_path, cwd, now, deadline, timeLeft,
    collectedErrors, skipped, emptyResult,
  } = ctx;
  const listSessions = orDefault(deps.linkedSessions, _linkedSessions);
  const gitImpl = orDefault(deps.gitImpl, git);
  const computeDelta = orDefault(deps.computeDelta, _computeDelta);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const durable = options.persistState !== false;
  const payloads = [];
  const children = [];

  // Every account this machine can currently produce a token for. An account that cannot is
  // already dropped by linkedSessions — a transient credential failure costs one account, not the
  // whole checkpoint.
  let sessions;
  try { sessions = await listSessions(deps); } catch { return emptyResult(); }
  if (!sessions || sessions.length === 0) return emptyResult();

  // Tenant gate, now PER ACCOUNT: audit-mode workspaces never track live — the server would 403
  // every report anyway (TrackingEnabledGuard), this just spares the work and the noise. The delta
  // is computed when AT LEAST ONE account allows it, and only the allowed ones receive it; a dark
  // tenant sitting beside a live one must not silence the live one. `gated` (no account allows it)
  // lets the track script tell "tracking is off" apart from "nothing new". The history import
  // passes skipLiveTrackingGate — an explicit flag, never inferred from the sink seam.
  const targets = options.skipLiveTrackingGate === true
    ? sessions
    : sessions.filter((session) => isLiveTrackingAllowed(session.key));
  if (targets.length === 0) return { ...emptyResult(), gated: true };
  const targetKeys = targets.map((session) => session.key);

  // Where a built payload goes. The history import collects them in memory and batches them
  // itself; letting it fall through to the disk queue would drip-feed hundreds of segments to
  // the single-report endpoint on the next hook, bypassing the batch route's whole-session dedupe.
  const emit = options.sink ? options.sink : (payload) => enqueue(targetKeys, payload);

  if (durable) {
    try {
      const pendingTransaction = readTransaction(sessionId);
      if (pendingTransaction) {
        const boundaries = commitTransaction(pendingTransaction, lock, emit, deps, true);
        return { ...emptyResult(), outcome: 'committed', reason: 'resumed', committedBoundaries: boundaries,
          enqueued: pendingTransaction.payloads.length };
      }
    } catch {
      return { ...emptyResult(), outcome: 'failed', reason: 'transaction-resume-failed' };
    }
  }

  // Below the token gate: skip this work entirely on an unlinked machine.
  const resolveSessionName = orDefault(deps.resolveSessionName, _resolveSessionName);
  const resolvedSessionName = resolveSessionName(sessionId, transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();
  // root→project instruction observation. Read once per repo root, not once per segment: a window
  // that spans twenty segments of one repo would otherwise repeat the same filesystem probes inside
  // a hook budget. Missing and unknown answers are cached too.
  const projectInstructionsCache = new Map();

  // Persisted known-root map: seeds resolution (prefix match) and gets refreshed with any root→origin
  // we learn this checkpoint. A best-effort hint — a load failure yields an empty map, not a throw.
  const map = loadRepoMap();
  let mapDirty = false;

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache, map);

  const projectInstructionsOf = (root) => {
    if (projectInstructionsCache.has(root)) return projectInstructionsCache.get(root);
    const observation = probeProjectInstructions(root);
    projectInstructionsCache.set(root, observation);
    return observation;
  };

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
      // Always resolve current HEAD too: it's the fallback for any line lacking a
      // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
      try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    if (!r) r = knownOrigin(root, map);
    if (r) { upsertRoot(map, root, r); mapDirty = true; }
    remoteCache.set(root, r);
    return r;
  };

  // The history import never reads persisted per-session state: on a dark-mode tenant the live
  // hooks kept advancing cursors while the server 403-dropped every report, so an import that
  // honored those cursors would bill only the tails of exactly the sessions it exists to recover.
  // The server upserts by segmentId, so re-covering lines a live run DID deliver is idempotent.
  const state = options.persistState === false
    ? { cursor: 0, sentSessionName: null, anchor: null }
    : loadState(sessionId);
  // G-3-3: a coverage-derived start line is a HARD OVERRIDE, not a comparison. The server is the
  // authority on what actually landed — a local cursor can sit at EOF while the upload was lost,
  // and at 0 for a session the server holds in full. lib/session-audit.mjs passes this only when
  // lib/session-coverage.mjs has PROVEN a non-overlapping boundary; 0 and absent are identical.
  const startCursor = Number.isInteger(options.startCursor) && options.startCursor >= 0
    ? options.startCursor
    : null;
  if (startCursor !== null) {
    state.cursor = startCursor;
    // Cleared with the cursor, never separately: coveredIntervals is wall clock already billed for
    // lines BELOW the old cursor, and keeping it while restarting from the server's line would
    // subtract time from segments that were never delivered.
    state.coveredIntervals = [];
  }
  let stateDirty = false;
  // When the session file is unreadable (name resolves to null), keep the last name we sent rather
  // than overwriting the stored name with null — but only after putting it through the same gate a
  // fresh name passes. Older resolvers stored names they would not produce today: injected context
  // blocks (XML preambles, absolute home paths), and later the session_index seed, which is raw
  // prompt text and can carry a path mid-sentence. Left in state, such a name is re-sent on every
  // checkpoint forever. sanitizeSessionName redacts what it can and drops what it cannot; either
  // way the name changes, which trips the anchor replay below and corrects what the server holds.
  const storedName = typeof state.sentSessionName === 'string' ? state.sentSessionName : null;
  const stored = sanitizeSessionName(storedName);
  if (storedName && !stored) {
    state.sentSessionName = null;
    stateDirty = true;
  }
  const sessionName = orDefault(resolvedSessionName, orDefault(stored, null));
  // How a rollout's lines map onto (repo, branch). Shared verbatim by the parent's own delta and
  // every subagent's — an agent's cwd may differ, and the memoized resolvers handle that.
  const resolvers = { cwd, repoRootOf, branchAt: branchOf };
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, resolvers);
  } catch {
    skipped.deltaFailed = true;
    return emptyResult();
  }
  const { nextCursor, segments, apiErrorEvents = [], rateLimitObservations = [] } = delta;

  // Recorded before anything can return early: the observations belong to lines this cursor is
  // about to advance past, so a checkpoint that bails later must not leave them unread. Local file
  // write only — the drain that posts them runs at turn end.
  if (options.persistState !== false && rateLimitObservations.length) {
    try {
      // One debounce decision, one row per allowed account. A queue this could not append to is
      // reported rather than thrown — see the contract on recordRateLimitObservations.
      const queued = recordRateLimitObservations(rateLimitObservations, targetKeys);
      if (queued && queued.skippedKeys && queued.skippedKeys.length) skipped.rateLimitDeferred = true;
    } catch {
      skipped.rateLimitDeferred = true;
      return emptyResult(); // keep the cursor so observations are retried
    }
  }

  // Billing is resolved HERE, after the delta, not before it: a quota or usage-limit error in this
  // window is proof of how the session bills, and that proof has to be in hand before the segments
  // it belongs to are stamped. Persisted so later sessions resolve correctly too — the switch that
  // produced it is invisible to process.env.
  let billingConfig = readBillingConfig();
  // Never persisted by the history import: an API-key quota error from months ago must not flip
  // TODAY's billing source. The import's payloads still reflect the current resolved config.
  const stamp = options.persistState === false
    ? null
    : isApiKeyBillingEvidence(apiErrorEvents)
      ? recordApiKeyEvidence(billingConfig)
      : isSubscriptionBillingEvidence(apiErrorEvents)
        ? recordSubscriptionEvidence(billingConfig)
        : null;
  if (stamp) {
    try { writeBillingConfig(stamp); } catch { /* best-effort */ }
    billingConfig = stamp;
  }
  // Both seams are threaded on purpose (G-10-1 L1/L3). Dropped, `resolveBilling` falls back to the
  // real `process.env` for step 1 of the ladder and opens the real `~/.codex/auth.json` for step 4,
  // so a caller that injected every other resolver still resolves billing off the host machine.
  //
  // `now` is handed over as an EPOCH, not as this file's clock function: resolveSource's `now` is a
  // number (`resolveSource` in billing-config.mjs), and passing the function through would make
  // every evidence-freshness comparison NaN and silently discard a fresh API-key stamp.
  const billingFields = resolveBilling(
    billingConfig,
    orDefault(deps.env, process.env),
    { now: now(), readCodexAuthSignals: deps.readCodexAuthSignals },
  );

  // The CHATGPT sign-in these numbers belong to — not a Beezi account, which is what `account`
  // means from 0.13 on. Explicit historical replays cannot infer their owner from today's sign-in.
  const chatgptIdentity = options.persistState === false ? {} : readChatgptIdentity(deps);

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  const timezone = detectTimezone();

  // Wall clock already billed this session, as a union of intervals — never a sum.
  // lib/active-time.mjs is the single definition of that rule and carries the measurement behind it.
  // Write-up: docs/plans/2026-09-15-comment-archive.md.
  let covered = mergeIntervals(Array.isArray(state.coveredIntervals) ? state.coveredIntervals : []);
  let coveredDirty = false;

  const enqueueSegments = (segs, segmentScope, extra = null) => {
    const isSubagent = !!(extra && extra.is_subagent);
    for (const seg of segs) {
      const intervals = Array.isArray(seg.activeIntervals) ? seg.activeIntervals : null;
      // Only the time nothing else has claimed. A caller that injected segments without intervals
      // (the test seam) keeps the scalar it supplied.
      const durationSec = intervals
        ? Math.round(totalMs(subtractIntervals(intervals, covered)) / 1000)
        : seg.stats.duration_sec;
      if (seg.stats.token_total === 0 && durationSec === 0) continue;
      const remote = orDefault(resolveRemote(seg.repoRoot), localRemote(orDefault(seg.repoRoot, cwd)));
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) { skipped.noRemote += 1; continue; }
      // Read the current instructions at the segment's OWN repo root, not the session cwd.
      // Historical imports use the same observation as live reports: this describes the file
      // available at collection time, not a reconstruction of its contents when the segment ran.
      const projectInstructions = projectInstructionsOf(seg.repoRoot);
      // A subagent runs its own context window, so the parent's occupancy is not its own and these
      // three never ship on a non-main segment. The server already nulls them there
      // (`session-report.service.ts` in the hb-ai-agent-portal repo), so this is hygiene rather
      // than correctness — but the payload must never state something the server will discard.
      // Byte-identical construct to the Claude plugin's own lib/checkpoint.mjs (the
      // beezi-claude-plugins repo); object rest is ES2018 and clears the ban gate.
      const { context_peak_tokens, context_final_tokens, context_final_model, ...statsSansContext } = seg.stats;
      const segStats = isSubagent ? statsSansContext : seg.stats;
      // Build the complete immutable transaction before publishing any payload.
      try {
        const payload = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId,
          remote,
          branch: clamp(seg.branch, BRANCH_MAX),
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...chatgptIdentity,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          // `claude_md_lines` is the established cross-agent wire field. On a Codex report it is
          // the line count of the selected root AGENTS file. The status key is a newer backend-first
          // addition: an older strict DTO rejects it rather than ignoring it.
          project_instructions_status: projectInstructions.status,
          ...(projectInstructions.status === 'present'
            ? { claude_md_lines: projectInstructions.lineCount }
            : {}),
          ...(extra || {}),
          ...segStats,
          // After the spread, deliberately: seg.stats carries the un-deduped scalar.
          duration_sec: durationSec,
        };
        payloads.push(payload);
        lastPayload = payload;
        enqueued += 1;
        // Claimed only on a successful write, so one failed segment cannot swallow the window for
        // the ones after it.
        if (intervals && intervals.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
      } catch { skipped.emitFailed += 1; /* abort publication after building the window */ }
    }
  };

  // Subagents first, the parent's own segments second. The parent sits blocked in wait_agent for the
  // whole fan-out, so that clock belongs to the agents that were actually working; billing them first
  // means the parent takes the residual rather than the other way round.
  const agentResults = ingestSubagents({
    sessionId,
    parentTranscriptPath: transcript_path,
    computeDelta,
    resolvers,
    enqueueSegments,
    // The import needs the sweep without the timeline POST: past sessions' hook sidecars are
    // pruned at 14 days, so the rollout-tree sweep is the only way it finds their subagents.
    sweep: options.emitTimeline === true || options.sweepSubagents === true,
    persist: options.persistState !== false,
    recovery: options.recovery === true || state.childRecoveryRequired === true,
    deps: { ...deps, writeAgent: (_parentId, agentId, childState) => children.push({ agentId, state: childState }) },
  });
  if (options.recovery) state.childRecoveryRequired = true;
  apiErrorEvents.push(...agentResults.apiErrorEvents);

  enqueueSegments(segments, sessionId);

  // Error reports run BEFORE the timeline POST, and both respect the budget. The ordering is
  // deliberate: the cursor advances below whether or not these landed, so an error that misses its
  // window is unrecoverable, while the timeline is re-derived from the whole transcript every turn
  // and simply retries. Anything the budget cuts off is parked in state.pendingErrors and drained
  // by the next checkpoint. postSessionError swallows its own failures (never rejects).
  // The history import buffers error reports instead of POSTing them: they are only worth a row
  // once the server has accepted the session's usage, which the import learns per batch, after
  // this call. It also must not drain state.pendingErrors — those belong to the live epoch.
  if (options.collectSessionErrors) {
    for (const event of apiErrorEvents) {
      collectedErrors.push({
        sessionId,
        error: orDefault(event.error, 'unknown'),
        errorDetails: orDefault(event.details, null),
        lastAssistantMessage: orDefault(event.text, null),
        occurredAt: orDefault(event.occurredAt, new Date().toISOString()),
        ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
      });
    }
  }
  const pending = options.collectSessionErrors
    ? []
    : [...(Array.isArray(state.pendingErrors) ? state.pendingErrors : []), ...apiErrorEvents];
  if (pending.length > 0) {
    const undelivered = [];
    for (const [i, event] of pending.entries()) {
      const remaining = timeLeft();
      if (remaining !== null && remaining <= 0) {
        undelivered.push(...pending.slice(i));
        break;
      }
      const errorPayload = {
        sessionId,
        error: orDefault(event.error, 'unknown'),
        errorDetails: orDefault(event.details, null),
        lastAssistantMessage: orDefault(event.text, null),
        occurredAt: orDefault(event.occurredAt, new Date().toISOString()),
        ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
      };
      // Every linked workspace is owed the failure, and the parked set is machine-level, so an
      // event is only retired once EVERY account took it. A retry can therefore re-post to an
      // account that already accepted one — which was always true of a request whose response was
      // lost, so the route already has to tolerate it; losing an error report for one tenant
      // because another was unreachable would not be.
      let deliveredEverywhere = true;
      for (const session of targets) {
        const left = timeLeft();
        if (left !== null && left <= 0) { deliveredEverywhere = false; break; }
        const { reported } = await postSessionError(
          errorPayload,
          session,
          { fetchImpl, ...(left === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, left) }) },
        );
        if (!reported) deliveredEverywhere = false;
      }
      if (!deliveredEverywhere) undelivered.push(event);
    }
    // Bounded: a session that cannot reach the server must not grow its state file without limit.
    const next = undelivered.slice(-MAX_PENDING_ERRORS);
    const before = Array.isArray(state.pendingErrors) ? state.pendingErrors : [];
    if (next.length !== before.length || JSON.stringify(next) !== JSON.stringify(before)) {
      state.pendingErrors = next;
      stateDirty = true;
    }
  }

  // The activity timeline is whole-session, so it's re-derived from the full transcript and shipped
  // only at turn-ends (Stop / SessionEnd) — not on the frequent PostToolUse:Bash path. Skip the POST
  // when the derived content is identical to the last one we sent (a Stop with no new activity), so
  // we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must never break the
  // checkpoint.
  if (options.emitTimeline) {
    try {
      // The agent map is handed over rather than re-read: ingestSubagents just built it, and its
      // sweep entries are ones a fresh readAgents would not see.
      const timeline = computeSessionTimeline(transcript_path, sessionId, {
        readAgents: () => agentResults.agents,
      });
      if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
        const sig = `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}`;
        // Skipped rather than started when the budget is already gone: the signature is only
        // recorded on a confirmed send, so the next turn re-derives and retries this same payload.
        if (sig !== state.sentTimelineSig && (timeLeft() === null || timeLeft() > 0)) {
          // The signature is machine-level, so it may only be remembered once every account has
          // the timeline: sealing it after a partial round would leave the accounts that missed
          // out with no timeline until the derived content changed again.
          let reportedEverywhere = true;
          for (const session of targets) {
            const remaining = timeLeft();
            if (remaining !== null && remaining <= 0) { reportedEverywhere = false; break; }
            const { reported } = await postSessionTimeline(
              { sessionId, ...timeline },
              session,
              { fetchImpl, ...(remaining === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, remaining) }) },
            );
            if (!reported) reportedEverywhere = false;
          }
          // Only remember the signature on a confirmed send, so a failed post retries next turn.
          if (reportedEverywhere) {
            state.sentTimelineSig = sig;
            stateDirty = true;
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // Rate-limit rows the rollout scan queued. Same turn-end gate as the timeline — these are
  // account-scoped observations, so posting them on every PostToolUse would be one request per
  // tool call describing a number that moves once a turn — plus an explicit opt-in for the manual
  // `/beezi:track` path, which is a turn end in every sense that matters and would otherwise queue
  // rows forever without ever shipping them.
  // The drain's own verdict, surfaced on the return rather than discarded (G-8-8). Null means the
  // drain never ran: this checkpoint was not a turn end, so "0 posted" would be a claim we cannot
  // make. `deferred` is normalised to 0 because the drain's two early exits ('no-token', 'empty')
  // report only `posted`.
  let rateLimits = null;
  if (options.emitTimeline === true || options.drainRateLimits === true) {
    const drainRateLimits = deps.drainRateLimitSnapshots == null
      ? _drainRateLimitSnapshots
      : deps.drainRateLimitSnapshots;
    try {
      const remaining = timeLeft();
      // Skipped rather than started on an exhausted budget: a negative timeout aborts the request
      // mid-flight, and the rows are only cleared on a confirmed store, so waiting for the next
      // turn end costs nothing but a self-inflicted failure costs a wasted POST.
      //
      // The deadline travels too, not just a per-request timeout: the drain is a serial loop over
      // up to 40 queued rows, so a cap alone bounds each request while the loop as a whole runs
      // well past the hook kill — taking the state write and flushQueue below down with it.
      if (remaining === null || remaining > 0) {
        // ONE deadline for all the accounts, not one each: the drains share the hook budget
        // rather than multiplying it, and whatever the budget cuts off stays queued per account.
        for (const session of targets) {
          const left = timeLeft();
          if (left !== null && left <= 0) break;
          const drained = await drainRateLimits(session.key, session, {
            fetchImpl,
            ...(deadline === null ? {} : { deadline, now, timeoutMs: POST_TIMEOUT_MS }),
          });
          if (!drained) continue;
          if (rateLimits === null) rateLimits = { posted: 0, deferred: 0 };
          rateLimits.posted += orDefault(drained.posted, 0);
          rateLimits.deferred += orDefault(drained.deferred, 0);
        }
      }
    } catch { /* best-effort */ }
  }

  // Codex retitles a session after the first prompt (the session_index thread_name). The new name
  // normally rides on the
  // next billable segment (each report re-reads it), but a session whose rename lands with no
  // further activity would keep the first-prompt title forever. So: remember the anchor segment
  // and the name we last sent; when the name changes but no new segment carried it, replay the
  // anchor with the corrected name. The server upserts by segmentId (idempotent tokens/cost) and
  // takes the latest non-null session_name, so this only fixes the name.
  if (enqueued > 0) {
    state.anchor = lastPayload;
    state.sentSessionName = sessionName;
    stateDirty = true;
  } else if (sessionName != null && sessionName !== state.sentSessionName && state.anchor) {
    try {
      payloads.push({ ...state.anchor, session_name: sessionName });
      state.sentSessionName = sessionName;
      stateDirty = true;
    } catch { /* best-effort; retry next checkpoint */ }
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    stateDirty = true;
  }
  if (coveredDirty) {
    state.coveredIntervals = covered;
    stateDirty = true;
  }
  // Remember where this session lives. The session's cwd drifts (cd, worktree switches)
  // while the rollout transcript path is fixed, so the track script (and the id-less transcript
  // resolver) reads this mapping instead of relying on process.cwd(). Only recorded once the
  // transcript has content, so an empty session writes no state.
  //
  // `sessionId` is recorded IN the file, not just as its name. findRolloutBySessionState
  // (`findRolloutBySessionState` in lib/transcript-codex.mjs) prefers the recorded id over the
  // filename precisely so a state file cannot answer with whatever string it happens to be named —
  // the read side of that guard is a no-op until this write lands. Old state files keep falling
  // through to the filename.
  if (nextCursor > 0
    && (state.cwd !== cwd || state.transcriptPath !== transcript_path || state.sessionId !== sessionId)) {
    state.cwd = orDefault(cwd, null);
    state.transcriptPath = transcript_path;
    state.sessionId = sessionId;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  // The one write that must never race, so it is the one write gated on still owning the lock.
  // `stillOwnsSession` above is where the expired-vs-lost rule is stated; this is the site it
  // protects. Aborting on 'lost' destroys nothing: the cursor simply does not advance, the window is
  // recomputed next checkpoint, and the server upserts by segmentId, so anything already enqueued is
  // idempotent. Write-up: docs/plans/2026-09-15-comment-archive.md.
  if (skipped.emitFailed || skipped.noRemote) return { ...emptyResult(), outcome: 'failed', reason: 'payload-build-failed' };
  let committedBoundaries;
  try {
    if (!stillOwnsSession(lock)) return { ...emptyResult(), reason: 'ownership-lost' };
    const tx = { version: 1, sessionId, payloads, children, state };
    if (durable) writeJsonDurable(transactionFile(sessionId), tx);
    committedBoundaries = commitTransaction(tx, lock, emit, deps, durable);
  } catch {
    skipped.emitFailed += 1;
    return { ...emptyResult(), outcome: 'failed', reason: 'transaction-commit-failed' };
  }
  // Deliberately unguarded: the repo-map is a machine-global dir→origin cache, and learning
  // origins from history is harmless and useful.
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  // The import owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  //
  // SERIAL over the accounts, sharing one deadline: flushQueue takes `shared:queue-<key>`, and two
  // rank-3 locks under different names at once in one process is a 'lock-order' refusal, which
  // would silently skip an account's drain rather than defer it.
  const flushes = [];
  if (!options.skipFlush) {
    for (const session of targets) {
      const drained = await flushQueue(session.key, session,
        { fetchImpl, now, ...(deadline === null ? {} : { deadline }) });
      flushes.push({ key: session.key, ...drained });
    }
  }
  // `agents` is the merged sidecar+sweep map — the import builds the session timeline from it
  // instead of re-reading (possibly pruned) sidecars.
  // `flush` is the machine-wide summary (one account's numbers when one is linked, which is what
  // every existing reader means by it); `flushes` is the per-account breakdown the track flow
  // words one line per account from.
  return {
    outcome: agentResults.childDeferred ? 'deferred' : 'committed',
    reason: agentResults.childDeferred ? 'child-coverage-unavailable' : null, committedBoundaries,
    enqueued, flush: options.skipFlush ? null : mergeFlushResults(flushes), flushes,
    sessionErrors: collectedErrors, skipped, rateLimits, agents: agentResults.agents,
  };
}

// The accounts' drains folded into one summary. Counters add, flags OR, and the first error stands
// — a caller asking "did the flush work" wants the worst answer any account gave, not an average.
function mergeFlushResults(results) {
  const merged = {
    flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0,
    quarantined: 0, salvaged: 0, unreadable: 0, unnamed: 0, routeAbsent: 0,
    trackingDisabled: false, lastError: null,
  };
  const counters = ['flushed', 'rejected', 'failed', 'deferred', 'expired',
    'quarantined', 'salvaged', 'unreadable', 'unnamed', 'routeAbsent'];
  for (const one of results) {
    if (!one) continue;
    for (const counter of counters) merged[counter] += orDefault(one[counter], 0);
    if (one.trackingDisabled) merged.trackingDisabled = true;
    if (one.lockSkipped) {
      merged.lockSkipped = true;
      merged.lockReason = orDefault(merged.lockReason, one.lockReason);
    }
    if (one.trackingDisabledWrite && !merged.trackingDisabledWrite) {
      merged.trackingDisabledWrite = one.trackingDisabledWrite;
    }
    if (merged.lastError === null) merged.lastError = orDefault(one.lastError, null);
  }
  return merged;
}

// Once tracking is off, queued reports are held for this long: a tenant that converts to paid
// inside the window flushes them normally on its first live session; after it they expire.
const QUEUE_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// Returns { flushed, rejected, failed, deferred, expired, quarantined, salvaged, unreadable,
// unnamed, trackingDisabled, lockSkipped, lockReason, lastError }. The four that are not their own
// names:
//   rejected     permanently declined by the server (4xx, e.g. branch not linked), as against
//                `failed`, which is transient or reversible and keeps the file for retry.
//   quarantined  unparseable, renamed to `<file>.corrupt` for inspection.
//   salvaged     recovered from a torn write and posted.
//   unnamed      carries a session id the plugin could not name, so it was left in place for the
//                quarantine sweep rather than posted.
// `lockSkipped` means another process held the queue lock and this pass deferred without reading
// the directory at all; `lockReason` carries the primitive's refusal. `trackingDisabledWrite` is
// present only when the server sent a dark-mode verdict.
// Write-up: docs/plans/2026-09-15-comment-archive.md.
export async function flushQueue(key, session, deps = {}) {
  const result = {
    flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0,
    quarantined: 0, salvaged: 0, unreadable: 0, unnamed: 0,
    // A SUBSET of `failed`, not an alternative to it. These files were refused because the route
    // was not there, which is a different fact from a server error even though the outcome for the
    // file is the same (kept, retried) — and the user still has to be told, which is why `failed`
    // counts them too. Carried as a counter rather than folded into `lastError` because
    // reconcileSession needs the COUNT: "is every leftover a 404" is the question it asks.
    routeAbsent: 0,
    trackingDisabled: false, lastError: null,
  };
  // What the drain LEARNED about the tenant, carried out of the critical section rather than acted
  // on inside it. Writing tracking.json takes `shared:tracking`, and rank-3 locks are never nested:
  // reaching for it while holding `shared:queue` is refused with 'lock-order', which fails forever
  // rather than being retryable, so the dark-mode verdict would be lost every single time.
  const verdict = { disabledByServer: false, reason: null };

  // ONE rank-3 `shared:queue-<key>` lock around the WHOLE drain (G-8-3 / R3). Every file in that
  // account's queue/ is read, POSTed and then unlinked, and two passes over the same directory
  // interleave those three steps: the losing pass re-POSTs a segment the winner already deleted
  // (idempotent server-side, merely wasteful) and, worse, its `unlinkSync` can remove a file the
  // other pass has not judged yet. `result.unreadable` — "a concurrent flush already unlinked it"
  // — is that race, counted.
  //
  // THE NAME CARRIES THE KEY, so two accounts never serialise against each other across processes
  // — and so a caller must never run two flushes at once IN one process: both are rank 3 under
  // different names, which is refused as 'lock-order' rather than waited out. Every fan-out site
  // drains the accounts one after another.
  //
  // The lock lives HERE, inside, so every caller is serialized without having to know: the two hook
  // paths through runCheckpoint, the CLI drain, and the bare caller in lib/session-start.mjs.
  //
  // Contention DEFERS rather than blocks. Nothing is lost by skipping — the files stay on disk and
  // the next checkpoint drains them — and a hook has a few milliseconds and no right to make the
  // holder wait.
  const run = await withLockAsync(
    sharedLock(`queue-${key}`),
    { leaseMs: QUEUE_LOCK_LEASE_MS },
    () => drainQueue(key, session, deps, result, verdict),
  );
  if (!run.ok) {
    result.lockSkipped = true;
    result.lockReason = run.reason;
    return result;
  }
  if (verdict.disabledByServer) {
    // Outside the queue lock by construction — see `verdict` above. withLockAsync released
    // `shared:queue` in its own finally before returning, so this is rank 3 AFTER rank 3, never
    // rank 3 inside it, which is exactly the sub-order the contract permits.
    //
    // The outcome is kept rather than discarded: 'held' is another writer and the next 403
    // re-records the verdict, but 'lock-order' would mean the release ordering above had broken
    // and every dark-mode verdict on this machine was being dropped in silence.
    try {
      result.trackingDisabledWrite = markTrackingDisabled(key, verdict.reason);
      if (result.trackingDisabledWrite.reason === 'lock-order') {
        recordIssue({
          code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED,
          source: DIAGNOSTIC_SOURCES.CHECKPOINT,
        });
      }
    } catch { /* best-effort */ }
  }
  return result;
}

// The drain itself. Split out of flushQueue so the lock above wraps it whole without re-indenting
// a hundred lines of judgement that has not changed.
async function drainQueue(key, session, deps, result, verdict) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const now = orDefault(deps.now, Date.now);
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  // Epoch ms after which no further report is started. Null = drain everything (the CLI path);
  // hooks pass one, because a serial loop with only a per-request bound costs N × that bound, and
  // Codex kills the hook — reporting a failure — long before a backlog against a stalled API is
  // drained. Deferring is free: the files stay on disk and the next checkpoint retries them.
  const deadline = orDefault(deps.deadline, null);
  const onRequestTimeout = orDefault(deps.onRequestTimeout, () => {});

  const dir = queueDir(key);

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire. One tenant going dark says
  // nothing about the others — only this account's queue is held.
  if (!isLiveTrackingAllowed(key)) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result, now());
    return;
  }

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    // Only queued payloads, and filtered HERE rather than inside the loop so `result.deferred`
    // counts postable files instead of dirents. Two things this skips, neither ever postable: the
    // `.tmp` writeJsonSecure leaves behind when a hard kill lands between the temp write and the
    // rename (fs-store.mjs — the temp is a sibling of its target), and the `.corrupt` files
    // quarantined below. pruneStale expires both at 14 days. The house pattern two modules over
    // already does this — `readAgents`/`pruneAgents` in subagent-state.mjs and
    // `findRolloutBySessionId` in transcript-codex.mjs; the queue drain was the one outlier, and an
    // unfiltered readdir is how a truncated `.tmp` got re-read on every flush forever.
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }

  // A 401 here is usually an access token that expired between the checkpoint's own token read and
  // this flush, not a revoked link — expires_at is only our estimate. Renew once for THIS ACCOUNT
  // and reuse the replacement for the rest of its queue. A file that still 401s afterwards is
  // kept, never dropped: an unjudged report must not be destroyed on a verdict we aren't sure of.
  //
  // The renewal is keyed: a bare getAccessToken() would refuse outright now, and a renewal that
  // reached for "the" token would hand this account's queue another account's bearer.
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    // The renewal is itself a network round trip; skip it once the budget is gone.
    if (deadline !== null && now() >= deadline) return null;
    const next = await getAccessToken(key, {}, { forceRefresh: true }).catch(() => null);
    if (!next || next === session.token) return null;
    // The client id is unchanged by a refresh — only the bearer moves.
    session = { ...session, token: next };
    return session;
  };

  for (const [index, file] of files.entries()) {
    if (deadline !== null && now() >= deadline) {
      result.deferred = files.length - index;
      break;
    }
    const filePath = path.join(dir, file);
    const salvage = readJsonSalvaged(filePath);
    const payload = salvage.value;
    if (salvage.unreadable) {
      // Could not be OPENED — a concurrent flush already unlinked it, or an AV scanner has it
      // locked for a moment. Nothing is known about its contents, so it is left exactly where it
      // is for the next pass. This is the one case that must NOT quarantine: renaming a payload
      // that was merely unavailable this instant removes a good report from the drain permanently.
      result.unreadable += 1;
      continue;
    }
    if (payload == null || (salvage.salvaged && payload.segmentId == null)) {
      // Parsed and found unusable — nothing recoverable, or a salvaged prefix with no segmentId,
      // which the server's idempotency key cannot address. Quarantine rather than `continue`: an
      // unparseable file used to be re-read on every flush (every PostToolUse and every Stop) for
      // fourteen days with zero signal, and then pruneStale deleted it and the session's analytics
      // went with it. `.corrupt` keeps the bytes where an operator can look at them, takes the file
      // out of the drain, and is counted in the result so the count is not invisible either.
      result.quarantined += 1;
      result.lastError = orDefault(result.lastError, `quarantined unparseable queue file ${file}`);
      // The one place a segment's analytics are taken out of the drain for good. The count above is
      // local and nobody reads it after the process exits, so without this the only trace of a
      // machine that quarantines every payload is a `.corrupt` file the user never looks at.
      // recordIssue is consent-gated, never throws and carries no payload content — only the code,
      // the source and the environment fields.
      recordIssue({
        code: DIAGNOSTIC_CODES.QUEUE_FILE_QUARANTINED,
        source: DIAGNOSTIC_SOURCES.CHECKPOINT,
      });
      try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
      continue;
    }
    // A report queued under a session id the plugin could not name — `queue/null_1-18.json`, written
    // by an older build before the resolver refused to answer with one. It must NOT be posted: the
    // server rejects it, this drain treats a 4xx as permanent, and the `fs.unlinkSync` below would
    // DELETE it. That destroys unreported analytics — the file holds real tokens, real cost and a
    // real segment window, and only its session id is wrong, which a human can still re-attribute
    // from the segment identity inside it. So it is left exactly where it is, out of the drain but
    // on disk, for quarantinePoisonedSessionState (lib/transcript-codex.mjs) to relocate under
    // `quarantine/` on the next `track`. Counted, so the skip is not invisible either.
    //
    // Only a PRESENT id is judged: an absent `sessionId` is not evidence of this bug, and narrowing
    // to what is actually there keeps the check from re-deciding payloads it knows nothing about.
    if (payload.sessionId !== undefined && !isUsableSessionId(payload.sessionId)) {
      result.unnamed += 1;
      result.lastError = orDefault(result.lastError, `skipped queue file with an unusable session id ${file}`);
      continue;
    }
    if (salvage.salvaged) result.salvaged += 1;

    // Never hand a request more time than the budget has left, or the last one overruns the kill.
    const perRequest = deadline === null
      ? undefined
      : Math.max(1, Math.min(POST_TIMEOUT_MS, deadline - now()));
    if (perRequest !== undefined) onRequestTimeout(perRequest);

    try {
      const post = (as) => postJson(reportUrl, as, payload, {
        fetchImpl,
        ...(perRequest === undefined ? {} : { timeoutMs: perRequest }),
      });
      let res = await post(session);
      if (res.status === 401) {
        const next = await renewToken();
        if (next) res = await post(next);
      }
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status === 401) {
        // Still rejected after a renewal (or there was none to make). Keep the file: the link
        // may genuinely be revoked, but that is the user's to fix, and re-linking should not
        // find their analytics already deleted.
        result.failed += 1;
        result.lastError = 'HTTP 401';
      } else if (res.status === 403) {
        // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
        // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
        // flush if the tenant converts within the window, and expire after it. A code-less 403
        // (seat revoked, deactivated user) is reversible: keep the file, count it failed.
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON body */ }
        if (body && body.code === 'TRACKING_DISABLED') {
          // RECORDED, not written: markTrackingDisabled runs after the queue lock is released.
          verdict.disabledByServer = true;
          verdict.reason = orDefault(body.message, null);
          result.trackingDisabled = true;
          result.lastError = orDefault(body.message, 'HTTP 403');
          sweepHeldQueue(dir, result, now());
          break;
        }
        result.failed += 1;
        result.lastError = orDefault((body || {}).message, `HTTP ${res.status}`);
      } else if (res.status === 404 || res.status === 405) {
        // NOT a verdict on the payload. A 404 is "this route is not here" — an older server, a
        // proxy in front of the API, an apiBase pointed somewhere else — and deleting a real
        // segment's tokens and cost over a missing route is unrecoverable. lib/audit-flush.mjs
        // already treats 404/405 as UNSUPPORTED_SERVER and retryable for exactly this reason; the
        // queue drain was the outlier. Kept, counted failed, and expired by pruneStale at 14 days
        // if the route never appears.
        result.failed += 1;
        result.routeAbsent += 1;
        result.lastError = `HTTP ${res.status}`;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = orDefault((body || {}).message, `HTTP ${res.status}`);
        } catch {
          result.lastError = `HTTP ${res.status}`;
        }
        fs.unlinkSync(filePath);
      } else {
        result.failed += 1; // keep for retry
      }
    } catch {
      result.failed += 1; // keep file for retry on network error / throw
    }
  }

}
