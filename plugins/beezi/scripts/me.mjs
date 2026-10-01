import { meLines } from '../lib/me.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// A thin wrapper. The report — the account blocks, the machine-level hook verdict, and the hook
// repair that precedes it — is composed in lib/me.mjs, where it can be tested in-process.

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  for (const line of await meLines()) console.log(line);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
