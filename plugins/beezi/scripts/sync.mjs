import { runAudit, createRunCache, planWorkspaceRuns, dontTrackSessionIds, SYNC_MODE, ACCOUNT_TOKEN_UNUSABLE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail, plural } from '../lib/cli.mjs';
import {
  AccountStatus, describeAccount, getAccount, listAccounts, parseAccountFlag,
} from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf } from '../lib/workspace.mjs';
import { usesRules } from '../lib/workspace-rules.mjs';
import { startHistoryWorker } from '../lib/history-trigger.mjs';

// The repeatable history repair pass (G-3-3 engine, G-9-3 surface).
//
// This is NOT the one-time import. It asks Beezi how far each session already reaches and uploads
// only what is missing above that point, so it is safe to run as often as the user likes and it
// neither consumes nor reopens the one-time backfill's seal.
//
// It reaches back 30 days and no further: MAX_SESSION_AGE_MS in lib/session-audit.mjs is shared
// policy, so a session out of scope for the one-time import is out of scope here too.
//
// It takes ONE FLAG — `--account`, which scopes the run to a single linked account — and the two
// refusals below are the mechanical enforcement of the flags it still does not take:
//
//   --since filters on the transcript's modification time, which says when a session last RAN, not
//   what Beezi is missing. It would silently exclude exactly the old half-uploaded session this
//   command exists to repair.
//
//   --force exists on the import to skip the LOCAL seal caches. There is no seal on this path to
//   force past, so accepting the flag would only advertise a bypass that does not exist — and
//   invite the model to reach for it the moment the one-time import refuses.
//
// With no --account the run repeats for EVERY linked account in turn. That is not wasteful
// duplication: /sessions/coverage answers for the account whose bearer asked, so a run for one
// account establishes nothing about what another is missing.
//
// An account in several workspaces repeats once per workspace its rules and New folders reach, for
// the same reason: each workspace answers coverage for itself. `--tenant <workspace[,…]>` (with
// --account when several accounts are linked) overrides that and sends those workspaces every past
// session, unrouted.
//
// `--dry-run` builds everything and sends nothing, so a run can be previewed.

function parseSyncArgs(argv) {
  for (const flag of argv) {
    if (flag === '--since') {
      fail(
        'Beezi: sync takes no --since. It uploads exactly what Beezi is missing from the last 30 '
        + 'days, wherever in that window those sessions ran. Run it with no flags.',
      );
    }
    if (flag === '--force') {
      fail(
        'Beezi: sync takes no --force. There is no one-time seal to force past — sync resumes each '
        + 'session from where Beezi already has it. Run it with no flags.',
      );
    }
  }
  return { mode: SYNC_MODE, dryRun: argv.indexOf('--dry-run') !== -1 };
}

