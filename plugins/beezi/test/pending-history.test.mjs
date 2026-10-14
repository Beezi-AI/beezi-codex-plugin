import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleRequestIds, removalRequestIds, gainedIds, requestHistory, pendingHistoryOf, historyDue, noteAttempt,
  settleHistory, takeResults, resultLine, waitingOnRecent, RunOutcome, SettleState, HistoryStatus,
  HISTORY_RETRY_MS, HISTORY_GIVE_UP_MS, HISTORY_BUSY_RETRY_MS, HISTORY_PASS_MAX_MS,
} from '../lib/pending-history.mjs';

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const multi = (extra = {}) => ({ tenants: [{ id: 'A' }, { id: 'B' }], workspaceRules: [], ...extra });

test('ruleRequestIds: every member the rule names, once each, in member order', () => {
  assert.deepEqual(ruleRequestIds(multi(), ['B', 'GONE', 'A', 'B']), ['A', 'B']);
  assert.deepEqual(ruleRequestIds(multi(), []), []);
});

test('ruleRequestIds: a one-workspace account requests its workspace unless the rule is []', () => {
  const one = { tenants: [{ id: 'A' }] };
  assert.deepEqual(ruleRequestIds(one, []), []);
  assert.deepEqual(ruleRequestIds(one, ['A']), ['A']);
});

test('removalRequestIds: a parent folder rule that remains is requested in full', () => {
  // repo rule api -> [A] was removed; api now falls through to ~/work -> [A, B].
  const row = multi({ workspaceRules: [{ kind: 'folder', match: '~/work', tenantIds: ['A', 'B'] }] });
  assert.deepEqual(removalRequestIds(row), ['A', 'B']);
});

test('removalRequestIds: remaining rules plus New folders send, members only, once each', () => {
  const row = {
    tenants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    workspaceRules: [{ kind: 'repo', match: 'r', tenantIds: ['C', 'GONE'] }, { kind: 'folder', match: '/f', tenantIds: [] }],
    newFolders: { mode: 'send', tenantIds: ['A', 'C'] },
  };
  assert.deepEqual(removalRequestIds(row), ['A', 'C']);
  assert.deepEqual(removalRequestIds(multi({ newFolders: { mode: 'ask', tenantIds: [] } })), []);
});

test('removalRequestIds: a one-workspace account requests its workspace', () => {
  assert.deepEqual(removalRequestIds({ tenants: [{ id: 'A' }], workspaceRules: [] }), ['A']);
});

test('gainedIds keeps order and drops duplicates', () => {
  assert.deepEqual(gainedIds(['A'], ['A', 'B', 'B', 'C']), ['B', 'C']);
  assert.deepEqual(gainedIds(['A', 'B'], ['A']), []);
});

test('requestHistory adds, refreshes and drops left workspaces', () => {
  const row = multi({ pendingHistory: [{ tenantId: 'GONE', requestedAt: iso(T0) }, { tenantId: 'A', requestedAt: iso(T0), attempts: 2, lastAttemptAt: iso(T0), sent: 4, skipped: 0 }] });
  requestHistory(row, ['A', 'B', 'NOT_MEMBER'], iso(T0 + 1000));
  assert.deepEqual(row.pendingHistory.map((e) => e.tenantId), ['A', 'B']);
  assert.equal(row.pendingHistory[0].requestedAt, iso(T0 + 1000));
  assert.equal(row.pendingHistory[0].lastAttemptAt, null);
  assert.equal(row.pendingHistory[0].sent, 4);
  assert.equal(row.pendingHistory[1].attempts, 0);
});

test('requestHistory with nothing gained leaves a row without a marker untouched', () => {
  const row = multi();
  requestHistory(row, [], iso(T0));
  assert.equal('pendingHistory' in row, false);
});

test('historyDue: never tried, an hour old, or a future stamp', () => {
  const row = multi();
  requestHistory(row, ['A'], iso(T0));
  assert.equal(historyDue(row, T0), true);
  noteAttempt(row, ['A'], iso(T0));
  assert.equal(historyDue(row, T0 + 1000), false);
  assert.equal(historyDue(row, T0 + HISTORY_RETRY_MS), true);
  assert.equal(historyDue(row, T0 - 1000), true);
  assert.equal(pendingHistoryOf(multi()).length, 0);
});

test('settle: clean clears and records a sent result', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  const state = settleHistory(row, 'B', { outcome: RunOutcome.CLEAN, sent: 42, skipped: 3 }, { plannedAtMs: T0 + 10, nowMs: T0 + 20 });
  assert.equal(state, SettleState.CLEARED);
  assert.equal(row.pendingHistory.length, 0);
  assert.deepEqual(row.historyResults, [{ tenantId: 'B', status: HistoryStatus.SENT, sent: 42, skipped: 3 }]);
});

test('settle: clean with nothing sent clears without a result', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  settleHistory(row, 'B', { outcome: RunOutcome.CLEAN, sent: 0, skipped: 0 }, { plannedAtMs: T0 + 10, nowMs: T0 + 20 });
  assert.equal(row.pendingHistory.length, 0);
  assert.equal(row.historyResults, undefined);
});

test('settle: a request newer than the plan survives a clean run', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0 + 500));
  const state = settleHistory(row, 'B', { outcome: RunOutcome.CLEAN, sent: 5, skipped: 0 }, { plannedAtMs: T0, nowMs: T0 + 900 });
  assert.equal(state, SettleState.KEPT);
  assert.equal(row.pendingHistory[0].sent, 5);
});

