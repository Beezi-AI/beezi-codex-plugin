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
