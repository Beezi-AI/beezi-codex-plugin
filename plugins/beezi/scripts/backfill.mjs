import { parseArgs, runAudit, createRunCache, planWorkspaceRuns, dontTrackSessionIds, ACCOUNT_TOKEN_UNUSABLE, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail, plural } from '../lib/cli.mjs';
import { parseAccountFlag, linkedSessions, getAccount, describeAccount } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf, joinedAfterLink } from '../lib/workspace.mjs';
import { usesRules } from '../lib/workspace-rules.mjs';
import { readTrackingState, matchesIdentity } from '../lib/tracking.mjs';
import { startHistoryWorker } from '../lib/history-trigger.mjs';

// The login flow's final step: uploads this machine's past Codex sessions into Beezi. There is
// no standalone skill for it — the login skill runs it after the link and plan capture, and
// running the login skill again resumes an interrupted upload. Flags (--dry-run / --since /
// --force) remain for manual `node scripts/backfill.mjs` runs only.
//
// `--account` is REQUIRED, and it is the one flag with no default. The one-time import is per
// account, and the account it belongs to is the one that has just been linked — which is not
// necessarily the default (a second workspace signing in does not take the default over). Falling
// back to the default would spend one account's single import on another's behalf, and there is no
// way to give it back. The login skill passes the key it just linked.
//
// An account in several workspaces runs once per workspace its rules and New folders reach, each
// under its own heading; `--tenant <workspace[,…]>` overrides that and sends those workspaces every
// past session, unrouted. One workspace's failure does not stop the others.

// The 30-day window is a hard floor, not a resume point: a re-run will not pick these up later,
// so the upload has to say so once rather than leave the user waiting for a run that never comes.
const OLD_SESSIONS_SUFFIX =
  'ran more than 30 days ago — Beezi only imports the last 30 days, and they will not be uploaded later.';
const OLD_SESSIONS_NOTE =
  'Beezi only imports the last 30 days; older sessions will not be uploaded later.';

const DEFERRED_LINE =
  '  Your one-time history upload stays open until those repos and folders have a rule — run the login skill or the sync skill to choose.';

const NOTHING_ROUTED_LINE =
  '  Nothing on this machine goes to this workspace yet, so its one-time history upload stays open.';

// Prints the ✗ line and reports a failed run, so the remaining workspaces still run.
function failed(message) {
  console.error(`✗ ${message}`);
  return 1;
}

// One git cache for the whole process, so every workspace pass reuses the first one's git answers.
const runCache = createRunCache();

