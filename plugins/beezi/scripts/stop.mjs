import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES, isTelemetryGranted } from '../lib/diagnostics.mjs';
import { touchHeartbeat } from '../lib/timing.mjs';
import { hookMayProceed } from '../lib/env-guard.mjs';

const startedAt = Date.now();
const input = readHookInput();
if (!input) process.exit(0);
// R1: nothing is checkpointed, queued or drained while the data root's environment is unsettled.
// Silent by design — a hook that writes to stderr is reported as a failed hook; SessionStart
// carries the explanation. R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
if (!hookMayProceed()) process.exit(0);
// A turn end IS a checkpoint, so it resets the mid-turn heartbeat window (G-3-2). Without this the
// marker would only ever track heartbeats, and a session whose Stop lands at minute 14 would pay a
// full engine load two minutes into the next turn for a window holding almost nothing. Stamped
// AFTER the run and only on `outcome === 'committed'`: the marker claims a window that was actually
// covered, so a checkpoint that was gated, skipped or failed leaves the old stamp standing and the
// next turn fires an immediate heartbeat — which is the correct outcome for a Stop that did not
// finish.

// Turn-end: emit the whole-session activity timeline alongside the segment checkpoint.
// budgetMs, because this is the hook that flushes the queue: a backlog against a stalled API costs
// one per-request timeout per report, and Codex kills — and reports as failed — a hook that
// overruns its registered timeout. Whatever does not fit stays queued for the next turn.
runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
  const mod = await importHookModule('./checkpoint.mjs');
  if (!mod) return;
  const { runCheckpoint, HOOK_BUDGET_MS } = mod;
  const result = await runCheckpoint(input, {}, { emitTimeline: true, budgetMs: HOOK_BUDGET_MS });
  if (result.outcome === 'committed') touchHeartbeat(input.session_id);
  const deadline = Math.min(startedAt + HOOK_BUDGET_MS - 250, Date.now() + 1000);
  if (Date.now() >= deadline || !isTelemetryGranted() || !hookMayProceed()) return;
  try {
    const { claimFlushWindow, flushDiagnostics } = await import('../lib/telemetry-flush.mjs');
    const { postDiagnostics } = await import('../lib/diagnostics-transport.mjs');
    const { sharedLock, withLock } = await import('../lib/single-instance-lock.mjs');
    if (Date.now() >= deadline) return;
    // Locked for the claim only, as in scripts/mcp.mjs; the claim keeps every other sender out.
    const claim = withLock(sharedLock('diagnostics-flush'), { leaseMs: HOOK_BUDGET_MS }, () => claimFlushWindow());
    if (!claim.ok || !claim.value) return;
    // This hook's own deadline cutting a request short is not a failed delivery: it must not
    // escalate the backoff the MCP server's 5 s attempt shares. A fast transport error still does.
    const budgetCutoff = { status: 0, retryAfterMs: null, body: null, budgetCutoff: true };
    await flushDiagnostics({
      claimedUntil: claim.value,
      postDiagnosticsImpl: async (url, payload, deps) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return budgetCutoff;
        try {
          return await postDiagnostics(url, payload, { ...deps, timeoutMs: Math.min(1000, remaining) });
        } catch (error) {
          if (error && error.name === 'AbortError') return budgetCutoff;
          throw error;
        }
      },
    });
  } catch { /* delivery never fails a hook */ }
});
