import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/diagnostics.mjs';
import { hookMayProceed, environmentNotice } from '../lib/env-guard.mjs';
import { linkedSessions } from '../lib/accounts.mjs';
import { markPendingWorkspace, buildWorkspacePrompt, buildTargetsNotice, buildJoinedPrompt, buildHistoryNotice } from '../lib/workspace-prompt.mjs';
import { maybeStartPendingHistory } from '../lib/history-trigger.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// startup | resume | clear | compact; may be missing on an older Codex.
const source = input.source;

// The production cutover guard (R1). SessionStart is the first hook of every session and the only
// one with a channel back to the user, so this is where the migration actually happens and where
// its notice — or its refusal — is shown. Every other entry point gets the memoized answer.
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
const proceed = hookMayProceed();
const notice = environmentNotice();

function write({ systemMessage = null, additionalContext = null }) {
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  if (additionalContext) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext };
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
}

// Both can be present: a session that migrated this run still has its own status to report.
function withNotice(message) {
  if (notice && message) return `${notice}\n\n${message}`;
  return notice || message;
}

if (!proceed) {
  write({ systemMessage: notice });
  process.exit(0);
}

// Resolved once and shared: the ask and the notice only need to know which accounts can produce a
// token, which runSessionStart has already asked every credential store.
let linked = null;
const deps = {
  linkedSessions: (d) => {
    if (linked == null) linked = linkedSessions(d);
    return linked;
  },
};

async function main() {
  // Bound before any network work, so a killed or failed start still leaves the checkpoint its hold.
  // Independent of lib/session-start.mjs: a failed import below still binds and asks.
  let marked = null;
  try { marked = await markPendingWorkspace(input); } catch { /* the ask is best-effort; the session still starts */ }
  const mod = await importHookModule('./session-start.mjs');
  let message = null;
  let failure = null;
  if (mod) {
    try { message = await mod.runSessionStart(input, deps); } catch (error) { failure = error; }
  }
  // Re-binds with the workspaces runSessionStart just refreshed; asks only on startup or clear.
  // A refused re-bind asks from the first bind's answer rather than dropping the question.
  let joinedPrompt = null;
  let workspacePrompt = null;
  try { joinedPrompt = await buildJoinedPrompt(input, deps); } catch { /* best-effort */ }
  try { workspacePrompt = await buildWorkspacePrompt(input, deps, marked); } catch { /* best-effort */ }
  // The joined re-pick comes first, so the current-folder question sees its answers.
  const additionalContext = [joinedPrompt, workspacePrompt].filter(Boolean).join('\n\n') || null;
  let targetsNotice = null;
  let historyNotice = null;
  if (source !== 'compact') {
    try { targetsNotice = await buildTargetsNotice(input, deps); } catch { /* best-effort */ }
    // Built only when the status line will be written, since building it takes the results.
    if (failure == null) {
      try { historyNotice = await buildHistoryNotice(input, deps); } catch { /* best-effort */ }
      // Awaited: the hook exits once main resolves. Never throws.
      await maybeStartPendingHistory();
    }
  }
  if (failure != null) {
    write({ systemMessage: notice, additionalContext });
    throw failure;
  }
  const status = [message, targetsNotice, historyNotice].filter((part) => part != null && part !== '').join('\n') || null;
  write({ systemMessage: withNotice(status), additionalContext });
}

// A hook that exits non-zero is reported by Codex as failed, so a failure still ends in a clean exit.
runHook(DIAGNOSTIC_SOURCES.SESSION_START, main);
