import { readHookInput, isGitCheckpointCommand, shellCommandsOf } from '../lib/hook-input.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
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
