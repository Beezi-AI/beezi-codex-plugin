import { fetchCompat } from './fetch-compat.mjs';
import fs from 'fs';
import path from 'path';
import { timelineWaits, isBackgroundNotification, isTimelineUserPrompt } from './timeline-waits-codex.mjs';
import { toolNamesFromProgram } from './exec-program.mjs';
import { parseArgs } from './operations-codex.mjs';
import { IDLE_GAP_SEC } from './timing.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { orDefault, parseTimestampMs } from './compat.mjs';
import { skillInjectionOf, skillReadsOfCall } from './skills-codex.mjs';
import { editedPathsOf } from './code-changes-codex.mjs';

// Whole-session activity timeline, derived from a Codex rollout. Same output contract as the Claude
// engine ({ periods, plan_events, subagents, started_at, ended_at, generated_at }), so the server
// upsert is unchanged.
//
// Period states match the Claude engine's five: working / planning / waiting_user / idle / break.
// `planning` is driven by `collaboration_mode` (Codex's equivalent of Claude's plan permission
// mode); `break` by a gap long enough to mean the session was abandoned and resumed rather than
// waited on. Both are new *values* on the existing `state` key — `periods[].state` and
// `plan_events[].type` are @MaxLength(50) bounded strings on the server, deliberately not enums,
// so a newer plugin adding a state cannot 400 the whole ingest. waiting_subtype is the optional
// field shared with Claude: plan_approval / question_answer / command_approval / next_instruction.
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
  PLANNING: 'planning',
  WAITING_USER: 'waiting_user',
  IDLE: 'idle',
  BREAK: 'break',
};

// A gap this long is an abandoned session resumed, not a turn anyone was waiting on. Claude's
// constant, adopted unchanged so the two agents stay comparable in one dashboard. It is also
// verified against Codex data: of 276 local gaps over 5 minutes, the 3–4h and 6–8h bands are both
// empty, so 6h sits in a hole and the classification is insensitive between 6h and 8h. 18 gaps
// >= 6h account for 438 hours — 80% of all >5-minute gap time on this machine — every one of them
// charted `idle` before this.
const BREAK_GAP_SEC = 6 * 60 * 60;

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
  const ms = rec && rec.timestamp ? new Date(rec.timestamp).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Esc. Codex records it as `event_msg/turn_aborted` — 79 occurrences locally, `reason:'interrupted'`
// on 79/79, so the reason is not worth matching on and matching it would only add a way to miss a
// future one.
//
// The `rec.type === 'event_msg'` guard is the load-bearing part: `<turn_aborted>…</turn_aborted>`
// also appears as literal *prose* inside a developer `response_item` message (54 occurrences, all
// on `response_item/message` and 0 on `event_msg/user_message`), and that prose is not an
// interrupt. The same distinction is already drawn for session naming by `isSafeSessionName` in
// lib/session-name-codex.mjs, whose `/^</` rule rejects the same prose.
function isInterrupt(rec) {
  return (rec || {}).type === 'event_msg' && (rec.payload || {}).type === 'turn_aborted';
}

// Substring, not equality — the same latitude the Claude engine takes (`session-timeline.mjs` in
// the beezi-claude-plugins repo), so a rename to 'plan_mode' or 'planning' still classifies instead
// of silently falling back to `working` and dropping the dimension. None of the other observed
// kinds — 'default', 'custom', 'code' — contains 'plan', so the looseness costs nothing.
function isPlanMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase().indexOf('plan') !== -1;
}

// Codex's answer to Claude's plan permission mode, from either of two real sources.
// `turn_context.collaboration_mode` carries the whole block (3 220 of 4 534 local turn_context
// records); `task_started.collaboration_mode_kind` carries just the kind and is present on 593 of
// 593 task_started events, including builds whose turn_context has no collaboration block at all.
// Keyed on turn_id the two agree 589/589 with zero disagreements, and task_started always lands
// first, so plain last-write-wins gives the final say to the richer source without a precedence
// rule. Both are needed: 1 545 turn_context records carry a mode with no turn_id at all, so on
// those builds the carry-forward variable is the only mechanism.
function collaborationModeOf(rec) {
  const p = (rec || {}).payload;
  if (!p) return null;
  if (rec.type === 'turn_context') {
    const cm = p.collaboration_mode;
    if (cm && typeof cm === 'object' && typeof cm.mode === 'string') return cm.mode;
    return null;
  }
  if (rec.type === 'event_msg' && p.type === 'task_started') {
    return typeof p.collaboration_mode_kind === 'string' ? p.collaboration_mode_kind : null;
  }
  return null;
}

