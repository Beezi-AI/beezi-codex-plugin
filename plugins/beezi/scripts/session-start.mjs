import { readHookInput } from '../lib/hook-input.mjs';
import { runSessionStart } from '../lib/session-start.mjs';
import { hookMayProceed, environmentNotice } from '../lib/env-guard.mjs';

const input = readHookInput();
if (!input) process.exit(0);

// The production cutover guard (R1). SessionStart is the first hook of every session and the only
// one with a channel back to the user, so this is where the migration actually happens and where
// its notice — or its refusal — is shown. Every other entry point gets the memoized answer.
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
const proceed = hookMayProceed();
const notice = environmentNotice();

function say(message) {
  if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
}

if (!proceed) {
  say(notice);
  process.exit(0);
}

runSessionStart(input)
  .then((msg) => {
    // Both can be present: a session that migrated this run still has its own status to report.
    if (notice && msg) say(`${notice}\n\n${msg}`);
    else say(notice || msg);
  })
  .catch(() => { say(notice); })
  .finally(() => process.exit(0));
