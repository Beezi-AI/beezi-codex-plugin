import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultQuestion, runSetup } from '../lib/setup-wizard.mjs';
import { failed, fakeCtx, ok } from '../tools/setup-fixtures.mjs';

const KEY = 'a1b2c3d4';
const ACCOUNT = `--account ${KEY}`;
const NEW_FOLDERS = `workspace.mjs new-folders ${ACCOUNT}`;
const CAPTURE = `billing-capture.mjs --from-codex --via login ${ACCOUNT}`;
const JOINED = `workspace.mjs joined ${ACCOUNT}`;
const ROUTES = `workspace.mjs routes ${ACCOUNT}`;
const BACKFILL = `backfill.mjs --via login ${ACCOUNT}`;
const KEYS = 'settings.mjs keys';
const HOOKS = 'hooks.mjs install';
const PLUS = '✓ Beezi billing captured: source=subscription plan=plus via=app-server.';
const PLAN_PROGRESS = '==> Checking your plan…';
const SESSIONS_PROGRESS = '==> Looking at your past sessions…';
const TRUST_NOTE = 'One step left in Codex: run /hooks and trust the Beezi entries.';
const FINALIZE_NOTE = 'History import is now closed for this account: past sessions on other machines can no longer be imported. New sessions are still tracked everywhere Beezi is installed.';
const DEFAULT_UNCHANGED = 'The default account is unchanged. The settings skill (Account → Default account) switches it later.';
const HOOKS_INSTALLED = ['', '  Analytics hooks installed for you.', '  One step left — run /hooks in Codex, review the Beezi entries, and trust them.'];
const STILL_READS = ["  The analytics skill still reads from this machine's default account.", ...HOOKS_INSTALLED];
const HOOKS_CURRENT = [
  '✓ Beezi: analytics hooks are already installed and current — nothing to change.',
  '  Registry: /home/dev/.codex/hooks.json',
  '  Events:   SessionStart, Stop',
  '  Left untouched on purpose: a rewrite would change each hook’s hash and revoke the trust you already granted.',
  '  If analytics still are not arriving, run /hooks in Codex, review the Beezi entries, and trust them.',
  '',
].join('\n');
const HOOKS_REFRESHED = [
  '✓ Beezi: analytics hooks updated to this plugin version.',
  '  Launcher: /home/dev/.codex/beezi/hook-launcher.mjs',
  '  The registry entries did not change, so there is NOTHING to re-trust — /hooks can stay closed.',
  '',
].join('\n');
const HOOKS_REPAIRED = [
  '✓ Beezi: analytics hooks repaired in /home/dev/.codex/hooks.json (was stale).',
  '  Events: SessionStart, Stop',
  '',
  '  One more step — Codex will not run a hook it has not been shown:',
  '    run /hooks in Codex, review the Beezi entries, and trust them.',
  '',
  '⚠ Beezi: 1 registered hook entry points at a file that no longer exists.',
  '  Codex runs these every session and every run fails — check `hook: <Event> Failed`.',
  '',
].join('\n');
const W = [`W. Acme account=${KEY} tenant=t1 role=Owner`, `W. Beta account=${KEY} tenant=t2 role=Member`];
const LINKED = ok(`Beezi: 1 account linked. The default is the account the analytics skill reads from.\n  1. Ann <ann@example.com> - Acme [${KEY}]  (default)\n`);

function signInOutput(extra) {
  return ok([
    '',
    'Beezi analytics — link this machine',
    '',
    'Opening your browser to sign in with your Beezi account…',
    'If it does not open, go to:',
    '  https://auth.example.com/authorize?client=1',
    '',
    '',
    '✓ Beezi analytics linked as Ann <ann@example.com> - Acme. Credentials stored in the macOS keychain.',
    ...extra,
    `account=${KEY}`,
    '',
  ].join('\n'));
}

function flow(over) {
  return {
    'accounts.mjs list': ok('No Beezi accounts are linked on this machine.\n'),
    'login.mjs': signInOutput(HOOKS_INSTALLED),
    [HOOKS]: ok(HOOKS_CURRENT),
    [NEW_FOLDERS]: ok(`new-folders=n/a multi=no account=${KEY}\n`),
    [CAPTURE]: ok(`${PLUS}\n`),
    [JOINED]: ok('joined=0\n'),
    [ROUTES]: ok('routes=0\n'),
    [BACKFILL]: ok('Beezi: 3/3 sessions read…\n✓ Beezi: uploaded 3 sessions (3 reports stored).\n'),
    [KEYS]: ok(`menu=Rules|Account|Crash reports\naccount=${KEY} default=yes multi=no workspaces=1 status=linked email=ann@example.com\ncrash=correlate\n`),
    ...over,
  };
}
const FRESH_RUNS = ['accounts.mjs list', 'login.mjs', NEW_FOLDERS, CAPTURE, JOINED, ROUTES, BACKFILL, KEYS];
const CONTINUE_RUNS = ['accounts.mjs list', HOOKS, NEW_FOLDERS, CAPTURE, JOINED, ROUTES, BACKFILL, KEYS];

