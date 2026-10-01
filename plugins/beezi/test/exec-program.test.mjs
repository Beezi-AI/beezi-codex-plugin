import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFromProgram, toolNamesFromProgram } from '../lib/exec-program.mjs';
import { commandsFromProgram as reExported } from '../lib/hook-input.mjs';

// lib/exec-program.mjs holds both unified-exec program parsers so lib/operations-codex.mjs — a
// pure computation — can reach them without importing lib/hook-input.mjs's `fs`.

test('hook-input re-exports the one and only commandsFromProgram', () => {
  // The whole point of the extraction is that there is no second parser to drift from this one.
  assert.equal(reExported, commandsFromProgram);
});

test('toolNamesFromProgram names the tool an exec program really called', () => {
  assert.deepEqual(
    toolNamesFromProgram('const r = await tools.exec_command({cmd:"rg -n foo"}); text(r.output);'),
    ['exec_command'],
  );
  assert.deepEqual(toolNamesFromProgram('await tools.apply_patch({input:"..."});'), ['apply_patch']);
  assert.deepEqual(toolNamesFromProgram('await tools.mcp__beezi__beezi_login({});'), ['mcp__beezi__beezi_login']);
});

test('toolNamesFromProgram tolerates whitespace before the paren', () => {
  assert.deepEqual(toolNamesFromProgram('await tools.web__run ({search_query:[]});'), ['web__run']);
});

test('toolNamesFromProgram de-duplicates and keeps first-call order', () => {
  const program = 'await tools.apply_patch({input:"a"}); await tools.exec_command({cmd:"npm test"}); '
    + 'await tools.apply_patch({input:"b"});';
  assert.deepEqual(toolNamesFromProgram(program), ['apply_patch', 'exec_command']);
});

test('toolNamesFromProgram returns nothing for a program that calls no tool', () => {
  // 6 of 1123 real programs only call text(...). Those must stay categorizable by name alone.
  assert.deepEqual(toolNamesFromProgram('text("nothing to run");'), []);
  assert.deepEqual(toolNamesFromProgram('const tools = 1; text(tools);'), []);
  assert.deepEqual(toolNamesFromProgram(null), []);
  assert.deepEqual(toolNamesFromProgram(undefined), []);
  assert.deepEqual(toolNamesFromProgram({ input: 'await tools.exec_command({})' }), []);
});

test('commandsFromProgram and toolNamesFromProgram answer different questions', () => {
  // A program can name its tool without exposing any command literal (the runtime-assembled 3.2%),
  // and the categorizer has to keep working on exactly those.
  const program = 'const cmdText = build(); const r = await tools.exec_command({cmd:cmdText}); text(r.output);';
  assert.deepEqual(toolNamesFromProgram(program), ['exec_command']);
  assert.deepEqual(commandsFromProgram(program), []);
});
