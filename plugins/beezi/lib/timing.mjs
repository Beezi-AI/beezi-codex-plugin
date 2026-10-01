import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';
import { safeFileName } from './fs-store.mjs';
import { orDefault } from './compat.mjs';

// Gaps longer than this between two activity timestamps count as idle, not active time. Shared by
// the delta engine (segment duration) and the session timeline (idle classification) so both
// classify "working" against the exact same threshold.
export const IDLE_GAP_SEC = 300;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MID-TURN HEARTBEAT (G-3-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A Codex turn can run for hours with no Stop and no git boundary, and until one arrives nothing is
// checkpointed: no token segments, no timeline, no rate-limit drain, no cursor advance. Close the
// terminal mid-turn and the whole turn is lost. This bounds that wait by riding the PostToolUse hook
// ALREADY registered for every tool (lib/hooks-install.mjs sets MATCH_ALL = '.*'), so it costs no
// new hook entry, no registry write and no second /hooks trust step — the expensive part, given
// Codex's trust gate.
//
// WHY IT LIVES IN timing.mjs AND NOT IN checkpoint.mjs: the gate runs on EVERY tool call, and the
// checkpoint engine pulls ~28 modules that all but one firing in a hundred discards. Measured on
// this machine, cold process, Node v24.11.1: importing lib/checkpoint.mjs costs 139 ms; importing
// this module's whole closure (paths + fs-store + compat, all four node builtins deep) costs 25 ms.
// The gated path must stay at roughly bare node startup or the heartbeat becomes a per-tool-call
// stall. Keeping it beside IDLE_GAP_SEC also keeps every wall-clock threshold in one file.

export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

// safeFileName because `session_id` arrives on a hook payload and this becomes a path segment.
//
// THE EXTENSION IS LOAD-BEARING, and `.json` in particular is forbidden here. state/ is enumerated
// by three other readers — findRolloutBySessionState filters `.json` and parses the match
// (lib/transcript-codex.mjs), poisonedStateEntries derives a session id from `<id>.json` and
// `<id>.agents` filenames, and pruneStale sweeps by mtime. A marker wearing `.json` would be an
// empty file handed to a JSON parser, and a filename minted into a session id — G-3-1 again, in the
// directory G-3-1 was about. `<id>.agents` (lib/subagent-state.mjs) is the precedent for a third
// shape here; test/heartbeat-wiring.test.mjs pins that all three readers ignore this one and that
// prune still reclaims it.
function markerFile(sessionId) {
  return path.join(stateDir(), `${safeFileName(sessionId)}.heartbeat`);
}

// Stamp the marker. Both the claim and the turn-end/boundary touch go through here so there is
// exactly one definition of what the marker means. Returns false when the filesystem refused.
function stamp(sessionId, fsImpl) {
  try {
    fsImpl.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fsImpl.closeSync(fsImpl.openSync(markerFile(sessionId), 'w'));
    return true;
  } catch {
    return false;
  }
}

// Claim the interval, or refuse. True means THIS caller now owns the next heartbeat and must run
// the checkpoint; false means skip and exit.
//
// The marker is stamped BEFORE the work, never after, and it is never un-stamped. Three
// consequences, all deliberate:
//
//   * Parallel tool completions racing here at worst double-run one checkpoint, which is harmless:
//     the second run takes the same rank-2 session lock the first holds and defers, and even if it
//     did not, the server upserts by `segmentId::model`.
//   * A checkpoint that dies — killed hook, thrown engine, an exhausted budget — waits out the
//     interval instead of retrying on the very next tool call. That is what bounds a hot loop:
//     at most one heartbeat attempt per session per interval, whatever happens downstream.
//   * A run that DEFERS on a busy session lock also consumes the interval, and that is correct
//     rather than merely tolerable: the lock holder is another writer checkpointing this same
//     session right now, so the thing the heartbeat wanted is already happening.
//
// An unwritable marker returns false rather than proceeding: running a full checkpoint on every
// tool call because the marker cannot be persisted is strictly worse than no heartbeat, and Stop
// still covers the turn end.
export function claimHeartbeat(sessionId, deps = {}) {
  if (!sessionId) return false;
  const now = orDefault(deps.now, Date.now);
  const intervalMs = orDefault(deps.intervalMs, HEARTBEAT_INTERVAL_MS);
  const fsImpl = orDefault(deps.fs, fs);
  try {
    if (now() - fsImpl.statSync(markerFile(sessionId)).mtimeMs < intervalMs) return false;
  } catch { /* no marker yet — first heartbeat of the session */ }
  return stamp(sessionId, fsImpl);
}

// Reset the window without running anything. Called from the paths that ALREADY checkpoint — the
// git boundary and the turn end — so the marker means "time since the last checkpoint of this
// session", not "time since the last heartbeat". Without it, a session whose Stop lands at minute
// 14 pays a full engine load two minutes into the next turn for a window with nothing in it.
// Best-effort: a failure here costs one early heartbeat and nothing else.
export function touchHeartbeat(sessionId, deps = {}) {
  if (!sessionId) return false;
  return stamp(sessionId, orDefault(deps.fs, fs));
}

// The whole gate, as one call, so scripts/checkpoint.mjs stays three obvious lines and the
// decision itself is unit-testable — nothing in the suite can spawn a hook script.
//
// M-5-1 IS UNMEASURED, AND THIS IS WHERE THAT LANDS. Whether a non-subagent PostToolUse payload
// carries `session_id` on both of Codex's tool surfaces is inferred (the shipped git-boundary path
// would already be broken without it), not measured. A missing id therefore has to fail CLOSED:
// no id, no claim, no heartbeat — exactly today's behaviour — rather than a crash or a checkpoint
// written under a phantom session name. See G-3-1 for what `${undefined}.json` costs.
export function shouldHeartbeat(input, deps = {}) {
  if (!input || typeof input !== 'object') return false;
  // A tool call made INSIDE a subagent thread carries `agent_id`, and scripts/checkpoint.mjs
  // refuses those for reasons that predate this row. Re-stated here rather than left implicit:
  // it is also the bound on an unmeasured fan-out. While the parent blocks in wait_agent every
  // PostToolUse firing comes from a child, so N concurrent agents produce N refusals and zero
  // heartbeat processes. The heartbeat does not cover a fan-out; Stop remains its only flush,
  // exactly as today.
  if (input.agent_id) return false;
  return claimHeartbeat(input.session_id, deps);
}