function joinedListing(n) {
  const lines = [`ann@example.com: you joined Beta — ${n} repos or folders to review account=${KEY} new=t2`,
    `W. Acme account=${KEY} tenant=t1 new=no role=Owner`, `W. Beta account=${KEY} tenant=t2 new=yes role=Member`];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`J${i}. r${i} (github.com/acme/r${i}), 1 session, now: Acme account=${KEY} kind=repo match=github.com/acme/r${i} now=t1`);
  }
  lines.push(`joined=${n}`);
  return ok(lines.join('\n'));
}

test('a fresh single-workspace link runs every step in order and ends with the Codex trust step', async () => {
  const ctx = fakeCtx(flow({}), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, FRESH_RUNS);
  assert.deepEqual(ctx.opts['login.mjs'], { stream: true, hide: /^account=/ });
  assert.deepEqual(ctx.opts[BACKFILL], { stream: true });
  assert.deepEqual(ctx.asked.map((a) => a.question), ['How should Beezi crash reports work?']);
  assert.deepEqual(ctx.printed, [PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, '', TRUST_NOTE]);
});

test('a multi-workspace account answers New folders, then joined workspaces, then repos with no rule, before the upload', async () => {
  const ctx = fakeCtx(flow({
    [NEW_FOLDERS]: ok(['New folders: Ask me', ...W, `new-folders=ask set=no multi=yes account=${KEY}`, ''].join('\n')),
    [`workspace.mjs new-folders ask ${ACCOUNT} --defer-upload`]: ok('✓ New folders: Ask me — Beezi asks once per repo or folder.\nnew-folders=ask\n'),
    [JOINED]: joinedListing(5),
    [`workspace.mjs joined add-all ${ACCOUNT} --defer-upload`]: ok('✓ Beta now gets analytics from 5 repos and folders.\nrules-added=5\n'),
    [ROUTES]: ok([
      `ann@example.com: 1 repo or folder has past sessions with no rule (2 sessions) account=${KEY}`,
      ...W,
      `P1. api (github.com/acme/api), 2 sessions account=${KEY} kind=repo match=github.com/acme/api`,
      `P1-command=node "/p/scripts/workspace.mjs" rule add --repo 'github.com/acme/api' ${ACCOUNT} <tenants>`,
      `all-command=node "/p/scripts/workspace.mjs" rule add-all ${ACCOUNT} <tenants>`,
      '1 other past session has no recorded folder and is not sent.',
      'routes=1',
    ].join('\n')),
    [`workspace.mjs rule add --repo github.com/acme/api ${ACCOUNT} t2 --defer-upload`]: ok('✓ Analytics for api go to Beta.\nrule=1\n'),
  }), [0, 0, [1]]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, [
    'accounts.mjs list', 'login.mjs',
    NEW_FOLDERS, `workspace.mjs new-folders ask ${ACCOUNT} --defer-upload`,
    CAPTURE,
    JOINED, `workspace.mjs joined add-all ${ACCOUNT} --defer-upload`,
    ROUTES, `workspace.mjs rule add --repo github.com/acme/api ${ACCOUNT} t2 --defer-upload`,
    BACKFILL, KEYS,
  ]);
  assert.deepEqual(ctx.asked.map((a) => a.question), [
    'Where should analytics go for repos and folders with no rule yet?',
    'You joined Beta. Where should analytics for these 5 repos and folders go? Their past sessions will be sent there too.',
    '(1 of 1) Where should analytics for api go?',
    'How should Beezi crash reports work?',
  ]);
  assert.deepEqual(ctx.printed, [
    '✓ New folders: Ask me — Beezi asks once per repo or folder.',
    PLAN_PROGRESS,
    PLUS,
    SESSIONS_PROGRESS,
    '✓ Beta now gets analytics from 5 repos and folders.',
    '1 other past session has no recorded folder and is not sent.',
    '✓ Analytics for api go to Beta.',
    '', TRUST_NOTE,
  ]);
});

