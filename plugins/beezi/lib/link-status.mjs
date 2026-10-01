import { apiBase } from './config.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { listAccounts as _listAccounts, getDefaultKey as _getDefaultKey } from './accounts.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { hooksStatus as _hooksStatus, statusCommand } from './hooks-install.mjs';
import { orDefault } from './compat.mjs';

// One answer to "is this machine linked, and is it reporting?".
//
// It exists because there used to be three. `performLogin` asked getCredentials() (raw read, no
// refresh), me.mjs asked getAccessToken() (refresh-aware, wipes on invalid_grant), and each phrased
// the outcome differently — so the MCP tool could say "already linked" in the same minute a script
// said "not linked". Worse, the two run in different environments: the MCP server is spawned by
// Codex and inherits BEEZI_API_URL, while a script the model runs through the shell tool may not,
// leaving them pointed at different APIs with the same credentials. Every answer therefore carries
// the `apiBase` it was computed against, so a disagreement is visible instead of baffling.

export const LinkState = Object.freeze({
  LINKED: 'linked',
  NOT_LINKED: 'not_linked',
  REVOKED: 'revoked',
  UNREACHABLE: 'unreachable',
});

// One account's verdict, in the same vocabulary the whole machine used to be described in.
//
// `key`, `email`, `name` and `tenantName` come off the index row; `state`, `authState`, `account`
// and `who` are what this function establishes. The whoami runs against the account's OWN session
// — bearer and client id together — because a client id borrowed from another account names the
// wrong machine row on a linked-machines page.
async function accountStatus(row, base, deps) {
  const getAccessToken = deps.getAccessToken || _getAccessToken;
  const whoami = deps.whoami || _whoami;
  const identity = { key: row.key, email: orDefault(row.email, null),
    name: orDefault(row.name, null), tenantName: orDefault(row.tenantName, null),
    // The INDEX row's own status rides along because the token layer cannot reproduce it:
    // markAccountRevoked deletes the credentials and THEN marks the row, so on the next read a
    // revoked grant and an account that never had credentials both answer 'unlinked'. Without
    // this field `me` would have to call them the same thing.
    status: orDefault(row.status, null) };

  const auth = deps.getAccessToken && !deps.getAuthentication
    ? { accessToken: await getAccessToken(row.key, deps).catch(() => null), state: 'unlinked' }
    : await (deps.getAuthentication || _getAuthentication)(row.key, deps)
      .catch(() => ({ state: 'unavailable' }));
  const token = auth.accessToken;
  if (!token) {
    const state = auth.state === 'unlinked' ? LinkState.NOT_LINKED
      : auth.state === 'reauth_required' ? LinkState.REVOKED : LinkState.UNREACHABLE;
    return { ...identity, state, authState: auth.state, account: null };
  }

  const who = await whoami({ token, clientId: orDefault(row.clientId, null) }, { base });
  if (who === null) return { ...identity, state: LinkState.UNREACHABLE, account: null };
  if (!who.valid) return { ...identity, state: LinkState.REVOKED, account: null };
  return {
    ...identity,
    state: LinkState.LINKED,
    account: who.name || who.email || null,
    // The full whoami verdict rides along so the already-linked login path can refresh the
    // tracking cache (trackingMode / backfillCompleted) without a second round trip.
    who,
  };
}

