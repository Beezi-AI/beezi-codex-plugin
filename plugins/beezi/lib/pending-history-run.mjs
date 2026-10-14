import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns, createRunCache as _createRunCache, dontTrackSessionIds, SYNC_MODE } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { isMultiTenant } from './workspace.mjs';
import { usesRules } from './workspace-rules.mjs';
import { rolloutStartedAt as _rolloutStartedAt } from './subagent-codex.mjs';
import { pendingHistoryOf, historyDue, waitingOnRecent, RunOutcome, SettleState } from './pending-history.mjs';

// A live checkpoint transaction or a run that took the lock over is busy, not a failure.
const BUSY_REASONS = ['run-in-progress', 'active-writer', 'pending-transaction'];
const BUSY_HALTS = [BackfillHalt.LOCK_LOST];
const REFUSED_REASONS = ['workspace-required', 'audit-only'];
const REFUSED_HALTS = [BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];

// One sync-mode run's meaning for the marker; `waiting` = a recent session predates the request.
export function classifyRun(result, waiting) {
  if (result == null) return RunOutcome.FAILED;
  if (BUSY_REASONS.indexOf(result.reason) !== -1 || BUSY_HALTS.indexOf(result.halt) !== -1) return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (result.ok !== true || result.reason != null || result.halt != null) return RunOutcome.FAILED;
  if (result.reportsFailed > 0 || result.deferredUnavailable > 0) return RunOutcome.FAILED;
  if (result.coverageKnown === false && result.candidates > 0) return RunOutcome.FAILED;
  return waiting ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

function startedAtMs(recent, startedAt) {
  try {
    const ms = startedAt(recent.path);
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Each pending workspace's runAudit options, as sync plans them; null when no route reaches it.
function plannedRuns(row, entries, planRuns) {
  if (!isMultiTenant(row)) {
    const options = { tenantId: null };
    if (usesRules(row)) options.excludedSessionIds = dontTrackSessionIds(planRuns(row));
    return entries.slice(0, 1).map((entry) => ({ entry, options }));
  }
  const plan = planRuns(row);
  return entries.map((entry) => ({
    entry,
    options: plan.tenantIds.indexOf(entry.tenantId) === -1 ? null : { tenantId: entry.tenantId, sessionRoutes: plan.routes },
  }));
}

// Runs every pending workspace of one account once and settles each entry.
export async function runPendingHistory(key, deps = {}) {
  const accounts = deps.accounts == null ? await import('./accounts.mjs') : deps.accounts;
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const planRuns = deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns;
  const startedAt = deps.rolloutStartedAt == null ? _rolloutStartedAt : deps.rolloutStartedAt;
  const now = deps.now == null ? () => Date.now() : deps.now;
  // Before the read: a rule landing after it must not count as covered by this plan.
  const plannedAtMs = now();
  const row = (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
  if (row == null) return [];
  const entries = pendingHistoryOf(row);
  if (entries.length === 0) return [];
  await accounts.notePendingAttempt(key, entries.map((e) => e.tenantId), new Date(plannedAtMs).toISOString());
  const done = [];
  let busy = false;
  // One git cache for every workspace pass, so each rollout's repository is resolved once.
  const runCache = (deps.createRunCache == null ? _createRunCache : deps.createRunCache)();
  for (const { entry, options } of plannedRuns(row, entries, planRuns)) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.CLEAN, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      // A throwing run settles as failed (classifyRun(null)) rather than leaving later entries unsettled.
      const result = await runAudit({ runCache }, { ...options, key, mode: SYNC_MODE }).catch(() => null);
      const ran = result == null ? {} : result;
      const recent = Array.isArray(ran.recent) ? ran.recent.map((r) => startedAtMs(r, startedAt)) : [];
      run = {
        outcome: classifyRun(result, waitingOnRecent(recent, entry.requestedAt)),
        sent: ran.sessionsImported || 0,
        skipped: (ran.deferredGap || 0) + (ran.deferredSplit || 0) + (ran.deferredOverlap || 0),
      };
      busy = run.outcome === RunOutcome.BUSY;
    }
    // A busy index lock leaves this entry for the next pass instead of abandoning the rest.
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: now() }).catch(() => SettleState.MISSING);
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}

// The watcher's retry: every linked account whose pending history is due, one after another.
// Reads the index as written: an unmigrated install has no marker, and its migration may reach the keyring.
export async function runDuePendingHistory(deps = {}) {
  const accounts = deps.accounts == null ? await import('./accounts.mjs') : deps.accounts;
  const nowMs = deps.now == null ? Date.now() : deps.now();
  const rows = accounts.listAccountsSync().filter((a) => a.status === accounts.AccountStatus.LINKED && historyDue(a, nowMs));
  const done = [];
  for (const row of rows) {
    if (deps.shouldStop != null && deps.shouldStop()) break;
    for (const item of await runPendingHistory(row.key, deps)) done.push(item);
  }
  return done;
}
