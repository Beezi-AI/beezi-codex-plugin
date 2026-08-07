import { readHookInput } from '../lib/hook-input.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
if (!input.session_id || !input.agent_id) process.exit(0);

// Records identity only. The agent's usage is billed by the parent's own checkpoint, which sweeps
// subagent rollouts — so this hook never reads a token, opens a socket, or parses a transcript.
//
// Note what is NOT here: SubagentStart carries no `agent_transcript_path` (that field is
// SubagentStop's), and its `transcript_path` is the PARENT's. Handing that to the transcript
// resolver as if it were the child's would bill the parent's work to the agent.
//
// Worth recording even though SubagentStop will record more: an agent killed mid-flight — the user
// hits Esc, the process dies — never fires a Stop, and this is then the only evidence it ran.
const { writeAgent } = await import('../lib/subagent-state.mjs');
try {
  writeAgent(input.session_id, input.agent_id, {
    agent_type: typeof input.agent_type === 'string' ? input.agent_type : undefined,
    started_at: new Date().toISOString(),
  });
} catch { /* best-effort: a hook must never fail the turn */ }

exitClean(0);
