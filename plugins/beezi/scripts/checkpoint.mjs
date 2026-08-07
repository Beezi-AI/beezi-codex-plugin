import { readHookInput, isGitCheckpointCommand, shellCommandsOf } from '../lib/hook-input.mjs';
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
if (input.agent_id) process.exit(0);
// Only checkpoint on branch-boundary git commands (commit / switch / checkout) — those are the
// moments a session's token deltas need attributing before the branch changes underfoot.
if (!shellCommandsOf(input).some(isGitCheckpointCommand)) process.exit(0);
// Imported past the guard on purpose: this hook is registered against every tool call (Codex's
// shell tool has a different name on each of its two surfaces, so the matcher cannot be narrowed
// yet), and the checkpoint engine pulls in ~28 modules that all but a few invocations discard.
const { runCheckpoint, HOOK_BUDGET_MS } = await import('../lib/checkpoint.mjs');
// Same budget as the Stop hook: this path flushes the queue too, and it is registered against
// every tool call, so an overrun here fails a hook in the middle of the user's work.
runCheckpoint(input, {}, { budgetMs: HOOK_BUDGET_MS }).catch(() => {}).finally(() => exitClean(0));
