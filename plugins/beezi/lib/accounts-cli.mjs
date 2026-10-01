import {
  AccountStatus, listAccounts, getDefaultKey, setDefault, resolveAccountRef, describeAccount,
} from './accounts.mjs';

// What the `accounts` skill shows and changes: the list of linked accounts, and which one the
// analytics tools read from.
//
// It lives here rather than in scripts/accounts.mjs for the reason every other flow in this plugin
// does: tools/hermetic-env.mjs guards child_process, so a test that spawned the script would prove
// the sandbox works and nothing about the listing. The script parses argv, calls one of these two
// functions, and prints.
//
// BOTH FUNCTIONS ARE OFFLINE. Neither resolves a token, reads the credential store or makes a
// request — the index is the whole source. That matters because the commonest reason to run
// `accounts` is that something is already wrong with a link, and a listing that needed a working
// bearer would fail exactly when it is most needed.

// The one phrasing of "the default you just chose cannot report". BOTH surfaces reach it —
// `accounts use <revoked>` here, and `logout --next-default <revoked>` in lib/logout.mjs — and the
// accounts and logout skills both branch on it, so a second spelling would leave one of them
// relaying a sentence nothing prints.
export const REVOKED_DEFAULT_NOTE =
  'That account\'s access was revoked, so it cannot report until you run the login skill and sign in as it.';

export async function renderList(deps = {}) {
  const accounts = await listAccounts(deps);
  const def = await getDefaultKey(deps);
  if (accounts.length === 0) return 'No Beezi accounts are linked on this machine.';
  const lines = [`Beezi: ${accounts.length} account${accounts.length === 1 ? '' : 's'} `
    + 'linked. The default is the account the analytics skill reads from.'];
  for (let i = 0; i < accounts.length; i += 1) {
    const a = accounts[i];
    const marks = [];
    if (a.key === def) marks.push('default');
    if (a.status === AccountStatus.REVOKED) marks.push('revoked');
    const suffix = marks.length === 0 ? '' : `  (${marks.join(', ')})`;
    lines.push(`  ${i + 1}. ${describeAccount(a)} [${a.key}]${suffix}`);
  }
  if (def === null) {
    lines.push('  No default is set — analytics have no account to read from until one is chosen.');
  }
  return lines.join('\n');
}

export async function useAccount(ref, deps = {}) {
  // Resolved against the list as it stands, which is why a position is safe here and not across a
  // removal: nothing below changes the ordering.
  const key = await resolveAccountRef(ref, deps);
  await setDefault(key, deps);
  const accounts = await listAccounts(deps);
  const account = accounts.find((a) => a.key === key);
  const lines = [`Analytics now read from ${describeAccount(account)}.`];
  // setDefault checks index MEMBERSHIP only, so a revoked account can be made the default — and
  // the list printed a moment earlier marked that very row `(revoked)`. Announcing it unqualified
  // would promise reporting the account cannot do.
  if (account && account.status === AccountStatus.REVOKED) lines.push(REVOKED_DEFAULT_NOTE);
  // Tool availability is decided when the MCP session opens, not per request.
  lines.push('If the two workspaces are on different plans, start a new Codex session for the tools to match.');
  // Said every time, because the default is the one thing about multi-account that reads like an
  // on/off switch and is not one.
  lines.push('Every linked account still receives this machine\'s analytics; the default only decides which one is read.');
  return { key, lines };
}
