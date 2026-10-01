import fs from 'fs';
import path from 'path';
import { codexSessionsDir } from './paths.mjs';
import { scanRecords } from './session-name-codex.mjs';
import { ROLLOUT_HEAD_BYTES, ROLLOUT_RE } from './transcript-codex.mjs';
import { orDefault } from './compat.mjs';

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
const FORK_BURST_MS = 500;
// Measured prefixes on the current format are 14-22 records. The cap bounds the search; overrunning
// it is treated as "this file is not the shape we know", never as "there is no prefix".
export const MAX_FORK_PREFIX_RECORDS = 64;

// Enough head to cover the prefix comfortably — measured prefixes are 76-79KB, dominated by two
// copies of `base_instructions` plus a permissions message, and they do NOT grow with parent
// history.
//
// This is the MANY-record default, for the fork-boundary scan. The one-record reads below pass
// ROLLOUT_HEAD_BYTES (512KB, lib/transcript-codex.mjs) instead; the two are not interchangeable.
const HEAD_BYTES = 2 * 1024 * 1024;
// The boundary search never looks past MAX_FORK_PREFIX_RECORDS, so reading more can only be waste.
const HEAD_RECORDS = MAX_FORK_PREFIX_RECORDS;

function tsOf(rec) {
  const ms = Date.parse(orDefault((rec || {}).timestamp, ''));
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
  const metaCount = window.filter((r) => r && r.type === 'session_meta').length;

  // Two session_meta records — the agent's own and the parent's replayed copy — is the signature of
  // the replaying format. Anything else is a rollout whose content is all its own.
  //
  // This gate is load-bearing and was measured, not assumed. A bare timestamp cliff returns 2, 7 and
  // 8 on the three older subagent formats in the local corpus, each time skipping real content (their
  // first user_message sits at index 6-7). Those files carry ONE session_meta and zero replayed
  // token_counts, so the correct answer for them is 0 — which is also what the plugin did before
  // subagents were read at all.
  if (metaCount !== 2) return 0;
  if ((records[1] || {}).type !== 'session_meta') return 0;

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
  if (!meta || meta.type !== 'session_meta') return null;
  const p = meta.payload;
  if (!p || p.thread_source !== 'subagent') return null;

  // Four independent links to the parent exist across format versions; prefer the explicit ones and
  // fall back to `session_id`, which on a subagent holds the PARENT's thread id (on a normal rollout
  // it equals `id`). The oldest format has none of them — hence the null.
  const spawn = orDefault(((p.source || {}).subagent || {}).thread_spawn, null);
  const ownThreadId = str(p.id);
  const sessionId = str(p.session_id);
  const parentThreadId = orDefault(
    orDefault(
      orDefault(str(p.parent_thread_id), str(p.forked_from_id)),
      str((spawn || {}).parent_thread_id),
    ),
    // Last resort for the oldest format, which has none of the above: on a subagent `session_id`
    // holds the PARENT's thread id while `id` is its own, so the two differing IS the link.
    sessionId !== ownThreadId ? sessionId : null,
  );

  return {
    ownThreadId,
    parentThreadId,
    // The ROOT session, on every format that carries it. On a subagent `session_id` names the
    // session that owns the whole spawn tree, not the immediate spawner — which is what makes a
    // depth-2 agent attributable to the session that must bill it. Null on the oldest format,
    // and null when it merely repeats `id` (an ordinary rollout shape), so it can never make a
    // rollout look like it belongs to a session it does not.
    rootSessionId: sessionId !== ownThreadId ? sessionId : null,
    agentNickname: orDefault(str(p.agent_nickname), str((spawn || {}).agent_nickname)),
    // The agent's ROLE path, e.g. "/root/api_domain" — the nearest thing a rollout carries to the
    // hook payload's `agent_type` (G-7-3). Present at the top level on the modern format and
    // duplicated inside `thread_spawn`; the oldest format has neither, hence the null.
    agentPath: orDefault(str(p.agent_path), str((spawn || {}).agent_path)),
    spawnDepth: spawn && Number.isInteger(spawn.depth) ? spawn.depth : null,
  };
}

// Last non-empty segment of an agent_path — "/root/api_domain" becomes "api_domain".
//
// Split on both separators. The paths are Codex-internal and slash-shaped, but nothing in the
// format promises a separator, and a wrong split must yield null rather than a mangled label.
// Clamped to the same 100 characters the wire field takes, so a caller cannot widen it by accident.
export function agentRoleFromPath(agentPath) {
  if (typeof agentPath !== 'string' || !agentPath) return null;
  const parts = agentPath.split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0) return null;
  return String(parts[parts.length - 1]).slice(0, 100);
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

