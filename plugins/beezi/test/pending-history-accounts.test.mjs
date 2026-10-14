import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import {
  getAccount, setWorkspaceRule, removeWorkspaceRule, setNewFolders,
  notePendingAttempt, settlePendingHistory, takeHistoryResults,
} from '../lib/accounts.mjs';
import { pendingHistoryOf, RunOutcome, SettleState } from '../lib/pending-history.mjs';

const TENANTS = [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'NewCo' }];
const setup = (t) => linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, linkedAt: '2026-10-01T00:00:00.000Z' });
const pendingIds = async () => pendingHistoryOf(await getAccount(TEST_KEY)).map((e) => e.tenantId);
const clear = async (id) => settlePendingHistory(TEST_KEY, id, { outcome: RunOutcome.CLEAN }, { plannedAtMs: Date.now() + 1000, nowMs: Date.now() });

test('a first rule requests its workspaces; widening requests every workspace of the rule', async (t) => {
  setup(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A'] });
  assert.deepEqual(await pendingIds(), ['A']);
  await clear('A');
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A', 'B'] });
  assert.deepEqual(await pendingIds(), ['A', 'B']);
});

test("Don't track requests nothing; New folders send does", async (t) => {
  setup(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'folder', match: '/work/secret', tenantIds: [] });
  assert.deepEqual(await pendingIds(), []);
  await setNewFolders(TEST_KEY, { mode: 'send', tenantIds: ['B'] });
  assert.deepEqual(await pendingIds(), ['B']);
});

test('removing a rule that hid New folders send requests what the place now reaches', async (t) => {
  setup(t);
  await setNewFolders(TEST_KEY, { mode: 'send', tenantIds: ['A', 'B'] });
  const { index } = await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/web', tenantIds: ['A'] });
  for (const id of await pendingIds()) await clear(id);
  await removeWorkspaceRule(TEST_KEY, index);
  assert.deepEqual(await pendingIds(), ['A', 'B']);
});

test('removing a repo rule requests what the remaining parent folder rule reaches', async (t) => {
  setup(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'folder', match: '/work', tenantIds: ['A', 'B'] });
  const { index } = await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A'] });
  for (const id of await pendingIds()) await clear(id);
  await removeWorkspaceRule(TEST_KEY, index);
  assert.deepEqual(await pendingIds(), ['A', 'B']);
});

test('attempt, settle and take round-trip through the index', async (t) => {
  setup(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['B'] });
  const now = Date.now();
  await notePendingAttempt(TEST_KEY, ['B'], new Date(now).toISOString());
  assert.equal((await getAccount(TEST_KEY)).pendingHistory[0].lastAttemptAt, new Date(now).toISOString());
  assert.equal(await settlePendingHistory(TEST_KEY, 'B', { outcome: RunOutcome.CLEAN, sent: 7, skipped: 0 }, { plannedAtMs: now + 1000, nowMs: now + 1000 }), SettleState.CLEARED);
  assert.deepEqual(await takeHistoryResults(TEST_KEY), [{ tenantId: 'B', status: 'sent', sent: 7, skipped: 0 }]);
  assert.deepEqual(await takeHistoryResults(TEST_KEY), []);
});
