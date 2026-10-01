import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCodeChanges, editedPathsOf } from '../lib/code-changes-codex.mjs';

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

// ============================================================================================
// The three code-change eras. The three tests above are ERA A — a `custom_tool_call` apply_patch
// with no event of any kind, which is what CLI 0.77-0.107 emits and what 72 of 201 local rollouts
// still contain. They must keep passing unmodified; needing to edit them means the change is
// wrong. Everything below covers era B (`event_msg/patch_apply_end`) and era C
// (`event_msg/item_completed` with `item.type === 'FileChange'`, which REPLACED era B in 0.153).
// ============================================================================================

const patchApplyEnd = (callId, changes, extra) => ({
  type: 'event_msg',
  payload: Object.assign({ type: 'patch_apply_end', call_id: callId, success: true, changes }, extra || {}),
});

const fileChange = (itemId, changes, extra) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: Object.assign({ type: 'FileChange', id: itemId, status: 'completed', changes }, extra || {}),
  },
});

// A real `unified_diff`: a bare diff BODY starting at a hunk header. No `*** Begin Patch`
// envelope, which is why the era-A parser cannot read it.
const UNIFIED_DIFF = [
  '@@ -1,4 +1,5 @@',
  ' unchanged context',
  '-old one',
  '-old two',
  '+new one',
  '+new two',
  '+new three',
].join('\n');

test('era B: patch_apply_end with an update counts the unified_diff', () => {
  const cc = computeCodeChanges([
    patchApplyEnd('call_1', { 'C:\\repo\\src\\a.ts': { type: 'update', unified_diff: UNIFIED_DIFF, move_path: null } }),
  ]);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 3);
  assert.equal(cc.lines_removed, 2);
  assert.deepEqual(cc.by_extension, { '.ts': 1 });
});

test('era C: item_completed/FileChange counts add and delete by their content', () => {
  const cc = computeCodeChanges([
    fileChange('exec-1', {
      '/repo/new.js': { type: 'add', content: 'one\ntwo\nthree\n' },
      '/repo/gone.py': { type: 'delete', content: 'a\nb\n' },
    }),
  ]);
  assert.equal(cc.files_changed, 2);
  assert.equal(cc.lines_added, 3, 'one trailing newline is stripped, then split — Claude\'s rule');
  assert.equal(cc.lines_removed, 2);
  assert.deepEqual(cc.by_extension, { '.js': 1, '.py': 1 });
});

test('an update carries unified_diff and no content — the field the parity plan got wrong', () => {
  // 288 of 411 measured change entries are updates, and none of them has a `content` field. A
  // parser keyed on `{type, content}` alone silently counts zero lines for 70% of all changes.
  const cc = computeCodeChanges([
    fileChange('exec-1', { '/repo/a.ts': { type: 'update', unified_diff: UNIFIED_DIFF } }),
  ]);
  assert.equal(cc.lines_added, 3);
  assert.equal(cc.lines_removed, 2);
});

test('unified_diff preamble is not counted, but +++/--- inside a hunk are real lines', () => {
  const cc = computeCodeChanges([
    patchApplyEnd('call_1', {
      '/repo/a.md': {
        type: 'update',
        unified_diff: [
          '--- a/a.md',   // preamble: before the first @@, must not count as a removal
          '+++ b/a.md',   // preamble: must not count as an addition
          '@@ -1,2 +1,3 @@',
          ' keep',
          '-gone',
          '+++ a markdown rule, genuinely added',
          '+plain addition',
        ].join('\n'),
      },
    }),
  ]);
  assert.equal(cc.lines_added, 2);
  assert.equal(cc.lines_removed, 1);
});

test('a rename counts one file — the destination, not the map key', () => {
  // The map keys the OLD path and names the NEW one in move_path; unified_diff is often "".
  const cc = computeCodeChanges([
    fileChange('exec-1', {
      '/repo/old-name.ts': { type: 'update', unified_diff: '', move_path: '/repo/new-name.ts' },
    }),
  ]);
  assert.equal(cc.files_changed, 1);
  assert.deepEqual([...Object.keys(cc.by_extension)], ['.ts']);
  assert.equal(cc.lines_added, 0);
  assert.equal(cc.lines_removed, 0);
});

