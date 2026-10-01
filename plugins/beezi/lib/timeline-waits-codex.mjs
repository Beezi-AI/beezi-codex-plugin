// Evidence for main-thread waits. A running child or process alone is not a wait: the parent
// may be doing useful work in parallel. Match blocking calls by call_id and classify their
// spans, including intervening bookkeeping, only while the main thread is actually blocked.
// Names and waiting subtypes match the Claude timeline contract.
import { toolNamesFromProgram } from './exec-program.mjs';

function argsOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export function isBackgroundNotification(rec) {
  const p = (rec || {}).payload || {};
  if (rec.type === 'response_item' && p.type === 'agent_message') return true;
  if (rec.type === 'event_msg' && p.type === 'item_completed' && p.item
    && p.item.type === 'SubAgentActivity' && p.item.kind === 'completed') return true;
  // Some builds deliver background task notifications through the user-message surface.
  return rec.type === 'event_msg' && p.type === 'user_message'
    && typeof p.message === 'string' && p.message.trimStart().indexOf('<task-notification>') === 0;
}

export function isTimelineUserPrompt(rec) {
  const p = (rec || {}).payload || {};
  return rec.type === 'event_msg' && (p.type === 'user_message'
    || (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage'))
    && !isBackgroundNotification(rec);
}

function callName(p) {
  if (p.type !== 'custom_tool_call' || p.name !== 'exec') return p.name;
  const names = toolNamesFromProgram(p.input);
  return names.length === 1 ? names[0] : null;
}

function callWait(p) {
  const args = argsOf(p.arguments) || {};
  // Mixed exec programs have no per-inner-call timestamps. Async questions are not blockers.
  const name = callName(p);
  if (name === 'request_user_input') return { state: 'waiting_user', subtype: 'question_answer' };
  if (name === 'request_permissions') return { state: 'waiting_user', subtype: 'command_approval' };
  if (name === 'wait_agent' || name === 'wait' || name === 'write_stdin') {
    // Sending stdin is a command, whereas an empty stdin call waits for a background process.
    // Accept only literal polling arguments in wrapped exec; never evaluate JS or guess a
    // variable's value. These are the numeric/empty-string arguments present in real rollouts.
    if (name === 'write_stdin') {
      if (p.type === 'function_call') {
        if (!args.session_id || (args.chars || '') !== '') return null;
      } else {
        const match = typeof p.input === 'string' && p.input.match(/tools\.write_stdin\s*\(\s*\{([^{}]*)\}\s*\)/);
        if (!match) return null;
        const fields = match[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (!fields.some((s) => /^session_id\s*:\s*\d+$/.test(s)) || !fields.every((s) =>
          /^(session_id|yield_time_ms|max_output_tokens)\s*:\s*\d+$/.test(s)
          || /^chars\s*:\s*(""|'')$/.test(s))) return null;
      }
    }
    if (name === 'wait' && p.type === 'function_call' && !args.cell_id && !Array.isArray(args.ids)) return null;
    return { state: 'idle', subtype: null };
  }
  return null;
}

function isBookkeeping(rec) {
  const p = rec.payload || {};
  // Completion echoes are observations of tools finishing, not fresh main-thread work.
  const completion = rec.type === 'event_msg' && p.type === 'item_completed' && p.item
    && ['CommandExecution', 'CollabAgentToolCall', 'McpToolCall', 'FileChange', 'ImageView'].indexOf(p.item.type) !== -1;
  return rec.type === 'token_usage_record' || rec.type === 'world_state'
    || completion
    // Modern prompts are written first as a raw user message, then as UserMessage. Preambles
    // and settings are also raw input messages; none proves the main agent resumed working.
    || (rec.type === 'response_item' && p.type === 'message'
      && (p.role === 'user' || p.role === 'developer' || p.role === 'system'))
    || rec.type === 'turn_context' || rec.type === 'inter_agent_communication_metadata'
    || (rec.type === 'event_msg' && (p.type === 'token_count' || p.type === 'task_complete' || p.type === 'task_started'
      || p.type === 'thread_settings_applied'));
}

export function timelineWaits(records) {
  const timed = records.filter((r) => Number.isFinite(Date.parse(r.timestamp)))
    .slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const calls = new Map();
  const asyncQuestions = new Set();
  const spans = [];
  let presentedPlan = false;
  let pendingQuestion = false;
  let betweenTurns = null;
  for (const rec of timed) {
    const ms = Date.parse(rec.timestamp);
    const p = rec.payload || {};
    const event = rec.type === 'event_msg';
    const response = rec.type === 'response_item';
    if (event && p.type === 'task_started') presentedPlan = false;
    if ((event && p.type === 'item_completed' && p.item && p.item.type === 'Plan')
      || (response && p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer'
        && Array.isArray(p.content) && p.content.some((b) => typeof b.text === 'string'
          && b.text.indexOf('<proposed_plan>') !== -1))) presentedPlan = true;

    if (betweenTurns) {
      if (isTimelineUserPrompt(rec)) {
        spans.push({ start: betweenTurns.start, end: ms, state: 'waiting_user', subtype: betweenTurns.subtype });
        betweenTurns = null;
      } else if (!isBookkeeping(rec)) {
        // A wake-up without a human is not next-instruction time.
        betweenTurns = null;
      }
    }
    if (isTimelineUserPrompt(rec)) pendingQuestion = false;
    if (event && p.type === 'task_complete') {
      if (!betweenTurns) betweenTurns = { start: ms, subtype: pendingQuestion ? 'question_answer'
        : presentedPlan ? 'plan_approval' : 'next_instruction' };
    }
    if (response && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (callName(p) === 'request_user_input_async' && p.call_id) asyncQuestions.add(p.call_id);
      const wait = callWait(p);
      if (wait && p.call_id) calls.set(p.call_id, { start: ms, state: wait.state, subtype: wait.subtype });
    }
    if (response && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      if (asyncQuestions.has(p.call_id)) {
        asyncQuestions.delete(p.call_id);
        const output = argsOf(p.output);
        if (output && output.accepted === true) pendingQuestion = true;
      }
      const call = calls.get(p.call_id);
      if (call) {
        calls.delete(p.call_id);
        // Failed / unavailable question calls are not evidence of a human answer.
        const output = argsOf(p.output);
        const answered = call.subtype !== 'question_answer' || (output && output.answers
          && typeof output.answers === 'object' && Object.keys(output.answers).length > 0);
        // Like Claude permission markers, suppress near-instant auto-resolved approvals.
        const human = call.subtype !== 'command_approval' || ms - call.start >= 1000;
        if (answered && human && !(output && output.error)) spans.push({ ...call, end: ms });
      }
    }
  }

  const waits = new Map();
  // Only classify complete observed waits, never extend an unanswered call to wall-clock now.
  // A main-thread work record inside a span ends the inference of continuous blocking. This
  // matters for parallel tool batches and makes async work stay working.
  for (const span of spans) {
    let start = span.start;
    for (const rec of timed) {
      const ms = Date.parse(rec.timestamp);
      if (ms <= span.start || ms >= span.end) continue;
      if (!isBookkeeping(rec)) start = ms;
    }
    for (const rec of timed) {
      const ms = Date.parse(rec.timestamp);
      if (ms <= start || ms > span.end) continue;
      const existing = waits.get(ms);
      // Human decisions have a more specific cause than a concurrent machine wait.
      if (!existing || span.state === 'waiting_user') waits.set(ms, { state: span.state, subtype: span.subtype });
    }
  }
  return waits;
}
