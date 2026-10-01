import { renderList, useAccount } from '../lib/accounts-cli.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

const USAGE = 'Usage: accounts.mjs [list|use <account>]';

// An async main(), not top-level await: the Node 13.2 floor bans top-level await outright, and
// every other script in this repo is shaped the same way.
async function main() {
  // Every CLI entry point gates on this FIRST. A script that skips it can write into the wrong
  // environment's root while an environment migration is in flight — and `use` writes the index.
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  const command = argv.length === 0 ? 'list' : argv[0];
  if (command === 'list') {
    console.log(await renderList());
    return;
  }
  if (command === 'use') {
    const result = await useAccount(argv[1]);
    for (const line of result.lines) console.log(line);
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
