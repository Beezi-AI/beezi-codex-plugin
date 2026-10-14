import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { listAccounts, setWorkspaceRule } from '../lib/accounts.mjs';
import { rulesOf } from '../lib/workspace-rules.mjs';
import { newTenantsOf } from '../lib/workspace.mjs';
import { listAllRollouts } from '../lib/transcript-index-codex.mjs';

// A,B joined before the link (not new); T (NewCo) joined after → the only new workspace.
const TENANTS = [
  { id: 'A', name: 'Acme', joinedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'B', name: 'Beta', joinedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'T', name: 'NewCo', joinedAt: '2026-10-10T00:00:00.000Z' },
];
const MATCH = 'github.com/acme/api';
const NOOP_DEPS = { startHistoryWorker: async () => {} };

function link(t, over = {}) {
  return linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, linkedAt: '2026-10-01T00:00:00.000Z', ...over });
}

async function rowNow() {
  return (await listAccounts()).find((a) => a.key === TEST_KEY);
}

function ruleFor(row, kind, match) {
  return rulesOf(row).find((r) => r.kind === kind && r.match === match);
}

async function pick() {
  const out = await workspaceCommand(['joined', 'pick', '--repo', MATCH, 'T', '--account', TEST_KEY], NOOP_DEPS);
  assert.equal(out.ok, true, out.stderr.join('\n'));
  return out;
}

test('joined pick extends a place that already sends to A → {A,T}', async (t) => {
  link(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: MATCH, tenantIds: ['A'] });
  await pick();
  assert.deepEqual(ruleFor(await rowNow(), 'repo', MATCH).tenantIds, ['A', 'T']);
});

test('joined pick on a Don\'t-track [] place → {T}', async (t) => {
  link(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: MATCH, tenantIds: [] });
  await pick();
  assert.deepEqual(ruleFor(await rowNow(), 'repo', MATCH).tenantIds, ['T']);
});

test('joined pick on a no-rule place (New folders = Ask) → {T}', async (t) => {
  link(t);
  await pick();
  assert.deepEqual(ruleFor(await rowNow(), 'repo', MATCH).tenantIds, ['T']);
});

test('joined pick on a place covered by New folders: send [A] → {A,T}', async (t) => {
  link(t, { newFolders: { mode: 'send', tenantIds: ['A'] } });
  await pick();
  assert.deepEqual(ruleFor(await rowNow(), 'repo', MATCH).tenantIds, ['A', 'T']);
});

test('joined pick does not mark the join reviewed', async (t) => {
  link(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: MATCH, tenantIds: ['A'] });
  await pick();
  const row = await rowNow();
  assert.ok(newTenantsOf(row).indexOf('T') !== -1);
  assert.equal((row.reviewedTenantIds || []).indexOf('T'), -1);
});

test('joined pick carries --defer-upload to the worker-start gate', async (t) => {
  link(t);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: MATCH, tenantIds: ['A'] });
  const started = [];
  const deps = { startHistoryWorker: async (key) => { started.push(key); } };
  const deferred = await workspaceCommand(['joined', 'pick', '--repo', MATCH, 'T', '--account', TEST_KEY, '--defer-upload'], deps);
  assert.equal(deferred.ok, true, deferred.stderr.join('\n'));
  assert.deepEqual(started, []);
  assert.deepEqual(ruleFor(await rowNow(), 'repo', MATCH).tenantIds, ['A', 'T']);
  const immediate = await workspaceCommand(['joined', 'pick', '--repo', MATCH, 'B', '--account', TEST_KEY], deps);
  assert.equal(immediate.ok, true, immediate.stderr.join('\n'));
  assert.deepEqual(started, [TEST_KEY]);
});

test('joined done prints kept= after reviewed= and marks the join reviewed', async (t) => {
  link(t);
  const out = await workspaceCommand(['joined', 'done', '--account', TEST_KEY, '--defer-upload'], { ...NOOP_DEPS, listAllRollouts: () => [] });
  assert.equal(out.ok, true, out.stderr.join('\n'));
  assert.deepEqual(out.lines.slice(-2), ['reviewed=T', 'kept=0']);
  assert.equal(newTenantsOf(await rowNow()).indexOf('T'), -1);
});

