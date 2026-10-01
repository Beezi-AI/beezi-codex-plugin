import { renderList } from '../lib/accounts-cli.mjs';
import { logoutAccount, logoutAll, NOTHING_TO_DO } from '../lib/logout.mjs';
import { listAccounts, resolveAccountRef } from '../lib/accounts.mjs';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// A thin wrapper: parse the flags, call ONE lib/logout.mjs function, print its lines. Every
// decision that matters — which session unlinks which account, what is deleted, what is left
// alone — is in lib/logout.mjs, where it can be tested without spawning a process.

function parseArgs(argv) {
  const flags = { list: false, all: false, account: null, nextDefault: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') { flags.list = true; continue; }
    if (arg === '--all') { flags.all = true; continue; }
    if (arg === '--account') {
      i += 1;
      if (i >= argv.length) throw new UserError('--account needs a value: a key, an email, or a position from the accounts skill.');
      flags.account = argv[i];
      continue;
    }
    if (arg === '--next-default') {
      i += 1;
      if (i >= argv.length) throw new UserError('--next-default needs a value: a key, an email, or a position from the accounts skill.');
      flags.nextDefault = argv[i];
      continue;
    }
    throw new UserError(`Unknown option "${arg}". logout.mjs takes --list, --account <account>, --next-default <account> and --all.`);
  }
  if (flags.all && flags.account !== null) {
    throw new UserError('--all logs out every account, so it cannot be combined with --account.');
  }
  if (flags.all && flags.nextDefault !== null) {
    throw new UserError('--all leaves no account to be the default, so it cannot be combined with --next-default.');
  }
  return flags;
}

function print(result) {
  for (const line of result.lines) console.log(line);
  // A partial --all used to exit non-zero because logoutAll threw. It no longer throws — it reports
  // every account instead — so the exit code has to be set here, or the only signal that some
  // accounts were left behind would be the text.
  if (result.failed && result.failed.length > 0) process.exitCode = 1;
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const flags = parseArgs(process.argv.slice(2));
  // --list is offline by construction: renderList resolves no token and makes no request.
  if (flags.list) {
    console.log(await renderList());
    return;
  }
  if (flags.all) {
    print(await logoutAll());
    return;
  }

  const accounts = await listAccounts();
  if (accounts.length === 0) {
    console.log(NOTHING_TO_DO);
    return;
  }

  // Both refs are resolved BEFORE anything is removed. A position names a row in the list as it
  // stands, and removing an account renumbers every row after it — resolving --next-default
  // afterwards would make the default land on the wrong account.
  let key;
  if (flags.account !== null) {
    key = await resolveAccountRef(flags.account);
  } else if (accounts.length === 1) {
    key = accounts[0].key;
  } else {
    console.log(await renderList());
    console.log('');
    console.log('Several Beezi accounts are linked. Choose one with --account <number>, or log every one out with --all.');
    return;
  }
  const nextDefault = flags.nextDefault === null ? null : await resolveAccountRef(flags.nextDefault);
  print(await logoutAccount(key, { nextDefault }));
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