// Rollouts under ~/.codex/sessions that belong to `sessionId`'s spawn tree, at ANY depth.
//
// The backstop for two cases the SubagentStop hook cannot cover: a machine where the user has not
// trusted the hooks (Codex will not run a hook it has not been shown, and that trust step is easy to
// skip), and the manual `track` path, which runs with no hooks at all. Returns [{ agentId, path }].
//
// Bounded deliberately: only files modified since the session began, and only the first record of
// each is parsed. `sinceMs` of null scans the whole tree, which is why callers pass one.
//
// BOUNDS, stated because nested discovery looks like it should recurse and this deliberately does
// not — a sweep runs inside a hook budget:
//   * DEPTH. The only recursion here is over DIRECTORIES, capped at `depth > 4` below (the tree is
//     sessions/<yyyy>/<mm>/<dd>/). There is no spawn-graph recursion at all: a depth-2 and a
//     depth-9 agent are found by the same single-pass test, because every subagent rollout names
//     the root session directly. Spawn depth costs nothing.
//   * READS. `maxReads` files OPENED, unchanged by the widening below — the wider filter changes
//     which files are KEPT, never how many are read.
//   * CYCLES. Unreachable by construction: no parent→child edge is ever followed, and one pass
//     opens each file at most once, so a rollout that named itself (or a mutual A↔B pair) as an
//     ancestor cannot loop. The one degenerate case that IS reachable — a file claiming to be its
//     own session's subagent — is rejected explicitly below rather than billed twice.
export function findSubagentRollouts(sessionId, { sinceMs = null, sessionsDir = null, maxReads = 500 } = {}) {
  if (!sessionId) return [];
  const root = sessionsDir === undefined || sessionsDir === null ? codexSessionsDir() : sessionsDir;
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
      const identity = subagentIdentityFrom(readRolloutHead(full, { maxBytes: ROLLOUT_HEAD_BYTES, maxRecords: 1 }));
      if (!identity) continue;
      // A file that claims to be its own session's subagent is a one-node cycle in the spawn graph.
      // The session's own rollout is already billed as the parent, so keeping it here would bill the
      // same file twice under two segment scopes. Reject rather than trust the claim.
      if (identity.ownThreadId === sessionId) continue;
      // Either link attributes this rollout to the session. `parentThreadId` catches a direct child;
      // `rootSessionId` catches a grandchild, whose parent is another AGENT and therefore never
      // equals the session id — measured: one such agent, 643,486 tokens (18.3% of that session's
      // subagent usage), silently dropped by the parent-only test. Both are read only after the
      // `thread_source: 'subagent'` gate in subagentIdentityFrom, and `rootSessionId` is null
      // whenever it merely repeats the rollout's own id, so widening cannot pull in an ordinary
      // rollout or attach an agent to a session that did not spawn it.
      if (identity.parentThreadId !== sessionId && identity.rootSessionId !== sessionId) continue;
      found.push({ agentId: orDefault(identity.ownThreadId, entry.name.replace(/\.jsonl$/, '')), path: full });
    }
  };

  walk(root, 0);
  return found;
}

// The wall-clock start of a rollout, from its session_meta. Used to bound the sweep above.
export function rolloutStartedAt(transcriptPath) {
  const [first] = readRolloutHead(transcriptPath, { maxBytes: ROLLOUT_HEAD_BYTES, maxRecords: 1 });
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

// Fold two sidecar records that turned out to describe one rollout. `agent_type` and `started_at`
// exist only on a hook payload and `cursor` only on a record the checkpoint has already advanced,
// so taking the defined one of each loses nothing.
//
// Two cursors for one file means one of them already covers lines the other does not. Take the
// HIGHER one: re-billing is the exact failure this guard exists to prevent, so when the two
// disagree the conservative direction is to skip lines rather than repeat them.
export function mergeAgentRecords(a, b) {
  const out = { ...orDefault(a, {}) };
  const from = orDefault(b, {});
  const keys = Object.keys(from);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = from[k];
    if (v === undefined || v === null) continue;
    if (k === 'cursor') {
      if (!Number.isInteger(out.cursor)) out.cursor = v;
      else if (Number.isInteger(v) && v > out.cursor) out.cursor = v;
      continue;
    }
    if (out[k] === undefined || out[k] === null) out[k] = v;
  }
  return out;
}