// { state, account, apiBase, hooks, accounts, defaultKey } — `hooks` is the analytics-reporting
// half of the answer, because "linked" alone never explains why no analytics are arriving.
//
// `accounts` is every linked account's verdict in the same vocabulary; the TOP-LEVEL fields
// describe the DEFAULT one, so every existing reader of `state`/`account` keeps getting the answer
// it has always got on a single-account machine. There is no aggregate state, deliberately: "this
// machine is linked" stopped being one fact the moment two workspaces could be linked at once, and
// collapsing three accounts into one verdict would hide the revoked one.
export async function linkStatus(deps = {}) {
  const base = deps.apiBase || apiBase();
  const listAccounts = deps.listAccounts || _listAccounts;
  const getDefaultKey = deps.getDefaultKey || _getDefaultKey;

  let rows = [];
  try { rows = orDefault(await listAccounts(deps), []); } catch { rows = []; }
  let defaultKey = null;
  try { defaultKey = orDefault(await getDefaultKey(deps), null); } catch { defaultKey = null; }

  // SERIAL: getAuthentication takes `shared:token-refresh-<key>` when it renews, rank 3, and two
  // rank-3 locks under different names at once in one process is refused as 'lock-order'. This is
  // a foreground command, so there is nothing to gain by racing them anyway.
  const accounts = [];
  for (const row of rows) accounts.push(await accountStatus(row, base, deps));

  const preferred = accounts.find((one) => one.key === defaultKey);
  const primary = preferred === undefined ? orDefault(accounts[0], null) : preferred;
  if (primary === null) {
    return { state: LinkState.NOT_LINKED, authState: null, account: null,
      apiBase: base, hooks: hooks(deps), accounts, defaultKey };
  }
  return { ...primary, apiBase: base, hooks: hooks(deps), accounts, defaultKey };
}

// Never let a hook-registry read break a link check — the two are independent failures.
//
// `broken` rides along with `state` because the two answer different questions and a machine can
// be in the worst combination of both: `state: 'installed'` while other entries in the same
// registry fail on every session. That combination is not hypothetical — it is the one measured on
// a live machine, and it is why this reader cannot go on returning `state` alone.
function hooks(deps) {
  const read = deps.hooksStatus || _hooksStatus;
  try {
    const s = read();
    return { state: s.state, registered: s.registered, broken: s.broken || [] };
  } catch {
    return { state: 'unknown', registered: [], broken: [] };
  }
}

/**
 * The one sentence about dead registry entries, or null.
 *
 * Separate from the `state` switch below because it is ORTHOGONAL to it: a dead entry fails its
 * spawn whether or not this machine is linked, and whether or not OUR OWN hooks are healthy. The
 * `installed` branch used to be the end of the conversation, which is exactly how a user could be
 * told "hooks are installed, trust them" while three entries had been failing every session for
 * weeks.
 */
function describeBrokenHooks(status) {
  const broken = status.hooks && status.hooks.broken ? status.hooks.broken : [];
  if (!broken.length) return null;

  const events = [];
  for (const entry of broken) {
    if (events.indexOf(entry.event) === -1) events.push(entry.event);
  }
  const plural = broken.length === 1 ? 'entry points' : 'entries point';
  return `Separately: ${broken.length} registered hook ${plural} at a file that no longer exists`
    + ` (${events.join(', ')}), so Codex reports those events as failed on every session.`
    + ` These are removed automatically the next time the hooks are installed or repaired;`
    + ` ${statusCommand()} lists the paths.`;
}

/**
 * True when the index holds rows and not one of them can report.
 *
 * The top-level `state` is the DEFAULT account's verdict and says nothing about the others, so on a
 * machine with rows it can read NOT_LINKED while the machine is plainly linked. Both sentences
 * below then said "this machine is not linked" — which lib/mcp-bridge.mjs contradicted in the same
 * breath (refusalFor answers DEFAULT_UNUSABLE_MESSAGE for exactly this machine) and which lib/me.mjs
 * printed directly under its own "N accounts linked" header.
 *
 * LINKED is the only state that means "a token was produced and the portal accepted it", so its
 * absence across every row is what "none can report" rests on.
 */
function noAccountCanReport(status) {
  const accounts = orDefault(status.accounts, []);
  return accounts.length > 0 && !accounts.some((one) => one.state === LinkState.LINKED);
}

