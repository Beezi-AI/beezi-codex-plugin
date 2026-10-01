import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkStatus, describeLink, describeReporting, LinkState } from '../lib/link-status.mjs';

// linkStatus answers per ACCOUNT now: it reads the index, resolves each row, and reports the
// DEFAULT one at the top level so every existing reader of `state`/`account` keeps the answer it
// has always had on a single-account machine. These cases are about that top-level answer, so they
// supply one linked row.
const ROW = {
  key: 'a1b2c3d4', email: 'd@e.f', name: 'Dev', tenantName: 'W-1',
  clientId: 'c-a1b2c3d4', status: 'linked',
};
const ONE = { listAccounts: async () => [ROW], getDefaultKey: async () => ROW.key };

const HOOKS_ABSENT = () => ({ state: 'absent', registered: [] });

test('no token reads as not_linked without calling whoami', async () => {
  let called = 0;
  const s = await linkStatus({
    ...ONE,
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
    ...ONE,
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
    ...ONE,
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
    ...ONE,
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
    ...ONE,
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
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart', 'PostToolUse', 'Stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /\/hooks/);
});

test('a broken hook registry never breaks the link check', async () => {
  const s = await linkStatus({
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => { throw new Error('registry unreadable'); },
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.hooks.state, 'unknown');
});

// The top-level `state` is the DEFAULT account's, so on a machine with two rows and no usable
// credentials it reads NOT_LINKED — and both sentences then told the user their machine was not
// linked, while lib/me.mjs printed "2 accounts linked" one line above and lib/mcp-bridge.mjs
// answered DEFAULT_UNUSABLE_MESSAGE for the very same machine.
test('rows in the index with none reporting is not "this machine is not linked"', async () => {
  const SECOND = { ...ROW, key: '99887766', email: 'two@e.f' };
  const s = await linkStatus({
    listAccounts: async () => [ROW, SECOND],
    getDefaultKey: async () => ROW.key,
    getAccessToken: async () => null,
    whoami: async () => { throw new Error('no token, so no whoami'); },
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart'] }),
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.NOT_LINKED, 'the default account still has no token');
  for (const text of [describeLink(s), describeReporting(s)]) {
    assert.doesNotMatch(text, /this machine is not linked/i, `"${text}" contradicts the index`);
    assert.match(text, /can report just now/);
  }
  assert.match(describeLink(s), /Sign in again to re-arm one/);
  assert.match(describeReporting(s), /NOT being reported/);
});

test('an empty index still says the machine is not linked', async () => {
  const s = await linkStatus({
    listAccounts: async () => [],
    getDefaultKey: async () => null,
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.NOT_LINKED);
  assert.match(describeLink(s), /This machine is not linked to Beezi/);
  assert.match(describeReporting(s), /this machine is not linked/);
});

test('no message names a slash command Codex does not have', async () => {
  for (const state of Object.values(LinkState)) {
    const s = { state, account: null, apiBase: 'https://api.test/api', hooks: { state: 'absent', registered: [] } };
    for (const text of [describeLink(s), describeReporting(s)].filter(Boolean)) {
      assert.ok(!/\/beezi:/.test(text), `"${text}" names a command that does not exist`);
    }
  }
});

// Dead registry entries reach every reporting surface.
//
// The measured failure this locks: a machine whose own hooks were complete was told "hooks are
// installed, trust them" while three OTHER entries in the same registry failed on every session.
// `state` could not say so — it is owner-scoped — so the warning has to be orthogonal to it and
// has to survive every branch of describeReporting, not just the unhappy ones.

const DEAD_TWO = [
  { event: 'SessionStart', owner: 'beezi', target: 'C:\gone\beezi-session-start.cmd' },
  { event: 'Stop', owner: 'beezi', target: 'C:\gone\beezi-stop.cmd' },
];

test('a healthy machine is still told about dead entries it does not own', async () => {
  const s = await linkStatus({
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart', 'Stop'], broken: DEAD_TWO }),
    apiBase: 'https://api.test/api',
  });
  const text = describeReporting(s);
  // Both halves, in one answer: ours are fine, and something in the registry is failing anyway.
  assert.match(text, /hooks are installed/i);
  assert.match(text, /2 registered hook entries point at a file that no longer exists/);
  assert.match(text, /SessionStart, Stop/);
  // The repair is ours to do, not the user's to run — every surface that reads this heals the
  // install before it reports. What is still quoted is the read-only path listing, and it has to be
  // runnable from the user's cwd (their repo, not the plugin root): this message reaches the
  // beezi_status MCP tool, whose reader will try to run what it is told.
  assert.match(text, /removed automatically/);
  assert.match(text, /node "[^"]*hooks\.mjs" status/);
  assert.doesNotMatch(text, /Run node "[^"]*hooks\.mjs" install/);
  assert.doesNotMatch(text, /<plugin>/);
});

test('the dead-entry warning survives every branch, including the ones that return early', async () => {
  const hooksStatus = () => ({ state: 'installed', registered: [], broken: DEAD_TWO });
  const cases = [
    { getAccessToken: async () => null },
    { getAccessToken: async () => 'tok', whoami: async () => ({ valid: false }) },
    { getAccessToken: async () => 'tok', whoami: async () => null },
    { getAccessToken: async () => 'tok', whoami: async () => ({ valid: true }) },
  ];
  for (const overrides of cases) {
    const s = await linkStatus({ ...ONE, whoami: async () => ({ valid: true }), ...overrides, hooksStatus, apiBase: 'https://api.test/api' });
    assert.match(describeReporting(s), /no longer exists/, JSON.stringify(s.state));
  }
});

test('a singular dead entry is phrased as one, and a clean registry adds nothing', async () => {
  const one = await linkStatus({
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: [], broken: [DEAD_TWO[0]] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(one), /1 registered hook entry points/);

  const none = await linkStatus({
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: [], broken: [] }),
    apiBase: 'https://api.test/api',
  });
  assert.doesNotMatch(describeReporting(none), /no longer exists/);
});

test('a hooksStatus that predates `broken` is read as "none", not as a crash', async () => {
  const s = await linkStatus({
    ...ONE,
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['Stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.deepEqual(s.hooks.broken, []);
  assert.doesNotMatch(describeReporting(s), /no longer exists/);
});

// ─── several accounts: one verdict each, and no aggregate that could hide one ─────────────────

test('every linked account gets its own verdict, and the default one is the headline', async () => {
  const rows = [
    { key: 'a1b2c3d4', name: 'Dev', clientId: 'c-a', status: 'linked' },
    { key: '99887766', name: 'Ops', clientId: 'c-b', status: 'linked' },
  ];
  const s = await linkStatus({
    listAccounts: async () => rows,
    getDefaultKey: async () => '99887766',
    getAccessToken: async (key) => (key === '99887766' ? 'tok-b' : 'tok-a'),
    whoami: async (session) => (session.token === 'tok-b'
      ? { valid: true, name: 'Ops' }
      : { valid: false }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });

  assert.equal(s.defaultKey, '99887766');
  assert.equal(s.state, LinkState.LINKED, 'the headline is the DEFAULT account, not the first row');
  assert.equal(s.account, 'Ops');
  assert.equal(s.accounts.length, 2);
  const revoked = s.accounts.find((one) => one.key === 'a1b2c3d4');
  assert.equal(revoked.state, LinkState.REVOKED,
    'a revoked sibling is reported as itself, never folded into one machine-wide answer');
});

// The client id travels with the bearer: a whoami made with another account's id would bind the
// wrong machine row on the portal's linked-machines page.
test('each account is checked with its own client id', async () => {
  const seen = [];
  await linkStatus({
    listAccounts: async () => [
      { key: 'a1b2c3d4', clientId: 'c-a', status: 'linked' },
      { key: '99887766', clientId: 'c-b', status: 'linked' },
    ],
    getDefaultKey: async () => 'a1b2c3d4',
    getAccessToken: async () => 'tok',
    whoami: async (session) => { seen.push(session.clientId); return { valid: true }; },
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.deepEqual(seen, ['c-a', 'c-b']);
});