// Past sessions for planReviewPlaces: real rollout files whose cwd is a plain folder outside home and temp (temp keys as `outside`).
const X_T = [
  { id: 'X', name: 'Xco', joinedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'T', name: 'NewCo', joinedAt: '2026-10-10T00:00:00.000Z' },
];
const R1 = path.resolve('/beezi-join-picker-test/r1');
const R2 = path.resolve('/beezi-join-picker-test/r2');
const SESSION_R1 = '019fd897-9320-7c20-9585-8fa3fff07b01';
const SESSION_R2 = '019fd897-9320-7c20-9585-8fa3fff07b02';

function seedRollouts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-joined-rollouts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026', '10', '13');
  fs.mkdirSync(dir, { recursive: true });
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (const [id, cwd] of [[SESSION_R1, R1], [SESSION_R2, R2]]) {
    const file = path.join(dir, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
    const meta = { timestamp: '2026-10-13T00:00:00.000Z', type: 'session_meta', payload: { id, thread_source: 'user', source: 'cli', cwd } };
    fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
    fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
  }
  return () => listAllRollouts({ sessionsDir: root });
}

function folderRule(row, name) {
  return rulesOf(row).find((r) => r.kind === 'folder' && path.basename(r.match) === name);
}

async function run(argv, deps) {
  const out = await workspaceCommand(argv.concat(['--account', TEST_KEY]), deps);
  assert.equal(out.ok, true, out.stderr.join('\n'));
  return out;
}

test('joined pick then joined done: the picked folder keeps {X,T}, the unpicked one is pinned to {X}', async (t) => {
  link(t, { tenants: X_T });
  const deps = { ...NOOP_DEPS, listAllRollouts: seedRollouts(t) };
  await run(['joined', 'pick', '--folder', R1, 'T'], deps);
  const out = await run(['joined', 'done'], deps);
  const row = await rowNow();
  assert.deepEqual(folderRule(row, 'r1').tenantIds, ['X', 'T']);
  assert.deepEqual(folderRule(row, 'r2').tenantIds, ['X']);
  assert.equal(newTenantsOf(row).indexOf('T'), -1);
  assert.deepEqual(out.lines.slice(-2), ['reviewed=T', 'kept=1']);
});

test('joined done --defer-upload writes the keep-current rules but does not start the worker', async (t) => {
  link(t, { tenants: X_T });
  const started = [];
  const deps = { startHistoryWorker: async (key) => { started.push(key); }, listAllRollouts: seedRollouts(t) };
  const out = await run(['joined', 'done', '--defer-upload'], deps);
  const row = await rowNow();
  assert.deepEqual(folderRule(row, 'r1').tenantIds, ['X']);
  assert.deepEqual(folderRule(row, 'r2').tenantIds, ['X']);
  assert.deepEqual(out.lines.slice(-1), ['kept=2']);
  assert.deepEqual(started, []);
});

test('joined pick --current is rejected and writes nothing', async (t) => {
  link(t, { tenants: X_T });
  const out = await workspaceCommand(['joined', 'pick', '--current', 'T', '--account', TEST_KEY], NOOP_DEPS);
  assert.equal(out.ok, false);
  assert.match(out.stderr.join('\n'), /Usage: workspace\.mjs/);
  assert.deepEqual(rulesOf(await rowNow()), []);
});

test('two new workspaces picked in turn for one folder → {X,T1,T2}', async (t) => {
  link(t, { tenants: [
    { id: 'X', name: 'Xco', joinedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'T1', name: 'NewCo1', joinedAt: '2026-10-10T00:00:00.000Z' },
    { id: 'T2', name: 'NewCo2', joinedAt: '2026-10-11T00:00:00.000Z' },
  ] });
  const deps = { ...NOOP_DEPS, listAllRollouts: seedRollouts(t) };
  await run(['joined', 'pick', '--folder', R1, 'T1'], deps);
  await run(['joined', 'pick', '--folder', R1, 'T2'], deps);
  assert.deepEqual(folderRule(await rowNow(), 'r1').tenantIds, ['X', 'T1', 'T2']);
});
