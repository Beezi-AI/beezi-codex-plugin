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
import { resolveSessionName as _resolveSessionName } from './session-name-codex.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';

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
  const filename = payload.segmentId.replace(/[:/\s]/g, '_') + '.json';
  writeJsonSecure(path.join(queueDir(), filename), payload);
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
  // PostToolUse / Stop hooks don't carry `transcript_path`; resolve the rollout from the session
  // id (or the cwd mapping in state). SessionEnd does provide it — resolveCodexTranscript prefers
  // the given path when present. No resolvable transcript → nothing to checkpoint.
  const resolveTranscript = deps.resolveTranscript ?? resolveCodexTranscript;
  const resolved = resolveTranscript(input);
  if (!resolved) return { enqueued: 0, flush: null };
  const transcript_path = resolved.transcriptPath;
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let token = null;
  try { token = await getAccessToken(); } catch { return { enqueued: 0, flush: null }; }
  if (!token) return { enqueued: 0, flush: null };

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

  const state = loadState(session_id);
  // When the session file is unreadable (name resolves to null), keep the last name we sent
  // rather than overwriting the stored name with null.
  const sessionName = resolvedSessionName ?? state.sentSessionName ?? null;
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, { cwd, repoRootOf, branchAt: branchOf });
  } catch {
    return { enqueued: 0, flush: null };
  }
  const { nextCursor, segments, apiErrorEvents = [] } = delta;

  // Billing is resolved HERE, after the delta, not before it: a quota or usage-limit error in this
  // window is proof of how the session bills, and that proof has to be in hand before the segments
  // it belongs to are stamped. Persisted so later sessions resolve correctly too — the switch that
  // produced it is invisible to process.env.
  let billingConfig = readBillingConfig();
  const stamp = isApiKeyBillingEvidence(apiErrorEvents)
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
  const enqueueSegments = (segs, segmentScope, extra = null) => {
    for (const seg of segs) {
      if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;
      const remote = resolveRemote(seg.repoRoot) ?? localRemote(seg.repoRoot ?? cwd);
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) continue;
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
        };
        enqueue(payload);
        lastPayload = payload;
        enqueued += 1;
      } catch { /* keep going; the cursor still advances below */ }
    }
  };
  enqueueSegments(segments, session_id);

  // No subagent windows here. Codex does spawn subagents, but it writes each one to its OWN
  // top-level rollout (`thread_source: "subagent"`, `source: {subagent: …}`) rather than nesting it
  // under this session, and that rollout holds no reference to its parent — so there is nothing to
  // enumerate from this transcript. Unlike the Claude engine, this is a gap in what we read, not an
  // absence of subagents. See lib/session-timeline-codex.mjs for the same caveat.

  let stateDirty = false;

  // Error reports run BEFORE the timeline POST, and both respect the budget. The ordering is
  // deliberate: the cursor advances below whether or not these landed, so an error that misses its
  // window is unrecoverable, while the timeline is re-derived from the whole transcript every turn
  // and simply retries. Anything the budget cuts off is parked in state.pendingErrors and drained
  // by the next checkpoint. postSessionError swallows its own failures (never rejects).
  const pending = [...(Array.isArray(state.pendingErrors) ? state.pendingErrors : []), ...apiErrorEvents];
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
      const timeline = computeSessionTimeline(transcript_path, session_id);
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
      enqueue({ ...state.anchor, session_name: sessionName });
      state.sentSessionName = sessionName;
      stateDirty = true;
    } catch { /* best-effort; retry next checkpoint */ }
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
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
  if (stateDirty) {
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  const flush = await flushQueue(token, { fetchImpl, now, ...(deadline === null ? {} : { deadline }) });
  return { enqueued, flush };
}

// Returns { flushed, rejected, failed, lastError } — flushed = accepted (2xx),
// rejected = permanently declined by the server (4xx, e.g. branch not linked),
// failed = transient (5xx/network, file kept for retry).
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
  const result = { flushed: 0, rejected: 0, failed: 0, deferred: 0, lastError: null };

  const dir = queueDir();
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
