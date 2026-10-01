import {
  linkStatus as _linkStatus, describeLink, describeReporting, LinkState, NO_DEFAULT_ACCOUNT,
} from './link-status.mjs';
import { AccountStatus, describeAccount } from './accounts.mjs';
import { readTrackingState } from './tracking.mjs';
import { ensureHooks as _ensureHooks, TRUST_STEP } from './hooks-install.mjs';
import { orDefault } from './compat.mjs';

// The `me` report, one line per thing the user came to find out.
//
// It lives here so the multi-account output is testable in-process: a script that both composed
// and printed it could only be checked by spawning it, and tools/hermetic-env.mjs guards
// child_process. scripts/me.mjs is the wrapper.
//
// TWO LEVELS, deliberately. The accounts are per account; the hook verdict is per MACHINE and
// prints once, because ~/.codex/hooks.json is one registry for the whole install and repeating it
// under three accounts would read as three separate problems.

// "Why is nothing being tracked?" is what brings a user here, and the answer used to be a command
// to go and run. Fix it instead, then report. A healthy install is not rewritten — see ensureHooks
// on why that matters for trust — so this is a no-op on every run but the one that needed it.
//
// LINKED MACHINES ONLY, the same rule the MCP bridge follows: nothing writes hook entries on behalf
// of someone who has never signed in. Login installs them at the moment analytics are asked for.
//
// Never lets a hook repair fail a status read: the two are independent, and the link half of the
// answer is still worth printing when the registry cannot be written.
function healHooks(deps) {
  try {
    const result = orDefault(deps.ensureHooks, _ensureHooks)();
    if (result.repaired) {
      return `  Analytics hooks were ${result.before === 'absent' ? 'installed' : 'repaired'} just now — to finish, ${TRUST_STEP}.`;
    }
    // A launcher-only refresh changes no registry entry, so no re-trust is owed — but the hook
    // state printed above was captured before the file came back, and this line reconciles it.
    if (result.launcherRefreshed) return '  The hook launcher was refreshed just now — no re-trust needed.';
    return null;
  } catch (error) {
    return null;
  }
}

// The tenant facts worth printing. The LIVE whoami verdict wins when there is one — linkStatus
// carries it on `who` for exactly this reason — and the cached tracking state is the fallback, so
// an account whose token could not be renewed still reports the last plan and mode it saw.
function facts(account, deps) {
  const who = account.who;
  if (who) {
    return {
      tier: orDefault(who.tenantTier, null),
      mode: orDefault(who.trackingMode, null),
      done: who.backfillCompleted === true,
    };
  }
  const cached = readTrackingState(account.key, deps);
  if (!cached) return { tier: null, mode: null, done: false };
  return {
    tier: orDefault(cached.tenantTier, null),
    mode: orDefault(cached.trackingMode, null),
    done: cached.backfillCompleted === true,
  };
}

const SIGN_IN_AGAIN = 'run the login skill and sign in as this account';

// One account's second line, or null when there is nothing to add.
function detail(account, deps) {
  // The row's own status is checked FIRST. A revoked grant has had its credentials deleted, so the
  // token layer answers 'unlinked' for it — identical to an account that never stored any.
  if (account.status === AccountStatus.REVOKED) return `revoked — ${SIGN_IN_AGAIN}.`;
  if (account.state === LinkState.REVOKED) return `revoked — ${SIGN_IN_AGAIN}.`;
  if (account.state === LinkState.NOT_LINKED) return `expired, ${SIGN_IN_AGAIN}.`;
  if (account.state === LinkState.UNREACHABLE) {
    return 'could not be checked just now — the saved link is preserved, retry shortly.';
  }
  const f = facts(account, deps);
  return `plan ${orDefault(f.tier, 'not recorded')}`
    + ` · tracking ${orDefault(f.mode, 'not recorded')}`
    + ` · history import ${f.done ? 'complete' : 'not finished'}`;
}

function accountBlock(account, position, defaultKey, deps) {
  const marker = account.key === defaultKey ? '  (default — analytics read from this one)' : '';
  const lines = [`  ${position}. ${describeAccount(account)} [${account.key}]${marker}`];
  const second = detail(account, deps);
  if (second !== null) lines.push(`     ${second}`);
  return lines;
}

/**
 * The whole report as an array of lines. scripts/me.mjs prints them and adds nothing.
 *
 * `deps` is handed straight to linkStatus, which accepts seams for every part of the answer
 * (listAccounts, getDefaultKey, getAuthentication, whoami, hooksStatus, apiBase) — so a test drives
 * the whole report without a network, a keyring or a hook registry.
 *
 * SERIAL, inside linkStatus, and it has to be: getAuthentication takes
 * sharedLock('token-refresh-<key>') when it renews, rank 3 in LOCK_ORDER, and two rank-3 locks
 * under different names at once in one process are refused as 'lock-order'. Resolving the accounts
 * concurrently would make every simultaneously-expiring account after the first report as
 * unreachable.
 */
export async function meLines(deps = {}) {
  const status = await orDefault(deps.linkStatus, _linkStatus)(deps);
  const accounts = orDefault(status.accounts, []);
  const anyLinked = accounts.some((one) => one.state === LinkState.LINKED);
  const healed = anyLinked ? healHooks(deps) : null;

  const lines = [];
  if (accounts.length === 0) {
    lines.push(`• Beezi: ${describeLink(status)}`);
  } else {
    lines.push(`${anyLinked ? '✓' : '•'} Beezi: ${accounts.length} account${accounts.length === 1 ? '' : 's'} `
      + 'linked. The analytics skill reads from the default.');
    lines.push(`  API: ${status.apiBase}`);
    for (let i = 0; i < accounts.length; i += 1) {
      for (const line of accountBlock(accounts[i], i + 1, status.defaultKey, deps)) lines.push(line);
    }
    if (status.defaultKey === null) {
      lines.push(`  ${NO_DEFAULT_ACCOUNT}`);
    }
  }

  // The reporting verdict is MACHINE-level and prints once. `state` is raised to LINKED when ANY
  // account is, because "is anything being reported" is true as soon as one account can report —
  // the blocks above have already named the accounts that cannot, and collapsing them into one
  // machine-wide "not reporting" is the hiding this report exists to stop.
  const reporting = describeReporting(anyLinked ? { ...status, state: LinkState.LINKED } : status);
  if (reporting) lines.push(`  ${reporting}`);
  if (healed) lines.push(healed);
  return lines;
}