test('an unknown ChatGPT plan is asked as the tier and recorded before the workspace questions', async () => {
  const PLAN = `billing-capture.mjs --plan plus --via login-user ${ACCOUNT}`;
  const ctx = fakeCtx(flow({
    [CAPTURE]: ok('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.\n'),
    [PLAN]: ok('✓ Beezi billing captured: source=subscription plan=plus.\n'),
  }), [1]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, ['accounts.mjs list', 'login.mjs', NEW_FOLDERS, CAPTURE, PLAN, JOINED, ROUTES, BACKFILL, KEYS]);
  assert.equal(ctx.asked[0].question, 'How does this machine pay for Codex?');
});

test('continuing with a linked account skips the sign-in and the default-account offer, and re-checks the hooks instead', async () => {
  const ctx = fakeCtx(flow({ 'accounts.mjs list': LINKED }), [0]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, CONTINUE_RUNS);
  assert.deepEqual(ctx.opts[HOOKS], {});
  assert.deepEqual(ctx.asked.map((a) => a.kind), ['choose', 'choose']);
  assert.deepEqual(ctx.printed, [
    '✓ Beezi: analytics hooks are already installed and current — nothing to change.',
    PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, '', TRUST_NOTE,
  ]);
});

test('on Continue the trust step follows the hooks output: none after a launcher refresh, and ✓/⚠ lines only after a repair', async () => {
  const refreshed = fakeCtx(flow({ 'accounts.mjs list': LINKED, [HOOKS]: ok(HOOKS_REFRESHED) }), [0]);
  assert.equal(await runSetup(refreshed), 0);
  assert.deepEqual(refreshed.printed, [
    '✓ Beezi: analytics hooks updated to this plugin version.',
    PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS,
  ]);
  const repaired = fakeCtx(flow({ 'accounts.mjs list': LINKED, [HOOKS]: ok(HOOKS_REPAIRED) }), [0]);
  assert.equal(await runSetup(repaired), 0);
  assert.deepEqual(repaired.printed, [
    '✓ Beezi: analytics hooks repaired in /home/dev/.codex/hooks.json (was stale).',
    '⚠ Beezi: 1 registered hook entry points at a file that no longer exists.',
    PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, '', TRUST_NOTE,
  ]);
});

test('a failing hooks check on Continue is reported and the setup carries on', async () => {
  const ctx = fakeCtx(flow({
    'accounts.mjs list': LINKED,
    [HOOKS]: failed('\n✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n'),
  }), [0]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, CONTINUE_RUNS);
  assert.deepEqual(ctx.printed, [
    '✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.',
    PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS,
  ]);
});

test('Link another account signs in and carries on with the key it printed', async () => {
  const ctx = fakeCtx(flow({ 'accounts.mjs list': LINKED }), [1]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, FRESH_RUNS);
});

test('a failed sign-in stops the setup with exit 1 and runs nothing after it', async () => {
  for (const login of [
    { code: 1, stdout: 'Opening your browser to sign in with your Beezi account…\n', stderr: '\n✗ Could not reach the Beezi server. Check your internet connection and try again.\n' },
    failed("✗ Beezi is migrating this machine's data to the production namespace. Try again in a moment.\n"),
  ]) {
    const ctx = fakeCtx(flow({ 'login.mjs': login }), []);
    assert.equal(await runSetup(ctx), 1);
    assert.deepEqual(ctx.runs, ['accounts.mjs list', 'login.mjs']);
    assert.deepEqual(ctx.printed, []);
    assert.equal(ctx.asked.length, 0);
  }
});

// Mirrors Enter at the real prompt: a choose answers its default, or null (dismissed) when it has none.
function pressEnter(ctx) {
  ctx.ask.choose = (question, options, extra) => {
    ctx.asked.push({ kind: 'choose', question, options });
    return Promise.resolve(extra && typeof extra.defaultIndex === 'number' ? extra.defaultIndex : null);
  };
  ctx.ask.confirm = (question, defaultYes) => {
    ctx.asked.push({ kind: 'confirm', question, defaultYes });
    return Promise.resolve(defaultYes);
  };
  return ctx;
}

test('re-running setup on a configured machine and pressing Enter everywhere signs nothing in and changes nothing', async () => {
  const ctx = pressEnter(fakeCtx(flow({
    'accounts.mjs list': LINKED,
    [NEW_FOLDERS]: ok([...W, `new-folders=ask set=yes multi=yes account=${KEY}`, ''].join('\n')),
    [BACKFILL]: ok('✓ Beezi: nothing new to upload.\n'),
  }), []));
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, [...CONTINUE_RUNS, 'telemetry.mjs correlate']);
  assert.deepEqual(ctx.asked.map((a) => a.question), [
    'This machine is already linked to Beezi. Which account should setup use?',
    'How should Beezi crash reports work?',
  ]);
});

