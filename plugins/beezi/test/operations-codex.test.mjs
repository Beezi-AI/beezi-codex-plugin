import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOperations } from '../lib/operations-codex.mjs';

const fn = (name, callId) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{}', call_id: callId } });
const fnOut = (callId, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });
const custom = (name, callId) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, input: 'x' } });
const customOut = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

test('categorizes shell, file, and unidentified tools without inventing MCP usage', () => {
  const lines = [
    fn('shell_command', 's1'),
    fnOut('s1', 'x'.repeat(40)), // 40 bytes → est 10
    custom('apply_patch', 'p1'),
    customOut('p1', 'y'.repeat(8)), // 8 bytes → est 2
    fn('notion_search', 'n1'), // no server evidence
    fnOut('n1', 'z'.repeat(20)), // 20 bytes → est 5
  ];
  const ops = computeOperations(lines);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.shell.est_tokens, 10);
  assert.equal(ops.file.count, 1);
  assert.equal(ops.file.est_tokens, 2);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.other.est_tokens, 5);
  assert.equal(ops.mcp.count, 0);
  assert.deepEqual(ops.plugins, {});
});

test('planning/interactive builtins fall into other, not mcp', () => {
  const ops = computeOperations([fn('update_plan', 'u1'), fn('request_user_input', 'r1'), fn('wait', 'w1')]);
  assert.equal(ops.other.count, 3);
  assert.equal(ops.mcp.count, 0);
});

test('server-agnostic MCP discovery does not invent a server', () => {
  const ops = computeOperations([fn('list_mcp_resources', 'm1')]);
  assert.equal(ops.mcp.count, 0);
  assert.equal(ops.other.count, 1);
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

test('direct prefixed MCP calls retain their server without a completion event', () => {
  const ops = computeOperations([
    fn('mcp__beezi__beezi_status', 'b1'), fnOut('b1', 'x'.repeat(20)),
    custom('mcp__plugin_beezi_staging__list_projects', 'b2'),
  ]);
  assert.deepEqual(ops.mcp.by_server.beezi, { count: 1, est_tokens: 5 });
  assert.deepEqual(ops.plugins.plugin_beezi_staging, { count: 1, est_tokens: 0 });
  assert.equal(ops.mcp.by_server.unknown, undefined);
});

test('completion metadata takes precedence over a direct MCP prefix', () => {
  const ops = computeOperations([
    fn('mcp__alias__search', 'n1'), mcpEnd('n1', 'notion', 'search'),
  ]);
  assert.equal(ops.mcp.by_server.notion.count, 1);
  assert.equal(ops.mcp.by_server.alias, undefined);
});

test('known direct builtins do not produce unknown MCP usage', () => {
  const ops = computeOperations([
    fn('write_stdin', 's1'), fn('web__run', 'w1'),
    fn('request_permissions', 'p1'), fn('request_user_input_async', 'p2'),
    fn('create_goal', 'g1'), fn('get_goal', 'g2'), fn('update_goal', 'g3'),
  ]);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.internet.count, 1);
  assert.equal(ops.other.count, 5);
  assert.equal(ops.mcp.count, 0);
  assert.deepEqual(ops.plugins, {});
});

test('agent lifecycle calls from local sessions never count as MCP', () => {
  const names = ['send_message', 'wait_agent', 'spawn_agent', 'list_agents', 'followup_task',
    'interrupt_agent', 'close_agent', 'resume_agent', 'new_builtin'];
  const ops = computeOperations(names.map((name, i) => fn(name, String(i))));
  assert.equal(ops.other.count, 9);
  assert.equal(ops.mcp.count, 0);
  assert.deepEqual(ops.plugins, {});
});

test('legacy Beezi local tools have an explicit mapping, not a prefix guess', () => {
  const ops = computeOperations([
    fn('beezi_login', 'l1'), fn('beezi_status', 's1'), fn('beezi_unrecognized', 'x1'),
  ]);
  assert.equal(ops.mcp.by_server.beezi.count, 2);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.mcp.by_server.unknown, undefined);
});

test('completion metadata overrides the legacy Beezi mapping', () => {
  const ops = computeOperations([fn('beezi_login', 'l1'), mcpEnd('l1', 'staging', 'beezi_login')]);
  assert.equal(ops.mcp.by_server.staging.count, 1);
  assert.equal(ops.mcp.by_server.beezi, undefined);
});

