import { settingsLines } from '../lib/settings-cli.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// A thin wrapper. The screen and every section are composed in lib/settings-cli.mjs, where they can
// be tested in-process.

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  for (const line of await settingsLines(process.argv[2])) console.log(line);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
