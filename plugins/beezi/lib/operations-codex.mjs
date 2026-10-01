import { orDefault } from './compat.mjs';
import { commandsFromProgram, toolNamesFromProgram } from './exec-program.mjs';
import { skillInjectionOf, skillReadsOfCall } from './skills-codex.mjs';

// Bucket each Codex tool call in a segment into one of seven operation categories and estimate
// the token cost of its result. Like the Claude engine, exact tool counts are cheap but a tool's
// real token cost (its output, which lands in the next model input) is never labelled per tool, so
// we approximate it as (matched output payload bytes / 4).
//
// Codex tool calls appear as rollout `response_item` records:
//   - function_call        { name, arguments, call_id }   + function_call_output       { call_id, output }
//   - custom_tool_call      { name, input, call_id }        + custom_tool_call_output    { call_id, output }
//
// MCP server tools can be bare function calls (e.g. `notion_search`, or plainly `js`).
// For those, the server name lives in a separate completion record,
// and Codex has shipped two era-exclusive spellings of it — `event_msg/mcp_tool_call_end` on
// ≤0.146 and `event_msg/item_completed` + `item.type === 'McpToolCall'` on 0.153+. Both name the
// server and both key on the call id. Explicit mcp__ names and the plugin's own
// legacy local tools can also identify the server without that event.
// `by_skill` has two sources, since Codex has no Skill tool: a `$name` injection (a user message
// starting `<skill><name>X</name>`, est = its bytes / 4; not a tool call, so it adds to `skill`
// without leaving any other bucket) and a shell/exec call that reads SKILL.md files (a call doing
// nothing else MOVES its tokens from shell/file/search to `skill`, never counted twice; one chained
// to other work records the use at 0 tokens and keeps its category).
//
// On unified exec (Codex ≥ ~0.145) the name in the record is NOT the tool that did the work:
// every action is a `custom_tool_call` named `exec` whose `input` is a JS program. The whole
// modern surface — 1123 local calls covering apply_patch, web__run, write_stdin, update_plan and
// MCP — therefore used to collapse into `shell`. See EXEC_TOOL_CATEGORY below.

const SHELL_TOOLS = new Set(['shell_command', 'shell', 'exec', 'exec_command', 'local_shell']);
const FILE_TOOLS = new Set(['apply_patch', 'view_image', 'read_file', 'write_file']);
const INTERNET_TOOLS = new Set(['web_search', 'web_fetch', 'browser', 'open_page']);
// Interactive / planning builtins that aren't real work against the repo. `tool_search_call` is
// Codex's own tool-discovery search, not a search of the user's code — it does not belong in
// the `search` bucket.
const OTHER_BUILTINS = new Set([
  'update_plan', 'request_user_input', 'request_user_input_async', 'wait', 'view_plan',
  'tool_search_call', 'create_goal', 'get_goal', 'update_goal',
  'spawn_agent', 'send_message', 'wait_agent', 'list_agents', 'followup_task',
  'interrupt_agent', 'close_agent', 'resume_agent', 'sleep',
]);

// These are the plugin's own legacy local tool names. Do not infer a server
// from arbitrary underscored names: Codex builtins use that spelling too.
const LEGACY_MCP_SERVERS = new Map([['beezi_login', 'beezi'], ['beezi_status', 'beezi']]);

const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other'];

// Codex has no dedicated search tool: searching the repo is `rg`/`grep`/`find` inside the shell
// tool. Bucketing those as plain shell hides the single most common thing a session does, and
// leaves the `search` category permanently empty. Matched on the command's leading executable.
const SEARCH_COMMANDS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'find',
  // PowerShell / cmd equivalents — Codex runs the platform's shell.
  'select-string', 'findstr', 'sls',
]);

// The leading executable of a shell command string, lowercased, or null when there isn't one.
// Both surfaces go through this, so `SEARCH_COMMANDS` stays the single source of truth for
// "is this command a search".
function headOf(command) {
  if (typeof command !== 'string') return null;
  const first = command.trim().split(/\s+/)[0];
  if (!first) return null;
  // Strip any path and extension: /usr/bin/rg and rg.exe are both rg.
  const base = first.replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return base.toLowerCase();
}

// The legacy surface: a `{ command }` argument object. Unchanged behaviour.
function commandHead(args) {
  return headOf(args && typeof args.command === 'string' ? args.command : null);
}