test('a failed patch contributes nothing even though it names the file it tried to write', () => {
  const changes = { '/repo/a.ts': { type: 'update', unified_diff: UNIFIED_DIFF } };
  const bySuccess = computeCodeChanges([patchApplyEnd('call_1', changes, { success: false, status: 'failed' })]);
  assert.deepEqual(bySuccess, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
  const byStatus = computeCodeChanges([patchApplyEnd('call_2', changes, { status: 'failed' })]);
  assert.deepEqual(byStatus, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
  const incomplete = computeCodeChanges([fileChange('exec-1', changes, { status: 'in_progress' })]);
  assert.deepEqual(incomplete, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
});

// --- dedup rule 2: one Set of event ids -----------------------------------------------------

test('the same event id twice counts once', () => {
  const changes = { '/repo/a.ts': { type: 'update', unified_diff: UNIFIED_DIFF } };
  const cc = computeCodeChanges([patchApplyEnd('call_1', changes), patchApplyEnd('call_1', changes)]);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 3);
  assert.equal(cc.lines_removed, 2);
});

test('patch_apply_end and FileChange share one id namespace', () => {
  // They never co-occurred in 95 local rollouts, but they use the same ids, so one Set makes a
  // future build that emits both safe for free.
  const changes = { '/repo/a.ts': { type: 'update', unified_diff: UNIFIED_DIFF } };
  const cc = computeCodeChanges([patchApplyEnd('exec-9', changes), fileChange('exec-9', changes)]);
  assert.equal(cc.lines_added, 3, 'one edit described twice is still one edit');
});

// --- dedup rule 3: suppress the legacy envelope by matching call_id, never by index ----------

test('an era-B legacy call and its patch_apply_end with the same call_id count once', () => {
  // This is the regression that matters most: on 0.122-0.146 builds the `apply_patch`
  // custom_tool_call and its `patch_apply_end` co-occur and share the call_id (169 measured
  // joins). Counting both doubles every line count for that whole installed base.
  const envelope = [
    '*** Begin Patch',
    '*** Update File: /repo/a.ts',
    '@@',
    ' unchanged context',
    '-old one',
    '-old two',
    '+new one',
    '+new two',
    '+new three',
    '*** End Patch',
  ].join('\n');
  const cc = computeCodeChanges([
    applyPatch(envelope),  // call_id 'c1'
    patchApplyEnd('c1', { '/repo/a.ts': { type: 'update', unified_diff: UNIFIED_DIFF } }),
  ]);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 3, 'not 6');
  assert.equal(cc.lines_removed, 2, 'not 4');
});

test('a legacy call whose call_id no event claims still counts — era A stays a live fallback', () => {
  const envelope = ['*** Begin Patch', '*** Add File: /repo/b.js', '+one', '*** End Patch'].join('\n');
  const cc = computeCodeChanges([
    applyPatch(envelope),                                                       // call_id 'c1'
    patchApplyEnd('other-call', { '/repo/a.ts': { type: 'add', content: 'x\n' } }),
  ]);
  assert.equal(cc.files_changed, 2, 'suppression is by matching key, never by position');
  assert.equal(cc.lines_added, 2);
});

// --- dedup rule 1: exec programs are never a code-change source -----------------------------

test('tools.apply_patch inside an exec program is never parsed for code changes', () => {
  // The trap. Every rollout whose exec programs contain `tools.apply_patch` also carries an event
  // describing the result, so parsing the program too would double-count every modern edit. The
  // exec call id (`call_<base62>`) and the event id (`exec-<uuid>`) deliberately do not join.
  const execCall = {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_YSETJS1GyV39DZI5bzGztrqa',
      input: 'const r = await tools.apply_patch({input:"*** Begin Patch\\n*** Add File: /repo/a.ts\\n+one\\n+two\\n*** End Patch"});text(r.output);',
    },
  };
  const cc = computeCodeChanges([
    execCall,
    fileChange('exec-019e6500-0000-0000-0000-000000000001', {
      '/repo/a.ts': { type: 'add', content: 'one\ntwo\n' },
    }),
  ]);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 2, 'the event is the single source; the program is not read');
  assert.equal(cc.lines_removed, 0);
});

test('an exec program with no event at all still contributes nothing', () => {
  const execCall = {
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_x', input: 'await tools.apply_patch({input:"*** Begin Patch\\n*** Add File: /a.ts\\n+one\\n*** End Patch"});' },
  };
  assert.deepEqual(computeCodeChanges([execCall]), {
    files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {},
  });
});

// --- path identity --------------------------------------------------------------------------

test('one file spelled with two drive-letter cases counts once', () => {
  const cc = computeCodeChanges([
    patchApplyEnd('call_1', { 'C:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n+one' } }),
    patchApplyEnd('call_2', { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n+two' } }),
  ]);
  assert.equal(cc.files_changed, 1);
  assert.deepEqual(cc.by_extension, { '.ts': 1 }, 'by_extension must still sum to files_changed');
  assert.equal(cc.lines_added, 2, 'both edits still count their lines');
});

test('a change map that is missing, empty or malformed is inert', () => {
  const cc = computeCodeChanges([
    patchApplyEnd('call_1', undefined),
    patchApplyEnd('call_2', {}),
    patchApplyEnd('call_3', { '/repo/a.ts': null }),
    fileChange('exec-1', { '/repo/b.ts': { type: 'update' } }),        // no unified_diff
    fileChange('exec-2', { '/repo/c.ts': { type: 'add' } }),           // no content
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', id: 'p1' } } },
  ]);
  assert.equal(cc.files_changed, 2, 'the two well-formed keys are still touched');
  assert.equal(cc.lines_added, 0);
  assert.equal(cc.lines_removed, 0);
});

test('editedPathsOf — FileChange prefers move_path; a failed patch_apply_end yields nothing', () => {
  const fc = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'a', status: 'completed',
    changes: { 'C:\\r\\old.md': { type: 'update', unified_diff: '@@\n+x', move_path: 'C:\\r\\new.md' }, 'C:\\r\\b.js': { type: 'add', content: 'x' } } } } };
  assert.deepEqual(editedPathsOf(fc), ['C:\\r\\new.md', 'C:\\r\\b.js']);
  const failed = { type: 'event_msg', payload: { type: 'patch_apply_end', success: false, changes: { 'C:\\r\\x.md': { type: 'add', content: 'x' } } } };
  assert.deepEqual(editedPathsOf(failed), []);
  const ok = { type: 'event_msg', payload: { type: 'patch_apply_end', success: true, changes: { '/r/x.md': { type: 'add', content: 'x' } } } };
  assert.deepEqual(editedPathsOf(ok), ['/r/x.md']);
});

test('editedPathsOf — a legacy envelope yields its Add and Update headers', () => {
  const input = '*** Begin Patch\n*** Add File: docs/plan.md\n+x\n*** Update File: src/a.js\n@@\n-a\n+b\n*** Delete File: old.md\n*** End Patch';
  assert.deepEqual(editedPathsOf({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input } }),
    ['docs/plan.md', 'src/a.js']);
  assert.deepEqual(editedPathsOf({ type: 'event_msg', payload: { type: 'agent_message' } }), []);
  assert.deepEqual(editedPathsOf(null), []);
});