// One run — the account's only one, or one workspace's. Returns the exit status instead of exiting
// mid-loop.
async function backfillOne(options) {
  const viaLogin = options.via === 'login';

  const result = await runAudit(
    {
      runCache,
      // "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still
      // produce nothing to upload. Calling it "sent" is what made the final totals look like they
      // had lost sessions when the arithmetic was simply against a different number.
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  // The real count, after the live-session skip the audit already applies — not the pre-run plan,
  // which also counts the live session and sessions still being written.
  if (options.excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${options.excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }

  // Unconditional now, because --account is required: every state that reaches this branch is an
  // account resolveAccountRef already found in the index and whose token could not be produced.
  // "This machine is not linked" was false of all of them — including the login flow's own step 4,
  // which runs seconds after a sign-in.
  if (result.reason === 'no-token') {
    return failed(ACCOUNT_TOKEN_UNUSABLE);
  }
  if (result.reason === 'workspace-required') {
    return failed(
      'Beezi: this account belongs to several workspaces and none was picked for this run. '
      + 'Check where analytics go with the settings skill, then run the login skill again.',
    );
  }
  if (result.reason === 'whoami-failed') {
    return failed(
      `Beezi: could not check this workspace with Beezi (${orDefault(result.lastError, 'unknown error')}), `
      + 'so nothing was uploaded to it. Run the login skill again to retry.',
    );
  }
  if (result.reason === 'account-registration-failed') {
    return failed(
      `Beezi: your current ChatGPT account could not be registered (${orDefault(result.lastError, 'unknown error')}). ` +
        'No history was uploaded or finalized. Run the Beezi login skill again to retry.',
    );
  }

  // The run lock (G-8-3 / R3). These three come back with `scanned === 0` because nothing was
  // scanned, so without them the summary below would tell the user this machine has no past Codex
  // sessions — a false statement about their machine, printed at the end of the login flow.
  if (result.reason === 'run-in-progress') {
    console.log('✓ Beezi: a history upload is already running on this machine — letting it finish.');
    return 0;
  }
  if (result.reason === 'lock-order' || result.reason === 'lock-failed') {
    return failed(`Beezi: could not start the history upload (${orDefault(result.lastError, 'lock error')}).`);
  }
  // Ownership was taken away partway through. Whatever this run delivered is delivered and
  // ledgered; the pull deliberately stays open, so the next login resumes it.
  if (result.halt === BackfillHalt.LOCK_LOST) {
    console.log(
      '✓ Beezi: another history upload took over partway through. Nothing was lost — '
      + 'run the Beezi login skill again once it finishes.',
    );
    return 0;
  }

  // The one-time import has been used — verified against the server before anything was parsed.
  // Inside the login flow this is a normal outcome; a direct/manual run is a rejected request.
  const alreadyUsed =
    result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED;
  if (alreadyUsed) {
    const lines = [
      'Beezi already has the history for this workspace — the one-time import has been used and cannot run again.',
    ];
    if (result.upgradeAdvised) {
      lines.push(
        'Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.',
      );
    }
    if (viaLogin) {
      console.log(`✓ ${lines[0]}`);
      if (lines[1]) console.log(`  ${lines[1]}`);
      return 0;
    }
    return failed(lines.join(' '));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return failed('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return failed('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${orDefault(result.lastError, 'forbidden')}). ` +
        'Check your seat with your workspace admin, then sign in to Beezi again.',
    );
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Codex sessions found to upload.');
    return 0;
  }
  if (result.candidates === 0) {
    const bits = [];
    if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
    if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
    if (result.tooOld > 0) bits.push(`${result.tooOld} older than 30 days`);
    console.log(`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    if (result.tooOld > 0) console.log(`  ${OLD_SESSIONS_NOTE}`);
    if (result.finalized) console.log('✓ Beezi: your history pull is finalized.');
    else if (result.routeDeferred > 0) console.log(DEFERRED_LINE);
    else if (result.nothingRouted) console.log(NOTHING_ROUTED_LINE);
    return 0;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.candidates, 'session')} / ` +
        `${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    return 0;
  }

  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // saying "sign in again to continue" is accurate — the next login's backfill picks them up.
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return failed(
      `Beezi: upload stopped — could not reach the server (${orDefault(result.lastError, 'unknown error')}). ` +
        'Run the Beezi login skill again to continue where it left off.',
    );
  }

  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) parts.push(`${result.liveTracked} were already tracked live.`);
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  // Sessions the server refused outright. Ledgered, so a re-run will not retry them — saying so
  // is the only chance the user has to notice.
  if (result.sessionsRejected > 0) {
    parts.push(
      `${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`,
    );
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run the login skill again to retry them.`,
    );
  }
  console.log(parts.join(' '));

  if (result.tooOld > 0) {
    console.log(`  ${plural(result.tooOld, 'session')} ${OLD_SESSIONS_SUFFIX}`);
  }
  // Every candidate that produced nothing to upload. These used to be invisible: the run said it
  // read N sessions and uploaded fewer, with no account of the difference.
  if (result.empty > 0) {
    console.log(
      `  ${plural(result.empty, 'session')} held no usage data (no assistant tokens recorded) — nothing to upload.`,
    );
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their transcripts record no working directory.',
    );
  }
  if (result.emitFailed > 0) {
    console.log(
      `  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  // The server's stored count against what we actually handed it. A silent shortfall here means
  // reports were acknowledged but not persisted, which nothing else in this summary would show.
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored ` +
        `and ${result.reportsSkipped} skipped by the server.`,
    );
  }

  if (result.finalized) {
    console.log('✓ Beezi: your history pull is finalized.');
  } else if (options.sinceMs != null) {
    console.log('  Scoped run (--since): the pull stays open — a full run (no flags) finalizes it.');
  } else if (result.retriableUnreadable > 0) {
    console.log(
      `  Your history is NOT finalized yet — ${plural(result.retriableUnreadable, 'session')} could not be read ` +
        'this time. Run the login skill again to retry them; if they fail again the pull finalizes without them.',
    );
  } else if (result.routeDeferred > 0) {
    console.log(DEFERRED_LINE);
  } else if (result.nothingRouted) {
    console.log(NOTHING_ROUTED_LINE);
  } else {
    console.log(
      '  Your history is NOT finalized yet — run the login skill again once the remaining sessions can be delivered.',
    );
  }
  if (result.timelines > 0) {
    console.log('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  // One stanza, not two: `timelinesDropped` is a subset of the offered-minus-attached gap, so an
  // if/else would suppress the unexplained remainder — the very gap these counters exist to show.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    console.log(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (!result.followupsAllowed) {
    console.log('  Rate-limit events are not collected in audit mode.');
  }
  console.log(
    '  Plan and billing details reflect your current setup, not the plan you were on at the time.',
  );
  return 0;
}

// A workspace joined after this machine linked the account got nothing live before the re-pick, so its
// history resumes from what it already has (sync's coverage check). One that takes no uploads on
// demand (audit-only) gets the one-time import instead, which has no link cutoff there.
async function backfillJoinedOne(options) {
  const result = await runAudit(
    { runCache, onProgress: ({ processed, total }) => { console.log(`Beezi: ${processed}/${total} sessions read…`); } },
    { ...options, mode: SYNC_MODE, liveOnly: true },
  );
  if (result.reason === 'audit-only' || result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    return backfillOne(options);
  }
  // A stop the next run will not clear prints backfillOne's own ✗ line; busy and pending runs get the sync line below.
  if (result.reason === 'no-token') {
    return failed(ACCOUNT_TOKEN_UNUSABLE);
  }
  if (result.reason === 'lock-order' || result.reason === 'lock-failed') {
    return failed(`Beezi: could not start the history upload (${orDefault(result.lastError, 'lock error')}).`);
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return failed('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${orDefault(result.lastError, 'forbidden')}). ` +
        'Check your seat with your workspace admin, then sign in to Beezi again.',
    );
  }
  if (options.dryRun) {
    console.log(`✓ Beezi (dry run): would send ${plural(orDefault(result.plannedReports, 0), 'report')} to this workspace you joined — nothing was sent.`);
    return 0;
  }
  const imported = orDefault(result.sessionsImported, 0);
  // Split sessions are left alone for good (sync.mjs), so they don't keep the run incomplete.
  const complete = result.reason == null && result.halt == null && result.coverageKnown !== false
    && !(result.reportsFailed > 0) && !((result.deferred - orDefault(result.deferredSplit, 0)) > 0);
  if (imported > 0) {
    console.log(`✓ Beezi: uploaded ${plural(imported, 'session')} (${plural(orDefault(result.reportsStored, 0), 'report')} stored) to this workspace you joined.`);
  } else if (complete) {
    console.log('✓ Beezi: this workspace already has this machine\'s history.');
  }
  if (!complete) {
    console.log('  Some history did not reach this workspace this time. Run the sync skill to send the rest and see why.');
  }
  return 0;
}