// ── the unified `exec` surface ──────────────────────────────────────────────────────────────────
// Every modern call is named `exec`, so the tool that did the work is only in the program text.
// `tools.<name>(` -> category. Counts are the measured histogram over 1123 real exec programs, so
// this table covers what Codex actually calls: write_stdin, shell_command, request_permissions and
// codex_app__* are all real and none of them appear in the older parity mapping.
//
// Deliberately NOT merged with SHELL_TOOLS/FILE_TOOLS/OTHER_BUILTINS above, even though the names
// overlap: categoryOf falls through to an MCP-shaped-name heuristic, and `write_stdin` (161),
// `web__run` (95) and `request_permissions` (6) all match it. Routing them through categoryOf
// would file 262 calls under `mcp` and invent a `by_server.unknown` for them. Default here is
// `other`, never a guessed server.
const EXEC_TOOL_CATEGORY = new Map([
  ['exec_command', 'shell'],                              // 677
  ['apply_patch', 'file'],                                // 238
  ['write_stdin', 'shell'],                               // 161 - stdin of a running exec_command
  ['web__run', 'internet'],                               //  95
  ['update_plan', 'other'],                               //  13
  ['shell_command', 'shell'],                             //  13 - the legacy name, still callable
  ['codex_app__load_workspace_dependencies', 'other'],    //   6
  ['request_permissions', 'other'],                       //   6
  ['view_image', 'file'],                                 //   1
  ['exec', 'shell'],                                      //   1
]);

// One exec program can call several tools (21 of 1123 locally, most often apply_patch with an
// exec_command that checked the result). It is still ONE tool call and gets ONE bucket: splitting
// it would inflate `count` past the number of model invocations and would need an invented split
// of the single output blob. Precedence prefers the action with repo impact over the command that
// verified it.
const EXEC_PRECEDENCE = ['mcp', 'file', 'internet', 'shell', 'other'];

// The modern surface names MCP tools with Claude's exact `mcp__<server>__<tool>` convention, so
// here the server is deterministic from the name and needs no completion-record join at all.
// Equivalent to Claude's `mcpServer()` (operations.mjs in the beezi-claude-plugins repo) on every
// input, including the degenerate ones: `mcp__a_b__c` -> `a_b` (split is on the double underscore,
// not the single), `mcp__a__b__c` -> `a`, `mcp__x` -> `x`, and a blank server -> no name. The one
// difference is the return value for a blank server: Claude returns the literal 'unknown', we
// return null so a completion record can still win, and the same 'unknown' is applied at the
// accumulation site.
function mcpServerOf(name) {
  const parts = String(name).split('__');
  const server = parts.length > 1 ? parts[1] : '';
  return server === '' ? null : server;
}

