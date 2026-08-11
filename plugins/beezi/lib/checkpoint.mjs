import fs from 'node:fs';
import path from 'node:path';
import { computeDelta as _computeDelta } from './delta-codex.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { resolveCodexTranscript } from './transcript-codex.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, POST_TIMEOUT_MS } from './http.mjs';
import { HOOK_TIMEOUT_SEC } from './hooks-install.mjs';
import { postSessionError } from './session-error-report.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline-codex.mjs';
import { isApiKeyBillingEvidence, isSubscriptionBillingEvidence } from './billing.mjs';
import {
  readBillingConfig,
  writeBillingConfig,
  resolveBilling,
  recordApiKeyEvidence,
  recordSubscriptionEvidence,
} from './billing-config.mjs';
import { resolveSessionName as _resolveSessionName, isSafeSessionName } from './session-name-codex.mjs';
import { readJson, writeJsonSecure, safeFileName } from './fs-store.mjs';
import { isLiveTrackingAllowed, markTrackingDisabled } from './tracking.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { mergeIntervals, subtractIntervals, totalMs, claimIntervals } from './active-time.mjs';
import { readAgents as _readAgents, writeAgent as _writeAgent } from './subagent-state.mjs';
import {
  inspectSubagentRollout as _inspectSubagentRollout,
  findSubagentRollouts as _findSubagentRollouts,
  rolloutStartedAt as _rolloutStartedAt,
} from './subagent-codex.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {
    cursor: 0,
    sentSessionName: null,
    anchor: null,
  });
}

function saveState(id, state) {
  writeJsonSecure(path.join(stateDir(), `${id}.json`), state);
}

function enqueue(payload) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  //
  // safeFileName, not a targeted replace: a subagent segmentId embeds an agent id that arrived on a
  // hook payload, so this name is partly untrusted input.
  writeJsonSecure(path.join(queueDir(), `${safeFileName(payload.segmentId, { max: 200 })}.json`), payload);
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
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
  sessionId, parentTranscriptPath, computeDelta, resolvers, enqueueSegments, sweep, persist = true, deps = {},
}) {
  const readAgents = deps.readAgents ?? _readAgents;
  const writeAgent = deps.writeAgent ?? _writeAgent;
  const inspectRollout = deps.inspectSubagentRollout ?? _inspectSubagentRollout;
  const findRollouts = deps.findSubagentRollouts ?? _findSubagentRollouts;
  const startedAt = deps.rolloutStartedAt ?? _rolloutStartedAt;
  const apiErrorEvents = [];

  let agents;
  try { agents = readAgents(sessionId); } catch { agents = {}; }

  if (sweep) {
    try {
      // The parent's own start bounds the scan: a subagent cannot predate the session that spawned
      // it. Without it this walks every rollout the machine has ever written.
      const since = startedAt(parentTranscriptPath);
      for (const { agentId, path: rolloutPath } of findRollouts(sessionId, { sinceMs: since })) {
        if (!agents[agentId]) agents[agentId] = { agent_id: agentId };
        agents[agentId].transcriptPath ??= rolloutPath;
      }
    } catch { /* best-effort: the sidecars are still authoritative */ }
  }

  // Deterministic order so the coverage union is reproducible across runs.
  const ordered = Object.entries(agents).sort((a, b) => {
    const at = Date.parse(a[1]?.started_at ?? '') || 0;
    const bt = Date.parse(b[1]?.started_at ?? '') || 0;
    return at - bt || String(a[0]).localeCompare(String(b[0]));
  });

  for (const [agentId, record] of ordered) {
    const rolloutPath = record?.transcriptPath;
    if (typeof rolloutPath !== 'string' || !rolloutPath) continue;

    // Null covers unreadable, not-a-subagent, and a fork whose replayed prefix could not be
    // delimited — that last one must be skipped rather than billed from line 0, which would charge
    // the parent's own history to the agent. See forkPrefixBoundary.
    let inspected;
    try { inspected = inspectRollout(rolloutPath); } catch { inspected = null; }
    if (!inspected) continue;

    // The import ignores stored cursors on purpose: a dark-mode tenant's live hooks advanced
    // them while every report was 403-dropped, so honoring them would bill only session tails.
    const from = persist && Number.isInteger(record?.cursor) ? record.cursor : inspected.forkBoundaryLine;
    let delta;
    try {
      delta = computeDelta(rolloutPath, from, resolvers);
    } catch { continue; }

    // segmentId is scoped by agent id because the server's idempotency key is `segmentId::model` and
    // does NOT include agent_id. Two agents both starting at their own fork boundary produce
    // identical line windows, so without this scope the second would overwrite the first.
    enqueueSegments(delta.segments, `${sessionId}:${agentId}`, {
      is_subagent: true,
      agent_id: String(agentId).slice(0, 200),
      agent_type: record?.agent_type ? String(record.agent_type).slice(0, 100) : null,
      agent_name: inspected.agentNickname ? String(inspected.agentNickname).slice(0, 200) : null,
      // Omitted rather than nulled when it is not a non-negative integer — the field is optional and
      // the clamp keeps a malformed value out of the payload entirely.
      ...(Number.isInteger(inspected.spawnDepth) && inspected.spawnDepth >= 0
        ? { spawn_depth: inspected.spawnDepth }
        : {}),
    });

    // An agent that dies on an API error never ends the parent's turn, so no Stop fires for it and
    // its own rollout is the only record that the failure happened.
    apiErrorEvents.push(...(delta.apiErrorEvents ?? []));

    if (persist && delta.nextCursor !== from) {
      try {
        writeAgent(sessionId, agentId, { cursor: delta.nextCursor, transcriptPath: rolloutPath });
      } catch { /* best-effort; re-derived next checkpoint */ }
    }
  }

  return { apiErrorEvents, agents };
}