// A refusal, worded identically either way — but the fan-out must not let one account's refusal
// cancel the accounts after it, and fail() exits the process. So when more than one account is
// being run, the ✗ line is printed, the exit code is set, and the loop carries on. With one
// account the output is byte-identical to what a single-account install has always printed.
function refuse(message, many) {
  if (!many) fail(message); // never returns
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

// One git cache for the whole process, so every workspace pass reuses the first one's git answers.
const runCache = createRunCache();

async function runOne(key, many, options) {
  const result = await runAudit(
    {
      runCache,
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    { ...options, key },
  );

  // The real count, after the live-session skip the audit already applies — not the pre-run plan,
  // which also counts the live session and sessions still being written.
  if (options.excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${options.excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }

  // 'no-token' says two different things depending on whether this run was scoped. Unscoped it is
  // the machine: nothing here can report. SCOPED it is the account, which the caller has already
  // resolved against the index — so "this machine is not linked" would be false, and on a fan-out
  // it would print under the heading of one account while another was mid-upload.
  if (result.reason === 'no-token') {
    return refuse(
      key === null
        ? 'Beezi: this machine is not linked. Sign in to Beezi first (the login skill).'
        : ACCOUNT_TOKEN_UNUSABLE,
      many,
    );
  }
  if (result.reason === 'workspace-required') {
    return refuse(
      'Beezi: this account belongs to several workspaces and none was picked for this run. '
      + 'Check where analytics go with the settings skill, then run sync again.',
      many,
    );
  }
  if (result.reason === 'lock-order' || result.reason === 'lock-failed') {
    return refuse(`Beezi: could not start the history sync (${orDefault(result.lastError, 'lock error')}).`, many);
  }
  if (result.reason === 'run-in-progress') {
    console.log('✓ Beezi: a history upload is already running on this machine — letting it finish.');
    return;
  }
  if (result.reason === 'audit-only') {
    console.log(
      '✓ Beezi: this workspace is on an audit-only plan, so past sessions cannot be uploaded on '
      + 'demand. Upgrade the workspace plan in the Beezi portal to enable live analytics.',
    );
    return;
  }
  // Reports this machine built and Beezi has not received yet. Coverage would be stale by exactly
  // those segments, so the run stops rather than reconcile against an answer it knows is behind.
  if (result.reason === 'pending-not-drained') {
    console.log(
      '✓ Beezi: nothing was synced this time — some already-saved analytics have not reached Beezi '
      + `yet (${orDefault(result.lastError, 'delivery pending')}). They are queued on disk and retried `
      + 'automatically; run sync again once they are through.',
    );
    return;
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    console.log(
      '✓ Beezi: another history upload took over partway through. Nothing was lost — run sync again '
      + 'once it finishes.',
    );
    return;
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    return refuse('Beezi: this workspace does not accept history uploads on demand.', many);
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return refuse(
      'Beezi: your workspace’s Beezi server does not support history sync yet — it needs updating. '
      + 'No history was lost; run this again after the portal update.',
      many,
    );
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return refuse(
      `Beezi: the server refused the upload (${orDefault(result.lastError, 'forbidden')}). `
      + 'Check your seat with your workspace admin, then sign in to Beezi again.',
      many,
    );
  }

  // The tri-state, surfaced verbatim: "could not ask" must never be printed as "nothing to do".
  if (result.coverageKnown === false) {
    console.log(
      '✓ Beezi: could not reach Beezi to check what it already has, so nothing was uploaded — '
      + 'and nothing was lost or duplicated. Try again in a moment.',
    );
    return;
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Codex sessions found on this machine.');
    return;
  }

  // "everything is already uploaded" is the ONE phrase the skill teaches the model to read as
  // final — "do not re-run hoping for a different answer". So it is gated on there being nothing
  // left to come back for. A run that deferred history has to say so first, or the surface tells
  // the user to stop precisely when a later retry is the whole point.
  if (options.dryRun === true) {
    // Nothing was sent, so none of the "uploaded" headlines below is true of this run.
    console.log(
      `✓ Beezi (dry run): sync would send ${plural(result.plannedReports, 'report')} — nothing was sent.`,
    );
  } else if (result.sessionsImported === 0 && result.deferred > 0) {
    // Split history is the one deferral a later run does not clear, so it gets no "run again".
    console.log(
      result.deferred > orDefault(result.deferredSplit, 0)
        ? `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left for a `
          + 'later run. Details below; run sync again afterwards.'
        : `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left alone. Details below.`,
    );
  } else if (result.sessionsImported === 0) {
    // Qualified when the window bit, because the unqualified phrase is the one the skill teaches
    // the model to read as final — and "everything" would be a false claim about older history.
    console.log(
      result.tooOld > 0
        ? '✓ Beezi: everything from the last 30 days is already uploaded.'
        : '✓ Beezi: everything is already uploaded.',
    );
  } else {
    console.log(
      `✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} `
      + `(${plural(result.reportsStored, 'report')} stored).`,
    );
  }

  // The window is a hard floor on this path too: unlike a deferral, a later run will not reach them.
  if (result.tooOld > 0) {
    console.log(
      `  ${plural(result.tooOld, 'session')} ran more than 30 days ago — sync only reaches back 30 `
      + 'days, so they will not be uploaded by a later run either.',
    );
  }
  if (result.pendingDrained > 0) {
    console.log(`  ${plural(result.pendingDrained, 'saved report')} were delivered before the check.`);
  }
  // Deferred history, split by cause, because the two causes need different follow-up.
  if (result.deferredGap > 0) {
    console.log(
      `  ${plural(result.deferredGap, 'session')} were left alone: what Beezi has recorded for them `
      + 'does not line up with what this machine sent, so re-uploading could double-count. They stay '
      + 'eligible — run sync again later.',
    );
  }
  // An account in several workspaces: this workspace's lines of the session are interleaved with
  // another workspace's. A one-workspace account with rules (I-3): an excluded segment left the
  // same kind of hole, so the wording cannot say "split between workspaces" — there is only one.
  // Either way Beezi's contiguous prefix cannot say what it holds past the gap.
  if (orDefault(result.deferredSplit, 0) > 0) {
    console.log(
      options.excludedSessionIds != null
        ? `  ${plural(result.deferredSplit, 'session')} were left alone: part of their history is in repos `
          + 'or folders you don\'t track, so what Beezi has does not prove a safe resume point and '
          + 're-uploading could double-count. A later run will not change that.'
        : `  ${plural(result.deferredSplit, 'session')} were left alone: their history was split between `
          + 'workspaces, so what Beezi has for this workspace does not prove a safe resume point and '
          + 're-uploading could double-count. A later run will not change that.',
    );
  }
  if (result.deferredOverlap > 0) {
    console.log(
      `  ${plural(result.deferredOverlap, 'session')} were left alone because the resume point could `
      + 'not be honoured. Nothing was sent for them.',
    );
  }
  if (result.childrenDeferred > 0) {
    console.log(
      `  ${plural(result.childrenDeferred, 'sub-agent')} left alone: live tracking is still delivering `
      + 'them, or they ran before 11 September 2026, when sub-agent ids changed. Their main sessions '
      + 'were still checked.',
    );
  }
  if (result.itemErrors > 0) {
    console.log(`  ${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    console.log(
      `  ${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run sync again to retry them.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
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

// One account: a single headerless run, or one run per workspace under its own heading. Workspace
// runs never exit mid-loop (many = true), so one workspace's refusal does not cancel the rest.
async function syncAccount(row, many, options, argv) {
  const override = parseTenantFlags(argv, row).tenantIds;
  if (!isMultiTenant(row)) {
    if (usesRules(row)) {
      const excludedSessionIds = dontTrackSessionIds(planWorkspaceRuns(row));
      await runOne(row.key, many, { ...options, excludedSessionIds, excludedLabel: describeAccount(row) });
    } else {
      await runOne(row.key, many, options);
    }
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  if (override.length > 0) {
    for (const tenantId of override) {
      console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
      await runOne(row.key, true, { ...options, tenantId });
    }
    return;
  }
  const plan = planWorkspaceRuns(row);
  if (plan.scanned === 0) {
    console.log(`✓ Beezi (${describeAccount(row)}): no past Codex sessions found on this machine.`);
    return;
  }
  const summary = routeSummary(row, plan);
  if (summary != null) console.log(summary);
  for (const tenantId of plan.tenantIds) {
    console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
    await runOne(row.key, true, { ...options, tenantId, sessionRoutes: plan.routes });
  }
}

// Runs the sync for the named account, else every linked one; → the accounts it ran for.
async function syncRows(account, options, rest) {
  if (account !== null) {
    const row = (await getAccount(account)) || { key: account };
    await syncAccount(row, false, options, rest);
    return [row];
  }

  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  // Nothing linked: one run, and no heading. `null` lets lib/session-audit.mjs pick the default
  // exactly as it always has — including answering 'no-token' on a machine that has never signed
  // in, which is the message that path must still produce.
  if (linked.length === 0) {
    await runOne(null, false, options);
    return [];
  }
  // A workspace name means nothing without the account it belongs to.
  if (linked.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <account> when several accounts are linked.');
  }
  // One account: no heading.
  if (linked.length === 1) {
    await syncAccount(linked[0], false, options, rest);
    return linked;
  }
  for (let i = 0; i < linked.length; i += 1) {
    if (i > 0) console.log('');
    // Same shape the settings skill (Account → Default account)'s list prints, key included: describeAccount answers
    // "linked account (no name or email recorded)" for a pre-0.13 migrated row, and two of those
    // would be indistinguishable headings without it.
    console.log(`── Account: ${describeAccount(linked[i])} [${linked[i].key}] ──`);
    await syncAccount(linked[i], true, options, rest);
  }
  return linked;
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  // The two flag refusals stay FIRST and unconditional. They are the mechanical half of "sync is
  // not a way around the one-time import", and a refused run must still be refused before anything
  // is read — including the accounts index.
  const options = parseSyncArgs(argv);
  const { account, rest } = await parseAccountFlag(argv);
  const rows = await syncRows(account, options, rest);
  // Pending history (rules gained a workspace) gets its own coverage-based pass once this sync let go of the lock.
  if (!options.dryRun) for (const row of rows) await startHistoryWorker(row.key);
}

main().catch((error) => fail(friendlyMessage(error)));