// A rollout `{ secs, nanos }` duration in whole milliseconds, or null when it is absent or
// unusable. Measured locally: present on 76/76 `mcp_tool_call_end` payloads and 12/12
// `McpToolCall` items, so this is the rollout's own per-call latency and needs no reconstruction.
// `result._meta['codex/nodeReplExecutionDurationMs']` is deliberately NOT read: that is the inner
// tool's own execution time, not the MCP round trip.
function durationMsOf(duration) {
  if (!duration || typeof duration !== 'object') return null;
  // Absent is 0, garbage is fatal. The distinction matters because Number(null) is 0, so a
  // permissive coercion would turn `{secs:"?", nanos:null}` into a confident 0 ms — a corrupt
  // record read as an instant call, which is worse than no measurement at all.
  const present = (value) => value !== undefined && value !== null;
  const part = (value) => {
    if (!present(value)) return 0;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (!present(duration.secs) && !present(duration.nanos)) return null;
  const secs = part(duration.secs);
  const nanos = part(duration.nanos);
  if (secs === null || nanos === null) return null;
  return Math.round(secs * 1000 + nanos / 1e6);
}

// What an exec program really did, as { category, server }, or null when it called no tool —
// 6 of 1123 programs only call `text(...)`, and those keep today's `shell`.
function execCategory(program) {
  const names = toolNamesFromProgram(program);
  if (names.length === 0) return null;
  let best = null;
  let server = null;
  for (const name of names) {
    let category;
    if (name.indexOf('mcp__') === 0) {
      category = 'mcp';
      if (server === null) server = mcpServerOf(name);
    } else {
      category = EXEC_TOOL_CATEGORY.has(name) ? EXEC_TOOL_CATEGORY.get(name) : 'other';
    }
    if (best === null || EXEC_PRECEDENCE.indexOf(category) < EXEC_PRECEDENCE.indexOf(best)) {
      best = category;
    }
  }
  if (best === 'shell') {
    // Reconstructed search, through the same SEARCH_COMMANDS set the legacy surface uses.
    // `every` keeps the legacy semantics: a program that only searched is a search, one that
    // also did other work stays shell.
    const commands = commandsFromProgram(program);
    if (commands.length > 0 && commands.every((c) => SEARCH_COMMANDS.has(headOf(c)))) {
      best = 'search';
    }
  }
  return { category: best, server };
}

// Tool name → category. `isMcp` comes from the mcp_tool_call_end join, not from a guess.
function categoryOf(name, { isMcp = false, args = null } = {}) {
  if (isMcp) return 'mcp';
  if (typeof name !== 'string' || name === '') return 'other';
  if (SHELL_TOOLS.has(name)) {
    return SEARCH_COMMANDS.has(commandHead(args)) ? 'search' : 'shell';
  }
  if (FILE_TOOLS.has(name)) return 'file';
  if (INTERNET_TOOLS.has(name)) return 'internet';
  if (OTHER_BUILTINS.has(name)) return 'other';
  // These builtins can also appear as direct calls, outside an exec program.
  if (EXEC_TOOL_CATEGORY.has(name)) return EXEC_TOOL_CATEGORY.get(name);
  return name.indexOf('mcp__') === 0 ? 'mcp' : 'other';
}

function serverFromName(name) {
  if (typeof name !== 'string') return null;
  return name.indexOf('mcp__') === 0 ? mcpServerOf(name) : (LEGACY_MCP_SERVERS.get(name) || null);
}

// Shared across repo segments, but only metadata is shared: calls, bytes and
// durations still belong to their original segment and are never replayed.
export function operationContext(records) {
  const servers = new Map();
  for (const record of records) {
    const inv = mcpInvocation(record);
    if (inv && String(inv.callId).indexOf('exec-') !== 0) servers.set(inv.callId, inv.server);
  }
  return servers;
}

// A bare direct call may only name its MCP server in a later completion event.
// Keep the cursor before such a call until that evidence or a turn boundary
// arrives. The transcript is the pending state; no second durable cursor exists.
export function operationWindowEnd(records, fromLine, servers) {
  let lastBoundary = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const p = (r && r.payload) || {};
    if ((r && r.type === 'event_msg' && ['task_complete', 'turn_aborted', 'task_started'].indexOf(p.type) !== -1)
      || (r && r.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.phase === 'final')) lastBoundary = i;
  }
  for (let i = fromLine; i < records.length; i++) {
    const call = toolCall(records[i]);
    if (!call || !call.callId || call.program !== null || i < lastBoundary) continue;
    const name = call.name;
    if (servers.has(call.callId) || serverFromName(name) !== null
      || categoryOf(name) !== 'other' || OTHER_BUILTINS.has(name) || EXEC_TOOL_CATEGORY.has(name)) continue;
    return i;
  }
  return records.length;
}

function outputBytes(output) {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf-8');
  if (output == null) return 0;
  return Buffer.byteLength(JSON.stringify(output), 'utf-8');
}

// A tool call's arguments as an object, or null. Codex writes them as a JSON string on
// `function_call` and as an already-parsed object on some custom calls, so both shapes arrive.
// Exported because lib/delta-codex.mjs reads workdir off the same field and must agree on what
// counts as unparseable — an exec program is NOT JSON and must yield null, not a throw.
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The unified-exec program carried by a call record, or null. Measured over 1116 real records:
// `exec` is always a `custom_tool_call` and its `input` is always the raw JS program string —
// never JSON, so parseArgs() throws on it and yields null. That is why an exec call used to fall
// through to the bare `SHELL_TOOLS` branch and bucket as `shell` whatever it did.
function execProgramOf(p) {
  if (p.type !== 'custom_tool_call' || p.name !== 'exec') return null;
  return typeof p.input === 'string' ? p.input : null;
}

// A tool-call record's { name, callId, args, program }, or null for non-call records.
function toolCall(record) {
  const p = record && record.payload;
  if (!p) return null;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    return {
      name: p.name,
      callId: orDefault(p.call_id, null),
      args: parseArgs(orDefault(p.arguments, p.input)),
      program: execProgramOf(p),
    };
  }
  return null;
}

