import fs from 'node:fs';
import { codexSessionIndexFile } from './paths.mjs';

const MAX = 200;

// Codex's session title lives in ~/.codex/session_index.jsonl as { id, thread_name, updated_at },
// one record per session (rewritten as the title changes). The latest matching record wins.
export function sessionNameFromIndex(sessionId) {
  if (!sessionId) return null;
  let content;
  try { content = fs.readFileSync(codexSessionIndexFile(), 'utf-8'); } catch { return null; }
  let name = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.id !== sessionId) continue;
    const n = typeof rec.thread_name === 'string' ? rec.thread_name.trim() : '';
    if (n) name = n.slice(0, MAX); // last matching record wins
  }
  return name;
}

// Only the first ~64KB is scanned — the first real user prompt lands near the top of the rollout.
const SCAN_CHUNK = 64 * 1024;

function readHead(transcriptPath) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, SCAN_CHUNK));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Text of a user_message event, tolerating string or content-block message shapes.
function userMessageText(rec) {
  const p = rec?.payload;
  if (rec?.type === 'event_msg' && p?.type === 'user_message') {
    if (typeof p.message === 'string') return p.message;
    if (typeof p.text === 'string') return p.text;
  }
  if (rec?.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
    const c = p.content;
    if (Array.isArray(c)) {
      return c.filter((b) => b?.type === 'input_text' && typeof b.text === 'string')
        .map((b) => b.text).join(' ');
    }
  }
  return '';
}

// Fallback title from the rollout: the first genuine user prompt, truncated. Codex injects an
// AGENTS.md/user-instructions message as a response_item first; the real prompt is the first
// event_msg user_message, so that is preferred.
export function sessionNameFrom(transcriptPath) {
  const head = readHead(transcriptPath);
  if (!head) return null;
  let firstResponseUser = null;
  for (const raw of head.split('\n')) {
    if (!raw.trim()) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
      const text = userMessageText(rec).trim();
      if (text) return text.slice(0, MAX);
    } else if (!firstResponseUser && rec.type === 'response_item') {
      const text = userMessageText(rec).trim();
      // Skip the injected instruction preamble (AGENTS.md / user_instructions markers).
      if (text && !/^#?\s*(AGENTS\.md|<user_instructions|## Skills)/i.test(text)) {
        firstResponseUser = text.slice(0, MAX);
      }
    }
  }
  return firstResponseUser;
}

// Session display name: prefer Codex's session index (the live thread title), falling back to the
// first user prompt in the rollout.
export function resolveSessionName(sessionId, transcriptPath) {
  return sessionNameFromIndex(sessionId) ?? sessionNameFrom(transcriptPath);
}
