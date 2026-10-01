import { commandsFromProgram } from './exec-program.mjs';

// Which skill a rollout record used, for the operations Skills row and the timeline's planning
// cycles. Codex has no Skill tool: a skill is either injected into the turn when the user types
// `$name` (a user message starting `<skill>\n<name>X</name>`), or read by the model itself through a
// shell call on its SKILL.md. Both consumers must agree on what counts — the portal marks a session
// "planned" on any plan event — so the predicate lives here once: a SKILL.md must be plainly READ
// (get-content/cat/…); listing or searching skill folders is not a use.

const INJECTION_RE = /^<skill>\s*<name>\s*([^<]+?)\s*<\/name>/;
const READ_HEADS = new Set(['get-content', 'gc', 'cat', 'type', 'sed', 'head', 'tail', 'less', 'more', 'bat']);
const WRAPPERS = new Set(['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd']);
const SKILL_PATH_RE = /"([^"]*[\\/]skill\.md)"|'([^']*[\\/]skill\.md)'|([^\s'"`]*[\\/]skill\.md)(?=$|[\s'"`;|])/gi;
const VERSION_RE = /^\d+\.\d+/;

export function skillNameFromPath(p) {
  if (typeof p !== 'string' || p === '') return null;
  const segs = p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  if (segs.length < 2 || segs[segs.length - 1].toLowerCase() !== 'skill.md') return null;
  const name = segs[segs.length - 2];
  const aboveSkills = segs.length >= 5 && segs[segs.length - 3].toLowerCase() === 'skills'
    ? segs[segs.length - 4] : null;
  if (aboveSkills !== null && VERSION_RE.test(aboveSkills)) return `${segs[segs.length - 5]}:${name}`;
  return name;
}

export function skillInjectionOf(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') return null;
  const content = Array.isArray(p.content) ? p.content : [];
  for (const c of content) {
    const text = c && typeof c.text === 'string' ? c.text : null;
    if (text === null) continue;
    const m = INJECTION_RE.exec(text);
    if (m) return { name: m[1], bytes: Buffer.byteLength(text, 'utf-8') };
  }
  return null;
}

function headOf(token) {
  const base = String(token).replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return base.toLowerCase();
}

// ['powershell.exe','-Command','X'] | 'pwsh -c "X"' | 'bash -lc X'  ->  'X'. One level only.
function unwrap(command) {
  if (Array.isArray(command)) {
    const parts = command.filter((s) => typeof s === 'string');
    if (parts.length >= 3 && WRAPPERS.has(headOf(parts[0])) && /^[-\/]/.test(parts[1])) {
      return parts.slice(2).join(' ');
    }
    return parts.join(' ');
  }
  if (typeof command !== 'string') return '';
  const m = /^\s*(\S+)\s+(-{1,2}[A-Za-z]+|\/c)\s+([\s\S]*)$/.exec(command);
  if (m && WRAPPERS.has(headOf(m[1]))) {
    const inner = m[3].trim();
    const q = inner.charAt(0);
    return (q === '"' || q === "'") && inner.charAt(inner.length - 1) === q ? inner.slice(1, -1) : inner;
  }
  return command;
}

// Pipe stages that only page or trim the read (`| head -n 200`, `| Select-Object -First 200`).
const PIPE_FILTER_HEADS = new Set(['head', 'tail', 'less', 'more', 'select-object', 'select', 'out-string']);

// Quoted spans overwritten with same-length filler, so separators can be FOUND in this copy and the
// original sliced at the same offsets — a `;` inside a quoted path is not a second command.
function maskQuotes(cmd) {
  return cmd.replace(/"[^"]*"|'[^']*'/g, (s) => s.charAt(0) + 'x'.repeat(s.length - 2) + s.charAt(0));
}

// `a; b && c || d` (and newline-separated) -> ['a', 'b', 'c', 'd'].
function segmentsOf(cmd) {
  const masked = maskQuotes(cmd);
  const out = [];
  const sep = /;|&&|\|\||\r?\n/g;
  let from = 0;
  let m;
  while ((m = sep.exec(masked)) !== null) {
    out.push(cmd.slice(from, m.index));
    from = m.index + m[0].length;
  }
  out.push(cmd.slice(from));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

// The skill names one segment plainly reads, or [] when it is anything else: its head must be a read
// command, it must name at least one SKILL.md, and any pipe may only feed a pager/limiter.
function skillsReadBySegment(seg) {
  const first = seg.split(/\s+/)[0];
  if (!first || !READ_HEADS.has(headOf(first))) return [];
  const stages = maskQuotes(seg).split('|');
  for (let i = 1; i < stages.length; i++) {
    const head = stages[i].trim().split(/\s+/)[0];
    if (!head || !PIPE_FILTER_HEADS.has(headOf(head))) return [];
  }
  const names = [];
  SKILL_PATH_RE.lastIndex = 0;
  let m;
  while ((m = SKILL_PATH_RE.exec(seg)) !== null) {
    const name = skillNameFromPath(orFirst(m).replace(/\\\\/g, '\\'));
    if (name !== null) names.push(name);
  }
  return names;
}

// Every skill the commands plainly read, as { names, pure }, or null when they read none. `names` is
// distinct and in first-read order. `pure` is true when EVERY segment of every command is such a
// read — only then may a caller treat the whole call as skill work.
//
// Measured: an automatic Codex skill run is not a lone read. It chains discovery and several
// SKILL.md reads in one command (`rg --files docs; Get-Content …/subagents/SKILL.md; Get-Content
// …/writing-plans/SKILL.md`), so demanding exactly one SKILL.md missed every real planning-skill run.
export function skillReadsOfCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return null;
  const names = [];
  let pure = true;
  for (const raw of commands) {
    const segments = segmentsOf(unwrap(raw).trim());
    if (segments.length === 0) pure = false;
    for (const seg of segments) {
      const read = skillsReadBySegment(seg);
      if (read.length === 0) { pure = false; continue; }
      for (const name of read) if (names.indexOf(name) === -1) names.push(name);
    }
  }
  return names.length === 0 ? null : { names, pure };
}

function orFirst(m) {
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

// Same body as operations-codex.mjs's parseArgs, copied rather than imported: operations-codex
// imports this module, and importing back would be a cycle.
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// skillReadsOfCommands for one tool-call payload: an exec program's commands, or a legacy
// shell call's `command` (a string or an argv array).
export function skillReadsOfCall(p) {
  if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call')) return null;
  if (p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
    return skillReadsOfCommands(commandsFromProgram(p.input));
  }
  const args = parseArgs(p.arguments !== undefined ? p.arguments : p.input);
  if (!args || args.command === undefined) return null;
  return skillReadsOfCommands([args.command]);
}