for (const [outcome, line] of [
  ['no-account', 'Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.'],
  ['kept-self-reported', 'Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.'],
]) {
  test(`re-running setup when the capture is ${outcome} and pressing Enter everywhere skips the tier question and still asks about crash reports`, async () => {
    const ctx = pressEnter(fakeCtx(flow({
      'accounts.mjs list': LINKED,
      [CAPTURE]: ok(`${line}\n`),
      [BACKFILL]: ok('✓ Beezi: nothing new to upload.\n'),
    }), []));
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(ctx.runs, [...CONTINUE_RUNS, 'telemetry.mjs correlate']);
    assert.equal(ctx.runs.some((command) => command.startsWith('billing-capture.mjs --plan')), false);
    assert.deepEqual(ctx.asked.map((a) => a.question), [
      'This machine is already linked to Beezi. Which account should setup use?',
      'How does this machine pay for Codex?',
      'How should Beezi crash reports work?',
    ]);
    assert.deepEqual(ctx.printed.slice(1, 5), [PLAN_PROGRESS, line, 'No plan was saved. Your Beezi link itself already succeeded.', SESSIONS_PROGRESS]);
  });
}

test('a busy hook registry on Continue prints its first line only and no trust step', async () => {
  const busy = [
    'Beezi: another Beezi process is updating the hook registry right now — nothing was changed.',
    '  It is writing the same entries. Re-run this in a moment to see the result.',
    '',
  ].join('\n');
  const ctx = fakeCtx(flow({ 'accounts.mjs list': LINKED, [HOOKS]: ok(busy) }), [0]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed, [
    'Beezi: another Beezi process is updating the hook registry right now — nothing was changed.',
    PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS,
  ]);
});

test('a dismissed account question stops the setup with exit 1 and runs nothing after the list', async () => {
  const ctx = fakeCtx(flow({ 'accounts.mjs list': LINKED }), [null]);
  assert.equal(await runSetup(ctx), 1);
  assert.deepEqual(ctx.runs, ['accounts.mjs list']);
});

