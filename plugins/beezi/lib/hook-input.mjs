import fs from 'fs';
import { commandsFromProgram } from './exec-program.mjs';

// The unified-exec program parsers live in lib/exec-program.mjs so a pure-computation module can
// reach them without importing this file's `fs`. Re-exported because this is their public home:
// scripts/checkpoint.mjs and test/hook-input.test.mjs are the contract.
export { commandsFromProgram };

export function isGitCheckpointCommand(cmd) {
  return /git\s+(commit|switch|checkout)\b/.test(cmd);
}

// The field names the two surfaces use, listed rather than branched on, so a third spelling is a
// one-word edit instead of a hunt through nested conditionals.
const COMMAND_FIELDS = ['command', 'cmd'];
const NESTING_FIELDS = ['arguments', 'input'];

// Every shell command in a PostToolUse payload's `tool_input`, tolerating the shapes Codex uses:
// a `{ command }` / `{ cmd }` object, either of those nested under `arguments` / `input`, any of it
// JSON-encoded, or a unified-exec JS program carrying several calls. Returns [] when the payload
// holds no command.
export function shellCommandsOf(input) {
  return commandsIn((input || {}).tool_input);
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