test('settle: waiting keeps the entry and accumulates counts', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  settleHistory(row, 'B', { outcome: RunOutcome.WAITING, sent: 40, skipped: 0 }, { plannedAtMs: T0 + 1, nowMs: T0 + 2 });
  settleHistory(row, 'B', { outcome: RunOutcome.CLEAN, sent: 1, skipped: 1 }, { plannedAtMs: T0 + 3, nowMs: T0 + 4 });
  assert.deepEqual(row.historyResults, [{ tenantId: 'B', status: HistoryStatus.SENT, sent: 41, skipped: 1 }]);
});

test('settle: the third failure adds one retrying result; busy re-arms soon without counting', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0));
  settleHistory(row, 'B', { outcome: RunOutcome.BUSY }, { plannedAtMs: T0, nowMs: T0 });
  assert.equal(historyDue(row, T0 + 1000), false);
  assert.equal(historyDue(row, T0 + HISTORY_BUSY_RETRY_MS), true);
  assert.equal(row.pendingHistory[0].attempts, 0);
  for (let i = 0; i < 4; i += 1) settleHistory(row, 'B', { outcome: RunOutcome.FAILED }, { plannedAtMs: T0, nowMs: T0 });
  assert.equal(row.pendingHistory[0].attempts, 4);
  assert.deepEqual(row.historyResults.map((r) => r.status), [HistoryStatus.RETRYING]);
});

test('noteAttempt: a second stamp inside the watchdog window does not count', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0 + HISTORY_PASS_MAX_MS - 1000));
  assert.equal(row.pendingHistory[0].attempts, 0);
});

test('noteAttempt: a pass never settled past the watchdog counts as failed', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0 + HISTORY_PASS_MAX_MS));
  assert.equal(row.pendingHistory[0].attempts, 1);
});

test('noteAttempt: a settled pass is not counted again', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  noteAttempt(row, ['B'], iso(T0));
  settleHistory(row, 'B', { outcome: RunOutcome.FAILED }, { plannedAtMs: T0, nowMs: T0 });
  assert.equal(row.pendingHistory[0].attempts, 1);
  noteAttempt(row, ['B'], iso(T0 + HISTORY_PASS_MAX_MS));
  assert.equal(row.pendingHistory[0].attempts, 1);
});

test('noteAttempt: three crashed passes add one retrying result', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  for (let i = 0; i < 4; i += 1) noteAttempt(row, ['B'], iso(T0 + i * HISTORY_PASS_MAX_MS));
  assert.equal(row.pendingHistory[0].attempts, 3);
  assert.deepEqual(row.historyResults, [{ tenantId: 'B', status: HistoryStatus.RETRYING, sent: 0, skipped: 0 }]);
});

test('settle: refused or seven days old gives up', () => {
  const a = multi();
  requestHistory(a, ['B'], iso(T0));
  assert.equal(settleHistory(a, 'B', { outcome: RunOutcome.REFUSED }, { plannedAtMs: T0, nowMs: T0 }), SettleState.GAVE_UP);
  const b = multi();
  requestHistory(b, ['B'], iso(T0));
  assert.equal(settleHistory(b, 'B', { outcome: RunOutcome.FAILED }, { plannedAtMs: T0, nowMs: T0 + HISTORY_GIVE_UP_MS }), SettleState.GAVE_UP);
  assert.equal(b.pendingHistory.length, 0);
  assert.equal(b.historyResults[b.historyResults.length - 1].status, HistoryStatus.GAVE_UP);
});

test('settle: a week of only waiting clears as sent, not as a failure', () => {
  const row = multi();
  requestHistory(row, ['B'], iso(T0));
  settleHistory(row, 'B', { outcome: RunOutcome.WAITING, sent: 9, skipped: 0 }, { plannedAtMs: T0 + 1, nowMs: T0 + 1 });
  const state = settleHistory(row, 'B', { outcome: RunOutcome.WAITING, sent: 0, skipped: 2 }, { plannedAtMs: T0 + 2, nowMs: T0 + HISTORY_GIVE_UP_MS });
  assert.equal(state, SettleState.CLEARED);
  assert.deepEqual(row.historyResults, [{ tenantId: 'B', status: HistoryStatus.SENT, sent: 9, skipped: 2 }]);
});

test('takeResults removes what it returns', () => {
  const row = { historyResults: [{ tenantId: 'A', status: 'sent', sent: 1, skipped: 0 }, { tenantId: 'B', status: 'gave-up', sent: 0, skipped: 0 }] };
  assert.equal(takeResults(row, 1).length, 1);
  assert.equal(row.historyResults.length, 1);
  assert.equal(takeResults(row).length, 1);
  assert.deepEqual(row.historyResults, []);
});

test('resultLine copy', () => {
  const opts = { prefix: 'Beezi', nameOf: (id) => (id === 'B' ? 'NewCo' : id), syncName: '/beezi:sync' };
  assert.equal(resultLine({ tenantId: 'B', status: 'sent', sent: 1, skipped: 0 }, opts), 'Beezi: sent 1 past session to NewCo.');
  assert.equal(resultLine({ tenantId: 'B', status: 'sent', sent: 42, skipped: 3 }, opts), "Beezi: sent 42 past sessions to NewCo; 3 couldn't be matched safely and were skipped.");
  assert.equal(resultLine({ tenantId: 'B', status: 'retrying' }, opts), "Beezi: couldn't send history to NewCo yet, will retry.");
  assert.equal(resultLine({ tenantId: 'B', status: 'gave-up' }, opts), "Beezi: couldn't send history to NewCo. Run /beezi:sync to try again.");
});

test('waitingOnRecent: a recent session that predates the request keeps it waiting', () => {
  assert.equal(waitingOnRecent([T0 - 1], iso(T0)), true);
  assert.equal(waitingOnRecent([T0 + 1], iso(T0)), false);
  assert.equal(waitingOnRecent([null], iso(T0)), false);
  assert.equal(waitingOnRecent([], iso(T0)), false);
});
