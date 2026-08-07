import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSessionTimeline, postSessionTimeline } from '../lib/session-timeline-codex.mjs';

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const at = (s) => `2026-01-01T00:${String(s).padStart(2, '0')}:00.000Z`;
const userMsg = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
const work = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'agent_message' } });
const updatePlan = (s, plan) => ({ timestamp: at(s), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) } });

test('classifies the gap before a user prompt as waiting_user and work runs as working', () => {
  const tl = computeSessionTimeline(writeRollout([
    userMsg(0),  // prompt at :00
    work(1),     // :00→:01 waiting_user (gap before prompt at :00? gap is between consecutive anchors)
    work(2),
    userMsg(5),  // :02→:05 gap < idle → but cur is prompt → waiting_user
  ]));
  assert.ok(tl);
  const states = tl.periods.map((p) => p.state);
  assert.ok(states.includes('working'));
  assert.ok(states.includes('waiting_user'));
});

test('long gaps become idle periods', () => {
  const tl = computeSessionTimeline(writeRollout([work(0), work(10)])); // 10min gap > 5min idle
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].state, 'idle');
});

test('update_plan calls emit plan_start and (when all completed) plan_ready', () => {
  const tl = computeSessionTimeline(writeRollout([
    updatePlan(0, [{ step: 'a', status: 'in_progress' }]),
    work(1),
    updatePlan(2, [{ step: 'a', status: 'completed' }]),
  ]));
  const types = tl.plan_events.map((e) => e.type);
  assert.deepEqual(types, ['plan_start', 'plan_ready']);
});

test('returns null when nothing is timestamped', () => {
  assert.equal(computeSessionTimeline(writeRollout([{ type: 'event_msg', payload: { type: 'agent_message' } }])), null);
});

test('postSessionTimeline guards missing fields and no token', async () => {
  assert.deepEqual(await postSessionTimeline({ periods: [] }, 't'), { reported: false, reason: 'missing-fields' });
  assert.deepEqual(await postSessionTimeline({ sessionId: 's', periods: [] }, null), { reported: false, reason: 'no-token' });
});

// ─── subagent spans ─────────────────────────────────────────────────────────
// They cannot come from the transcript — Codex writes a subagent to its own rollout and this file
// records nothing about it. The SubagentStart/SubagentStop hooks are the source.

const agents = (recs) => ({ readAgents: () => recs });

test('subagent spans come from the hook records, keyed to this session', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(1), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', agent_type: 'explore', started_at: at(2), ended_at: at(4) },
  }));
  assert.deepEqual(tl.subagents, [{
    agent_id: 'agent-a', agent_type: 'explore', started_at: at(2), ended_at: at(4),
  }]);
});

test('an agent still running is clamped to the session end, never left without one', () => {
  // ended_at is required by the server; omitting it rejects the WHOLE timeline, periods included.
  // The session's own end is the last moment we have evidence anything was alive.
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(1), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: at(2), ended_at: null },
  }));
  assert.equal(tl.subagents[0].ended_at, tl.ended_at);
  assert.equal(tl.subagents[0].agent_type, null);
});

test('clock skew can never produce ended_at before started_at', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: at(5), ended_at: at(3) },
  }));
  assert.ok(Date.parse(tl.subagents[0].ended_at) >= Date.parse(tl.subagents[0].started_at));
});

test('an agent with no usable start is dropped rather than invented', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: 'nonsense' },
    'agent-b': { agent_id: 'agent-b', started_at: at(2), ended_at: at(3) },
  }));
  assert.deepEqual(tl.subagents.map((s) => s.agent_id), ['agent-b']);
});

test('spans are sorted by start and capped at the server limit', () => {
  const many = {};
  for (let i = 0; i < 1200; i++) {
    many[`agent-${i}`] = { agent_id: `agent-${i}`, started_at: new Date(Date.parse(at(1)) + i).toISOString(), ended_at: at(5) };
  }
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents(many));
  assert.equal(tl.subagents.length, 1000, 'a runaway fan-out must not 400 the payload');
  const starts = tl.subagents.map((s) => s.started_at);
  assert.deepEqual(starts, [...starts].sort());
});

test('each span carries exactly the four fields the server accepts', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', agent_type: 'x', started_at: at(2), ended_at: at(3), cursor: 7, transcriptPath: '/tmp/x' },
  }));
  // cursor and transcriptPath are ours; the server rejects any unknown key outright.
  assert.deepEqual(Object.keys(tl.subagents[0]).sort(), ['agent_id', 'agent_type', 'ended_at', 'started_at']);
});

test('no session id means no subagent lookup, and an empty array', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]));
  assert.deepEqual(tl.subagents, []);
});