test('an unrecognized bare word is not invented into an MCP server', () => {
  // Without an mcp_tool_call_end and without an MCP-shaped name, a new Codex builtin is `other` —
  // guessing 'mcp' would report a server that does not exist.
  const ops = computeOperations([fn('somenewbuiltin', 'x1')]);
  assert.equal(ops.mcp.count, 0);
  assert.equal(ops.other.count, 1);
});

test('an underscore is not sufficient evidence of an MCP server', () => {
  const ops = computeOperations([fn('notion_search', 'n1')]);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.mcp.count, 0);
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

// --- the unified `exec` surface ---------------------------------------------------------------
// Every modern call is a custom_tool_call named `exec` whose `input` is the raw JS program the
// model wrote — a string in 1116 of 1116 real records, never JSON and never nested. The tool that
// actually did the work exists only inside that program, so without parsing it the entire modern
// surface (1123 local calls) buckets as `shell`.
//
// This replaces a fixture that was wrong three ways: it built a `function_call`, it wrapped the
// program as `arguments: JSON.stringify({input})`, and it used a positional
// `tools.exec_command("rg foo")` — a form that occurs 0 times in 702 real call sites, all of
// which pass an object literal.
const exec = (callId, program) => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed', input: program },
});

test('a search run through the unified exec surface lands in the search bucket', () => {
  const ops = computeOperations([
    exec('e1', 'const r = await tools.exec_command({cmd:"rg -n foo",workdir:"C:\\\\w",yield_time_ms:10000}); text(r.output);'),
    customOut('e1', 'x'.repeat(40)),
  ]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.search.est_tokens, 10, 'est_tokens follows the call into its real bucket');
  assert.equal(ops.shell.count, 0);
});

test('an exec program that calls no tool at all is still shell', () => {
  // 6 of 1123 real programs only call `text(...)`. Nothing to re-bucket, so today's answer stands.
  const ops = computeOperations([exec('e1', 'text("nothing to run");')]);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.search.count, 0);
  assert.equal(ops.other.count, 0);
});

test('non-search exec work stays in the shell bucket', () => {
  const ops = computeOperations([exec('e1', 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);')]);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.search.count, 0);
});

test('an exec program that edits files is a file operation, not shell', () => {
  const ops = computeOperations([
    exec('e1', 'await tools.apply_patch({input:"*** Begin Patch\\n*** Update File: a.ts\\n*** End Patch"});'),
    customOut('e1', 'y'.repeat(8)),
  ]);
  assert.equal(ops.file.count, 1);
  assert.equal(ops.file.est_tokens, 2);
  assert.equal(ops.shell.count, 0);
});

test('an exec program that browses the web is an internet operation', () => {
  const ops = computeOperations([
    exec('e1', 'const r = await tools.web__run({search_query:[{q:"hetzner cloud pricing"}],response_length:"long"}); text(r);'),
  ]);
  assert.equal(ops.internet.count, 1);
  assert.equal(ops.shell.count, 0);
});

test('planning and stdin tools inside exec land in other and shell respectively', () => {
  const ops = computeOperations([
    exec('e1', 'await tools.update_plan({plan:[{step:"one",status:"in_progress"}]});'),
    exec('e2', 'await tools.write_stdin({session_id:"s",chars:"y\\n"});'),
  ]);
  assert.equal(ops.other.count, 1, 'update_plan is planning, not repo work');
  assert.equal(ops.shell.count, 1, 'write_stdin feeds a running exec_command');
  assert.equal(ops.mcp.count, 0, 'write_stdin is MCP-shaped by name and must not be read as MCP');
});

test('the legacy shell_command name is still recognized inside an exec program', () => {
  const ops = computeOperations([exec('e1', 'const r = await tools.shell_command({cmd:"grep -rn foo ."}); text(r.output);')]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.shell.count, 0);
});

test('an unknown tool inside an exec program is other, never an invented MCP server', () => {
  const ops = computeOperations([exec('e1', 'await tools.request_permissions({scopes:["write"]});')]);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.mcp.count, 0);
  assert.deepEqual(ops.mcp.by_server, {});
});

test('an MCP tool called inside exec is attributed with no mcp_tool_call_end at all', () => {
  // The modern surface spells MCP tools `mcp__<server>__<tool>`, exactly as Claude does, so the
  // server is deterministic from the name — no same-segment join needed.
  const ops = computeOperations([
    exec('e1', 'const r = await tools.mcp__beezi__beezi_login({}); text(r);'),
    customOut('e1', 'z'.repeat(20)),
  ]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.beezi.count, 1);
  assert.equal(ops.mcp.by_server.beezi.est_tokens, 5);
  assert.equal(ops.mcp.by_server.unknown, undefined);
  assert.equal(ops.plugins.beezi.count, 1);
  assert.equal(ops.shell.count, 0);
});

test('a multi-tool exec program is one call in one bucket, the highest-impact one', () => {
  // 21 of 1123 real programs call two or three tools, most often an apply_patch plus the
  // exec_command that checked it. Splitting would report more calls than the model made.
  const ops = computeOperations([
    exec('e1', 'await tools.apply_patch({input:"*** Begin Patch\\n*** End Patch"}); const r = await tools.exec_command({cmd:"npm test"}); text(r.output);'),
    customOut('e1', 'q'.repeat(16)),
  ]);
  assert.equal(ops.file.count, 1);
  assert.equal(ops.file.est_tokens, 4);
  assert.equal(ops.shell.count, 0);
  assert.equal(ops.search.count, 0);
});

test('a backtick cmd inside exec still reaches the search bucket', () => {
  // The G-5-5 dependency, end to end: before the backtick fix this program yielded no command,
  // so the search sniffing had no head to read and the call fell back to `shell`.
  const ops = computeOperations([
    exec('e1', 'for (const p of paths){ const r = await tools.exec_command({cmd:`rg -n "foo" "${p}"`}); text(r.output); }'),
  ]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.shell.count, 0);
});

test('a mixed exec program that only partly searched stays shell', () => {
  const ops = computeOperations([
    exec('e1', 'await tools.exec_command({cmd:"rg -n foo"}); await tools.exec_command({cmd:"npm run build"});'),
  ]);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.search.count, 0);
});

