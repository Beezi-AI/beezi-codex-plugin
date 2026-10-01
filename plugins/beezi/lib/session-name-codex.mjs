import fs from 'fs';
import path from 'path';
import { codexSessionIndexFile } from './paths.mjs';
import { orDefault } from './compat.mjs';

const MAX = 200;

// ~/.codex/session_index.jsonl holds { id, thread_name, updated_at }, appended to as the title
// changes. `thread_name` is the AI-generated title Codex shows in its own UI, which makes it the
// best session name available — better than any prompt text, since it is a summary rather than an
// opening line ("Виправити проблему на зображенні" for a session whose first prompt was a pasted
// OAuth error blob).
//
// This was written when the index looked originator-gated, and that is no longer true. Re-measured
// 2026-09-09 over 200 local rollouts: on Codex 0.153+ EVERY top-level session is indexed (12/12,
// plain `codex-tui` included), against 2/10 on 0.146-0.152 and 13/167 before that. So on a current
// install this is the primary source and sessionNameFrom below is the compatibility fallback — the
// reverse of the old reading. (Subagent rollouts are never indexed, 0/11, and never need to be:
// checkpoint.mjs bills them under the parent session, so they inherit its name.)
//
// Two records per session is the normal shape, and the ORDER MATTERS: Codex seeds the index with
// the user's raw opening prompt truncated to ~36 characters, then replaces it with the AI title
// 3-12s later. Both consequences are handled below — the raw seed is prompt text and must be
// redacted like any other (readIndex), and it must not be mistaken for a finished title
// (isTruncatedPrompt).
export function sessionNameFromIndex(sessionId, transcriptPath = null) {
  const entry = indexEntry(sessionId, transcriptPath);
  return entry ? entry.name : null;
}

// The chosen record plus how many the session has, for resolveSessionName's placeholder check.
function indexEntry(sessionId, transcriptPath) {
  if (!sessionId) return null;
  for (const file of indexCandidates(transcriptPath)) {
    const entry = readIndex(file, sessionId);
    if (entry) return entry;
  }
  return null;
}

// The configured index, then one derived from the transcript's own location. codexHome() reads
// CODEX_HOME || ~/.codex, and both diverge from where Codex actually writes on macOS (App Sandbox
// container, CODEX_HOME exported in an interactive shell but not inherited by a GUI launch, $HOME
// unset under launchd). The resolved transcript path is already known-good, so it recovers the real
// home when the configured one is wrong.
function indexCandidates(transcriptPath) {
  const out = [codexSessionIndexFile()];
  const derived = codexHomeFromTranscript(transcriptPath);
  if (derived) {
    const file = path.join(derived, 'session_index.jsonl');
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

// …/<codexHome>/sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl → <codexHome>, or null when the path
// does not have exactly that shape (a test fixture, a hand-passed file, a relocated transcript).
export function codexHomeFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const parts = path.resolve(transcriptPath).split(path.sep);
  const i = parts.lastIndexOf('sessions');
  // sessions/YYYY/MM/DD/<file> — exactly four entries after `sessions`.
  if (i < 1 || parts.length - i !== 5) return null;
  return parts.slice(0, i).join(path.sep);
}

// Every named record for this session, newest first.
//
// Codex writes at least two per session and the ORDER MATTERS: the user's opening prompt, truncated
// to ~36 characters, lands the moment the turn starts, and the AI-generated thread name replaces it
// 3-12s later. `updated_at` is what separates them; file order only breaks ties and covers a record
// whose timestamp is missing or unparseable. Taking the last line of the file happened to pick the
// right one, but by accident of append order rather than by anything the format guarantees.
function indexRecords(file, sessionId) {
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out = [];
  let line = 0;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    line += 1;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.id !== sessionId) continue;
    const name = typeof rec.thread_name === 'string' ? rec.thread_name.trim() : '';
    if (!name) continue;
    const ms = Date.parse(typeof rec.updated_at === 'string' ? rec.updated_at : '');
    out.push({ name, at: Number.isFinite(ms) ? ms : null, line });
  }
  out.sort((a, b) => {
    if (a.at !== b.at) {
      // A record with no usable timestamp sorts after every dated one rather than winning by luck.
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at - a.at;
    }
    return b.line - a.line;
  });
  return out;
}

