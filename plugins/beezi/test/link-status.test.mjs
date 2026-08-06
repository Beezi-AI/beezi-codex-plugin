import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkStatus, describeLink, describeReporting, LinkState } from '../lib/link-status.mjs';

const HOOKS_ABSENT = () => ({ state: 'absent', registered: [] });

test('no token reads as not_linked without calling whoami', async () => {
  let called = 0;
  const s = await linkStatus({
    getAccessToken: async () => null,
    whoami: async () => { called += 1; return { valid: true }; },
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.NOT_LINKED);
  assert.equal(called, 0);
});

test('a valid token reports the account and the API it was checked against', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev', email: 'd@e.f' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'http://localhost:5001/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.account, 'Dev');
  assert.match(describeLink(s), /localhost:5001/);
});

test('whoami null is unreachable, not "not linked"', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => null,
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.UNREACHABLE);
  // The distinction matters: an unreachable API says nothing about the credentials, and claiming
  // otherwise is what made the status script and the sign-in tool look like they disagreed.
  assert.doesNotMatch(describeReporting(s), /not linked/i);
  assert.match(describeReporting(s), /unknown/i);
});

test('whoami invalid is revoked', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: false }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.REVOKED);
  assert.match(describeReporting(s), /revoked/i);
});

test('a linked machine with no hooks is told why nothing is reported', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /NOT being reported/);
  assert.match(describeReporting(s), /not installed/);
});

test('installed hooks still point at the trust step, since untrusted hooks never run', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart', 'PostToolUse', 'Stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /\/hooks/);
});

test('a broken hook registry never breaks the link check', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => { throw new Error('registry unreadable'); },
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.hooks.state, 'unknown');
});

test('no message names a slash command Codex does not have', async () => {
  for (const state of Object.values(LinkState)) {
    const s = { state, account: null, apiBase: 'https://api.test/api', hooks: { state: 'absent', registered: [] } };
    for (const text of [describeLink(s), describeReporting(s)].filter(Boolean)) {
      assert.ok(!/\/beezi:/.test(text), `"${text}" names a command that does not exist`);
    }
  }
});
