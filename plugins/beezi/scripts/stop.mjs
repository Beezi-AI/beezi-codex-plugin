import { readHookInput } from '../lib/hook-input.mjs';
import { runCheckpoint, HOOK_BUDGET_MS } from '../lib/checkpoint.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// Turn-end: emit the whole-session activity timeline alongside the segment checkpoint.
// budgetMs, because this is the hook that flushes the queue: a backlog against a stalled API costs
// one per-request timeout per report, and Codex kills — and reports as failed — a hook that
// overruns its registered timeout. Whatever does not fit stays queued for the next turn.
runCheckpoint(input, {}, { emitTimeline: true, budgetMs: HOOK_BUDGET_MS })
  .catch(() => {})
  .finally(() => exitClean(0));
