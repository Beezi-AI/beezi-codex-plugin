import fs from 'fs';
import { IDLE_GAP_SEC } from './timing.mjs';
import { orDefault } from './compat.mjs';
import { computeCodeChanges } from './code-changes-codex.mjs';
import { computeOperations, parseArgs, operationContext, operationWindowEnd } from './operations-codex.mjs';
import { buildActiveIntervals, totalMs } from './active-time.mjs';
import { rateLimitObservationFromRecord } from './rate-limits-codex.mjs';

// Attribute new Codex rollout activity to (repoRoot, branch) and bill token usage per segment.
//
// Codex records the whole session's token usage as a MONOTONIC cumulative total on `token_count`
// events (`payload.info.total_token_usage`). The per-turn `last_token_usage` field overlaps and
// double-counts, so the reliable delta model is: increment = total(now) − total(prev token_count),
// attributed to the run active at that event. This mirrors the Claude engine's cursor/delta shape.
//
// Invariants verified against real rollouts (universal):
//   total_tokens          = input_tokens + output_tokens
//   cached_input_tokens  ⊆ input_tokens                 (a subset — cache hits within input)
//   reasoning_output_tokens ⊆ output_tokens             (a breakdown of output — not added on top)
// Cache writes are also a subset of input, disjoint from cache reads (OpenAI prompt-caching
// usage accounting). Codex maps input_tokens_details.cache_write_tokens to cache_write_input_tokens.
// So ordinary input = Δ(input) − Δ(cached) − Δ(cacheWrite); each cache leg is priced separately.
//
// cwd (and thus repo) is authoritative per turn: `session_meta.cwd` seeds it, `turn_context.cwd`
// updates it as the session cd's, and a shell tool's `arguments.workdir` refines it. The current
// model comes from `turn_context.model` and the current reasoning effort from `turn_context.effort`.
// Token-count events carry none of them, so we bill the increment to whatever cwd/model/effort is
// active when the event lands.
//
// Three dimensions ride on top of that same walk, all of them already whitelisted server-side:
//   models[m].by_effort[e]  — a PARTITION of the model tally, accumulated in one loop with it so
//                             the server's per-bucket prices always sum to the model's.
//   context_*               — context-window OCCUPANCY, from `last_token_usage`, never the
//                             cumulative `total_token_usage` and never Claude's additive formula.
//   tokenSourceMissing      — a client-local canary for `token_usage_record` (see below). It adds
//                             no wire field and parses nothing.

function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// The cwd a single rollout record implies, or null (caller carries the previous cwd forward).
function cwdFromRecord(rec) {
  const p = rec && rec.payload;
  if (!p) return null;
  if (rec.type === 'session_meta') return typeof p.cwd === 'string' ? norm(p.cwd) : null;
  if (rec.type === 'turn_context') return typeof p.cwd === 'string' ? norm(p.cwd) : null;
  if (rec.type === 'response_item' && p.type === 'function_call') {
    const args = parseArgs(p.arguments);
    const workdir = args && typeof args.workdir === 'string' ? args.workdir : null;
    return workdir ? norm(workdir) : null;
  }
  return null;
}

function modelFromRecord(rec) {
  const p = rec && rec.payload;
  if (rec && rec.type === 'turn_context' && p && typeof p.model === 'string') return p.model;
  return null;
}

// The effort key ends up in the server's `effort` varchar(50) and inside source_ref;
// SessionReportEffortUsageDto's IsEffortUsageRecord rejects a key longer than 50 (or empty), and a
// rejection 400s the WHOLE segment — its tokens, cost, code changes and operations with it.
const MAX_EFFORT_KEY = 50;

// The reasoning effort the turn ran at. Rides `turn_context` beside `model`, so it is tracked the
// same way and for the same reason: a token_count event carries neither, and bills to whatever the
// surrounding turn declared.
//
// `payload.effort` and not `collaboration_mode.reasoning_effort`: over every local record carrying
// both they agreed 802 times and disagreed 0 times, and `effort` is present on 3623 records where
// `reasoning_effort` is absent. `effort` is the superset — classify by the field that is actually
// populated.
function effortFromRecord(rec) {
  const p = rec && rec.payload;
  if (rec && rec.type === 'turn_context' && p && typeof p.effort === 'string' && p.effort !== '') {
    return p.effort.slice(0, MAX_EFFORT_KEY);
  }
  return null;
}

