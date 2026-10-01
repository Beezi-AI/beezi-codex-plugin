import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEARTBEAT_INTERVAL_MS,
  claimHeartbeat,
  touchHeartbeat,
  shouldHeartbeat,
} from '../lib/timing.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GATE (G-3-2), with an injected clock and an injected filesystem.
//
// This is the half of the heartbeat that runs on EVERY tool call, so what it has to prove is a
// bound, not a feature: at most one claim per session per interval, whatever the tool-call rate.
// The injected clock is what makes that assertable without sleeping — and the risk this row ships
// wrong is precisely "an interval that is too short, or a marker that never claims", which turns
// every tool call into a full 28-module checkpoint inside a 10-second hook budget.
//
// Nothing here touches a real disk: `fakeFs` is the only filesystem the module can see.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// The four calls lib/timing.mjs makes, and nothing else. A fifth would throw rather than silently
// fall through to the real fs, so a future rewrite of the marker cannot quietly escape this test.
function fakeFs({ readonly = false } = {}) {
  const files = new Map();
  let fd = 10;
  return {
    files,
    mkdirSync() { if (readonly) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    openSync(p) {
      if (readonly) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      files.set(p, this.now);
      fd += 1;
      return fd;
    },
    closeSync() {},
    statSync(p) {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: files.get(p) };
    },
  };
}

// A clock the test drives, wired so the fake fs stamps marker mtimes from the same source.
function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  return { now, advance: (ms) => { t += ms; }, get value() { return t; } };
}

function rig(over = {}) {
  const c = clock();
  const f = fakeFs(over);
  // openSync stamps `this.now`; bind it to the driven clock rather than to Date.now.
  Object.defineProperty(f, 'now', { get: c.now });
  return { fs: f, clock: c, deps: { fs: f, now: c.now } };
}

test('the interval is fifteen minutes, and it is the value the gate actually uses', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 15 * 60 * 1000);

  const { clock: c, deps } = rig();
  assert.equal(claimHeartbeat('s1', deps), true, 'first call of the session claims');
  c.advance(HEARTBEAT_INTERVAL_MS - 1);
  assert.equal(claimHeartbeat('s1', deps), false, 'one millisecond short of the interval');
  c.advance(1);
  assert.equal(claimHeartbeat('s1', deps), true, 'exactly at the interval');
});

test('THE BOUND: a hot tool loop claims once per interval, not once per tool call', () => {
  const { clock: c, deps } = rig();
  let claimed = 0;
  // Two hundred tool calls, four seconds apart — thirteen and a bit minutes of a hot agentic loop.
  for (let i = 0; i < 200; i += 1) {
    if (claimHeartbeat('s1', deps)) claimed += 1;
    c.advance(4_000);
  }
  // 200 * 4s = 800s = 13m20s, so the window opens exactly once more after the first claim.
  assert.equal(claimed, 1, 'a full checkpoint per tool call is the failure this row must not ship');

  c.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(claimHeartbeat('s1', deps), true, 'and the window does reopen — the marker is not a latch');
});

test('the marker is stamped BEFORE the work, so a checkpoint that dies waits out the interval', () => {
  const { clock: c, deps } = rig();
  assert.equal(claimHeartbeat('s1', deps), true);
  // The caller now explodes — killed hook, thrown engine, exhausted budget. Nothing un-stamps.
  c.advance(30_000);
  assert.equal(claimHeartbeat('s1', deps), false,
    'retrying a failed checkpoint on the very next tool call is the stall this ordering prevents');
});

test('parallel claims in one interval: exactly one wins, the rest skip', () => {
  const { deps } = rig();
  const wins = [claimHeartbeat('s1', deps), claimHeartbeat('s1', deps), claimHeartbeat('s1', deps)];
  assert.deepEqual(wins, [true, false, false]);
});

test('sessions have their own windows — one session does not suppress another', () => {
  const { deps } = rig();
  assert.equal(claimHeartbeat('s1', deps), true);
  assert.equal(claimHeartbeat('s2', deps), true, 'a second live session gets its own marker');
  assert.equal(claimHeartbeat('s1', deps), false);
});

test('an unwritable marker refuses rather than running a checkpoint on every tool call', () => {
  const { deps } = rig({ readonly: true });
  assert.equal(claimHeartbeat('s1', deps), false);
  assert.equal(claimHeartbeat('s1', deps), false, 'and it stays refused, it does not retry into a stall');
});

test('touchHeartbeat resets the window without claiming — that is what makes the marker mean "last checkpoint"', () => {
  const { clock: c, deps } = rig();
  assert.equal(claimHeartbeat('s1', deps), true);
  c.advance(14 * 60 * 1000);
  // A git boundary (scripts/checkpoint.mjs) or a turn end (scripts/stop.mjs) just checkpointed.
  assert.equal(touchHeartbeat('s1', deps), true);
  c.advance(2 * 60 * 1000);
  assert.equal(claimHeartbeat('s1', deps), false,
    'a session that commits every few minutes must not also pay for a redundant heartbeat');
  c.advance(13 * 60 * 1000 + 1);
  assert.equal(claimHeartbeat('s1', deps), true, 'measured from the touch, not from the last claim');
});

test('a falsy session id never claims and never writes — M-5-1 fails CLOSED', () => {
  const { fs: f, deps } = rig();
  for (const id of [undefined, null, '', 0]) {
    assert.equal(claimHeartbeat(id, deps), false, `claim refused for ${String(id)}`);
    assert.equal(touchHeartbeat(id, deps), false, `touch refused for ${String(id)}`);
  }
  // The point is not just the return value. `${undefined}.heartbeat` would be ONE marker shared by
  // every id-less session on the machine — the same class of bug G-3-1 closed for state files.
  assert.equal(f.files.size, 0, 'nothing was written under a name we do not have');
});

test('shouldHeartbeat is the whole gate: no payload, no id, or a subagent id → false', () => {
  const { fs: f, deps } = rig();
  assert.equal(shouldHeartbeat(null, deps), false);
  assert.equal(shouldHeartbeat('not an object', deps), false);
  assert.equal(shouldHeartbeat({}, deps), false, 'PostToolUse carrying no session_id is inferred, not measured');
  assert.equal(shouldHeartbeat({ session_id: 's1', agent_id: 'a1' }, deps), false);
  assert.equal(f.files.size, 0, 'and none of those stamped a marker');

  assert.equal(shouldHeartbeat({ session_id: 's1' }, deps), true);
  assert.equal(shouldHeartbeat({ session_id: 's1' }, deps), false);
});

test('THE FAN-OUT BOUND: N subagent tool calls produce N refusals and zero heartbeats', () => {
  const { fs: f, clock: c, deps } = rig();
  // The parent is blocked in wait_agent, so every PostToolUse in this window carries agent_id.
  // Eight agents, fifty tool calls each, spread over an hour — four heartbeat intervals.
  let fired = 0;
  for (let i = 0; i < 400; i += 1) {
    if (shouldHeartbeat({ session_id: 's1', agent_id: `agent-${i % 8}` }, deps)) fired += 1;
    c.advance(9_000);
  }
  assert.equal(fired, 0, 'an unmeasured fan-out cannot cost anything, because the guard is checked first');
  assert.equal(f.files.size, 0, 'and it does not even consume the parent session\'s window');

  // Proof the fixture is not vacuous: the same payloads without agent_id do fire.
  assert.equal(shouldHeartbeat({ session_id: 's1' }, deps), true);
});