test('an mcp_tool_call_end still wins over the exec program text', () => {
  // The server's own record beats any inference from a name.
  const ops = computeOperations([
    exec('e1', 'const r = await tools.exec_command({cmd:"rg -n foo"}); text(r.output);'),
    mcpEnd('e1', 'notion', 'notion-search'),
  ]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.notion.count, 1);
  assert.equal(ops.search.count, 0);
});

test('Codex tool-discovery search is not a code search', () => {
  const ops = computeOperations([fn('tool_search_call', 't1')]);
  assert.equal(ops.search.count, 0);
  assert.equal(ops.other.count, 1);
});

// --- 0.153+: item_completed / McpToolCall ------------------------------------------------------
// 0.153 replaced the discrete mcp_tool_call_end event with the unified item_completed stream.
// Measured over 204 local rollouts: 76 mcp_tool_call_end / 0 McpToolCall on 0.145-0.146 builds,
// 0 / 12 on 0.153.x — era-exclusive, never both in one rollout. Field paths below are copied from
// real records, not from prose: item.{id,server,tool,duration}, with the item nested under
// payload.item of an `event_msg` whose payload.type is `item_completed`.
const mcpItem = (id, server, tool, duration = null) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: '01a07b74-0000-0000-0000-000000000000',
    turn_id: '01a07b74-0000-0000-0000-000000000001',
    item: {
      type: 'McpToolCall',
      id,
      server,
      tool,
      arguments: {},
      pluginId: 'unified-computer-use@openai-bundled',
      readOnlyHint: true,
      status: 'completed',
      result: { content: [], isError: false },
      ...(duration === null ? {} : { duration }),
    },
    started_at_ms: 1788780965921,
    completed_at_ms: 1788780973143,
  },
});

test('a 0.153 McpToolCall names the server the call record does not', () => {
  // The real 0.153 call record is a bare `function_call` named `js` — no underscore, so even
  // categoryOf's MCP-shaped-name fallthrough misses it and the call used to land in `other`.
  const ops = computeOperations([
    fn('js', 'call_fTRX2cXF7ZnUQpFw8pdcpp0K'),
    fnOut('call_fTRX2cXF7ZnUQpFw8pdcpp0K', 'z'.repeat(20)),
    mcpItem('call_fTRX2cXF7ZnUQpFw8pdcpp0K', 'cua_repl', 'js'),
  ]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.cua_repl.count, 1);
  assert.equal(ops.mcp.by_server.cua_repl.est_tokens, 5);
  assert.equal(ops.mcp.by_server.unknown, undefined);
  assert.equal(ops.plugins.cua_repl.count, 1);
  assert.equal(ops.other.count, 0, 'the call must leave the other bucket, not just gain a name');
});