// { input, cached, cacheWrite, output } cumulative totals from a token_count event, or null.
function totalsFromRecord(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'event_msg' || !p || p.type !== 'token_count') return null;
  const u = (p.info || {}).total_token_usage;
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    cached: u.cached_input_tokens || 0,
    cacheWrite: u.cache_write_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

// Context OCCUPANCY at this request, not the session's cumulative total. `last_token_usage`
// describes ONE request, so its input_tokens IS that request's whole prompt — the context the model
// was carrying at that instant. `cached_input_tokens` is a SUBSET of it (10368/10368), not a
// sibling to add: porting the Claude engine's additive formula (delta.mjs in the
// beezi-claude-plugins repo, where the cache legs ARE disjoint from input) overflows
// model_context_window in 14.4% of local observations, peaking at 1.77x capacity. `input_tokens`
// alone never exceeded it once (max 0.908x).
//
// `total_token_usage` must never be used here — it is cumulative, one local session reached
// 25 783 494 against a 258 400 window, and the DTO's `@IsInt() @Min(0)` has no upper bound, so a
// ~100x-capacity reading would be stored and charted as a real one.
function contextTokensFromRecord(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'event_msg' || !p || p.type !== 'token_count') return null;
  const u = (p.info || {}).last_token_usage;
  if (!u || typeof u.input_tokens !== 'number' || !isFinite(u.input_tokens)) return null;
  return Math.max(0, u.input_tokens);
}

// One model (or effort) tally. All four counters are always present because
// SessionReportEffortUsageDto requires every one of them as a non-negative int — only `requests` is
// optional — and a bucket missing one fails IsEffortUsageRecord and 400s the whole segment.
function emptyBucket() {
  return { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0 };
}

// Codex records a failed turn as `event_msg/{type:'error', message, codex_error_info}`. Two message
// shapes occur in real rollouts: plain prose ("Selected model is at capacity."), and a stringified
// upstream JSON body ({"type":"error","status":400,"error":{"type":"invalid_request_error",…}}).
// Both are handled; `codex_error_info` is the coarse Codex-side classification on top.
//
// Note `event_msg/turn_aborted{reason:'interrupted'}` is a user pressing Esc, NOT a failure — by
// far the most common "something stopped" record (71 local occurrences vs 6 real errors). It must
// never be reported as an error.
function parseErrorMessage(message) {
  if (typeof message !== 'string') return { code: null, status: null, text: null };
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return { code: null, status: null, text: trimmed || null };
  try {
    const body = JSON.parse(trimmed);
    const err = ((body || {}).error) || {};
    return {
      code: typeof err.type === 'string' ? err.type : null,
      status: typeof (body || {}).status === 'number' ? body.status : null,
      text: typeof err.message === 'string' ? err.message : trimmed,
    };
  } catch {
    return { code: null, status: null, text: trimmed };
  }
}

// Transient failures Codex retries on its own. Reporting them buries the durable ones — quota
// exhausted, a revoked link, an unsupported model — that a team actually needs to see.
function isTransientApiError({ info, code, status }) {
  if (info === 'server_overloaded') return true;
  if (code === 'server_error' || code === 'overloaded_error') return true;
  if (typeof status === 'number' && status >= 500) return true;
  return false;
}

