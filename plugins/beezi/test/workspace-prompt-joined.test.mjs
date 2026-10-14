import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildJoinedPrompt, buildHistoryNotice } from '../lib/workspace-prompt.mjs';

const LINKED = '2026-10-01T00:00:00.000Z';
const JOINED = '2026-10-10T00:00:00.000Z';
const row = (over = {}) => ({
  key: 'k1', email: 'u@example.com', status: 'linked', linkedAt: LINKED,
  tenants: [{ id: 'A', name: 'Acme', joinedAt: '2026-01-01T00:00:00.000Z' }, { id: 'B', name: 'NewCo', joinedAt: JOINED }],
  ...over,
});
// withUsableLogin keeps the rows linkedSessions returns a session for.
const deps = (rows, extra = {}) => ({ listAccounts: async () => rows, linkedSessions: async () => rows, pluginRoot: '/p', ...extra });

test('asks on startup while the join is unreviewed, even after the old notice was shown', async () => {
  const text = await buildJoinedPrompt({ source: 'startup' }, deps([row({ joinNoticedTenantIds: ['B'] })]));
  assert.match(text, /node "\/p\/scripts\/workspace\.mjs" joined --account k1/);
  assert.match(text, /escalated permissions/);
  assert.match(text, /\/p\/skills\/sync\/SKILL\.md/);
  assert.match(text, /request_user_input/);
  assert.match(text, /end your reply with that question as one plain sentence/);
  assert.match(text, /run neither routes nor sync\.mjs/);
});

test('the quoted sync-skill anchors each match exactly once, the stop point only at its paragraph start', async () => {
  const text = await buildJoinedPrompt({ source: 'startup' }, deps([row()]));
  const skill = fs.readFileSync(new URL('../skills/sync/SKILL.md', import.meta.url), 'utf8');
  const stop = '**Then, repos and folders with no rule.**';
  assert.ok(text.includes(`up to the paragraph that begins "${stop}"`));
  assert.equal(skill.split(stop).length - 1, 1);
  assert.match(skill, /^\*\*Then, repos and folders with no rule\.\*\*$/m);
  assert.equal(skill.split('**First, new workspaces.**').length - 1, 1);
  const start = 'Its output is for you only. For an account that joined';
  assert.ok(text.includes(`from "${start}" up to`));
  assert.equal(skill.split(start).length - 1, 1);
  assert.ok(skill.indexOf(start) > skill.indexOf('**First, new workspaces.**'));
  assert.ok(skill.indexOf(start) < skill.indexOf(stop));
});

test('request_user_input only where the skill allows it', async () => {
  const text = await buildJoinedPrompt({ source: 'startup' }, deps([row()]));
  assert.match(text, /where the skill allows request_user_input/);
});

test('the current-folder question is gated on this session\'s rules after the joined pass', async () => {
  const text = await buildJoinedPrompt({ source: 'startup', session_id: 'sess-1' }, deps([row()]));
  assert.ok(text.includes('`node "/p/scripts/workspace.mjs" rules --session sess-1 --account <key>`'));
  assert.match(text, /Beezi is holding this session's analytics/);
  assert.match(text, /only when the `here:` line shows `no rule`/);
  assert.match(text, /ask it only after that part is finished/);
  assert.ok(text.indexOf('rules --session') > text.indexOf('(5) stop after that part'));
  assert.ok(text.endsWith('Then continue with the user\'s request.'));
});

test('no session id, no rules step', async () => {
  const text = await buildJoinedPrompt({ source: 'startup' }, deps([row()]));
  assert.ok(!text.includes('rules --session'));
});

test('never asks on resume or compact, nor once reviewed', async () => {
  assert.equal(await buildJoinedPrompt({ source: 'resume' }, deps([row()])), null);
  assert.equal(await buildJoinedPrompt({ source: 'compact' }, deps([row()])), null);
  assert.equal(await buildJoinedPrompt({ source: 'clear' }, deps([row({ reviewedTenantIds: ['B'] })])), null);
});

test('skips an account whose login is unusable', async () => {
  assert.equal(await buildJoinedPrompt({ source: 'startup' }, deps([row()], { linkedSessions: async () => [] })), null);
});

test('history notice: one line per result, prefixed by email with several accounts', async () => {
  const rows = [row({ historyResults: [{ tenantId: 'B', status: 'sent', sent: 2, skipped: 0 }] }), row({ key: 'k2', email: 'v@example.com' })];
  const takeHistoryResults = async (key) => (key === 'k1' ? rows[0].historyResults : []);
  const text = await buildHistoryNotice({ source: 'startup' }, deps(rows, { takeHistoryResults }));
  assert.equal(text, 'Beezi (u@example.com): sent 2 past sessions to NewCo.');
  assert.equal(await buildHistoryNotice({ source: 'resume' }, deps(rows, { takeHistoryResults })), null);
});

test('history notice: a gave-up upload points at the sync skill', async () => {
  const gaveUp = [{ tenantId: 'B', status: 'gave-up', sent: 0, skipped: 0 }];
  const rows = [row({ historyResults: gaveUp })];
  const text = await buildHistoryNotice({ source: 'startup' }, deps(rows, { takeHistoryResults: async () => gaveUp }));
  assert.equal(text, "Beezi: couldn't send history to NewCo. Run the sync skill to try again.");
});