test('an item_completed that is not an McpToolCall names no server', () => {
  // The same envelope carries FileChange and Plan items. Reading `item.server` off those would
  // invent an MCP call out of a file edit.
  const fileChange = {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'FileChange', id: 'exec-1', changes: {} } },
  };
  const ops = computeOperations([fn('somenewbuiltin', 'x1'), fileChange]);
  assert.equal(ops.mcp.count, 0);
  assert.equal(ops.other.count, 1);
});

test('both era records populate one map, so a mixed segment attributes both', () => {
  const ops = computeOperations([
    fn('notion_search', 'n1'), mcpEnd('n1', 'notion', 'notion-search'),
    fn('js', 'call_a'), mcpItem('call_a', 'cua_repl', 'js'),
  ]);
  assert.equal(ops.mcp.count, 2);
  assert.equal(ops.mcp.by_server.notion.count, 1);
  assert.equal(ops.mcp.by_server.cua_repl.count, 1);
  assert.equal(ops.mcp.by_server.unknown, undefined);
});

test('a blank server in an mcp__ name falls back to unknown rather than being invented', () => {
  // Matches Claude's mcpServer() (test/operations.test.mjs:109-113): a blank name is 'unknown'.
  const ops = computeOperations([exec('e1', 'await tools.mcp__({});')]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.unknown.count, 1);
});

test('an mcp__ name splits on the double underscore, exactly as Claude does', () => {
  const ops = computeOperations([
    exec('e1', 'await tools.mcp__plugin_beezi_staging__list_projects({});'),
    exec('e2', 'await tools.mcp__a__b__c({});'),
  ]);
  assert.equal(ops.mcp.by_server.plugin_beezi_staging.count, 1, 'single underscores stay inside the server name');
  assert.equal(ops.mcp.by_server.a.count, 1, 'only the first segment is the server');
});

// --- per-call latency ---------------------------------------------------------------------------
// duration is present on 76/76 mcp_tool_call_end payloads and 12/12 McpToolCall items measured
// locally. It rides inside by_server, which the report DTO validates as a plain object record.

const mcpEndTimed = (callId, server, tool, duration) => ({
  type: 'event_msg',
  payload: { type: 'mcp_tool_call_end', call_id: callId, invocation: { server, tool, arguments: {} }, duration },
});

test('mcp latency is summed per server with its own denominator', () => {
  const ops = computeOperations([
    fn('notion_search', 'n1'), mcpEndTimed('n1', 'notion', 'notion-search', { secs: 0, nanos: 256581500 }),
    fn('notion_fetch', 'n2'), mcpEndTimed('n2', 'notion', 'notion-fetch', { secs: 1, nanos: 500000000 }),
  ]);
  assert.equal(ops.mcp.by_server.notion.duration_ms, 257 + 1500);
  assert.equal(ops.mcp.by_server.notion.duration_calls, 2);
  assert.equal(ops.mcp.by_server.notion.count, 2);
});

test('a 0.153 McpToolCall duration reaches by_server too', () => {
  const ops = computeOperations([
    fn('js', 'call_a'),
    mcpItem('call_a', 'cua_repl', 'js', { secs: 7, nanos: 221151100 }),
  ]);
  assert.equal(ops.mcp.by_server.cua_repl.duration_ms, 7221);
  assert.equal(ops.mcp.by_server.cua_repl.duration_calls, 1);
});

test('an in-exec MCP call gets its latency from the exec-id record no join could reach', () => {
  // Measured: 1 of 12 McpToolCall items reports under an `exec-<uuid>` id that matches no call
  // record, because the model called the MCP tool from inside an exec program. The program text
  // names the server, the item names the latency, and banking latency per server joins them.
  const ops = computeOperations([
    exec('call_ByrxRVhyuRe9B8vOJKx0ayh9', 'for (const r of await Promise.allSettled([\n'
      + 'tools.mcp__vercel__get_project({projectId:"prj_x",teamId:"team_y"}),\n'
      + 'tools.exec_command({cmd:"where.exe node"})\n])) text(r);'),
    mcpItem('exec-32f6621b-9c96-4262-b673-dbd674194a66', 'vercel', 'get_project', { secs: 0, nanos: 784903700 }),
  ]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.by_server.vercel.count, 1);
  assert.equal(ops.mcp.by_server.vercel.duration_ms, 785);
  assert.equal(ops.mcp.by_server.vercel.duration_calls, 1);
  assert.equal(ops.mcp.by_server.unknown, undefined);
});