// Map onto the error vocabulary the /sessions/errors endpoint stores (shared with the Claude
// plugin): rate_limit | billing_error | authentication_failed | unknown.
function classifyError({ info, code, status, text }) {
  if (info === 'usage_limit_exceeded') return 'rate_limit';
  // Billing is checked before the generic 429: OpenAI ships an exhausted prepaid balance as
  // `insufficient_quota` with status 429, and calling that a rate limit tells the user to wait
  // for a window that will never reopen.
  if (code === 'insufficient_quota') return 'billing_error';
  if (/exceeded your current quota|billing[ _]hard[ _]limit|credit balance is too low/i.test(orDefault(text, ''))) {
    return 'billing_error';
  }
  if (code === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (code === 'authentication_error' || status === 401 || status === 403) return 'authentication_failed';
  return 'unknown';
}

// One reportable event from either the legacy `error` record or Codex 0.154's
// `task_complete.error` record, or null when it is transient or not an error at all.
function apiErrorFromRecord(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'event_msg' || !p) return null;
  const failure = p.type === 'error'
    ? p
    : p.type === 'task_complete' && p.error && typeof p.error === 'object'
      ? p.error
      : null;
  if (!failure) return null;
  const info = typeof failure.codex_error_info === 'string' ? failure.codex_error_info : null;
  const { code, status, text } = parseErrorMessage(failure.message);
  if (isTransientApiError({ info, code, status })) return null;
  return {
    error: classifyError({ info, code, status, text }),
    info,
    // The Codex-side code is the most durable identifier; the prose is what a human reads.
    details: orDefault(code, orDefault(info, null)),
    text: text ? text.slice(0, 1000) : null,
    occurredAt: orDefault(rec.timestamp, null),
  };
}

// Codex says "try again at 6:25 PM" in prose, which the portal cannot turn into a reset time. The
// exact instant is on the last account-level token_count before the error, as unix SECONDS.
//
// Scans the WHOLE-file records backward from the error rather than carrying state through the
// window loop: a checkpoint window can begin between the token_count and the error, and the
// pre-window records are exactly where the reading lives. Bounded so a huge rollout stays cheap.
const RESETS_AT_SCAN_LIMIT = 2000;

export function resetsAtBefore(records, index, occurredAtIso) {
  const occurredMs = new Date(occurredAtIso).getTime();
  if (!Number.isFinite(occurredMs)) return null;
  const stop = Math.max(0, index - RESETS_AT_SCAN_LIMIT);
  for (let i = index - 1; i >= stop; i--) {
    const rec = records[i];
    const p = rec && rec.type === 'event_msg' ? rec.payload : null;
    if (!p || p.type !== 'token_count' || !p.rate_limits || typeof p.rate_limits !== 'object') continue;
    const limits = p.rate_limits;
    // Other limit families (e.g. `premium`) usually carry null windows and are not the quota that
    // just ran out.
    if (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== 'codex') continue;
    let best = null;
    for (const w of [limits.primary, limits.secondary]) {
      if (!w || typeof w !== 'object' || !Number.isFinite(w.resets_at)) continue;
      const used = Number.isFinite(w.used_percent) ? w.used_percent : -Infinity;
      // The exhausted window often reads 99, so highest used wins; a tie takes the later reset.
      if (!best || used > best.used || (used === best.used && w.resets_at > best.resetsAt)) {
        best = { used, resetsAt: w.resets_at };
      }
    }
    if (!best) continue;
    const resetMs = best.resetsAt * 1000;
    return resetMs > occurredMs ? new Date(resetMs).toISOString() : null;
  }
  return null;
}

// Second source: Codex stamps `rate_limits.rate_limit_reached_type` on token_count when a window
// is exhausted. Unverified shape — it was null in all 1727 local samples that carry rate_limits —
// so treat whatever lands here as opaque text rather than assuming a structure.
function rateLimitFromRecord(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'event_msg' || !p || p.type !== 'token_count') return null;
  const reached = (p.rate_limits || {}).rate_limit_reached_type;
  if (reached === null || reached === undefined || reached === '') return null;
  return {
    error: 'rate_limit',
    details: 'rate_limit_reached',
    text: String(reached).slice(0, 1000),
    occurredAt: orDefault(rec.timestamp, null),
  };
}

