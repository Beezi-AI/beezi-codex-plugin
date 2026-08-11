import { apiBase } from './config.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { hooksStatus as _hooksStatus, installCommand } from './hooks-install.mjs';

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

// { state, account, apiBase, hooks } — `hooks` is the analytics-reporting half of the answer,
// because "linked" alone never explains why no analytics are arriving.
export async function linkStatus(deps = {}) {
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const whoami = deps.whoami ?? _whoami;
  const base = deps.apiBase ?? apiBase();

  const token = await getAccessToken().catch(() => null);
  if (!token) return { state: LinkState.NOT_LINKED, account: null, apiBase: base, hooks: hooks(deps) };

  const who = await whoami(token, { base });
  if (who === null) return { state: LinkState.UNREACHABLE, account: null, apiBase: base, hooks: hooks(deps) };
  if (!who.valid) return { state: LinkState.REVOKED, account: null, apiBase: base, hooks: hooks(deps) };

  return {
    state: LinkState.LINKED,
    account: who.name || who.email || null,
    apiBase: base,
    hooks: hooks(deps),
    // The full whoami verdict rides along so the already-linked login path can refresh the
    // tracking cache (trackingMode / backfillCompleted) without a second round trip.
    who,
  };
}

// Never let a hook-registry read break a link check — the two are independent failures.
function hooks(deps) {
  const read = deps.hooksStatus ?? _hooksStatus;
  try {
    const s = read();
    return { state: s.state, registered: s.registered };
  } catch {
    return { state: 'unknown', registered: [] };
  }
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
      return `Could not reach Beezi at ${status.apiBase} to check the link. Check the connection, or BEEZI_API_URL if that address is wrong.`;
    default:
      return 'This machine is not linked to Beezi. Sign in to link it.';
  }
}

// Analytics need both halves: a link and trusted hooks. Returns null when there is nothing to say.
export function describeReporting(status) {
  if (status.state === LinkState.NOT_LINKED) {
    return 'Analytics are NOT being reported — this machine is not linked.';
  }
  if (status.state === LinkState.REVOKED) {
    return 'Analytics are NOT being reported — this machine’s link was revoked.';
  }
  // Unreachable says nothing about the link itself: the credentials may be perfectly good and the
  // hooks may be reporting fine from a process that can see the API. Claiming "not linked" here is
  // what made a status check and the sign-in tool look like they disagreed.
  if (status.state === LinkState.UNREACHABLE) {
    return 'Could not verify the link, so whether analytics are reporting is unknown. Queued reports are retried automatically once the API is reachable.';
  }
  switch (status.hooks.state) {
    case 'installed':
      return 'Analytics hooks are installed. If nothing is arriving, run /hooks in Codex and trust the Beezi entries — Codex will not run a hook it has not been shown.';
    case 'absent':
      return `Analytics are NOT being reported: the hooks are not installed. Run ${installCommand()}, then run /hooks in Codex and trust them.`;
    case 'stale':
      return `Analytics are NOT being reported: the hooks point at an older plugin version. Run ${installCommand()}, then re-trust via /hooks.`;
    case 'partial':
      return `Analytics may not be reported: the hook install is incomplete. Run ${installCommand()}, then re-trust via /hooks.`;
    default:
      return null;
  }
}