// The MCP server behind a call and its measured latency, as { callId, server, durationMs }, or
// null. Two records name the server, one per era, and they are ALTERNATIVES rather than
// duplicates: 0.153 replaced the discrete `*_end` events with the unified `item_completed`
// stream. Measured over 204 local rollouts — 76 `mcp_tool_call_end` and 0 `McpToolCall` on
// 0.145/0.146 builds, 0 and 12 on 0.153.x, never both in one rollout. Both key on the call id,
// so one map serves both eras and the accumulation below needs no era branch.
//
// Without the `item_completed` branch, a 0.153 MCP call is invisible: the call record is a bare
// `function_call` named for the tool alone (measured: `js`, from the `cua_repl` server), which
// carries no `_`, so even `categoryOf`'s MCP-shaped-name fallthrough misses it and the call lands
// in `other`. All 11 such calls in the local corpus were mis-bucketed that way.
function mcpInvocation(record) {
  const p = record && record.payload;
  if (!record || record.type !== 'event_msg' || !p) return null;
  if (p.type === 'mcp_tool_call_end') {
    const server = (p.invocation || {}).server;
    if (!p.call_id || typeof server !== 'string' || !server) return null;
    return { callId: p.call_id, server, durationMs: durationMsOf(p.duration) };
  }
  if (p.type === 'item_completed') {
    // `item.id` is a `call_<base62>` id joining the function_call for a discrete MCP call (11 of
    // 12 measured), and an `exec-<uuid>` id matching no call record when the model called the MCP
    // tool from inside an exec program (1 of 12). The latter joins nothing on purpose — the
    // program text already names that server — which is why latency is banked per server below.
    const item = p.item;
    if (!item || item.type !== 'McpToolCall') return null;
    if (!item.id || typeof item.server !== 'string' || !item.server) return null;
    return { callId: item.id, server: item.server, durationMs: durationMsOf(item.duration) };
  }
  return null;
}

// A tool-output record's { callId, bytes }, or null.
function toolOutput(record) {
  const p = record && record.payload;
  if (!p) return null;
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    return { callId: orDefault(p.call_id, null), bytes: outputBytes(p.output) };
  }
  return null;
}

