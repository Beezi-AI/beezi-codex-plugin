import fs from 'node:fs';
import { IDLE_GAP_SEC } from './timing.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { readAgents as _readAgents } from './subagent-state.mjs';

// Whole-session activity timeline, derived from a Codex rollout. Same output contract as the Claude
// engine ({ periods, plan_events, subagents, started_at, ended_at, generated_at }), so the server
// upsert is unchanged.
//
// Codex has no plan *permission mode* and no interrupt markers, so periods are working /
// waiting_user / idle (planning is surfaced only as discrete plan_events from `update_plan` tool
// calls).
//
// `subagents` does NOT come from the transcript. Codex writes a subagent as its own top-level rollout
// under ~/.codex/sessions (`thread_source: "subagent"`), and this session's transcript records
// nothing about when one ran. The parent link does exist on the child's own session_meta
// (`parent_thread_id` / `forked_from_id` / `source.subagent.thread_spawn.parent_thread_id`) — an
// earlier version of this comment claimed otherwise — but the child's file still cannot say when the
// parent considered it running. The SubagentStart/SubagentStop hooks are the source: they leave
// per-agent records under ~/.beezi-codex/state/<sessionId>.agents/, and buildSubagents reads those.
// With no hooks trusted, the array is empty while token attribution still works (see
// lib/checkpoint.mjs ingestSubagents).

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

// One active span per subagent, from the records the SubagentStart/SubagentStop hooks left behind.
//
// The span cannot come from the transcript: Codex writes a subagent to its own top-level rollout,
// and this session's transcript contains no trace of when one ran. The hooks are the only source of
// the exact start and end.
//
// `ended_at` is REQUIRED by the server and omitting it rejects the entire timeline — periods and
// plan_events included — so an agent that started but has not stopped is clamped to the session's
// own end. That is the last moment we have evidence anything was alive, it can never overflow the
// parent's bar, and it is self-correcting: the timeline is re-derived and re-sent at every turn end,
// so the true end lands as soon as the agent finishes.
const MAX_SUBAGENTS = 1000;

function buildSubagents(agents, fallbackEndMs) {
  const out = [];
  for (const [agentId, rec] of Object.entries(agents ?? {})) {
    const started = Date.parse(rec?.started_at ?? '');
    // No start means no span the server would accept; drop it rather than invent one.
    if (!Number.isFinite(started)) continue;
    const ended = Date.parse(rec?.ended_at ?? '');
    const endMs = Number.isFinite(ended) ? ended : fallbackEndMs;
    out.push({
      agent_id: String(agentId).slice(0, 200),
      agent_type: rec?.agent_type ? String(rec.agent_type).slice(0, 100) : null,
      started_at: new Date(started).toISOString(),
      // Math.max guards clock skew: ended_at < started_at would be rejected outright.
      ended_at: new Date(Math.max(started, endMs)).toISOString(),
    });
  }
  out.sort((a, b) => a.started_at.localeCompare(b.started_at));
  // A runaway fan-out must not 400 the payload — the server caps the array at 1000.
  return out.slice(0, MAX_SUBAGENTS);
}

export function computeSessionTimeline(transcriptPath, sessionId = null, deps = {}) {
  let records;
  try { records = parseTranscript(transcriptPath); } catch { return null; }

  const periods = buildPeriods(records);
  const plan_events = buildPlanEvents(records);

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const rec of records) {
    const t = tsOf(rec);
    if (t == null) continue;
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  if (minTs === Infinity) return null;

  let agents = {};
  if (sessionId) {
    const readAgents = deps.readAgents ?? _readAgents;
    try { agents = readAgents(sessionId); } catch { agents = {}; }
  }
  const subagents = buildSubagents(agents, maxTs);

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
