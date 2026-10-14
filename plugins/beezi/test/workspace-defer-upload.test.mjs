import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { setWorkspaceRule } from '../lib/accounts.mjs';

const TENANTS = [
  { id: 'A', name: 'Acme', joinedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'B', name: 'NewCo', joinedAt: '2026-10-10T00:00:00.000Z' },
];

test('joined --defer-upload prints pick commands that carry the flag before <tenant>', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, linkedAt: '2026-10-01T00:00:00.000Z' });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A'] });
  const out = await workspaceCommand(['joined', '--defer-upload', '--account', TEST_KEY], { startHistoryWorker: async () => { throw new Error('must not start'); } });
  assert.equal(out.ok, true, out.stderr.join('\n'));
  const j = out.lines.find((l) => /^J\d+-command=/.test(l));
  assert.match(j, new RegExp(`joined pick --repo .* --account ${TEST_KEY} --defer-upload <tenant>$`));
  assert.match(out.lines.find((l) => l.startsWith('add-all-command=')), /--defer-upload$/);
  assert.match(out.lines.find((l) => l.startsWith('done-command=')), new RegExp(`joined done --account ${TEST_KEY} --defer-upload$`));
});

test('rule add starts the worker unless deferred', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, linkedAt: '2026-10-01T00:00:00.000Z' });
  const started = [];
  const deps = { startHistoryWorker: async (key) => { started.push(key); } };
  await workspaceCommand(['rule', 'add', '--repo', 'github.com/acme/api', '--account', TEST_KEY, 'B', '--defer-upload'], deps);
  assert.deepEqual(started, []);
  await workspaceCommand(['rule', 'add', '--repo', 'github.com/acme/web', '--account', TEST_KEY, 'B'], deps);
  assert.deepEqual(started, [TEST_KEY]);
});
