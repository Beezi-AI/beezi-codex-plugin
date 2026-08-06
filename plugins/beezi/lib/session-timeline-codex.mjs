import fs from 'node:fs';
import { IDLE_GAP_SEC } from './timing.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';

// Whole-session activity timeline, derived from a Codex rollout. Same output contract as the Claude
// engine ({ periods, plan_events, subagents, started_at, ended_at, generated_at }), so the server
// upsert is unchanged.
//
// Codex has no plan *permission mode* and no interrupt markers, so periods are working /
// waiting_user / idle (planning is surfaced only as discrete plan_events from `update_plan` tool
// calls).
//
// `subagents` is always empty — but not because Codex has none. Codex writes a subagent as its own
// top-level rollout under ~/.codex/sessions (`thread_source: "subagent"`, `source: {subagent: …}`),
// and that rollout carries NO pointer back to the parent session — verified against the full
// session_meta key set (id, timestamp, cwd, originator, cli_version, source, thread_source,
// model_provider, git). So a subagent's activity cannot be attached to this session's timeline from
// the transcript alone. This is a gap in what we read, not an absence of subagents.

const STATE = {
  WORKING: 'working',
  WAITING_USER: 'waiting_user',
  IDLE: 'idle',
};

function parseTranscript(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = content.replace(/\n+$/, '');
  if (trimmed === '') return [];
  const out = [];
  for (const raw of trimmed.split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return out;
}

function tsOf(rec) {
  return rec?.timestamp ? new Date(rec.timestamp).getTime() : null;
}

// A genuine user turn-start. Codex writes the real prompt as an `event_msg` of type `user_message`;
// the injected AGENTS.md / user-instructions preamble is a `response_item` message and is ignored.
function isRealUserPrompt(rec) {
  return rec?.type === 'event_msg' && rec.payload?.type === 'user_message';
}

function buildPeriods(records) {
  const anchors = [];
  for (const rec of records) {
    const ms = tsOf(rec);
    if (ms == null) continue;
    anchors.push({ ts: ms, isPrompt: isRealUserPrompt(rec) });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    let state;
    if (cur.isPrompt) state = STATE.WAITING_USER;
    else if (cur.ts - prev.ts > IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    else state = STATE.WORKING;

    const last = merged[merged.length - 1];
    if (last && last.state === state) last.endMs = cur.ts;
    else merged.push({ state, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => ({
    state: m.state,
    started_at: new Date(m.startMs).toISOString(),
    ended_at: new Date(m.endMs).toISOString(),
  }));
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// An `update_plan` tool call and its plan steps, or null.
function updatePlanOf(rec) {
  const p = rec?.payload;
  if (rec?.type !== 'response_item' || p?.type !== 'function_call' || p.name !== 'update_plan') {
    return null;
  }
  const args = parseArgs(p.arguments);
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  return { plan };
}

// Discrete plan markers from Codex's `update_plan` tool. The first update marks plan_start; an
// update whose every step is completed marks plan_ready. A session with several plan cycles emits
// the first start and the last completion (a coarse but honest summary of Codex planning).
function buildPlanEvents(records) {
  const events = [];
  let started = false;
  for (const rec of records) {
    const up = updatePlanOf(rec);
    if (!up) continue;
    const ms = tsOf(rec);
    if (ms == null) continue;
    if (!started) {
      events.push({ type: 'plan_start', at: new Date(ms).toISOString() });
      started = true;
    }
    if (up.plan.length > 0 && up.plan.every((s) => s?.status === 'completed')) {
      events.push({ type: 'plan_ready', at: new Date(ms).toISOString() });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

export function computeSessionTimeline(transcriptPath /*, sessionId */) {
  let records;
  try { records = parseTranscript(transcriptPath); } catch { return null; }

  const periods = buildPeriods(records);
  const plan_events = buildPlanEvents(records);
  const subagents = [];

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const rec of records) {
    const t = tsOf(rec);
    if (t == null) continue;
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  if (minTs === Infinity) return null;

  return {
    periods,
    plan_events,
    subagents,
    started_at: new Date(minTs).toISOString(),
    ended_at: new Date(maxTs).toISOString(),
    generated_at: new Date().toISOString(),
  };
}

// POST the session timeline to Beezi. Session-scoped (upserted by sessionId), fire-and-forget by
// convention — callers swallow the result.
export async function postSessionTimeline(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!payload?.sessionId || !Array.isArray(payload?.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs travels through: the caller may be running against a hook deadline and needs this
    // request bounded by what is left of it, not by the default.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, token, payload, {
      fetchImpl,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
