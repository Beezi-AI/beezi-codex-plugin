import fs from 'node:fs';
import { IDLE_GAP_SEC } from './timing.mjs';
import { computeCodeChanges } from './code-changes-codex.mjs';
import { computeOperations } from './operations-codex.mjs';

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
// So we map: token_input = Δ(input − cached), token_cache_read = Δ(cached), token_output = Δ(output).
//
// cwd (and thus repo) is authoritative per turn: `session_meta.cwd` seeds it, `turn_context.cwd`
// updates it as the session cd's, and a shell tool's `arguments.workdir` refines it. The current
// model comes from `turn_context.model`. Token-count events carry neither, so we bill the increment
// to whatever cwd/model is active when the event lands.

function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The cwd a single rollout record implies, or null (caller carries the previous cwd forward).
function cwdFromRecord(rec) {
  const p = rec?.payload;
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
  const p = rec?.payload;
  if (rec?.type === 'turn_context' && typeof p?.model === 'string') return p.model;
  return null;
}

// { input, cached, output } cumulative totals from a token_count event, or null.
function totalsFromRecord(rec) {
  const p = rec?.payload;
  if (rec?.type !== 'event_msg' || p?.type !== 'token_count') return null;
  const u = p.info?.total_token_usage;
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    cached: u.cached_input_tokens || 0,
    output: u.output_tokens || 0,
  };
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
    return {
      code: typeof body?.error?.type === 'string' ? body.error.type : null,
      status: typeof body?.status === 'number' ? body.status : null,
      text: typeof body?.error?.message === 'string' ? body.error.message : trimmed,
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
  if (/exceeded your current quota|billing[ _]hard[ _]limit|credit balance is too low/i.test(text ?? '')) {
    return 'billing_error';
  }
  if (code === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (code === 'authentication_error' || status === 401 || status === 403) return 'authentication_failed';
  return 'unknown';
}

// One reportable event from an error record, or null when it is transient or not an error at all.
function apiErrorFromRecord(rec) {
  const p = rec?.payload;
  if (rec?.type !== 'event_msg' || p?.type !== 'error') return null;
  const info = typeof p.codex_error_info === 'string' ? p.codex_error_info : null;
  const { code, status, text } = parseErrorMessage(p.message);
  if (isTransientApiError({ info, code, status })) return null;
  return {
    error: classifyError({ info, code, status, text }),
    // The Codex-side code is the most durable identifier; the prose is what a human reads.
    details: code ?? info ?? null,
    text: text ? text.slice(0, 1000) : null,
    occurredAt: rec.timestamp ?? null,
  };
}

// Second source: Codex stamps `rate_limits.rate_limit_reached_type` on token_count when a window
// is exhausted. Unverified shape — it was null in all 1727 local samples that carry rate_limits —
// so treat whatever lands here as opaque text rather than assuming a structure.
function rateLimitFromRecord(rec) {
  const p = rec?.payload;
  if (rec?.type !== 'event_msg' || p?.type !== 'token_count') return null;
  const reached = p.rate_limits?.rate_limit_reached_type;
  if (reached === null || reached === undefined || reached === '') return null;
  return {
    error: 'rate_limit',
    details: 'rate_limit_reached',
    text: String(reached).slice(0, 1000),
    occurredAt: rec.timestamp ?? null,
  };
}

// The server keys an error row on session + error + minute, and a single failure often repeats
// (the same invalid_request_error fired 4× in ~2 minutes locally). Collapse here so one turn
// doesn't spend its whole hook budget POSTing the same row.
function dedupeErrors(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const minute = (e.occurredAt ?? '').slice(0, 16); // YYYY-MM-DDTHH:MM
    const key = `${e.error}|${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function computeDelta(transcriptPath, fromLine, resolvers = {}) {
  const repoRootOf = resolvers.repoRootOf ?? ((dir) => dir);
  const branchAt = resolvers.branchAt ?? null;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');

  const segments = [];
  const apiErrorEvents = [];
  let run = null;
  let activeCwd = null;
  let activeModel = 'unknown';
  let activeRoot = null;
  // Cumulative baseline (the last token_count total we've seen, including pre-window history).
  let prev = { input: 0, cached: 0, output: 0 };

  const closeRun = () => {
    if (run) {
      segments.push({
        repoRoot: run.repoRoot,
        branch: run.branch,
        fromLine: run.fromLine,
        toLine: run.toLine,
        stats: summarize(run.models, run.timestamps, run.lines),
      });
      run = null;
    }
  };

  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    let rec;
    try { rec = JSON.parse(raw[i]); } catch { continue; }
    const lineNo = i + 1;

    // Update the active cwd/model/root from this record BEFORE attributing it, so a turn's work
    // (and its trailing token_count) bills to the cwd the turn declared.
    const cwd = cwdFromRecord(rec);
    if (cwd) {
      activeCwd = cwd;
      const root = repoRootOf(cwd);
      if (root) activeRoot = root; // last-touch-wins; unresolvable → carry forward
    }
    const model = modelFromRecord(rec);
    if (model) activeModel = model;

    const totals = totalsFromRecord(rec);

    if (lineNo <= fromLine) {
      // Pre-window: only advance the cumulative baseline; never emit.
      if (totals) prev = totals;
      continue;
    }

    const apiError = apiErrorFromRecord(rec) ?? rateLimitFromRecord(rec);
    if (apiError) apiErrorEvents.push(apiError);

    const ms = rec.timestamp ? new Date(rec.timestamp).getTime() : null;
    const branch = branchAt ? branchAt(activeRoot, ms) : '(unknown)';

    if (!run || run.repoRoot !== activeRoot || run.branch !== branch) {
      closeRun();
      run = { repoRoot: activeRoot, branch, fromLine: lineNo, toLine: lineNo, models: {}, timestamps: [], lines: [] };
    }
    run.toLine = lineNo;
    run.lines.push(rec);
    if (ms != null) run.timestamps.push(ms);

    if (totals) {
      const dInput = Math.max(0, totals.input - prev.input);
      const dCached = Math.max(0, totals.cached - prev.cached);
      const dOutput = Math.max(0, totals.output - prev.output);
      prev = totals;
      const nonCachedInput = Math.max(0, dInput - dCached);
      if (dInput > 0 || dOutput > 0) {
        const m = (run.models[activeModel] ??= {
          token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0,
        });
        m.token_input += nonCachedInput;
        m.token_output += dOutput;
        m.token_cache_read += dCached;
        m.requests += 1;
      }
    }
  }
  closeRun();
  return {
    nextCursor: Math.max(fromLine, raw.length),
    segments,
    apiErrorEvents: dedupeErrors(apiErrorEvents),
  };
}

function summarize(models, timestamps, lines) {
  timestamps.sort((a, z) => a - z);
  let activeMs = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > 0 && gap < IDLE_GAP_SEC * 1000) activeMs += gap;
  }
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
    operations: computeOperations(lines),
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    ended_at: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
  };
}