// The newest record that is safe to report, or null.
//
// The gate is not optional. This used to return `thread_name` verbatim, which was defensible while
// the index only held threads the user had NAMED — but current Codex seeds it with the raw opening
// prompt, so a prompt beginning `C:\Users\<name>\…` would be POSTed as-is. That is the same leak
// redactPaths/isSafeSessionName already closed on the rollout path, reopened through another door.
// A record that cannot be salvaged is skipped, not fatal: an older, cleaner record may follow.
function readIndex(file, sessionId) {
  const records = indexRecords(file, sessionId);
  for (const rec of records) {
    const name = sanitizeSessionName(rec.name);
    // `total` lets the caller tell "the AI title has already landed" from "so far there is only the
    // placeholder", without re-reading the file.
    if (name) return { name, total: records.length };
  }
  return null;
}

// The rollout is scanned as a bounded stream, not a fixed head slice. A 64KB head used to be the
// whole budget, and it was far too small: session_meta alone is ~37KB on a modern install
// (base_instructions ~16KB + dynamic_tools ~20KB, the latter growing with every installed MCP
// server), then a ~21KB permissions developer message follows. Measured offsets of the first
// user_message across 182 local rollouts: p50 19KB, p90 81KB, p95 159KB, p99 555KB, max 1.21MB —
// 23 files past 64KB, none past 2MB. Those are machine-scoped sizes, not OS-scoped, which is why a
// mac with a few more MCP servers fails on EVERY session while a leaner box never notices.
//
// The common case still reads one chunk: the scan returns on the first usable user_message.
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
// A single record larger than this is abandoned rather than buffered — a pathological transcript
// must not turn a bounded read into a bounded read plus unbounded memory.
const MAX_LINE_BYTES = 1024 * 1024;

