import fs from 'node:fs';
import path from 'node:path';
import { codexSessionsDir } from './paths.mjs';
import { scanRecords } from './session-name-codex.mjs';
import { ROLLOUT_RE } from './transcript-codex.mjs';

// Codex writes a subagent to its OWN top-level rollout under ~/.codex/sessions, not nested under the
// parent. The file starts with the subagent's session_meta (`thread_source: "subagent"`, carrying
// `parent_thread_id` and `forked_from_id`), and on the forking builds it is followed by a replayed
// copy of the PARENT's session_meta plus the parent's opening records — written in one burst at fork
// time before the agent does any work of its own.
//
// That replay is why a subagent rollout cannot simply be fed to computeDelta from line 0. It carries
// the parent's own `event_msg/token_count` records verbatim, and the subagent's cumulative counter
// then CONTINUES from the parent's total rather than restarting (measured: last replayed input
// 80130, first own 94527). Billing from zero would charge the parent's history again, once per
// agent — +15.4% on local data.
//
// The fix is to start the delta window after the replay. computeDelta's pre-window branch already
// walks those records to advance its baseline, so a correct boundary gives correct numbers with no
// other change.

// The replay burst is written in one go: measured spans are 63-99ms, and the gap to the agent's
// first genuine record is 2.4-11.3s. 500ms sits with ~5x margin on both sides.
export const FORK_BURST_MS = 500;
// Measured prefixes on the current format are 14-22 records. The cap bounds the search; overrunning
// it is treated as "this file is not the shape we know", never as "there is no prefix".
export const MAX_FORK_PREFIX_RECORDS = 64;

// Enough head to cover the prefix comfortably — measured prefixes are 76-79KB, dominated by two
// copies of `base_instructions` plus a permissions message, and they do NOT grow with parent
// history.
const HEAD_BYTES = 2 * 1024 * 1024;
// The boundary search never looks past MAX_FORK_PREFIX_RECORDS, so reading more can only be waste.
const HEAD_RECORDS = MAX_FORK_PREFIX_RECORDS;

function tsOf(rec) {
  const ms = Date.parse(rec?.timestamp ?? '');
  return Number.isFinite(ms) ? ms : null;
}

// Where this rollout's own work begins: the 0-based index of the first genuine record, 0 meaning
// "bill the whole file".
//
// NULL means the file is a fork whose replayed prefix could not be delimited, and the caller must
// skip it entirely — see the fail-closed note at the bottom.
export function forkPrefixBoundary(records) {
  if (!Array.isArray(records) || records.length < 2) return 0;

  const window = records.slice(0, MAX_FORK_PREFIX_RECORDS);
  const metaCount = window.filter((r) => r?.type === 'session_meta').length;

  // Two session_meta records — the agent's own and the parent's replayed copy — is the signature of
  // the replaying format. Anything else is a rollout whose content is all its own.
  //
  // This gate is load-bearing and was measured, not assumed. A bare timestamp cliff returns 2, 7 and
  // 8 on the three older subagent formats in the local corpus, each time skipping real content (their
  // first user_message sits at index 6-7). Those files carry ONE session_meta and zero replayed
  // token_counts, so the correct answer for them is 0 — which is also what the plugin did before
  // subagents were read at all.
  if (metaCount !== 2) return 0;
  if (records[1]?.type !== 'session_meta') return 0;

  const t0 = tsOf(records[0]);
  if (t0 == null) return null;

  for (let i = 1; i < window.length; i++) {
    const ts = tsOf(window[i]);
    if (ts == null) continue;
    if (ts - t0 >= FORK_BURST_MS) return i;
  }

  // A confirmed fork whose prefix we could not find the end of. FAIL CLOSED.
  //
  // The tempting alternative — fall back to 0 — is the dangerous one. An older Codex format replays
  // the parent's ENTIRE token history into the child (~99.8% of the file; it inflated ccusage 91x),
  // and it also carries two session_meta records, so it reaches exactly here. Billing that from a
  // zero baseline would charge the parent's whole history again. Skipping costs one unreported
  // agent; guessing corrupts the account's numbers.
  return null;
}

