import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFromProgram, isGitCheckpointCommand, shellCommandsOf } from '../lib/hook-input.mjs';

test('isGitCheckpointCommand matches commit/switch/checkout only', () => {
  assert.ok(isGitCheckpointCommand('git commit -m "x"'));
  assert.ok(isGitCheckpointCommand('git switch main'));
  assert.ok(isGitCheckpointCommand('git checkout -b feat'));
  assert.ok(!isGitCheckpointCommand('git status'));
  assert.ok(!isGitCheckpointCommand('ls -la'));
});

test('shellCommandsOf reads a plain command field', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: { command: 'git commit', workdir: '/r' } }), ['git commit']);
});

test('shellCommandsOf unwraps a JSON-encoded tool_input', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: '{"command":"git switch dev"}' }), ['git switch dev']);
});

test('shellCommandsOf reads a nested arguments/input object', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: { arguments: { command: 'git checkout main' } } }), ['git checkout main']);
  assert.deepEqual(shellCommandsOf({ tool_input: { input: '{"command":"git commit"}' } }), ['git commit']);
});

test('shellCommandsOf returns no commands when the payload carries none', () => {
  assert.deepEqual(shellCommandsOf({}), []);
  assert.deepEqual(shellCommandsOf({ tool_input: {} }), []);
});

// Unified exec: one `exec` tool whose input is a JS program calling tools.exec_command(...).
// Shape taken verbatim from a real rollout record.
const EXEC_PROGRAM =
  'const r = await tools.exec_command({"cmd":"git commit -m \\"probe\\"","shell":"powershell",' +
  '"yield_time_ms":10000});\ntext(r.output);\n';

test('commandsFromProgram pulls every cmd literal out of a unified-exec program', () => {
  assert.deepEqual(commandsFromProgram(EXEC_PROGRAM), ['git commit -m "probe"']);
  assert.deepEqual(
    commandsFromProgram('await tools.exec_command({"cmd":"git add -A"});await tools.exec_command({"cmd":"git commit"});'),
    ['git add -A', 'git commit'],
  );
  assert.deepEqual(commandsFromProgram('text("no commands here")'), []);
  assert.deepEqual(commandsFromProgram(null), []);
});

test('shellCommandsOf reads a unified-exec JS program, as a raw string or nested', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: EXEC_PROGRAM }), ['git commit -m "probe"']);
  assert.deepEqual(shellCommandsOf({ tool_input: { input: EXEC_PROGRAM } }), ['git commit -m "probe"']);
});

test('a git checkpoint is detected under both tool surfaces', () => {
  assert.ok(shellCommandsOf({ tool_input: { command: 'git commit -m x' } }).some(isGitCheckpointCommand));
  assert.ok(shellCommandsOf({ tool_input: EXEC_PROGRAM }).some(isGitCheckpointCommand));
});

test('shellCommandsOf keeps every exec command separate so any one of them can match', () => {
  const program = 'await tools.exec_command({"cmd":"ls"});await tools.exec_command({"cmd":"git switch dev"});';
  assert.deepEqual(shellCommandsOf({ tool_input: program }), ['ls', 'git switch dev']);
  assert.ok(shellCommandsOf({ tool_input: program }).some(isGitCheckpointCommand));
});

test('shellCommandsOf reads a bare cmd field (unified exec, un-wrapped)', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: { cmd: 'git checkout main' } }), ['git checkout main']);
  assert.deepEqual(shellCommandsOf({ tool_input: { arguments: { cmd: 'git commit' } } }), ['git commit']);
});

// The unified-exec tool_input is JS the model wrote, not JSON, so the `cmd` key and its value may
// be spelled any way JS allows. Matching only the JSON form makes checkpoints stop firing silently.
test('commandsFromProgram tolerates bare and single-quoted JS spellings', () => {
  assert.deepEqual(commandsFromProgram('await tools.exec_command({cmd: "git switch dev"});'), ['git switch dev']);
  assert.deepEqual(commandsFromProgram("await tools.exec_command({'cmd': 'git checkout main'});"), ['git checkout main']);
  assert.deepEqual(commandsFromProgram('await tools.exec_command({"cmd":"git commit -m \\"x\\""});'), ['git commit -m "x"']);
});

test('every JS spelling still reaches the git checkpoint test', () => {
  for (const src of [
    'await tools.exec_command({cmd: "git commit -m x"});',
    "await tools.exec_command({'cmd': 'git commit -m x'});",
    'await tools.exec_command({"cmd":"git commit -m x"});',
  ]) {
    assert.ok(shellCommandsOf({ tool_input: src }).some(isGitCheckpointCommand), src);
  }
});