test('duration keys are absent, not zero, when nothing was measured', () => {
  // Era A/B rollouts and in-exec-only segments must keep exactly the payload they ship today —
  // an added `duration_ms: 0` would read as "measured, and instant".
  const ops = computeOperations([
    fn('notion_search', 'n1'), mcpEnd('n1', 'notion', 'notion-search'),
    exec('e1', 'await tools.mcp__beezi__beezi_login({});'),
  ]);
  assert.deepEqual(ops.mcp.by_server.notion, { count: 1, est_tokens: 0 });
  assert.deepEqual(ops.mcp.by_server.beezi, { count: 1, est_tokens: 0 });
});

test('a latency with no counted call in the segment invents no server entry', () => {
  // The completion record can outlive its call across a segment boundary. A duration alone must
  // not conjure a by_server row with count 0 — that would read as a server that answered nothing.
  const ops = computeOperations([mcpEndTimed('gone', 'notion', 'notion-search', { secs: 2, nanos: 0 })]);
  assert.deepEqual(ops.mcp.by_server, {});
  assert.equal(ops.mcp.count, 0);
});

test('a corrupt or missing duration is dropped rather than counted as zero', () => {
  const ops = computeOperations([
    fn('a_one', 'c1'), mcpEndTimed('c1', 'srv', 'one', { secs: -1, nanos: 0 }),
    fn('a_two', 'c2'), mcpEndTimed('c2', 'srv', 'two', { secs: 'x', nanos: null }),
    fn('a_three', 'c3'), mcpEndTimed('c3', 'srv', 'three', { secs: 2, nanos: 0 }),
  ]);
  assert.equal(ops.mcp.by_server.srv.count, 3);
  assert.equal(ops.mcp.by_server.srv.duration_ms, 2000);
  assert.equal(ops.mcp.by_server.srv.duration_calls, 1, 'only the usable duration counts');
});

test('one call id contributes its latency once even if both era records appear', () => {
  // Era-exclusive in all 204 rollouts measured, but the two records share the call-id namespace,
  // so a build emitting both must not double the latency.
  const ops = computeOperations([
    fn('notion_search', 'n1'),
    mcpEndTimed('n1', 'notion', 'notion-search', { secs: 1, nanos: 0 }),
    mcpItem('n1', 'notion', 'notion-search', { secs: 1, nanos: 0 }),
  ]);
  assert.equal(ops.mcp.by_server.notion.duration_ms, 1000);
  assert.equal(ops.mcp.by_server.notion.duration_calls, 1);
});

test('latency never lands on the unknown bucket', () => {
  // Every record carrying a duration also names its server, so an unattributed call cannot pick
  // one up. Pinning it: an unnamed MCP call and a timed one from another server coexist cleanly.
  const ops = computeOperations([
    fn('mcp____search', 'n1'),
    fn('beezi_status', 'b1'), mcpEndTimed('b1', 'beezi', 'beezi_status', { secs: 0, nanos: 5000000 }),
  ]);
  assert.equal(ops.mcp.by_server.unknown.count, 1);
  assert.equal(ops.mcp.by_server.unknown.duration_ms, undefined);
  assert.equal(ops.mcp.by_server.beezi.duration_ms, 5);
});

// --- skills ----------------------------------------------------------------------------------

const userMsg = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('a $skill injection counts as one skill use with its body size', () => {
  const text = '<skill>\n<name>beezi-staging:me</name>\n' + 'x'.repeat(400);
  const ops = computeOperations([userMsg(text)]);
  assert.equal(ops.skill.count, 1);
  assert.equal(ops.skill.by_skill['beezi-staging:me'].count, 1);
  assert.equal(ops.skill.by_skill['beezi-staging:me'].est_tokens, Math.round(Buffer.byteLength(text) / 4));
  assert.equal(ops.plugins['beezi-staging'].count, 1);
  assert.deepEqual(Object.keys(ops.skill.by_skill['beezi-staging:me']).sort(), ['count', 'est_tokens']);
});

