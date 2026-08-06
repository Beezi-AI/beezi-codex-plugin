import fs from 'node:fs';

export function isGitCheckpointCommand(cmd) {
  return /git\s+(commit|switch|checkout)\b/.test(cmd);
}

// Codex has shipped two tool surfaces and both are in the field: the legacy one, where a shell
// call is its own tool (`shell_command`) carrying `{ command }`, and unified exec (Codex ≥ ~0.145
// / the desktop + IDE builds), where every action goes through one `exec` tool whose input is a
// JS program calling `tools.exec_command({"cmd": "...", "shell": "powershell"})`. One payload can
// therefore carry several commands, which is why extraction is plural.
//
// A regex over the program text is deliberate: the input is JS, not JSON, so it cannot simply be
// parsed, and the only question asked of the result is whether a git checkpoint command appears in
// it. A stray match costs one no-op checkpoint, never a wrong one.
// The key may be bare, single- or double-quoted, and so may the value: this is JS the model wrote,
// not JSON, and `{cmd: 'git commit'}` is as likely as `{"cmd":"git commit"}`. Matching only the
// JSON spelling would make branch checkpoints stop firing with no error anywhere.
const CMD_LITERAL = /['"]?cmd['"]?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

// The field names the two surfaces use, listed rather than branched on, so a third spelling is a
// one-word edit instead of a hunt through nested conditionals.
const COMMAND_FIELDS = ['command', 'cmd'];
const NESTING_FIELDS = ['arguments', 'input'];

export function commandsFromProgram(source) {
  if (typeof source !== 'string' || !source.includes('cmd')) return [];
  const out = [];
  for (const match of source.matchAll(CMD_LITERAL)) {
    const literal = match[1];
    // Single-quoted is valid JS but not JSON; re-quote before parsing so escapes still decode.
    const json = literal.startsWith("'")
      ? `"${literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"')}"`
      : literal;
    try { out.push(JSON.parse(json)); } catch { /* skip an unparseable literal */ }
  }
  return out;
}

// Every shell command in a PostToolUse payload's `tool_input`, tolerating the shapes Codex uses:
// a `{ command }` / `{ cmd }` object, either of those nested under `arguments` / `input`, any of it
// JSON-encoded, or a unified-exec JS program carrying several calls. Returns [] when the payload
// holds no command.
export function shellCommandsOf(input) {
  return commandsIn(input?.tool_input);
}

function commandsIn(value) {
  if (typeof value === 'string') {
    const program = commandsFromProgram(value);
    if (program.length) return program;
    // A JSON-encoded envelope round-trips into the object form; anything else is the command.
    try { return commandsIn(JSON.parse(value)); } catch { return [value]; }
  }
  if (!value) return [];
  for (const field of COMMAND_FIELDS) {
    if (typeof value[field] === 'string') return [value[field]];
  }
  for (const field of NESTING_FIELDS) {
    if (value[field] != null) return commandsIn(value[field]);
  }
  return [];
}

// Parse the hook's JSON payload from stdin (fd 0). Returns null on any read/parse
// failure so the caller can exit quietly — a hook must never throw on bad input.
export function readHookInput(fd = 0) {
  try {
    return JSON.parse(fs.readFileSync(fd, 'utf-8'));
  } catch {
    return null;
  }
}
