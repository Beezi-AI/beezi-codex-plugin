import { runAudit, SYNC_MODE, ACCOUNT_TOKEN_UNUSABLE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail, plural } from '../lib/cli.mjs';
import {
  AccountStatus, describeAccount, listAccounts, parseAccountFlag,
} from '../lib/accounts.mjs';

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
  return { mode: SYNC_MODE };
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

async function runOne(key, many, options) {
  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    { ...options, key },
  );

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
  if (result.sessionsImported === 0 && result.deferred > 0) {
    console.log(
      `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left for a `
      + 'later run. Details below; run sync again afterwards.',
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
  if (result.deferredOverlap > 0) {
    console.log(
      `  ${plural(result.deferredOverlap, 'session')} were left alone because the resume point could `
      + 'not be honoured. Nothing was sent for them.',
    );
  }
  if (result.childrenDeferred > 0) {
    console.log(
      `  ${plural(result.childrenDeferred, 'session')} were resumed partway, so their sub-agent `
      + 'activity was not re-checked — Beezi records sub-agents separately from the main session.',
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

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  // The two flag refusals stay FIRST and unconditional. They are the mechanical half of "sync is
  // not a way around the one-time import", and a refused run must still be refused before anything
  // is read — including the accounts index.
  const options = parseSyncArgs(argv);
  const { account } = await parseAccountFlag(argv);

  if (account !== null) {
    await runOne(account, false, options);
    return;
  }

  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  // Nothing linked, or one account: one run, and no heading. `null` lets lib/session-audit.mjs
  // pick the default exactly as it always has — including answering 'no-token' on a machine that
  // has never signed in, which is the message that path must still produce.
  if (linked.length < 2) {
    await runOne(linked.length === 1 ? linked[0].key : null, false, options);
    return;
  }
  for (let i = 0; i < linked.length; i += 1) {
    if (i > 0) console.log('');
    // Same shape the accounts skill's list prints, key included: describeAccount answers
    // "linked account (no name or email recorded)" for a pre-0.13 migrated row, and two of those
    // would be indistinguishable headings without it.
    console.log(`── Account: ${describeAccount(linked[i])} [${linked[i].key}] ──`);
    await runOne(linked[i].key, true, options);
  }
}

main().catch((error) => fail(friendlyMessage(error)));