test('a SKILL.md read through exec moves from shell to skill', () => {
  const p = 'C:\\Users\\u\\.codex\\plugins\\cache\\mk\\superpowers\\6.3.0\\skills\\brainstorming\\SKILL.md';
  const ops = computeOperations([
    exec('e1', `const r = await tools.exec_command({cmd:"Get-Content -Raw '${p.replace(/\\/g, '\\\\')}'"}); text(r.output);`),
    customOut('e1', 'y'.repeat(800)),
  ]);
  assert.equal(ops.shell.count, 0);
  assert.equal(ops.shell.est_tokens, 0);
  assert.equal(ops.skill.count, 1);
  assert.equal(ops.skill.est_tokens, 200);
  assert.deepEqual(ops.skill.by_skill['superpowers:brainstorming'], { count: 1, est_tokens: 200 });
  assert.equal(ops.plugins.superpowers.count, 1);
});

test('a SKILL.md read through a legacy shell call moves out of shell', () => {
  const ops = computeOperations([
    shell('s1', 'cat /home/u/.codex/skills/foo/SKILL.md'),
    fnOut('s1', 'y'.repeat(40)),
  ]);
  assert.equal(ops.shell.count, 0);
  assert.deepEqual(ops.skill.by_skill.foo, { count: 1, est_tokens: 10 });
});

test('a bare user skill lands under plugins.builtin', () => {
  const ops = computeOperations([shell('s1', 'cat /home/u/.codex/skills/foo/SKILL.md'), fnOut('s1', 'y'.repeat(8))]);
  assert.deepEqual(ops.plugins.builtin, { count: 1, est_tokens: 2 });
});

test('listing skill folders stays shell/search, not skill', () => {
  const ops = computeOperations([shell('s1', 'Get-ChildItem C:/x/skills -Recurse -Filter SKILL.md'), fnOut('s1', 'y'.repeat(8))]);
  assert.equal(ops.skill.count, 0);
  assert.deepEqual(ops.skill.by_skill, {});
  assert.equal(ops.shell.count + ops.search.count, 1);
});

test('the $mention text alone is not counted', () => {
  const ops = computeOperations([userMsg('$beezi-staging:me')]);
  assert.equal(ops.skill.count, 0);
  assert.deepEqual(ops.skill.by_skill, {});
});

test('a SKILL.md read whose call is named by an MCP server stays MCP', () => {
  const ops = computeOperations([
    shell('s1', 'cat /home/u/.codex/skills/foo/SKILL.md'),
    mcpEnd('s1', 'notion', 'x'),
  ]);
  assert.equal(ops.skill.count, 0);
  assert.equal(ops.mcp.count, 1);
});

test('a call reading only skills splits its tokens across every skill it read', () => {
  const ops = computeOperations([
    shell('s1', 'cat /h/.codex/skills/a/SKILL.md /h/.codex/skills/b/SKILL.md; cat /h/.codex/skills/c/SKILL.md'),
    fnOut('s1', 'y'.repeat(40)), // est 10 -> 4 + 3 + 3
  ]);
  assert.equal(ops.shell.count, 0);
  assert.equal(ops.skill.count, 1);
  assert.equal(ops.skill.est_tokens, 10);
  assert.deepEqual(ops.skill.by_skill, {
    a: { count: 1, est_tokens: 4 }, b: { count: 1, est_tokens: 3 }, c: { count: 1, est_tokens: 3 },
  });
  const sum = Object.values(ops.skill.by_skill).reduce((s, v) => s + v.est_tokens, 0);
  assert.equal(sum, ops.skill.est_tokens);
});

test('skill reads chained to other work record each use at 0 tokens and keep their category', () => {
  // The measured shape of an automatic writing-plans run. Its leading `rg` makes it a search.
  const ops = computeOperations([
    shell('s1', 'rg --files docs; Get-Content /h/.agents/skills/subagents/SKILL.md; Get-Content /h/.codex/plugins/cache/m/superpowers/6.3.0/skills/writing-plans/SKILL.md'),
    fnOut('s1', 'y'.repeat(40)),
  ]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.search.est_tokens, 10);
  assert.equal(ops.skill.count, 0);
  assert.equal(ops.skill.est_tokens, 0);
  assert.deepEqual(ops.skill.by_skill, {
    subagents: { count: 1, est_tokens: 0 }, 'superpowers:writing-plans': { count: 1, est_tokens: 0 },
  });
});