export function computeOperations(lines, context = null) {
  // First pass: output bytes by call_id (a call's result lands in a later record within the
  // segment), and the MCP server behind each call from its completion record.
  const bytesById = new Map();
  // callId -> server name. Values stay plain strings: the second pass hands this straight to the
  // `by_server` key, and an object here would key the whole map under '[object Object]'.
  const serverByCallId = context || new Map();
  // server -> { ms, calls }. Banked by the server the completion record names, NOT by a call-id
  // join, because an MCP call made inside an exec program reports under an `exec-<uuid>` id that
  // matches no call record (1 of 12 measured). Joining would drop the latency for exactly the
  // surface G-5-2 taught us to attribute. `by_server` is a per-server aggregate anyway, so the
  // server name is the correct key and a wrong server is not reachable — the record names it.
  const latencyByServer = new Map();
  // The two completion records are era-exclusive in every rollout measured, but they share the
  // call-id namespace, so a build emitting both would double-count. One id contributes once.
  const timedIds = new Set();
  for (const record of lines) {
    const out = toolOutput(record);
    if (out && out.callId) bytesById.set(out.callId, out.bytes);
    const inv = mcpInvocation(record);
    if (!inv) continue;
    // An `exec-<uuid>` completion id belongs to the event namespace, not the call namespace — the
    // one measured locally matched no call record. Keeping it out of the join map costs nothing
    // today and stops it aliasing a call id should the namespaces ever converge.
    if (String(inv.callId).indexOf('exec-') !== 0) serverByCallId.set(inv.callId, inv.server);
    if (inv.durationMs === null || timedIds.has(inv.callId)) continue;
    timedIds.add(inv.callId);
    const acc = latencyByServer.get(inv.server);
    if (acc === undefined) latencyByServer.set(inv.server, { ms: inv.durationMs, calls: 1 });
    else { acc.ms += inv.durationMs; acc.calls += 1; }
  }

  const totals = {};
  for (const cat of CATEGORIES) totals[cat] = { count: 0, est_tokens: 0 };
  totals.mcp.by_server = {};
  totals.skill.by_skill = {};
  const plugins = {};

  // Mirrors the Claude engine's skillPlugin: `plugin:skill` -> plugin, a bare name is builtin.
  const tallySkill = (name, est) => {
    const skill = totals.skill;
    if (skill.by_skill[name] === undefined || skill.by_skill[name] === null) {
      skill.by_skill[name] = { count: 0, est_tokens: 0 };
    }
    skill.by_skill[name].count += 1;
    skill.by_skill[name].est_tokens += est;
    const colon = name.indexOf(':');
    const plugin = colon > 0 ? name.slice(0, colon) : 'builtin';
    if (plugins[plugin] === undefined || plugins[plugin] === null) plugins[plugin] = { count: 0, est_tokens: 0 };
    plugins[plugin].count += 1;
    plugins[plugin].est_tokens += est;
  };

  for (const record of lines) {
    const injected = skillInjectionOf(record);
    if (injected !== null) {
      const injectedEst = Math.round(injected.bytes / 4);
      totals.skill.count += 1;
      totals.skill.est_tokens += injectedEst;
      tallySkill(injected.name, injectedEst);
      continue;
    }
    const call = toolCall(record);
    if (!call) continue;
    const prefixed = serverFromName(call.name);
    const named = orDefault(serverByCallId.get(call.callId), prefixed);
    // An mcp_tool_call_end still wins: it is the server's own record, not an inference from a
    // name. Otherwise, an exec call is categorized by the program it ran.
    const viaExec = named === null && call.program !== null ? execCategory(call.program) : null;
    const server = viaExec !== null && viaExec.server !== null ? viaExec.server : named;
    // SKILL.md reads are skill uses — unless an MCP server was named for the call. A call that ONLY
    // reads skills is skill work: it moves out of shell/file/search and its tokens are split across
    // the skills it read. A call that also does other work keeps its category and tokens (its output
    // cannot be apportioned), but each skill still records the use, at 0 tokens.
    const reads = server === null ? skillReadsOfCall(record.payload) : null;
    let category;
    if (reads !== null && reads.pure) category = 'skill';
    else if (viaExec === null) category = categoryOf(call.name, { isMcp: named !== null, args: call.args });
    else category = viaExec.category;
    const est = Math.round((bytesById.get(call.callId) || 0) / 4);
    const cat = totals[category];
    cat.count += 1;
    cat.est_tokens += est;

    if (reads !== null) {
      const n = reads.names.length;
      const share = category === 'skill' ? Math.floor(est / n) : 0;
      const remainder = category === 'skill' ? est - share * n : 0;
      reads.names.forEach((name, i) => tallySkill(name, share + (i === 0 ? remainder : 0)));
    }
    if (category === 'mcp') {
      // Malformed explicit MCP names can still lack a server. Unidentified bare
      // tools are other, not evidence of an unnamed MCP server.
      const serverName = orDefault(server, 'unknown');
      if (cat.by_server[serverName] === undefined || cat.by_server[serverName] === null) {
        cat.by_server[serverName] = { count: 0, est_tokens: 0 };
      }
      const s = cat.by_server[serverName];
      s.count += 1;
      s.est_tokens += est;
      if (plugins[serverName] === undefined || plugins[serverName] === null) {
        plugins[serverName] = { count: 0, est_tokens: 0 };
      }
      const p = plugins[serverName];
      p.count += 1;
      p.est_tokens += est;
    }
  }

  // Per-call MCP latency, projected onto the only per-server shape the wire has.
  //
  // `duration_calls` is the denominator and is deliberately NOT `count`: a call the rollout never
  // completed a record for still contributes to `count`, so `duration_ms / count` would understate
  // the mean. Dividing by `duration_calls` gives the mean latency of the calls actually measured.
  //
  // Both keys live INSIDE `by_server`, which the report DTO declares as a plain `@IsObject()`
  // record whose values are never class-transformed ("deep validation not required"), so
  // `forbidNonWhitelisted` does not reach them. A new key directly on `operations.mcp` would be a
  // different story: that object IS `@ValidateNested`, an unknown key there 400s, and a 400 on
  // /sessions/report deletes the queued segment.
  //
  // Attached only where a duration was actually measured, so era A/B rollouts without one and
  // in-exec-only segments keep byte-for-byte the payload they ship today.
  for (const serverName of Object.keys(totals.mcp.by_server)) {
    const acc = latencyByServer.get(serverName);
    if (acc === undefined || acc.calls === 0) continue;
    totals.mcp.by_server[serverName].duration_ms = acc.ms;
    totals.mcp.by_server[serverName].duration_calls = acc.calls;
  }

  return { ...totals, plugins };
}