function tenantLabel(row, tenantId) {
  const t = tenantById(row, tenantId);
  return t != null && t.name ? t.name : tenantId;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => tenantLabel(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// Pending history (rules gained a workspace) gets its own coverage-based pass once this upload let go of the lock.
async function startAfterBackfill(key, options) {
  if (!options.dryRun) await startHistoryWorker(key);
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const flagged = await parseAccountFlag(process.argv.slice(2));
  if (flagged.account === null) {
    throw new UserError(
      'Beezi: backfill needs --account <account>. The one-time import is per account, and it is '
      + 'the login skill that runs this with the account it has just linked.',
    );
  }
  const key = flagged.account;
  const indexRow = (await getAccount(key)) || { key };
  const { argv, tenantIds: override } = parseTenantFlags(flagged.rest, indexRow);
  const options = parseArgs(argv);
  options.key = key;

  // The linked session, not the index row: planWorkspaceRuns binds the ledgers it reads to its
  // clientId, which is the identity runAudit writes them under.
  let session = null;
  if (isMultiTenant(indexRow)) {
    let sessions = [];
    try { sessions = await linkedSessions(); } catch { sessions = []; }
    session = orDefault(sessions.find((s) => s.key === key), null);
  }
  // One or unknown workspaces, or no usable login (runAudit then says so): one headerless run.
  if (session == null || !isMultiTenant(session)) {
    const planningRow = session == null ? indexRow : session;
    // Already sealed: every re-run (every login) would otherwise re-plan and re-read up to 64KB of
    // every transcript just to report "already uploaded" right after.
    const tracking = readTrackingState(key);
    // Matches runAudit's own seal test (lib/session-audit.mjs): --force and a stale identity must
    // reopen planning here too, or a manual --force / a relink can skip past the rule-exclusion
    // scan and let this shortcut re-upload sessions the real audit would still refuse (M-2).
    const trackingValid = matchesIdentity(key, orDefault(planningRow.clientId, null));
    const sealed = !options.force && usesRules(planningRow) && trackingValid
      && tracking != null && tracking.backfillCompleted === true;
    if (usesRules(planningRow) && !sealed) {
      options.excludedSessionIds = dontTrackSessionIds(planWorkspaceRuns(planningRow));
      options.excludedLabel = describeAccount(indexRow);
    }
    const status = await backfillOne(options);
    await startAfterBackfill(key, options);
    if (status !== 0) process.exitCode = 1;
    return;
  }
  const row = session;

  // --tenant is an override: those workspaces get every past session, unrouted.
  let tenantIds = override;
  let routes = null;
  if (tenantIds.length === 0) {
    const plan = planWorkspaceRuns(row, { markWaiting: true });
    if (plan.scanned === 0) {
      console.log('✓ Beezi: no past Codex sessions found to upload.');
      return;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(summary);
    tenantIds = plan.tenantIds;
    routes = plan.routes;
  }
  const joinedIds = joinedAfterLink(indexRow);
  let status = 0;
  for (const tenantId of tenantIds) {
    console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
    // One workspace's exception must not stop the rest.
    try {
      const run = joinedIds.indexOf(tenantId) === -1 ? backfillOne : backfillJoinedOne;
      if (await run({ ...options, tenantId, sessionRoutes: routes }) !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  await startAfterBackfill(key, options);
  if (status !== 0) process.exitCode = 1;
}

main().catch((error) => fail(friendlyMessage(error)));