// Resolve a session's agent dictionary to one entry per ROLLOUT FILE before any of it is billed.
//
// `ordered` is [[agentId, record], ...] already in billing order; `inspect` is
// inspectSubagentRollout (injectable, may throw). Returns [{ agentId, record, rolloutPath,
// inspected }] in first-seen order — the order is load-bearing, since the caller's wall-clock
// coverage union and its segment ids both depend on a reproducible sequence, so this never re-sorts.
//
// WHY THIS EXISTS. The dictionary is keyed by two independent sources: the sweep keys by the
// rollout's own thread id, while a hook sidecar keys by the hook's `agent_id` — and Codex documents
// `agent_id` only as "Identifier for the subagent". It does not promise the thread id, the schema
// embedded in the shipped binary is a bare {"type":"string"}, and live data holds two other
// plausible values (`agent_path` = /root/api_domain, and the spawn tool's `call_id`). When the two
// strings disagree the SAME file arrives under two keys with independent cursors and non-colliding
// segment ids — and the server upserts on `segmentId::model`, so it CANNOT collapse them. The
// tokens are billed twice, per agent, on every fan-out.
//
// WHY IT CANONICALIZES RATHER THAN SKIPPING. The house precedent is forkPrefixBoundary above, which
// fails closed — but it does that because NO CORRECT ANSWER IS AVAILABLE to it: it genuinely cannot
// tell where the replay ends. Here a correct answer is available: the rollout states its own id in
// its own session_meta, derived from data rather than from an unspecified hook field. So the two
// entries are folded onto that id and billed once, which collapses the duplicate AND keeps the agent
// reported. Skipping would add a second silent agent-drop to a module that already had one (the
// nested-agent loss fixed above), which is the wrong trade.
export function canonicalizeAgents(ordered, inspect) {
  const canonical = Object.create(null);
  const order = [];
  const entries = Array.isArray(ordered) ? ordered : [];

  for (let i = 0; i < entries.length; i++) {
    const pair = orDefault(entries[i], []);
    const agentId = pair[0];
    const record = orDefault(pair[1], {});
    const rolloutPath = record.transcriptPath;
    if (typeof rolloutPath !== 'string' || !rolloutPath) continue;

    let inspected;
    try { inspected = inspect(rolloutPath); } catch { inspected = null; }
    if (!inspected) continue;

    const own = inspected.ownThreadId;
    // Fall back to the dictionary key only when the rollout states no id of its own. Skipping there
    // would lose a real agent to defend against a duplicate that cannot occur: with no own id there
    // is no second key for it to collide with. (The key stays untrusted input on that path — it
    // still reaches a segment id and therefore a queue filename.)
    const key = typeof own === 'string' && own ? own : agentId;

    const prior = canonical[key];
    if (!prior) {
      canonical[key] = { agentId: key, record, rolloutPath, inspected };
      order.push(key);
      continue;
    }
    if (prior.rolloutPath !== rolloutPath) {
      // Two DIFFERENT files claiming one thread id. Now there is no correct answer available, so
      // fail closed exactly as forkPrefixBoundary does: bill the first, drop the second. Billing
      // both would double-count under one id; picking by guess could bill the wrong file.
      continue;
    }
    // Same file, second key: fold and bill once.
    prior.record = mergeAgentRecords(prior.record, record);
  }

  const out = [];
  for (let i = 0; i < order.length; i++) out.push(withDerivedRole(canonical[order[i]]));
  return out;
}

// G-7-3. `agent_type` exists only on a hook payload, and Codex will not run a hook the user has not
// trusted through /hooks — so the common case is no sidecar at all and an agent that reaches the
// server labelled `null`. What the rollout does state about itself is `agent_path`
// (e.g. "/root/api_domain"), whose last segment names the agent's role. That stands in.
//
// DERIVED, NEVER INVENTED. A hook-supplied `agent_type` always wins, and a rollout with no path
// keeps the null it has today. This deliberately maps many agents to one label — a fan-out from one
// definition yields the same basename three times — which is right: `agent_type` is a categorical
// role, not an identity. Identity stays in `agent_id`, and nothing here is read by billing.
//
// Applied here, AFTER every fold, so a sidecar arriving as the second key for a rollout still beats
// the derived value; deriving during the fold would leave mergeAgentRecords seeing the field as
// already filled and dropping the real one.
//
// The record is COPIED, not stamped. It is the caller's own dictionary entry, and that same map is
// handed on to the timeline builder — enriching what billing reads must not quietly rewrite it.
function withDerivedRole(entry) {
  const record = orDefault(entry.record, {});
  if (record.agent_type) return entry;
  const role = agentRoleFromPath(orDefault(entry.inspected, {}).agentPath);
  if (!role) return entry;
  return { ...entry, record: { ...record, agent_type: role } };
}
