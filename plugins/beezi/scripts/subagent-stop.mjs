import { readHookInput } from '../lib/hook-input.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
if (!input.session_id || !input.agent_id) process.exit(0);
// Codex re-fires Stop hooks on a blocked turn; this flag marks the re-entry. Nothing here is
// idempotency-sensitive, but there is also nothing new to record on a second pass.
if (input.stop_hook_active === true) process.exit(0);

// Like subagent-start, this only records — it does not ingest. The parent's checkpoint bills every
// subagent from one process, which is what keeps the wall-clock union deterministic and the state
// writes uncontended. See lib/checkpoint.mjs.
//
// What this hook uniquely contributes: `agent_transcript_path`, which is authoritative and saves the
// parent a directory scan, and `agent_type`, which exists ONLY on the hook payload — the rollout
// itself carries a nickname and a role, never the task name the model chose.
// Async IIFE, not top-level await: top-level await is Node 14.8+, past this plugin's 13.2 floor
// and banned by the gate. The catch below is what a rejected top-level await did.
(async () => {
  // Identity is written into the data root, so it waits on lib/env-guard.mjs like every other
  // writer. Imported dynamically, like the module below it, to keep this hook at bare node startup.
  const { hookMayProceed } = await import('../lib/env-guard.mjs');
  if (!hookMayProceed()) return exitClean(0);
  const { writeAgent } = await import('../lib/subagent-state.mjs');
  try {
    writeAgent(input.session_id, input.agent_id, {
      agent_type: typeof input.agent_type === 'string' ? input.agent_type : undefined,
      transcriptPath: typeof input.agent_transcript_path === 'string' ? input.agent_transcript_path : undefined,
      ended_at: new Date().toISOString(),
    });
  } catch { /* best-effort: a hook must never fail the turn */ }

  exitClean(0);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
