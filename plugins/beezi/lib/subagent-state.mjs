import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonDurable, safeFileName } from './fs-store.mjs';
import { orDefault, removeFileSync } from './compat.mjs';

// Per-subagent bookkeeping, one small JSON file per agent under
// ~/.beezi-codex/state/<sessionId>.agents/<agentId>.json.
//
// One file per agent rather than a map inside the parent's state file, because a fan-out spawns
// several agents within milliseconds of each other and every one fires its own hook process. A
// shared file would be read-modify-written concurrently by all of them, and last-writer-wins would
// silently drop all but one agent's record — precisely in the sessions this feature exists for.
// Split this way, no two processes ever write the same file and there is nothing to race.
//
// This module is imported by the SubagentStart hook, which must stay cheap: node built-ins and two
// tiny local modules only, never the checkpoint engine.

// A session that spawns more than this is pathological; keep the newest by start time rather than
// letting one session's directory grow without bound. Mirrors MAX_PENDING_ERRORS in checkpoint.mjs.
const MAX_AGENTS = 64;

// agentId and sessionId come off a hook payload, so they are untrusted input on a path — hence
// safeFileName on both components.
export function agentDir(sessionId) {
  return path.join(stateDir(), `${safeFileName(sessionId)}.agents`);
}

function agentFile(sessionId, agentId) {
  return path.join(agentDir(sessionId), `${safeFileName(agentId)}.json`);
}

// Every recorded agent of a session, keyed by agent id. `{}` on any failure — a missing directory is
// the normal case for a session that never spawned one.
export function readAgents(sessionId) {
  const dir = agentDir(sessionId);
  let files;
  try { files = fs.readdirSync(dir); } catch { return {}; }
  const out = {};
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, file));
    if (!rec || typeof rec !== 'object') continue;
    const id = typeof rec.agent_id === 'string' ? rec.agent_id : file.slice(0, -'.json'.length);
    out[id] = rec;
  }
  return out;
}

// Merge `patch` into one agent's record. Read-merge-write of a single file whose only other writers
// are that same agent's hooks, so the merge cannot lose a concurrent write from a sibling agent.
//
// Undefined values in the patch are ignored, so a caller can pass a field it did not resolve without
// erasing what an earlier hook already recorded.
export function writeAgent(sessionId, agentId, patch = {}) {
  const file = agentFile(sessionId, agentId);
  const existing = orDefault(readJson(file), {});
  const next = { ...existing, agent_id: String(agentId) };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) next[k] = v;
  }
  writeJsonDurable(file, next);
  pruneAgents(sessionId);
  return next;
}

// Drop the oldest records once a session has more than MAX_AGENTS. Best-effort: failing to prune is
// never worth failing a hook over.
function pruneAgents(sessionId) {
  const dir = agentDir(sessionId);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
  if (files.length <= MAX_AGENTS) return;
  const scored = files.map((f) => {
    const rec = readJson(path.join(dir, f));
    return { f, at: Date.parse(orDefault((rec || {}).started_at, '')) || 0 };
  }).sort((a, b) => a.at - b.at);
  for (const { f } of scored.slice(0, scored.length - MAX_AGENTS)) {
    removeFileSync(path.join(dir, f)); // best-effort: swallows its own errors
  }
}

// No removeAgents here on purpose: pruneStale sweeps any stale DIRECTORY under stateDir(), so a
// session's agent folder goes with its state file without either side knowing about the other.