// Cap on error reports carried forward in session state. An error whose POST missed the hook
// budget is unrecoverable once the cursor advances, so it is parked rather than dropped — but a
// machine that can never reach the server must not grow its state file forever. Newest wins.
const MAX_PENDING_ERRORS = 20;

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush } — flush is the flushQueue summary (or null when it never ran).
// `options.budgetMs` bounds the network work: hooks pass it, the CLI (track.mjs) does not, because
// a user waiting at a terminal would rather see the whole queue drained than a partial flush.
export async function runCheckpoint(input, deps = {}, options = {}) {
  const { session_id, cwd } = input;
  const now = deps.now ?? Date.now;
  const deadline = options.budgetMs ? now() + options.budgetMs : null;
  const timeLeft = () => (deadline === null ? null : deadline - now());
  // Where a built payload goes. The history import collects them in memory and batches them
  // itself; letting it fall through to the disk queue would drip-feed hundreds of segments to
  // the single-report endpoint on the next hook, bypassing the batch route's whole-session dedupe.
  const emit = options.sink ?? enqueue;
  const collectedErrors = [];
  // Why segments did not become reports. A caller that gets zero reports cannot otherwise tell a
  // session that genuinely holds no usage (a transcript with no assistant tokens — nothing to
  // upload, and nothing wrong) from one we dropped for a reason worth reporting. Only the
  // problem cases are counted: "no usage" is the absence of all of them.
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false };
  const emptyResult = () => ({ enqueued: 0, flush: null, sessionErrors: collectedErrors, skipped });
  // PostToolUse / Stop hooks don't carry `transcript_path`; resolve the rollout from the session
  // id (or the cwd mapping in state). SessionEnd does provide it — resolveCodexTranscript prefers
  // the given path when present. No resolvable transcript → nothing to checkpoint.
  const resolveTranscript = deps.resolveTranscript ?? resolveCodexTranscript;
  const resolved = resolveTranscript(input);
  if (!resolved) return emptyResult();
  const transcript_path = resolved.transcriptPath;
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let token = null;
  try { token = await getAccessToken(); } catch { return emptyResult(); }
  if (!token) return emptyResult();

  // Tenant gate: audit-mode workspaces never track live — the server would 403 every report
  // anyway (TrackingEnabledGuard), this just spares the work and the noise. `gated` lets the
  // track script tell "tracking is off" apart from "nothing new". The history import passes
  // skipLiveTrackingGate — an explicit flag, never inferred from the sink seam.
  if (options.skipLiveTrackingGate !== true && !isLiveTrackingAllowed()) {
    return { ...emptyResult(), gated: true };
  }

  // Below the token gate: skip this work entirely on an unlinked machine.
  const resolveSessionName = deps.resolveSessionName ?? _resolveSessionName;
  const resolvedSessionName = resolveSessionName(session_id, transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();

  // Persisted known-root map: seeds resolution (prefix match) and gets refreshed with any root→origin
  // we learn this checkpoint. A best-effort hint — a load failure yields an empty map, not a throw.
  const map = loadRepoMap();
  let mapDirty = false;

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache, map);

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
    : loadState(session_id);
  let stateDirty = false;
  // When the session file is unreadable (name resolves to null), keep the last name we sent rather
  // than overwriting the stored name with null — but only while that name is still one we would
  // send today. An older resolver captured Codex's injected context blocks as names (absolute home
  // paths, XML preambles); left in state, such a name is re-sent on every checkpoint forever, so
  // drop it here and let the next successful resolution replay the anchor with a real one.
  const storedName = typeof state.sentSessionName === 'string' ? state.sentSessionName : null;
  const stored = storedName && isSafeSessionName(storedName) ? storedName : null;
  if (storedName && !stored) {
    state.sentSessionName = null;
    stateDirty = true;
  }
  const sessionName = resolvedSessionName ?? stored ?? null;
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
  const { nextCursor, segments, apiErrorEvents = [] } = delta;

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
  const billingFields = resolveBilling(billingConfig);

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  const timezone = detectTimezone();

  // Wall clock already billed this session, as a union of intervals. A subagent and its parent
  // describe the SAME stretch of clock — the parent blocks in wait_agent while the agent works — so
  // summing their durations bills those seconds twice. Measured locally: one parent and three agents
  // spanning 431s of wall clock summed to 1117s.
  let covered = mergeIntervals(Array.isArray(state.coveredIntervals) ? state.coveredIntervals : []);
  let coveredDirty = false;

  const enqueueSegments = (segs, segmentScope, extra = null) => {
    for (const seg of segs) {
      const intervals = Array.isArray(seg.activeIntervals) ? seg.activeIntervals : null;
      // Only the time nothing else has claimed. A caller that injected segments without intervals
      // (the test seam) keeps the scalar it supplied.
      const durationSec = intervals
        ? Math.round(totalMs(subtractIntervals(intervals, covered)) / 1000)
        : seg.stats.duration_sec;
      if (seg.stats.token_total === 0 && durationSec === 0) continue;
      const remote = resolveRemote(seg.repoRoot) ?? localRemote(seg.repoRoot ?? cwd);
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) { skipped.noRemote += 1; continue; }
      // A single write failure must not abort the window (which would leave the cursor
      // unadvanced and re-process everything forever) — skip that segment and continue.
      try {
        const payload = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId: session_id,
          remote,
          branch: seg.branch,
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(extra || {}),
          ...seg.stats,
          // After the spread, deliberately: seg.stats carries the un-deduped scalar.
          duration_sec: durationSec,
        };
        emit(payload);
        lastPayload = payload;
        enqueued += 1;
        // Claimed only on a successful write, so one failed segment cannot swallow the window for
        // the ones after it.
        if (intervals?.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
      } catch { skipped.emitFailed += 1; /* keep going; the cursor still advances below */ }
    }
  };

  // Subagents first, the parent's own segments second. The parent sits blocked in wait_agent for the
  // whole fan-out, so that clock belongs to the agents that were actually working; billing them first
  // means the parent takes the residual rather than the other way round.
  const agentResults = ingestSubagents({
    sessionId: session_id,
    parentTranscriptPath: transcript_path,
    computeDelta,
    resolvers,
    enqueueSegments,
    // The import needs the sweep without the timeline POST: past sessions' hook sidecars are
    // pruned at 14 days, so the rollout-tree sweep is the only way it finds their subagents.
    sweep: options.emitTimeline === true || options.sweepSubagents === true,
    persist: options.persistState !== false,
    deps,
  });
  apiErrorEvents.push(...agentResults.apiErrorEvents);

  enqueueSegments(segments, session_id);

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
        sessionId: session_id,
        error: event.error ?? 'unknown',
        errorDetails: event.details ?? null,
        lastAssistantMessage: event.text ?? null,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
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
      const { reported } = await postSessionError(
        {
          sessionId: session_id,
          error: event.error ?? 'unknown',
          errorDetails: event.details ?? null,
          lastAssistantMessage: event.text ?? null,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
        },
        token,
        { fetchImpl, ...(remaining === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, remaining) }) },
      );
      if (!reported) undelivered.push(event);
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
      const timeline = computeSessionTimeline(transcript_path, session_id, {
        readAgents: () => agentResults.agents,
      });
      if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
        const sig = `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}`;
        // Skipped rather than started when the budget is already gone: the signature is only
        // recorded on a confirmed send, so the next turn re-derives and retries this same payload.
        if (sig !== state.sentTimelineSig && (timeLeft() === null || timeLeft() > 0)) {
          const remaining = timeLeft();
          const { reported } = await postSessionTimeline(
            { sessionId: session_id, ...timeline },
            token,
            { fetchImpl, ...(remaining === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, remaining) }) },
          );
          // Only remember the signature on a confirmed send, so a failed post retries next turn.
          if (reported) {
            state.sentTimelineSig = sig;
            stateDirty = true;
          }
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
      emit({ ...state.anchor, session_name: sessionName });
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
  if (nextCursor > 0 && (state.cwd !== cwd || state.transcriptPath !== transcript_path)) {
    state.cwd = cwd ?? null;
    state.transcriptPath = transcript_path;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  if (stateDirty && options.persistState !== false) {
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }
  // Deliberately unguarded: the repo-map is a machine-global dir→origin cache, and learning
  // origins from history is harmless and useful.
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  // The import owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  const flush = options.skipFlush
    ? null
    : await flushQueue(token, { fetchImpl, now, ...(deadline === null ? {} : { deadline }) });
  // `agents` is the merged sidecar+sweep map — the import builds the session timeline from it
  // instead of re-reading (possibly pruned) sidecars.
  return { enqueued, flush, sessionErrors: collectedErrors, skipped, agents: agentResults.agents };
}