function buildPeriods(records, skillIntervals) {
  // A skill-plan window (buildSkillPlanCycles) charts as planning too, at the same rank as plan mode.
  const inSkillPlan = (ms) => {
    for (const iv of skillIntervals || []) {
      if (ms >= iv.startMs && ms <= iv.endMs) return true;
    }
    return false;
  };
  const waits = timelineWaits(records);
  const anchors = [];
  // 'default' rather than null: a session whose build predates collaboration_mode must read as
  // working, exactly as it did before, not as an unknown third thing.
  let currentMode = 'default';
  for (const rec of records) {
    // Read the mode BEFORE the timestamp guard, and before pushing the anchor. Before the guard so
    // a mode carried on an untimestamped record is not silently dropped; before the anchor because
    // a turn_context announces the mode for the turn that FOLLOWS it, so the work after it — and
    // the turn_context anchor itself — belongs to the new mode. Same ordering delta-codex.mjs
    // already uses for cwd and model.
    const mode = collaborationModeOf(rec);
    if (mode !== null) currentMode = mode;
    const ms = tsOf(rec);
    if (ms == null) continue;
    // An interrupt is never a turn start. Folded into isPrompt rather than given its own branch on
    // purpose: a separate branch would have to sit somewhere in the chain below, and anywhere above
    // the idle check would make an interrupt outrank idle — a deviation from Claude, which keeps
    // `break` and `idle` above everything an abort could claim. Written this way the interrupt can
    // never reorder the chain, and it stays correct if Codex ever routes an abort through
    // `user_message`. Measured today: 0 of 79 aborts arrive as `user_message`, so this is a guard,
    // not a reclassification.
    anchors.push({ ts: ms, isPrompt: isTimelineUserPrompt(rec) && !isInterrupt(rec),
      isBackground: isBackgroundNotification(rec), mode: currentMode });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    const gapMs = cur.ts - prev.ts;
    let state;
    let subtype = null;
    const wait = waits.get(cur.ts);
    // The order IS the contract; every branch below outranks the ones after it.
    // Explicit background waits first, as in Claude. Then break, above even a real prompt:
    // a human returning after 29 hours abandoned the
    // session and resumed it, they were not being waited on. Put it after the prompt check and
    // that 29 hours inflates "time waiting on the human" — the exact metric `break` exists to
    // deflate. `>=` (not `>`) so the threshold itself is a break.
    if (cur.isBackground || (wait && wait.state === STATE.IDLE)) state = STATE.IDLE;
    else if (gapMs >= BREAK_GAP_SEC * 1000) state = STATE.BREAK;
    else if (wait) { state = wait.state; subtype = wait.subtype; }
    else if (cur.isPrompt) { state = STATE.WAITING_USER; subtype = 'next_instruction'; }
    else if (gapMs >= IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    // Planning last, below idle and waiting_user deliberately: a five-minute silence inside plan
    // mode is still idle, and a plan sitting unapproved is the human's time, not more planning.
    // Same rank as `session-timeline.mjs` in the beezi-claude-plugins repo gives it.
    else if (isPlanMode(cur.mode) || inSkillPlan(cur.ts)) state = STATE.PLANNING;
    else state = STATE.WORKING;

    const last = merged[merged.length - 1];
    if (last && last.state === state && last.subtype === subtype) last.endMs = cur.ts;
    else merged.push({ state, subtype, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => ({
    state: m.state,
    started_at: new Date(m.startMs).toISOString(),
    ended_at: new Date(m.endMs).toISOString(),
    ...(m.subtype ? { waiting_subtype: m.subtype } : {}),
  }));
}

// `tools.update_plan(` inside a unified-exec program. G-5-2's `toolNamesFromProgram`
// (lib/exec-program.mjs) is the one census of which tools a program called, and it keys on the same
// literal `tools.` prefix — which is what separates the call from the same words appearing in
// prose. The question asked here is the narrow one: "did this program call update_plan". Measured:
// 13 occurrences across 2 local rollouts, which is the whole population the appendix counted.
function execCallsUpdatePlan(source) {
  return toolNamesFromProgram(source).indexOf('update_plan') !== -1;
}

// Codex has emitted plan activity three ways, and which one you see is purely a question of build:
//
//   - `response_item/function_call` `update_plan` (123 local) — a todo list with per-step status.
//     Legacy, era A/B, still the only source on those builds, so this path must keep working.
//   - `event_msg/item_completed` with `item.type === 'Plan'` (15 local) — the modern surface, and
//     the ONLY one any 0.144+ rollout emits. This is a finished plan *document*, not a todo list:
//     there is no per-step `status` to test, so the item's existence IS the completion. Start and
//     ready at once, by construction.
//   - `tools.update_plan(` inside an exec program (13 local) — a start marker only. The step list
//     is not recoverable from the program text, so it can open a plan but never close one.
//
// `payload.started_at_ms` is present on 1 of 15 Plan items, so the record's own `timestamp` is the
// only usable anchor — which is also the house rule: a row carries the record's own timestamp so a
// re-scan reproduces the same key and the server's idempotent upsert collapses the replay.
//
// `update_plan` (either surface) only counts inside plan mode: in default mode it is a todo list,
// not a plan — 17 of the 20 local rollouts calling it never entered plan mode, and the portal marks
// a session `planned` on any plan event. `Plan` items are finished documents and stay unconditional.
function planMarkersOf(rec, mode) {
  const p = (rec || {}).payload;
  if (!p) return null;
  if (rec.type === 'event_msg' && p.type === 'item_completed') {
    const item = orDefault(p.item, null);
    if (!item || item.type !== 'Plan') return null;
    return { start: true, ready: true };
  }
  if (rec.type !== 'response_item') return null;
  if (!isPlanMode(mode)) return null;
  if (p.type === 'function_call' && p.name === 'update_plan') {
    const args = parseArgs(p.arguments);
    const plan = args && Array.isArray(args.plan) ? args.plan : [];
    return { start: true, ready: plan.length > 0 && plan.every((s) => (s || {}).status === 'completed') };
  }
  if (p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
    return execCallsUpdatePlan(p.input) ? { start: true, ready: false } : null;
  }
  return null;
}

// Discrete plan markers, collapsed rather than concatenated.
//
// Unlike the code-change sources, these genuinely co-occur: one local 0.137.0 rollout carries both
// 2 `Plan` items and 13 `update_plan` calls, so naively appending both sources — the way the Claude
// engine appends its two — would double-report. The collapse is a same-second key, which is the
// resolution at which two sources describing ONE completion can disagree.
//
// Its honest limit, measured on that same rollout: its Plan items (20:40:47, 20:42:20) and its five
// completing `update_plan` calls (20:53:52 … 22:09:52) are minutes apart, so they are genuinely
// different completion moments and all of them are kept. The key suppresses duplicate reports of
// one moment; it does not and should not merge a session's separate plan cycles.
function buildPlanEvents(records) {
  const events = [];
  let mode = 'default';
  for (const rec of records) {
    // Mode is read before the marker so an update_plan is judged by the mode in force for it.
    const m = collaborationModeOf(rec);
    if (m !== null) mode = m;
    const marker = planMarkersOf(rec, mode);
    if (!marker) continue;
    const ms = tsOf(rec);
    if (ms == null) continue;
    const at = new Date(ms).toISOString();
    if (marker.start) events.push({ type: 'plan_start', at: at });
    if (marker.ready) events.push({ type: 'plan_ready', at: at });
  }
  return events;
}

// Built-in and skill events merged into one list: sorted, only the earliest start kept (a session
// opens its plan once), and plan_ready deduped per second so two sources reporting one completion
// produce one row while separate plan cycles cannot suppress each other. Rows are rebuilt as
// exactly {type, at}, the two keys the server accepts.
function mergePlanEvents(events) {
  const sorted = events.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  const seenReady = new Set();
  let started = false;
  for (const e of sorted) {
    if (e.type === 'plan_start') {
      if (started) continue;
      started = true;
    } else {
      const key = e.at.slice(0, 19);
      if (seenReady.has(key)) continue;
      seenReady.add(key);
    }
    out.push({ type: e.type, at: e.at });
  }
  return out;
}

// Skill-based planning, ported from buildSkillPlanCycles in the Claude engine
// (beezi-claude-plugins/plugins/beezi/lib/session-timeline.mjs); names are kept identical so the two
// can be diffed. Planning done through a skill (writing-plans, brainstorming) never enters plan
// mode, so it charted as plain `working` and the session read "Plan Mode skipped".
//   plan_start - a planning skill used: a `$name` injection or a SKILL.md read, even one chained to
//     other work (that is how an automatic run looks). Detection is skills-codex.mjs only: the
//     portal marks a session `planned` on any plan event, so listing skill folders must not qualify.
//   plan_ready - the LAST plan-document write before the cycle closes.
// A cycle closes on a non-plan edit after a plan write, another planning skill, an execution skill,
// built-in plan mode starting (it owns its window), or end of transcript. A lone start gets no
// interval: an unclosed brainstorm must not paint the rest of the session as planning.
const PLAN_SKILL_HINTS = ['plan', 'spec', 'brainstorm'];
const PLAN_SKILL_EXCLUSIONS = ['execut', 'implement'];
const PLAN_DOC_HINTS = ['design', 'spec', 'plan'];
const PLAN_DIR_NAMES = { plan: true, plans: true, spec: true, specs: true, design: true, designs: true };
const PLAN_DOC_EXT = '.md';

// Forward slashes so a Windows path parses with path.posix; bare path.basename on a POSIX runtime
// would return the whole 'C:\...\plans\foo.md' string and turn basename matching into directory matching.
function normPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// Segment after the last ':', tokenized on non-alphanumerics and matched by token PREFIX:
// 'plans' matches 'plan', 'inspect' does not match 'spec'.
function leafTokens(skillId) {
  if (typeof skillId !== 'string' || skillId === '') return [];
  const i = skillId.lastIndexOf(':');
  const leaf = i === -1 ? skillId : skillId.slice(i + 1);
  return leaf.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
}

function anyTokenStartsWith(tokens, hints) {
  for (const t of tokens) {
    for (const h of hints) {
      if (t.indexOf(h) === 0) return true;
    }
  }
  return false;
}

function isPlanningSkill(skillId) {
  const tokens = leafTokens(skillId);
  if (tokens.length === 0) return false;
  if (anyTokenStartsWith(tokens, PLAN_SKILL_EXCLUSIONS)) return false;
  return anyTokenStartsWith(tokens, PLAN_SKILL_HINTS);
}

function isExcludedPlanSkill(skillId) {
  return anyTokenStartsWith(leafTokens(skillId), PLAN_SKILL_EXCLUSIONS);
}

// '.md' with a keyword in the BASENAME, or directly inside a folder named exactly plan(s)/spec(s)/
// design(s). Exact folder names only: execution dirs hold progress artifacts, and a substring match
// would keep the cycle open forever.
function isPlanDocPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const p = normPath(filePath);
  const base = path.posix.basename(p).toLowerCase();
  if (path.posix.extname(base) !== PLAN_DOC_EXT) return false;
  for (const h of PLAN_DOC_HINTS) {
    if (base.indexOf(h) !== -1) return true;
  }
  const parent = path.posix.basename(path.posix.dirname(p)).toLowerCase();
  return PLAN_DIR_NAMES[parent] === true;
}

// Every skill this record used. A read chained to other work still counts: that is how an automatic
// Codex skill run looks (discovery plus several SKILL.md reads in one command).
function skillsUsedBy(rec) {
  const injected = skillInjectionOf(rec);
  if (injected) return [injected.name];
  const reads = skillReadsOfCall(rec && rec.payload);
  return reads === null ? [] : reads.names;
}

function buildSkillPlanCycles(records) {
  const events = [];
  const intervals = [];
  let mode = 'default';
  let cycle = null; // { startMs, lastPlanMs }

  const close = () => {
    if (cycle === null) return;
    if (cycle.lastPlanMs !== null) {
      events.push({ type: 'plan_ready', at: new Date(cycle.lastPlanMs).toISOString() });
      intervals.push({ startMs: cycle.startMs, endMs: cycle.lastPlanMs });
    }
    cycle = null;
  };

  for (const rec of records) {
    const m = collaborationModeOf(rec);
    if (m !== null) {
      const wasPlan = isPlanMode(mode);
      mode = m;
      if (isPlanMode(mode) && !wasPlan) close(); // built-in plan mode owns its window
    }
    const ms = tsOf(rec);
    if (ms == null) continue;

    const skills = skillsUsedBy(rec);
    if (!isPlanMode(mode) && skills.some(isPlanningSkill)) {
      close(); // a new planning skill ends the previous cycle
      events.push({ type: 'plan_start', at: new Date(ms).toISOString() });
      cycle = { startMs: ms, lastPlanMs: null };
      continue;
    }
    if (cycle === null) continue;
    if (skills.some(isExcludedPlanSkill)) { close(); continue; }

    for (const filePath of editedPathsOf(rec)) {
      if (isPlanDocPath(filePath)) cycle.lastPlanMs = ms;
      else if (cycle.lastPlanMs !== null) { close(); break; }
    }
  }
  close(); // end of transcript
  return { events, intervals };
}

const MAX_SUBAGENTS = 1000;

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
function buildSubagents(agents, fallbackEndMs) {
  const out = [];
  for (const [agentId, rec] of Object.entries(agents || {})) {
    const started = parseTimestampMs((rec || {}).started_at);
    // No start means no span the server would accept; drop it rather than invent one.
    if (started === null) continue;
    const ended = parseTimestampMs((rec || {}).ended_at);
    const endMs = ended === null ? fallbackEndMs : ended;
    out.push({
      agent_id: String(agentId).slice(0, 200),
      agent_type: rec && rec.agent_type ? String(rec.agent_type).slice(0, 100) : null,
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

  const skillPlan = buildSkillPlanCycles(records);
  const periods = buildPeriods(records, skillPlan.intervals);
  const plan_events = mergePlanEvents(buildPlanEvents(records).concat(skillPlan.events));

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const rec of records) {
    const t = tsOf(rec);
    if (t == null) continue;
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  if (minTs === Infinity) return null;

  // `deps.readAgents` is REQUIRED alongside a sessionId — both callers (checkpoint and the audit)
  // hand over the agent map they just built, sweep entries included, rather than letting this
  // re-read the (possibly pruned) sidecars. No sessionId means no lookup and no subagent spans.
  //
  // The check is outside the try on purpose: a miswired caller must fail loudly, not be handed an
  // empty subagent array that looks exactly like a session that spawned none. The try covers only
  // the read, where a pruned or unreadable sidecar directory legitimately answers with nothing.
  let agents = {};
  if (sessionId) {
    if (typeof deps.readAgents !== 'function') {
      throw new TypeError('computeSessionTimeline needs deps.readAgents when a sessionId is given');
    }
    try { agents = deps.readAgents(sessionId); } catch { agents = {}; }
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

// POST the session timeline to Beezi. Session-scoped (upserted by sessionId). The result is read:
// `runLockedCheckpoint` in checkpoint.mjs destructures `{ reported }` and branches on it, so a
// `reported: false` reason has to stay accurate.
export async function postSessionTimeline(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  if (!payload || !payload.sessionId || !Array.isArray(payload.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  // { token, clientId }, never a bare token — see lib/http.mjs sessionOf.
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs travels through: the caller may be running against a hook deadline and needs this
    // request bounded by what is left of it, not by the default.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, session, payload, {
      fetchImpl,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
