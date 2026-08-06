import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta-codex.mjs';

// code-changes-codex and operations-codex are unit-tested on their own; this suite asserts the
// wiring — that their output actually reaches the segment stats the report payload is built from,
// and that it is scoped to the right segment when a session moves between repos.

function writeRollout(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

const meta = (cwd) => ({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { cwd } });
const turn = (cwd, ts) => ({ timestamp: ts, type: 'turn_context', payload: { cwd, model: 'gpt-5.2-codex' } });
const tokens = (ts, input, output) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } },
});
const applyPatch = (ts, callId, patch) => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: patch },
});
const shell = (ts, callId, command) => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'function_call', name: 'shell_command', call_id: callId, arguments: JSON.stringify({ command }) },
});
const shellOut = (ts, callId, output) => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output },
});

const resolvers = { repoRootOf: (dir) => dir, branchAt: () => 'main' };

const PATCH_TS = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  ' unchanged',
  '-old line',
  '+new line',
  '+another new line',
  '*** End Patch',
].join('\n');

test('computeDelta attaches code_changes to the segment', (t) => {
  const p = writeRollout(t, [
    meta('/repo'),
    turn('/repo', '2026-01-01T00:00:01.000Z'),
    applyPatch('2026-01-01T00:00:02.000Z', 'c1', PATCH_TS),
    tokens('2026-01-01T00:00:03.000Z', 10, 5),
  ]);
  const { segments } = computeDelta(p, 0, resolvers);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].stats.code_changes, {
    files_changed: 1, lines_added: 2, lines_removed: 1, by_extension: { '.ts': 1 },
  });
});

test('computeDelta attaches per-category operations to the segment', (t) => {
  const p = writeRollout(t, [
    meta('/repo'),
    turn('/repo', '2026-01-01T00:00:01.000Z'),
    shell('2026-01-01T00:00:02.000Z', 's1', 'rg -n "foo" src'),
    shellOut('2026-01-01T00:00:03.000Z', 's1', 'x'.repeat(400)),
    shell('2026-01-01T00:00:04.000Z', 's2', 'npm test'),
    applyPatch('2026-01-01T00:00:05.000Z', 'c1', PATCH_TS),
    tokens('2026-01-01T00:00:06.000Z', 10, 5),
  ]);
  const { segments } = computeDelta(p, 0, resolvers);
  const ops = segments[0].stats.operations;
  assert.equal(ops.search.count, 1);
  assert.equal(ops.search.est_tokens, 100); // 400 bytes / 4
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.file.count, 1); // apply_patch
  assert.equal(ops.mcp.count, 0);
});

test('code_changes are scoped to the repo the edit landed in', (t) => {
  const p = writeRollout(t, [
    meta('/repoA'),
    turn('/repoA', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 10, 5),
    turn('/repoB', '2026-01-01T00:00:03.000Z'),
    applyPatch('2026-01-01T00:00:04.000Z', 'c1', PATCH_TS),
    tokens('2026-01-01T00:00:05.000Z', 20, 10),
  ]);
  const { segments } = computeDelta(p, 0, resolvers);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].repoRoot, '/repoA');
  assert.equal(segments[0].stats.code_changes.files_changed, 0);
  assert.equal(segments[1].repoRoot, '/repoB');
  assert.equal(segments[1].stats.code_changes.files_changed, 1);
});

test('a segment with no tool activity still carries empty stats, not undefined', (t) => {
  const p = writeRollout(t, [
    meta('/repo'),
    turn('/repo', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 10, 5),
  ]);
  const { segments } = computeDelta(p, 0, resolvers);
  assert.deepEqual(segments[0].stats.code_changes, {
    files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {},
  });
  assert.equal(segments[0].stats.operations.file.count, 0);
  assert.deepEqual(segments[0].stats.operations.skill.by_skill, {});
});