export function* scanRecords(transcriptPath, { maxBytes = MAX_SCAN_BYTES } = {}) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return; }
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    // Streaming decode, not buf.toString(): a multi-byte UTF-8 sequence straddling a chunk boundary
    // would otherwise decode to U+FFFD, and a mangled character in a name we POST is a visible bug
    // on a corpus full of non-ASCII prompts.
    const decoder = new TextDecoder('utf-8');
    let carry = '';
    let read = 0;
    while (read < maxBytes) {
      let n;
      try { n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, maxBytes - read), read); } catch { return; }
      if (n <= 0) break;
      read += n;
      const text = carry + decoder.decode(buf.subarray(0, n), { stream: true });
      const lines = text.split('\n');
      // The trailing element is an incomplete record; hold it for the next chunk.
      carry = orDefault(lines.pop(), '');
      if (carry.length > MAX_LINE_BYTES) carry = '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        yield rec;
      }
    }
    // A file with no trailing newline ends on a complete record; a file cut off by maxBytes ends on
    // a partial one. JSON.parse separates the two.
    if (carry.trim()) {
      try { yield JSON.parse(carry); } catch { /* truncated at the ceiling — drop it */ }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Text of a user message, tolerating string or content-block shapes.
function userMessageText(rec) {
  const p = rec && rec.payload;
  if (rec && rec.type === 'event_msg' && p && p.type === 'user_message') {
    if (typeof p.message === 'string') return p.message;
    if (typeof p.text === 'string') return p.text;
  }
  if (rec && rec.type === 'response_item' && p && p.type === 'message' && p.role === 'user') {
    const c = p.content;
    if (Array.isArray(c)) {
      return c.filter((b) => b && b.type === 'input_text' && typeof b.text === 'string')
        .map((b) => b.text).join(' ');
    }
  }
  return '';
}

// Absolute filesystem paths, which session_name must never carry off the machine: a Windows
// drive-rooted path, or a POSIX home path. Relative paths ("src/lib/parser.ts") are left alone —
// they are ordinary prompt content and say nothing about the user.
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)[^\s"'`)\]]*/g;

// Redact rather than reject. A stack trace or a "update this file" prompt is a perfectly good
// session name once the path is gone, and dropping the whole name over one substring is how a real
// prompt like "[ERROR] Unable to build website ... at tryToBuildLocale (C:\Users\...)" ended up
// unnamed. Replacing keeps the useful half and still lets nothing identifying leave.
function redactPaths(text) {
  return text.replace(ABSOLUTE_PATH, '…');
}

function clean(text) {
  if (typeof text !== 'string') return '';
  return redactPaths(text)
    .replace(/\s+/g, ' ')
    // A prompt that listed a dozen files redacts to a dozen markers before the actual sentence;
    // collapse the run so the human part is what a reader sees.
    .replace(/(?:…[\s,;]*){2,}/g, '… ')
    .trim();
}

// The Codex IDE extensions prepend a context dump — active file, open tabs, the current selection —
// to the user's message and mark the human part with a "My request for Codex:" heading. Measured on
// 182 local rollouts this is the DOMINANT shape (106 of them), so neither taking the message whole
// nor refusing it is acceptable: the first reports the user's open tab list as the session name, the
// second reports nothing at all. Unwrap to the request instead.
//
// A header with no request marker means there is no human text in the message — return empty so the
// caller keeps scanning rather than naming the session after an IDE dump.
const IDE_CONTEXT_HEADER = /^#\s*Context from my IDE setup:/i;
const IDE_REQUEST_MARKER = /^##[ \t]*My request for Codex:[ \t]*$/im;

function unwrapIdeContext(raw) {
  if (!IDE_CONTEXT_HEADER.test(raw.trimStart())) return raw;
  const marker = IDE_REQUEST_MARKER.exec(raw);
  return marker ? raw.slice(marker.index + marker[0].length) : '';
}

// Context Codex injects as a `user` message before the human ever types. This was an allowlist of
// three shapes and it leaked: across the 60 most recent local rollouts the first response_item user
// message was <environment_context> in 54 and <recommended_plugins> in 6, neither of which was
// listed. Naming shapes is necessary but can never be sufficient — hence isSafeSessionName below.
// Only the shapes isSafeSessionName cannot already see. Everything Codex injects as XML
// (<environment_context>, <user_instructions>, <recommended_plugins>, <permissions>, <world_state>,
// <turn_aborted>) is caught by its /^</ rule, and the AGENTS.md / "## Skills" blocks by its heading
// rule — verified against 182 local rollouts, where every one of those matched both checks. Listing
// them here as well only invites a reader to maintain two overlapping rejection lists.
//
// What is left is the pair that genuinely needs naming: Codex's own internal turns. It emits them
// through `event_msg:user_message` — the same channel a human prompt arrives on — with no ordering,
// timestamp or role difference to separate them. Text is the only discriminator available.
const PREAMBLE_SHAPES = [
  /^#?\s*AGENTS\.md/i,
  /^You are a helpful assistant\.\s*You will be presented with a user prompt/i,
  // Codex's own title-generation turn, issued as a user message inside the session it is naming.
  /^Generate a concise UI title/i,
];

// Raw user text of a record, with any IDE context wrapper unwrapped to the human's request.
function candidateText(rec) {
  return clean(unwrapIdeContext(userMessageText(rec)));
}

function isPreamble(text) {
  return PREAMBLE_SHAPES.some((re) => re.test(text));
}

// session_name is POSTed to the server and is the reason queue files are written 0600: it carries
// prompt text. An older resolver shipped 21 of 182 local sessions named "<environment_context>
// <cwd>C:\Users\<name>…" — the user's home path, shell and timezone left the machine.
//
// The single gate every reported name goes through: redact first, then refuse what is left if it is
// not a name. Exported because isSafeSessionName ALONE is not enough for a caller holding untrusted
// text — it rejects a name that is nothing but a path, but happily passes one with a path buried in
// it ("why does C:\Users\…\main.ts crash"), which is exactly the shape Codex's index seed produces.
// checkpoint.mjs holds such a name in state on any machine that ran the un-redacted resolver.
export function sanitizeSessionName(text) {
  const name = clean(text).slice(0, MAX);
  return isSafeSessionName(name) ? name : null;
}

// The catch-all, applied to text clean() has already redacted — sanitizeSessionName above is how
// every caller should reach it. Not redundant after redaction: a name that redacts down to nothing
// but markers, or that is still shaped like injected context, is no name at all, and refusing it is
// what sends the caller back to a real source.
export function isSafeSessionName(text) {
  if (!text || typeof text !== 'string') return false;
  if (/^</.test(text)) return false; // any XML-ish injected block
  if (/^#{1,6}\s/.test(text)) return false; // a document heading, not a prompt
  // Nothing but an absolute path (or punctuation) is not a name — and this is the rule that refuses
  // a raw stored name a previous version captured before redaction existed.
  if (!/[\p{L}\p{N}]/u.test(text.replace(ABSOLUTE_PATH, ''))) return false;
  return true;
}

// Fallback title from the rollout: the first genuine user prompt, truncated.
//
// An event_msg/user_message is the real thing and wins immediately. A response_item user message is
// only a candidate — Codex injects several before the human's, so each one that fails the preamble
// or safety check is SKIPPED and scanning continues. It used to latch on the first non-skipped
// candidate, which is how <environment_context> at byte 37,915 beat the actual prompt at 51,636.
export function sessionNameFrom(transcriptPath) {
  let fallback = null;
  for (const rec of scanRecords(transcriptPath)) {
    if (rec && rec.type === 'event_msg' && rec.payload && rec.payload.type === 'user_message') {
      const text = candidateText(rec);
      if (text && !isPreamble(text) && isSafeSessionName(text)) return text.slice(0, MAX);
    } else if (!fallback && rec && rec.type === 'response_item') {
      const text = candidateText(rec);
      if (!text || isPreamble(text) || !isSafeSessionName(text)) continue;
      fallback = text.slice(0, MAX);
    }
  }
  return fallback;
}

// Session display name: prefer Codex's session index (the live thread title), falling back to the
// first user prompt in the rollout. The transcript path is passed through so the index lookup can
// recover a codex home that codexHome() got wrong.
export function resolveSessionName(sessionId, transcriptPath) {
  // Written out (not orDefault) so the rollout scan only runs when it can change the answer.
  const entry = indexEntry(sessionId, transcriptPath);
  if (entry === null) return sessionNameFrom(transcriptPath);
  // More than one record for this id means Codex has already written past the placeholder seed, so
  // the chosen name is a real title and the rollout never has to be opened. (The chosen record is
  // the newest that passed the gate, which on a two-record session is the AI title.)
  if (entry.total > 1) return entry.name;
  const fromRollout = sessionNameFrom(transcriptPath);
  return isTruncatedPrompt(entry.name, fromRollout) ? fromRollout : entry.name;
}

// Is this index name just Codex's ~36-character cut of the opening prompt, taken before the AI
// title landed? It is exactly a prefix of what the rollout reports, and shorter.
//
// Why this matters at all: a checkpoint firing inside that 3-12s window would name the session after
// a mid-word stub, and nothing guarantees a later checkpoint to correct it — Codex silently drops
// SessionEnd, so checkpoint.mjs's replay-the-anchor path may never run. The rollout holds the same
// prompt at full length and redacted the same way, which is strictly the better name.
//
// Compared case-sensitively and against the CLEANED prompt, so an AI title that merely echoes the
// prompt's wording ("Ping" for "ping", "Deploy apps to Vercel" for "we need to deploy our apps on
// vercel") is kept rather than mistaken for a truncation.
function isTruncatedPrompt(name, prompt) {
  if (!name || !prompt) return false;
  return prompt.length > name.length && prompt.slice(0, name.length) === name;
}