// The server keys an error row on session + error + minute, and a single failure often repeats
// (the same invalid_request_error fired 4× in ~2 minutes locally). Collapse here so one turn
// doesn't spend its whole hook budget POSTing the same row.
function dedupeErrors(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const minute = orDefault(e.occurredAt, '').slice(0, 16); // YYYY-MM-DDTHH:MM
    const key = `${e.error}|${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// The number of lines the cursor is allowed to advance over.
//
// A trailing line that is non-blank, unparseable AND not newline-terminated is a TORN record — the
// writer has not finished it. Skipping it (as the loop does) *and* counting it in the cursor loses
// it permanently: its metadata and its operations can be recovered from nothing else. So the
// cursor stops short of it and the next pass re-reads it whole. The cost is one re-read of a
// record that was never billed. (Its token count is not at stake either way: Codex reports totals
// cumulatively, so a later token_count record re-states them.)
//
// Every OTHER unparseable line is complete-but-corrupt — it is newline-terminated, or another line
// follows it — and is skipped AND passed over. That is what stops a bad line blocking the file
// forever: a torn line holds the cursor only while it is the last line, and the moment anything is
// appended it becomes newline-terminated and is treated as corrupt-but-complete.
//
// A valid JSON record with no final newline is accepted and passed over. A torn write cannot
// produce one: the closing brace is the last byte of the record, so a prefix of it never parses.
function completeLineCount(raw, endsWithNewline) {
  if (raw.length === 0 || endsWithNewline) return raw.length;
  const last = raw[raw.length - 1];
  // A blank tail holds no record — records start with '{' — so it can never be a torn one.
  if (!last.trim()) return raw.length;
  try { JSON.parse(last); } catch { return raw.length - 1; }
  return raw.length;
}

export function computeDelta(transcriptPath, fromLine, resolvers = {}) {
  const repoRootOf = orDefault(resolvers.repoRootOf, (dir) => dir);
  const branchAt = orDefault(resolvers.branchAt, null);

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  // A rollout is appended one line at a time, so the final line can be a record that is still
  // being written. Whether the file ends in a newline is the ONLY signal separating a torn record
  // from a complete one, and the trim below destroys it — so capture it first.
  const endsWithNewline = /\n$/.test(content);
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');

  // A restored/replaced file can be shorter than its durable cursor. Replaying from zero would
  // create overlapping windows with different segment IDs. Preserve the cursor and defer until
  // the file catches up or an explicit coverage reconciliation supplies a valid boundary.
  if (fromLine > raw.length) {
    const error = new Error('Transcript is shorter than its saved cursor; reconciliation required');
    error.code = 'CURSOR_MISMATCH';
    throw error;
  }

  // How far the cursor may advance. Everything except a torn trailing record is passed over.
  const completeLines = completeLineCount(raw, endsWithNewline);
  const records = raw.slice(0, completeLines).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });
  const operationServers = operationContext(records);
  const windowEnd = operationWindowEnd(records, fromLine, operationServers);

  const segments = [];
  const apiErrorEvents = [];
  const rateLimitObservations = [];
  let run = null;
  let activeModel = 'unknown';
  // 'unknown' is the server's own name for the effort-less bucket — `session-report.service.ts` in
  // the hb-ai-agent-portal repo maps it to a NULL effort row with the legacy source_ref, so a
  // pre-effort payload and an unknown bucket store identically. Do NOT invent a different sentinel.
  let activeEffort = 'unknown';
  let activeRoot = null;
  // Cumulative baseline (the last token_count total we've seen, including pre-window history).
  let prev = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

  // Canary, not a parser. `token_usage_record` is a second, per-request token source that appeared
  // on CLI 0.153 (870 records across 16/201 local rollouts) and is entirely unread here. If a build
  // ever stops emitting `token_count`, totalsFromRecord returns null for every line and the session
  // reports ZERO tokens with nothing anywhere saying why — the same silent-data-loss class as audit
  // findings #2 and #5. All 16 local files that carry token_usage_record ALSO carry token_count, so
  // today this can never fire; it exists to make the day it changes loud instead of silent.
  //
  // Deliberately a boolean and never a parse: the two sources describe the SAME usage, so reading
  // token_usage_record alongside token_count would double-count every token on CLI 0.153+.
  //
  // `sawTokenCount` is driven by totalsFromRecord's own verdict rather than by the record type, so a
  // renamed/removed `total_token_usage` block trips it too — the failure being watched for is "the
  // parser found no totals anywhere", not "the record type vanished".
  let sawTokenCount = false;
  let sawTokenUsageRecord = false;

  const closeRun = () => {
    if (run) {
      // The wall-clock spans this segment was active for, as a sibling of `stats` and deliberately
      // NOT a key inside it: checkpoint.mjs spreads `...seg.stats` straight into the report payload,
      // and the server rejects any unknown key with a 400 — which flushQueue treats as permanent and
      // deletes the file for. A stray field here destroys data rather than retrying it.
      //
      // The caller needs the intervals, not just their total, so a subagent's time and its parent's
      // can be unioned instead of summed (they describe the same stretch of clock).
      const activeIntervals = buildActiveIntervals(run.timestamps, IDLE_GAP_SEC * 1000);
      const stats = summarize(run.models, run.timestamps, run.lines, activeIntervals, operationServers);
      // Context occupancy: absent rather than 0 when the window saw no reading. 0 is a claim that
      // the context was empty and the server stores it as one, so a token-free window must ship no
      // key at all — mirroring delta.mjs in the beezi-claude-plugins repo.
      if (run.contextFinal != null) {
        stats.context_peak_tokens = run.contextPeak;
        stats.context_final_tokens = run.contextFinal;
        // run.contextFinalModel, never activeModel: closeRun() fires from the run-switch branch
        // AFTER the model read has already advanced activeModel to the record opening the NEXT run,
        // so reading activeModel here would stamp the next segment's model onto this segment's
        // context. Claude captures it per-reading for the same reason (delta.mjs in the
        // beezi-claude-plugins repo).
        stats.context_final_model = String(run.contextFinalModel).slice(0, 100);
      }
      segments.push({
        repoRoot: run.repoRoot,
        branch: run.branch,
        fromLine: run.fromLine,
        toLine: run.toLine,
        activeIntervals,
        stats,
      });
      run = null;
    }
  };

  for (let i = 0; i < windowEnd; i++) {
    const rec = records[i];
    if (!rec) continue;
    const lineNo = i + 1;

    // Update the active root/model from this record BEFORE attributing it, so a turn's work
    // (and its trailing token_count) bills to the cwd the turn declared.
    const cwd = cwdFromRecord(rec);
    if (cwd) {
      const root = repoRootOf(cwd);
      if (root) activeRoot = root; // last-touch-wins; unresolvable → carry forward
    }
    const model = modelFromRecord(rec);
    if (model) activeModel = model;
    // Read with the model and ABOVE the pre-window branch, for the same reason: a resumed window
    // whose turn_context sits before the cursor must still bill its first token_count to the effort
    // that turn declared, not to 'unknown'.
    const effort = effortFromRecord(rec);
    if (effort) activeEffort = effort;

    const totals = totalsFromRecord(rec);
    // Whole-file facts, so they are collected across the pre-window prefix too.
    if (totals) sawTokenCount = true;
    if (rec.type === 'token_usage_record') sawTokenUsageRecord = true;

    if (lineNo <= fromLine) {
      // Pre-window: only advance the cumulative baseline; never emit.
      if (totals) prev = totals;
      continue;
    }

    const apiError = orDefault(apiErrorFromRecord(rec), rateLimitFromRecord(rec));
    if (apiError) {
      if (apiError.info === 'usage_limit_exceeded') {
        apiError.resetsAt = resetsAtBefore(records, i, apiError.occurredAt);
      }
      apiErrorEvents.push(apiError);
    }

    // Account-scoped, so it is collected as a flat time series rather than attributed to the
    // (repoRoot, branch) segment the surrounding loop is building.
    const rateLimit = rateLimitObservationFromRecord(rec);
    if (rateLimit) rateLimitObservations.push(rateLimit);

    const ms = rec.timestamp ? new Date(rec.timestamp).getTime() : null;
    const branch = branchAt ? branchAt(activeRoot, ms) : '(unknown)';

    if (!run || run.repoRoot !== activeRoot || run.branch !== branch) {
      closeRun();
      run = {
        repoRoot: activeRoot, branch, fromLine: lineNo, toLine: lineNo,
        models: {}, timestamps: [], lines: [],
        contextPeak: null, contextFinal: null, contextFinalModel: null,
      };
    }
    run.toLine = lineNo;
    run.lines.push(rec);
    // `ms` is NaN for a record whose timestamp does not parse, and `NaN != null` is TRUE — so the
    // NaN would reach buildActiveIntervals and make the segment's activeIntervals (and every
    // duration computed from them) non-finite. A broken stamp must cost the clock only that
    // record, never the whole segment's duration. Note the NaN is still handed to `branchAt`
    // above: the branch a broken stamp resolves to is that resolver's business, and turning it
    // into null there would silently re-label the segment.
    if (ms != null && !Number.isNaN(ms)) run.timestamps.push(ms);

    // Occupancy is read HERE, below the run-creation block above — never beside the
    // apiError/rateLimit reads, which sit above it precisely because they never touch `run`. `run`
    // is null on a window's first content line, so an assignment up there throws, computeDelta
    // throws, and the whole checkpoint dies with the cursor unadvanced, the segment unflushed and
    // the rate-limit queue undrained.
    const ctx = contextTokensFromRecord(rec);
    if (ctx !== null) {
      run.contextPeak = Math.max(run.contextPeak == null ? 0 : run.contextPeak, ctx);
      run.contextFinal = ctx;
      // The model THIS reading was taken under, captured now rather than read back in closeRun.
      run.contextFinalModel = activeModel;
    }

    if (totals) {
      const dInput = Math.max(0, totals.input - prev.input);
      const dCached = Math.max(0, totals.cached - prev.cached);
      const dCacheWrite = Math.max(0, totals.cacheWrite - prev.cacheWrite);
      const dOutput = Math.max(0, totals.output - prev.output);
      prev = totals;
      const nonCachedInput = Math.max(0, dInput - dCached - dCacheWrite);
      if (dInput > 0 || dOutput > 0) {
        if (run.models[activeModel] === undefined || run.models[activeModel] === null) {
          run.models[activeModel] = emptyBucket();
        }
        const m = run.models[activeModel];
        if (m.by_effort === undefined || m.by_effort === null) m.by_effort = {};
        if (m.by_effort[activeEffort] === undefined || m.by_effort[activeEffort] === null) {
          m.by_effort[activeEffort] = emptyBucket();
        }
        // ONE loop over both, never two separate accumulations: the server explodes the payload into
        // one priced row per (model x effort) and expects those rows to sum to the unsplit model
        // cost. Two code paths is exactly how that partition breaks silently, with cost drifting up
        // and no error anywhere.
        const buckets = [m, m.by_effort[activeEffort]];
        for (let b = 0; b < buckets.length; b++) {
          buckets[b].token_input += nonCachedInput;
          buckets[b].token_output += dOutput;
          buckets[b].token_cache_read += dCached;
          buckets[b].token_cache_creation += dCacheWrite;
          buckets[b].requests += 1;
        }
      }
    }
  }
  closeRun();
  return {
    nextCursor: Math.max(fromLine, windowEnd),
    segments,
    apiErrorEvents: dedupeErrors(apiErrorEvents),
    rateLimitObservations,
    // CLIENT-LOCAL. Deliberately NOT folded into apiErrorEvents: that stream feeds /sessions/errors,
    // and "the plugin found no token source" is a diagnostic about us, not an API error the user
    // hit — the same argument G-4-6 makes for keeping turn_aborted off the error wire. Its home is
    // §8's crash/diagnostic telemetry when that exists; until then it sits here unconsumed, adds no
    // wire field, and costs nothing.
    tokenSourceMissing: sawTokenUsageRecord && !sawTokenCount,
  };
}

function summarize(models, timestamps, lines, activeIntervals, operationServers) {
  timestamps.sort((a, z) => a - z);
  // Identical to the gap sum this replaced: buildActiveIntervals emits exactly the pairs that loop
  // summed (0 < gap < idle) and coalesces consecutive ones, so totalMs is the same integer. A lone
  // transcript's duration_sec is unchanged; only a segment overlapping a sibling's now differs.
  const activeMs = totalMs(activeIntervals);
  const totals = Object.values(models).reduce((acc, m) => ({
    token_input: acc.token_input + m.token_input,
    token_output: acc.token_output + m.token_output,
    token_cache: acc.token_cache + m.token_cache_read + m.token_cache_creation,
  }), { token_input: 0, token_output: 0, token_cache: 0 });
  return {
    models,
    token_total: totals.token_input + totals.token_output + totals.token_cache,
    ...totals,
    duration_sec: Math.round(activeMs / 1000),
    code_changes: computeCodeChanges(lines),
    operations: computeOperations(lines, operationServers),
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    ended_at: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
  };
}