// The single phrasing of each outcome, so the MCP tool, the CLI script and the session banner
// cannot drift apart — and so none of them names a slash command Codex does not have.
export function describeLink(status) {
  switch (status.state) {
    case LinkState.LINKED:
      return `This machine is linked to Beezi${status.account ? ` as ${status.account}` : ''} (API: ${status.apiBase}).`;
    case LinkState.REVOKED:
      return `This machine's Beezi link was revoked (API: ${status.apiBase}). Sign in again to re-link.`;
    case LinkState.UNREACHABLE:
      if (status.authState) return 'Beezi authentication is temporarily unavailable or refreshing. Retry shortly; your saved link has been preserved.';
      return `Could not reach Beezi at ${status.apiBase} to check the link. Check the connection, or BEEZI_API_URL if that address is wrong.`;
    default:
      if (noAccountCanReport(status)) {
        return `No Beezi account linked on this machine can report just now (API: ${status.apiBase}). Sign in again to re-arm one.`;
      }
      return 'This machine is not linked to Beezi. Sign in to link it.';
  }
}

// "Accounts are linked but none of them is the default", in one phrasing for the same reason as
// the switch above: lib/me.mjs prints it as its own line and the bridge's beezi_status appends it
// to a lead-in, and the two had drifted into two sentences for one outcome.
//
// lib/accounts-cli.mjs keeps its own wording deliberately: that output IS the accounts skill, so a
// remedy naming the accounts skill would send the reader where they already are.
export const NO_DEFAULT_ACCOUNT =
  'No default is set — run the accounts skill to choose which account analytics read from.';

// Analytics need both halves: a link and trusted hooks. Returns null when there is nothing to say.
//
// Every branch runs its verdict through `withBroken`, so the dead-entry warning reaches the MCP
// tool, the CLI and the session banner by construction rather than by three call sites remembering
// to ask — the same reason the phrasings live here in the first place.
export function describeReporting(status) {
  const dead = describeBrokenHooks(status);
  const withBroken = (line) => {
    if (!dead) return line;
    return line ? `${line} ${dead}` : dead;
  };

  if (status.state === LinkState.NOT_LINKED) {
    return withBroken(noAccountCanReport(status)
      ? 'Analytics are NOT being reported — no Beezi account linked on this machine can report just now.'
      : 'Analytics are NOT being reported — this machine is not linked.');
  }
  if (status.state === LinkState.REVOKED) {
    return withBroken('Analytics are NOT being reported — this machine’s link was revoked.');
  }
  // Unreachable says nothing about the link itself: the credentials may be perfectly good and the
  // hooks may be reporting fine from a process that can see the API. Claiming "not linked" here is
  // what made a status check and the sign-in tool look like they disagreed.
  if (status.state === LinkState.UNREACHABLE) {
    return withBroken('Could not verify the link, so whether analytics are reporting is unknown. Queued reports are retried automatically once the API is reachable.');
  }
  switch (status.hooks.state) {
    case 'installed':
      return withBroken('Analytics hooks are installed. If nothing is arriving, run /hooks in Codex and trust the Beezi entries — Codex will not run a hook it has not been shown.');
    // The three unhealthy states name no command for the user to run. Every surface that reads
    // this — the MCP status tool, the `me` script, the session banner — repairs the install itself
    // before it reports, so quoting an install command here would hand the user a step that has
    // already been taken. What is left is the trust step, which genuinely cannot be automated.
    case 'absent':
      return withBroken('Analytics are NOT being reported: the hooks are not installed. Beezi installs them for you — then run /hooks in Codex and trust the Beezi entries.');
    case 'stale':
      // `stale` no longer means "an upgrade moved the plugin" — the entries name a fixed launcher,
      // so an upgrade leaves them alone. It now means entries written by a version that registered
      // the plugin path directly, which is a one-off migration and a one-off re-trust.
      return withBroken('Analytics are NOT being reported: the hooks were registered by an older plugin version. Beezi rewrites them for you — then re-trust via /hooks, once.');
    case 'partial':
      return withBroken('Analytics may not be reported: the hook install is incomplete. Beezi repairs it for you — then re-trust via /hooks.');
    default:
      return withBroken(null);
  }
}
