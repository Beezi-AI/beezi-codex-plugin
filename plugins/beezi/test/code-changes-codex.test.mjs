import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCodeChanges } from '../lib/code-changes-codex.mjs';

const applyPatch = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input } });

test('counts added/removed lines and files across an apply_patch envelope', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    ' unchanged',
    '-old line',
    '+new line',
    '+another new line',
    '*** Add File: src/b.js',
    '+created',
    '*** Delete File: src/c.txt',
    '*** End Patch',
  ].join('\n');

  const cc = computeCodeChanges([applyPatch(patch)]);
  assert.equal(cc.files_changed, 3);
  assert.equal(cc.lines_added, 3); // +new, +another, +created
  assert.equal(cc.lines_removed, 1); // -old line
  assert.equal(cc.by_extension['.ts'], 1);
  assert.equal(cc.by_extension['.js'], 1);
  assert.equal(cc.by_extension['.txt'], 1);
});

test('ignores non-apply_patch records and hunk/envelope headers', () => {
  const shell = { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"ls"}', call_id: 'x' } };
  const patch = ['*** Begin Patch', '*** Update File: a.py', '@@ def f():', '+    return 1', '*** End Patch'].join('\n');
  const cc = computeCodeChanges([shell, applyPatch(patch)]);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 1);
  assert.equal(cc.lines_removed, 0);
});

test('empty when there are no apply_patch calls', () => {
  const cc = computeCodeChanges([{ type: 'event_msg', payload: { type: 'agent_message' } }]);
  assert.deepEqual(cc, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
});
