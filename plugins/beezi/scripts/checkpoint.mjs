import { readHookInput, isGitCheckpointCommand, shellCommandsOf } from '../lib/hook-input.mjs';
import { shouldHeartbeat, touchHeartbeat } from '../lib/timing.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// PostToolUse also fires for tool calls made INSIDE a subagent thread, and carries `agent_id` when
// it does. Running the parent's checkpoint from there is wrong under either reading of the
// accompanying `session_id`: if it is the parent's, this advances the parent's cursor and anchor
// from a second process while the parent sits blocked in wait_agent; if it is the child's, the
// transcript resolver finds the child rollout and reports it as a top-level session with no
// subagent identity — a session row for something that is not a session.
//
// Nothing is lost by skipping. The parent's own checkpoint sweeps subagent rollouts end to end, so
// the agent's tokens and its git-boundary attribution are billed there.
//
// It is also what keeps an unmeasured fan-out from costing anything: see shouldHeartbeat.
if (input.agent_id) process.exit(0);

// Two reasons to run the engine, and they are not the same reason.
//
// A BRANCH BOUNDARY — commit / switch / checkout — has to attribute the window before the branch
// moves underfoot. That is what this hook has always done.
//
// THE HEARTBEAT INTERVAL ELAPSING (G-3-2) is the new one. A long turn fires no Stop for hours, so
// without it the turn's tokens, timeline and queued rows all wait for a turn end that a mid-turn
// kill will never deliver. lib/timing.mjs is three local modules and four node builtins deep, so
// this gate stays at roughly bare node startup; the 28-module engine is still imported only past
// it. Almost every firing is one stat() and an exit.
//
// The boundary is checked FIRST and short-circuits the claim: a session that commits every few
// minutes must not also pay for a redundant heartbeat, so the boundary path stamps the marker
// instead of claiming it. The marker therefore means "time since the last checkpoint of this
// session" — scripts/stop.mjs stamps it at turn end for the same reason.
const boundary = shellCommandsOf(input).some(isGitCheckpointCommand);
const heartbeat = boundary ? false : shouldHeartbeat(input);
if (!boundary && !heartbeat) process.exit(0);
// Imported past the guard on purpose: this hook is registered against every tool call (Codex's
// shell tool has a different name on each of its two surfaces, so the matcher cannot be narrowed
// yet), and the checkpoint engine pulls in ~28 modules that all but a few invocations discard.
//
// Async IIFE, not top-level await: top-level await is Node 14.8+, past this plugin's 13.2 floor
// and banned by the gate. The catch below is what a rejected top-level await did.
(async () => {
  // R1's guard, imported HERE rather than at the top for the same reason the engine is: it reaches
  // the lock primitive, the credential store and the data root, and this hook is registered against
  // every tool call. Past the gates above, the process is already paying for the engine. R-numbers
  // cite docs/plans/2026-09-10-sections/REVIEW.md.
  const { hookMayProceed } = await import('../lib/env-guard.mjs');
  if (!hookMayProceed()) return exitClean(0);
  const { runCheckpoint, HOOK_BUDGET_MS } = await import('../lib/checkpoint.mjs');
  // Same budget as the Stop hook: this path flushes the queue too, and it is registered against
  // every tool call, so an overrun here fails a hook in the middle of the user's work.
  //
  // emitTimeline on the HEARTBEAT path only, and it is the whole point of the heartbeat: it stands
  // in for a Stop that may never come, so it must ship what a turn end ships — the one flag drives
  // the subagent sweep, the timeline POST and the rate-limit drain. Measured on this machine, Node
  // v24.11.1, so the 17.5 s budget is a real bound rather than a hope: the sweep is 22 ms filtered
  // to the session start (456 ms over all 204 local rollouts unfiltered, and capped at
  // maxReads = 500 file opens), computeDelta over the largest local rollout — 12.2 MB, 1306 lines
  // — is 231 ms, and computeSessionTimeline over the same file is 165 ms. Everything after that is
  // network and already deadline-bounded inside runCheckpoint.
  //
  // The boundary path keeps its existing behaviour exactly: no timeline, no drain, no sweep.
  runCheckpoint(input, {}, { budgetMs: HOOK_BUDGET_MS, emitTimeline: heartbeat })
    .then(result => { if (result.outcome === 'committed') touchHeartbeat(input.session_id); })
    .catch(() => {})
    .finally(() => exitClean(0));
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
