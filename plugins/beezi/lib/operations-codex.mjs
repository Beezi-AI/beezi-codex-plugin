// Bucket each Codex tool call in a segment into one of seven operation categories and estimate
// the token cost of its result. Like the Claude engine, exact tool counts are cheap but a tool's
// real token cost (its output, which lands in the next model input) is never labelled per tool, so
// we approximate it as (matched output payload bytes / 4).
//
// Codex tool calls appear as rollout `response_item` records:
//   - function_call        { name, arguments, call_id }   + function_call_output       { call_id, output }
//   - custom_tool_call      { name, input, call_id }        + custom_tool_call_output    { call_id, output }
//
// MCP server tools are surfaced as bare function calls (e.g. `notion_search`) with NO server
// prefix in the call record. The server name is recoverable from the matching
// `event_msg/mcp_tool_call_end`, whose `payload.invocation.{server,tool}` names it and whose
// `call_id` joins back to the call — so a call IS an MCP call exactly when such a record exists.
// `by_skill` stays empty — Codex skills are prompt-injected, not tools.

const SHELL_TOOLS = new Set(['shell_command', 'shell', 'exec', 'exec_command', 'local_shell']);
const FILE_TOOLS = new Set(['apply_patch', 'view_image', 'read_file', 'write_file']);
const INTERNET_TOOLS = new Set(['web_search', 'web_fetch', 'browser', 'open_page']);
// Interactive / planning builtins that aren't real work against the repo. `tool_search_call` is
// Codex's own tool-discovery search, not a search of the user's code — it does not belong in
// the `search` bucket.
const OTHER_BUILTINS = new Set(['update_plan', 'request_user_input', 'wait', 'view_plan', 'tool_search_call']);

const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other'];

// Codex has no dedicated search tool: searching the repo is `rg`/`grep`/`find` inside the shell
// tool. Bucketing those as plain shell hides the single most common thing a session does, and
// leaves the `search` category permanently empty. Matched on the command's leading executable.
const SEARCH_COMMANDS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'find',
  // PowerShell / cmd equivalents — Codex runs the platform's shell.
  'select-string', 'findstr', 'sls',
]);

// The leading executable of a shell command string, lowercased, or null when the arguments
// don't expose a plain command (the unified `exec` surface passes a JS program instead).
function commandHead(args) {
  const command = args && typeof args.command === 'string' ? args.command : null;
  if (!command) return null;
  const first = command.trim().split(/\s+/)[0];
  if (!first) return null;
  // Strip any path and extension: /usr/bin/rg and rg.exe are both rg.
  const base = first.replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return base.toLowerCase();
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
  // An unrecognized name with no mcp_tool_call_end behind it. Older rollouts predate that event,
  // so a name shaped like an MCP tool (`<server>_<verb>`) still reads as MCP; anything else is a
  // Codex builtin we don't know yet, and calling that MCP would invent a server.
  return /^[a-z0-9]+_[a-z0-9_]+$/i.test(name) ? 'mcp' : 'other';
}

function outputBytes(output) {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf-8');
  if (output == null) return 0;
  return Buffer.byteLength(JSON.stringify(output), 'utf-8');
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// A tool-call record's { name, callId, args }, or null for non-call records.
function toolCall(record) {
  const p = record?.payload;
  if (!p) return null;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    return { name: p.name, callId: p.call_id ?? null, args: parseArgs(p.arguments ?? p.input) };
  }
  return null;
}

// The MCP server behind a call, from `event_msg/mcp_tool_call_end`. Returns { callId, server }
// or null. This is the only place a server name appears in the rollout.
function mcpInvocation(record) {
  const p = record?.payload;
  if (record?.type !== 'event_msg' || p?.type !== 'mcp_tool_call_end') return null;
  const server = p.invocation?.server;
  if (!p.call_id || typeof server !== 'string' || !server) return null;
  return { callId: p.call_id, server };
}

// A tool-output record's { callId, bytes }, or null.
function toolOutput(record) {
  const p = record?.payload;
  if (!p) return null;
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    return { callId: p.call_id ?? null, bytes: outputBytes(p.output) };
  }
  return null;
}

export function computeOperations(lines) {
  // First pass: output bytes by call_id (a call's result lands in a later record within the
  // segment), and the MCP server behind each call from its mcp_tool_call_end.
  const bytesById = new Map();
  const serverByCallId = new Map();
  for (const record of lines) {
    const out = toolOutput(record);
    if (out && out.callId) bytesById.set(out.callId, out.bytes);
    const inv = mcpInvocation(record);
    if (inv) serverByCallId.set(inv.callId, inv.server);
  }

  const totals = {};
  for (const cat of CATEGORIES) totals[cat] = { count: 0, est_tokens: 0 };
  totals.mcp.by_server = {};
  totals.skill.by_skill = {};
  const plugins = {};

  for (const record of lines) {
    const call = toolCall(record);
    if (!call) continue;
    const named = serverByCallId.get(call.callId) ?? null;
    const category = categoryOf(call.name, { isMcp: named !== null, args: call.args });
    const est = Math.round((bytesById.get(call.callId) || 0) / 4);
    const cat = totals[category];
    cat.count += 1;
    cat.est_tokens += est;

    if (category === 'mcp') {
      // 'unknown' only when the call had no mcp_tool_call_end to name its server.
      const server = named ?? 'unknown';
      const s = (cat.by_server[server] ??= { count: 0, est_tokens: 0 });
      s.count += 1;
      s.est_tokens += est;
      const p = (plugins[server] ??= { count: 0, est_tokens: 0 });
      p.count += 1;
      p.est_tokens += est;
    }
  }

  return { ...totals, plugins };
}