test('a failing later step is reported and the setup carries on', async () => {
  const ctx = fakeCtx(flow({
    [NEW_FOLDERS]: failed('\n✗ No such linked account.\n'),
    [BACKFILL]: failed('✗ Beezi: upload stopped — could not reach the server (fetch failed). Run the Beezi login skill again to continue where it left off.\n'),
  }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.runs, FRESH_RUNS);
  assert.deepEqual(ctx.printed, ['✗ No such linked account.', PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, '', TRUST_NOTE]);
});

test('the crash question marks the current mode as the default, and keeping it still runs telemetry.mjs', async () => {
  const ON = 'Beezi diagnostics are ON. Crash reports about the plugin will be sent — never your code or prompts. Reports are anonymous — no installation ID is attached. Recommended: choose Correlate in the settings skill — it attaches one so support can find your report.';
  const ctx = fakeCtx(flow({ [KEYS]: ok('menu=Account|Crash reports\ncrash=on\n'), 'telemetry.mjs on': ok(`${ON}\n`) }), [1]);
  await runSetup(ctx);
  const question = ctx.asked[0];
  assert.equal(question.question, 'How should Beezi crash reports work?');
  assert.equal(question.defaultIndex, 1);
  assert.deepEqual(question.options, [
    { label: 'Correlate (recommended)', description: 'attaches an installation ID so support can find your report' },
    { label: 'On', description: 'sends reports without an installation ID and leaves that choice open, current setting' },
    { label: 'Anonymous', description: 'sends reports without an installation ID and never offers one again' },
    { label: 'Off', description: 'sends nothing and deletes pending reports' },
  ]);
  assert.deepEqual(ctx.runs.slice(-2), [KEYS, 'telemetry.mjs on']);
  assert.deepEqual(ctx.printed.slice(-3), [ON, '', TRUST_NOTE]);
});

test('a different crash mode runs telemetry.mjs once and prints its line; a dismissal runs nothing', async () => {
  const ctx = fakeCtx(flow({
    [KEYS]: ok('crash=off\n'),
    'telemetry.mjs correlate': ok('Beezi diagnostics are ON with account correlation. An installation ID is attached.\n'),
  }), [0]);
  await runSetup(ctx);
  assert.deepEqual(ctx.runs.slice(-2), [KEYS, 'telemetry.mjs correlate']);
  assert.deepEqual(ctx.printed.slice(-3), [
    'Beezi diagnostics are ON with account correlation. An installation ID is attached.', '', TRUST_NOTE,
  ]);
  const dismissed = fakeCtx(flow({ [KEYS]: ok('crash=off\n') }), []);
  await runSetup(dismissed);
  assert.equal(dismissed.asked.length, 1);
  assert.equal(dismissed.runs.some((command) => command.startsWith('telemetry.mjs')), false);
});

test('the crash question is skipped when the current mode cannot be read', async () => {
  const refused = fakeCtx(flow({ [KEYS]: failed('✗ Beezi: the data root could not be checked.\n') }), []);
  await runSetup(refused);
  assert.equal(refused.asked.length, 0);
  assert.ok(refused.printed.includes('✗ Beezi: the data root could not be checked.'));
  const silent = fakeCtx(flow({ [KEYS]: ok('menu=Account|Crash reports\n') }), []);
  await runSetup(silent);
  assert.equal(silent.asked.length, 0);
  assert.equal(silent.printed.includes('menu=Account|Crash reports'), false);
});

test('a sign-in that left another default offers to switch it, default No, streams accounts use on yes and says so on no', async () => {
  const yes = fakeCtx(flow({ 'login.mjs': signInOutput(STILL_READS) }), [true]);
  await runSetup(yes);
  const confirm = yes.asked[0];
  assert.deepEqual([confirm.kind, confirm.question, confirm.defaultYes],
    ['confirm', 'Make Ann <ann@example.com> (Acme) the account the analytics skill reads from?', false]);
  assert.deepEqual(yes.runs.slice(-3), [BACKFILL, `accounts.mjs use ${KEY}`, KEYS]);
  assert.deepEqual(yes.opts[`accounts.mjs use ${KEY}`], { stream: true });
  assert.equal(yes.printed.includes(DEFAULT_UNCHANGED), false);
  const no = fakeCtx(flow({ 'login.mjs': signInOutput(STILL_READS) }), [false]);
  await runSetup(no);
  assert.equal(no.runs.includes(`accounts.mjs use ${KEY}`), false);
  assert.deepEqual(no.printed, [PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, DEFAULT_UNCHANGED, '', TRUST_NOTE]);
  const dismissed = fakeCtx(flow({ 'login.mjs': signInOutput(STILL_READS) }), []);
  await runSetup(dismissed);
  assert.equal(dismissed.printed.includes(DEFAULT_UNCHANGED), false);
});

test('a finalized upload adds the finalize note, and an already-installed hook still gets the trust step', async () => {
  const ctx = fakeCtx(flow({
    'login.mjs': signInOutput(['  Analytics hooks are installed. If nothing arrives, run /hooks in Codex, review the Beezi entries, and trust them.']),
    [BACKFILL]: ok('✓ Beezi: uploaded 3 sessions (3 reports stored).\n✓ Beezi: your history pull is finalized.\n'),
  }), []);
  await runSetup(ctx);
  assert.deepEqual(ctx.printed, [PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS, FINALIZE_NOTE, '', TRUST_NOTE]);
});

test('no trust step is printed when the sign-in did not report the hooks', async () => {
  const ctx = fakeCtx(flow({ 'login.mjs': signInOutput(['  Another Beezi process is updating the hook registry; it will be current in a moment.']) }), []);
  await runSetup(ctx);
  assert.deepEqual(ctx.printed, [PLAN_PROGRESS, PLUS, SESSIONS_PROGRESS]);
});

test('defaultQuestion names the account and its workspace the way the sign-in printed them', () => {
  assert.equal(defaultQuestion('✓ Beezi analytics linked as Ann <ann@example.com> - Acme. Credentials stored in the macOS keychain.'),
    'Make Ann <ann@example.com> (Acme) the account the analytics skill reads from?');
  assert.equal(defaultQuestion('✓ Beezi analytics re-linked as Ann. Credentials stored in Windows Credential Manager.'),
    'Make Ann the account the analytics skill reads from?');
  assert.equal(defaultQuestion('✓ already linked as ann@example.com - Acme. Nothing changed — the sign-in you just completed was handed back.'),
    'Make ann@example.com (Acme) the account the analytics skill reads from?');
  assert.equal(defaultQuestion(''), 'Make this account the account the analytics skill reads from?');
});
