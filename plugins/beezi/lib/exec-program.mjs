// Parsers for the unified-exec `input`: a JS program the model wrote, calling `tools.<name>({...})`.
//
// Codex has shipped two tool surfaces and both are in the field: the legacy one, where a shell
// call is its own tool (`shell_command`) carrying `{ command }`, and unified exec (Codex ≥ ~0.145
// / the desktop + IDE builds), where every action goes through one `exec` tool whose input is a
// JS program calling `tools.exec_command({"cmd": "...", "shell": "powershell"})`. One payload can
// therefore carry several commands, which is why extraction is plural.
//
// A regex over the program text is deliberate: the input is JS, not JSON, so it cannot simply be
// parsed. Measured over real rollouts, `payload.input` is a string in 1116 of 1116 records.
// This module holds no fs/network access on purpose — `lib/operations-codex.mjs` is a pure
// computation and must not pull `fs` in through `lib/hook-input.mjs` just to reach these parsers.
//
// The only question asked of a command result is whether a git checkpoint command appears in it.
// A stray match costs one no-op checkpoint, never a wrong one.
// The key may be bare, single- or double-quoted, and so may the value: this is JS the model wrote,
// not JSON, and `{cmd: 'git commit'}` is as likely as `{"cmd":"git commit"}`. Matching only the
// JSON spelling would make branch checkpoints stop firing with no error anywhere.
// The value may also be a template literal: the model reaches for backticks exactly when the
// command interpolates a path or a variable, and 43 of 683 real `cmd:` sites do. A ${...} inside
// one cannot be resolved - the value is runtime JS - but neither caller needs it resolved:
// isGitCheckpointCommand matches on the text, and the search sniffing reads only the leading
// executable, which precedes any interpolation. Left in place, `${p}` is harmless in both.
const CMD_LITERAL = /['"`]?cmd['"`]?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

// Every shell command string a unified-exec program passes to `tools.exec_command` /
// `tools.shell_command`. Returns [] when the program builds its command out of variables, which
// no regex can recover — 3.2% of real programs, and the accepted residual.
export function commandsFromProgram(source) {
  if (typeof source !== 'string' || !source.includes('cmd')) return [];
  const out = [];
  for (const match of source.matchAll(CMD_LITERAL)) {
    const literal = match[1];
    const quote = literal.charAt(0);
    // Single- and backtick-quoted are valid JS but not JSON; re-quote before parsing so escapes
    // still decode. An unescaped `"` inside such a literal must be escaped on the way in.
    const json = quote === '"'
      ? literal
      : '"' + literal.slice(1, -1).split('\\' + quote).join(quote).split('"').join('\\"') + '"';
    try { out.push(JSON.parse(json)); } catch { /* skip an unparseable literal */ }
  }
  return out;
}

// Which `tools.<name>` a program called — a different question from commandsFromProgram, and the
// one tool categorization needs: on the unified surface every call is named `exec`, so the tool
// that actually did the work only exists inside the program text.
const TOOL_CALL_RE = /tools\.([A-Za-z0-9_$]+)\s*\(/g;

// Distinct tool names, in first-call order. 1096 of 1123 real programs call exactly one tool,
// 21 call two or three, and 6 call none (a bare `text(...)`).
export function toolNamesFromProgram(source) {
  if (typeof source !== 'string' || source.indexOf('tools.') === -1) return [];
  const out = [];
  const seen = new Set();
  for (const match of source.matchAll(TOOL_CALL_RE)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    out.push(match[1]);
  }
  return out;
}