// Identity of a subagent rollout from its own session_meta, or null when it is not one.
export function subagentIdentityFrom(records) {
  const meta = Array.isArray(records) ? records[0] : null;
  if (meta?.type !== 'session_meta') return null;
  const p = meta.payload;
  if (!p || p.thread_source !== 'subagent') return null;

  // Four independent links to the parent exist across format versions; prefer the explicit ones and
  // fall back to `session_id`, which on a subagent holds the PARENT's thread id (on a normal rollout
  // it equals `id`). The oldest format has none of them — hence the null.
  const spawn = p.source?.subagent?.thread_spawn ?? null;
  const ownThreadId = str(p.id);
  const sessionId = str(p.session_id);
  const parentThreadId =
    str(p.parent_thread_id) ??
    str(p.forked_from_id) ??
    str(spawn?.parent_thread_id) ??
    // Last resort for the oldest format, which has none of the above: on a subagent `session_id`
    // holds the PARENT's thread id while `id` is its own, so the two differing IS the link.
    (sessionId !== ownThreadId ? sessionId : null);

  return {
    ownThreadId,
    parentThreadId,
    agentNickname: str(p.agent_nickname) ?? str(spawn?.agent_nickname),
    spawnDepth: Number.isInteger(spawn?.depth) ? spawn.depth : null,
  };
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Parse a bounded head of a rollout into records. Only the prefix matters here, and the prefix does
// not scale with the session, so this never reads the whole file.
//
// Built on scanRecords rather than repeating it: that generator stops at the first record the caller
// stops asking for, and decodes through a streaming TextDecoder so a multi-byte UTF-8 sequence
// straddling a chunk boundary does not become U+FFFD. A local `buf.toString()` here had exactly that
// bug, and read the whole byte window before honouring maxRecords.
export function readRolloutHead(transcriptPath, { maxBytes = HEAD_BYTES, maxRecords = HEAD_RECORDS } = {}) {
  const out = [];
  for (const rec of scanRecords(transcriptPath, { maxBytes })) {
    out.push(rec);
    if (out.length >= maxRecords) break;
  }
  return out;
}

// Rollouts under ~/.codex/sessions that name `sessionId` as their parent.
//
// The backstop for two cases the SubagentStop hook cannot cover: a machine where the user has not
// trusted the hooks (Codex will not run a hook it has not been shown, and that trust step is easy to
// skip), and the manual `track` path, which runs with no hooks at all. Returns [{ agentId, path }].
//
// Bounded deliberately: only files modified since the session began, and only the first record of
// each is parsed. `sinceMs` of null scans the whole tree, which is why callers pass one.
export function findSubagentRollouts(sessionId, { sinceMs = null, sessionsDir = null, maxReads = 500 } = {}) {
  if (!sessionId) return [];
  const root = sessionsDir ?? codexSessionsDir();
  const found = [];
  // Counts files OPENED, not files matched. Bounding matches would be no bound at all: a machine
  // with thousands of rollouts and no subagents is exactly the case that never hits a match cap.
  let reads = 0;

  const walk = (dir, depth) => {
    if (depth > 4 || reads >= maxReads) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (reads >= maxReads) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!ROLLOUT_RE.test(entry.name)) continue;
      // mtime first: it is one stat, and it rejects most of the tree before any file is opened.
      if (sinceMs != null) {
        try { if (fs.statSync(full).mtimeMs < sinceMs) continue; } catch { continue; }
      }
      reads += 1;
      // Only the first record — the session_meta — is needed to answer "is this ours?".
      const identity = subagentIdentityFrom(readRolloutHead(full, { maxBytes: 512 * 1024, maxRecords: 1 }));
      if (!identity || identity.parentThreadId !== sessionId) continue;
      found.push({ agentId: identity.ownThreadId ?? entry.name.replace(/\.jsonl$/, ''), path: full });
    }
  };

  walk(root, 0);
  return found;
}

// The wall-clock start of a rollout, from its session_meta. Used to bound the sweep above.
export function rolloutStartedAt(transcriptPath) {
  const [first] = readRolloutHead(transcriptPath, { maxBytes: 512 * 1024, maxRecords: 1 });
  return first ? tsOf(first) : null;
}

// Everything the checkpoint needs to bill a rollout as a subagent, or null when it must not be
// billed as one — unreadable, not a subagent, or a fork whose replayed prefix could not be
// delimited. The caller treats all three the same way (skip), so they are one return value.
export function inspectSubagentRollout(transcriptPath) {
  const records = readRolloutHead(transcriptPath);
  if (records.length === 0) return null;

  const identity = subagentIdentityFrom(records);
  if (!identity) return null;

  const forkBoundaryLine = forkPrefixBoundary(records);
  if (forkBoundaryLine === null) return null;

  return { forkBoundaryLine, ...identity };
}