// Once tracking is off, queued reports are held for this long: a tenant that converts to paid
// inside the window flushes them normally on its first live session; after it they expire.
export const QUEUE_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now = Date.now()) {
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

// Returns { flushed, rejected, failed, deferred, expired, trackingDisabled, lastError } —
// flushed = accepted (2xx), rejected = permanently declined by the server (4xx, e.g. branch not
// linked), failed = transient or reversible (5xx/network/code-less 403, file kept for retry),
// deferred = budget ran out, expired = held files past the 3-day window, trackingDisabled = the
// workspace is dark (audit mode) and the flush stopped.
export async function flushQueue(token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  // Epoch ms after which no further report is started. Null = drain everything (the CLI path);
  // hooks pass one, because a serial loop with only a per-request bound costs N × that bound, and
  // Codex kills the hook — reporting a failure — long before a backlog against a stalled API is
  // drained. Deferring is free: the files stay on disk and the next checkpoint retries them.
  const deadline = deps.deadline ?? null;
  const onRequestTimeout = deps.onRequestTimeout ?? (() => {});
  const result = { flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0, trackingDisabled: false, lastError: null };

  const dir = queueDir();

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire.
  if (!isLiveTrackingAllowed()) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result, now());
    return result;
  }

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }

  // A 401 here is usually an access token that expired between the checkpoint's getAccessToken()
  // and this flush, not a revoked link — expires_at is only our estimate. Renew once, machine-wide,
  // and reuse the replacement for the rest of the queue. A file that still 401s afterwards is kept,
  // never dropped: an unjudged report must not be destroyed on a verdict we aren't sure of.
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    // The renewal is itself a network round trip; skip it once the budget is gone.
    if (deadline !== null && now() >= deadline) return null;
    const next = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    if (!next || next === token) return null;
    token = next;
    return next;
  };

  for (const [index, file] of files.entries()) {
    if (deadline !== null && now() >= deadline) {
      result.deferred = files.length - index;
      break;
    }
    const filePath = path.join(dir, file);
    const payload = readJson(filePath);
    if (payload == null) continue;

    // Never hand a request more time than the budget has left, or the last one overruns the kill.
    const perRequest = deadline === null
      ? undefined
      : Math.max(1, Math.min(POST_TIMEOUT_MS, deadline - now()));
    if (perRequest !== undefined) onRequestTimeout(perRequest);

    try {
      const post = (bearer) => postJson(reportUrl, bearer, payload, {
        fetchImpl,
        ...(perRequest === undefined ? {} : { timeoutMs: perRequest }),
      });
      let res = await post(token);
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
        if (body?.code === 'TRACKING_DISABLED') {
          try { markTrackingDisabled(body?.message ?? null); } catch { /* best-effort */ }
          result.trackingDisabled = true;
          result.lastError = body?.message ?? 'HTTP 403';
          sweepHeldQueue(dir, result, now());
          break;
        }
        result.failed += 1;
        result.lastError = body?.message ?? `HTTP ${res.status}`;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body?.message ?? `HTTP ${res.status}`;
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

  return result;
}
