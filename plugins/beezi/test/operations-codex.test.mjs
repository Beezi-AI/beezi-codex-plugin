import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOperations } from '../lib/operations-codex.mjs';

const fn = (name, callId) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{}', call_id: callId } });
const fnOut = (callId, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });
const custom = (name, callId) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, input: 'x' } });
const customOut = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

test('categorizes shell, file, and unknown-as-mcp tools with est_tokens from output bytes', () => {
  const lines = [
    fn('shell_command', 's1'),
    fnOut('s1', 'x'.repeat(40)), // 40 bytes → est 10
    custom('apply_patch', 'p1'),
    customOut('p1', 'y'.repeat(8)), // 8 bytes → est 2
    fn('notion_search', 'n1'), // unknown name → mcp
    fnOut('n1', 'z'.repeat(20)), // 20 bytes → est 5
  ];
  const ops = computeOperations(lines);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.shell.est_tokens, 10);
  assert.equal(ops.file.count, 1);
  assert.equal(ops.file.est_tokens, 2);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.est_tokens, 5);
  assert.equal(ops.mcp.by_server.unknown.count, 1);
  assert.equal(ops.plugins.unknown.count, 1);
});

test('planning/interactive builtins fall into other, not mcp', () => {
  const ops = computeOperations([fn('update_plan', 'u1'), fn('request_user_input', 'r1'), fn('wait', 'w1')]);
  assert.equal(ops.other.count, 3);
  assert.equal(ops.mcp.count, 0);
});

test('list_mcp_resources is an mcp builtin', () => {
  const ops = computeOperations([fn('list_mcp_resources', 'm1')]);
  assert.equal(ops.mcp.count, 1);
});

// --- MCP server attribution ------------------------------------------------------------------
// Shapes copied from real rollouts: mcp_tool_call_end is the only record naming the server.

const shell = (callId, command, workdir = 'C:/work') => ({
  type: 'response_item',
  payload: { type: 'function_call', name: 'shell_command', call_id: callId, arguments: JSON.stringify({ command, workdir }) },
});
const mcpEnd = (callId, server, tool) => ({
  type: 'event_msg',
  payload: { type: 'mcp_tool_call_end', call_id: callId, invocation: { server, tool, arguments: {} } },
});

test('an MCP call is attributed to the server that answered it', () => {
  const ops = computeOperations([
    fn('notion_search', 'n1'),
    fnOut('n1', 'z'.repeat(20)),
    mcpEnd('n1', 'notion', 'notion-search'),
  ]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.notion.count, 1);
  assert.equal(ops.mcp.by_server.notion.est_tokens, 5);
  assert.equal(ops.mcp.by_server.unknown, undefined);
  assert.equal(ops.plugins.notion.count, 1);
});

test('two servers in one segment stay separate', () => {
  const ops = computeOperations([
    fn('notion_search', 'n1'), mcpEnd('n1', 'notion', 'notion-search'),
    fn('beezi_status', 'b1'), mcpEnd('b1', 'beezi', 'beezi_status'),
    fn('notion_fetch', 'n2'), mcpEnd('n2', 'notion', 'notion-fetch'),
  ]);
  assert.equal(ops.mcp.count, 3);
  assert.equal(ops.mcp.by_server.notion.count, 2);
  assert.equal(ops.mcp.by_server.beezi.count, 1);
});

test('an unrecognized bare word is not invented into an MCP server', () => {
  // Without an mcp_tool_call_end and without an MCP-shaped name, a new Codex builtin is `other` —
  // guessing 'mcp' would report a server that does not exist.
  const ops = computeOperations([fn('somenewbuiltin', 'x1')]);
  assert.equal(ops.mcp.count, 0);
  assert.equal(ops.other.count, 1);
});

test('an MCP-shaped name still reads as MCP on rollouts predating mcp_tool_call_end', () => {
  const ops = computeOperations([fn('notion_search', 'n1')]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.unknown.count, 1);
});

// --- the search bucket -----------------------------------------------------------------------

test('a repo search run through the shell lands in the search bucket', () => {
  const ops = computeOperations([
    shell('s1', 'rg -n "ChoiceSet|filtered" api/src'),
    fnOut('s1', 'x'.repeat(40)),
  ]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.search.est_tokens, 10);
  assert.equal(ops.shell.count, 0);
});

test('non-search shell work stays in the shell bucket', () => {
  const ops = computeOperations([
    shell('s1', 'Get-Content api/src/index.ts'),
    shell('s2', 'npm test'),
  ]);
  assert.equal(ops.shell.count, 2);
  assert.equal(ops.search.count, 0);
});

test('search is recognized past a path and an extension', () => {
  const ops = computeOperations([
    shell('s1', '/usr/bin/grep -r foo .'),
    shell('s2', 'C:\\tools\\rg.exe bar'),
    shell('s3', 'Select-String -Pattern foo *.ts'),
  ]);
  assert.equal(ops.search.count, 3);
});

test('a shell call with no plain command string is left as shell', () => {
  // The unified `exec` surface passes a JS program, not a command line — no head to read.
  const ops = computeOperations([
    { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'e1', arguments: JSON.stringify({ input: 'tools.exec_command("rg foo")' }) } },
  ]);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.search.count, 0);
});

test('Codex tool-discovery search is not a code search', () => {
  const ops = computeOperations([fn('tool_search_call', 't1')]);
  assert.equal(ops.search.count, 0);
  assert.equal(ops.other.count, 1);
});
