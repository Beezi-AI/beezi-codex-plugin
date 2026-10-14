import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// Rules, New folders, the routes pass and the read workspace; every decision is lib/workspace-cli.mjs's.
async function main() {
  // Gate first: rule and New folders changes write the index and session state.
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const result = await workspaceCommand(process.argv.slice(2));
  for (const line of result.lines) console.log(line);
  for (const line of result.stderr) console.error(line);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
