import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderList } from '../lib/accounts-cli.mjs';
import { CRASH_MODES } from '../lib/diagnostics.mjs';
import { keysLines } from '../lib/settings-cli.mjs';
import { lastLine, parsePlaces, parseWorkspaces, token } from '../lib/setup-routing.mjs';
import {
  ACCOUNT_LINE, CRASH_CHOICES, FINALIZED, LINKED_AS, PLAN_EXPIRED, STILL_DEFAULT, TIER_CHOICES, TRUST_PENDING,
  crashModeOf, parseLinkedAccounts, planSettled,
} from '../lib/setup-wizard.mjs';
import { linkAccount, makeHome } from '../tools/account-fixtures.mjs';

// The terminal setup branches on other scripts' output text. Each row is two-sided: the script still prints the fragment, and the setup still reads a line of that shape.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEY = 'a1b2c3d4';

// [file that prints it, the fragment it must still print, a line of that shape, what the setup reads from it]
const LINES = [
  [['scripts', 'login.mjs'], 'account=${result.key}', `account=${KEY}`,
    (line) => ACCOUNT_LINE.exec(line)[1] === KEY],
  [['scripts', 'login.mjs'], 'linked as ${who}. Credentials stored in',
    '✓ Beezi analytics re-linked as Ann - Acme. Credentials stored in the macOS keychain.',
    (line) => LINKED_AS.exec(line)[1] === 'Ann - Acme'],
  [['scripts', 'login.mjs'], 'already linked as ${who}. Nothing changed',
    '✓ already linked as Ann. Nothing changed — the sign-in you just completed was handed back.',
    (line) => LINKED_AS.exec(line)[1] === 'Ann'],
  [['scripts', 'login.mjs'], 'The analytics skill still reads from this machine',
    "  The analytics skill still reads from this machine's default account.",
    (line) => STILL_DEFAULT.test(line)],
  [['scripts', 'login.mjs'], 'One step left — ${TRUST_STEP}',
    '  One step left — run /hooks in Codex, review the Beezi entries, and trust them.',
    (line) => TRUST_PENDING.test(line)],
  [['scripts', 'login.mjs'], 'If nothing arrives, ${TRUST_STEP}',
    '  Analytics hooks are installed. If nothing arrives, run /hooks in Codex, review the Beezi entries, and trust them.',
    (line) => TRUST_PENDING.test(line)],
  [['lib', 'hooks-install.mjs'], "export const TRUST_STEP = 'run /hooks in Codex, ",
    '    run /hooks in Codex, review the Beezi entries, and trust them.',
    (line) => TRUST_PENDING.test(line)],
  [['scripts', 'hooks.mjs'], 'If analytics still are not arriving, ${TRUST_STEP}.',
    '  If analytics still are not arriving, run /hooks in Codex, review the Beezi entries, and trust them.',
    (line) => TRUST_PENDING.test(line)],
  [['scripts', 'hooks.mjs'], '`    ${TRUST_STEP}.`',
    '    run /hooks in Codex, review the Beezi entries, and trust them.',
    (line) => TRUST_PENDING.test(line)],
  [['scripts', 'hooks.mjs'], 'there is NOTHING to re-trust — /hooks can stay closed.',
    '  The registry entries did not change, so there is NOTHING to re-trust — /hooks can stay closed.',
    (line) => !TRUST_PENDING.test(line)],
  [['scripts', 'billing-capture.mjs'], "✓ Beezi billing captured: source=${config.source} plan=${orDefault(config.plan, 'n/a')}${capturedVia}.",
    '✓ Beezi billing captured: source=subscription plan=pro_5x via=app-server.',
    (line) => planSettled(line)],
  [['scripts', 'billing-capture.mjs'], 'your Codex sign-in expired on ${on}',
    'Beezi: your Codex sign-in expired on 2026-09-30, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.',
    (line) => PLAN_EXPIRED.test(line)],
  [['scripts', 'backfill.mjs'], '✓ Beezi: your history pull is finalized.', '✓ Beezi: your history pull is finalized.',
    (line) => FINALIZED.test(line)],
  [['lib', 'settings-cli.mjs'], 'crash=${crashMode()}', 'crash=anonymous',
    (line) => crashModeOf(line) === 'anonymous'],
  [['lib', 'workspace-cli.mjs'], "new-folders=${newFoldersNow.mode} set=${newFoldersNow.set ? 'yes' : 'no'} multi=yes account=${row.key}",
    `new-folders=ask set=no multi=yes account=${KEY}`,
    (line) => token(lastLine(line, /^new-folders=/), 'set') === 'no'],
  [['lib', 'workspace-cli.mjs'], 'new-folders=n/a multi=no account=${row.key}', `new-folders=n/a multi=no account=${KEY}`,
    (line) => token(lastLine(line, /^new-folders=/), 'set') === null],
  [['lib', 'workspace-cli.mjs'], 'W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}',
    `W. Acme Team account=${KEY} tenant=t1 role=Owner`,
    (line) => parseWorkspaces(line)[0].name === 'Acme Team' && parseWorkspaces(line)[0].tenant === 't1'],
  [['lib', 'workspace-cli.mjs'], "new=${newIds.indexOf(t.id) === -1 ? 'no' : 'yes'} role=${roleLabel(t)}",
    `W. Beta account=${KEY} tenant=t2 new=yes role=`,
    (line) => parseWorkspaces(line)[0].isNew === true],
  [['lib', 'workspace-cli.mjs'], 'P${total}. ${labeled(g)}, ${sessionsCount(g.sessions)} account=${row.key} kind=${g.kind} match=${g.match}',
    `P1. My docs (~/My docs), 2 sessions account=${KEY} kind=folder match=/Users/dev/My docs`,
    (line) => parsePlaces(line, 'P')[0].match === '/Users/dev/My docs'],
  [['lib', 'workspace-cli.mjs'], 'J${total}. ${labeled(place)}, ${sessionsCount(place.sessions)}, now: ${where} account=${row.key} kind=${place.kind} match=${place.match} now=${',
    `J1. api (github.com/acme/api), 1 session, now: Acme account=${KEY} kind=repo match=github.com/acme/api now=t1`,
    (line) => parsePlaces(line, 'J')[0].where === 'Acme' && parsePlaces(line, 'J')[0].match === 'github.com/acme/api'],
];

// Shapes setup-routing splits on whose reading its own tests already cover.
const SHAPES = [
  "return key.kind === 'outside' ? shortLabel(key) : `${shortLabel(key)} (${key.label})`;",
  "return `${n} session${n === 1 ? '' : 's'}`;",
  ': you joined ${joinTenantNames(row, newIds)} — ${count} to review account=${row.key}',
  "'1 other past session has no recorded folder and is not sent.'",
  '`${lost} other past sessions have no recorded folder and are not sent.`',
];

// The argv setup-routing builds, as workspace.mjs documents it.
const USAGE = [
  ' | rule add (--current | --repo <url> | --folder <path> | --outside) (<id|name|n>… | none) [--session <id>] [--account <ref>]',
  ' | rule add-all (<id|name|n>… | none) [--session <id>] [--account <ref>]',
  ' | routes [--session <id>] [--account <ref>]',
  ' | joined [add-all | done | pick (--repo <url> | --folder <path> | --outside) <id|name|n>] [--session <id>] [--account <ref>]',
  ' | new-folders [ask | send <id|name|n>… | none] [--session <id>] [--account <ref>]',
];

test('every line the setup reads is still printed in that shape, and the setup still reads it', () => {
  for (const [file, fragment, sample, reads] of LINES) {
    assert.ok(read(...file).includes(fragment), `${file.join('/')} should still print "${fragment}"`);
    assert.ok(reads(sample), `the setup no longer reads "${sample}"`);
  }
});

test('the place shapes and summary lines setup-routing relies on are unchanged', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  for (const fragment of SHAPES) assert.ok(cli.includes(fragment), fragment);
});

test('workspace.mjs still takes the argv the setup builds', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  for (const usage of USAGE) assert.ok(cli.includes(usage), usage);
  assert.ok(cli.includes("if (sub === 'pick') { await joinedPick(cx, after); return; }"), 'joined pick dispatch');
  assert.ok(cli.includes('J${total}-command=${script} joined pick ${ruleTargetFlag(place)} --account ${row.key}${deferText(cx)} <tenant>'), 'J-command is joined pick');
  assert.ok(cli.includes('done-command=${script} joined done --account ${row.key}${deferText(cx)}'), 'done-command carries the defer flag');
});

test('every sign-in failure exits non-zero, so the setup needs no failure text of its own', () => {
  const login = read('scripts', 'login.mjs');
  assert.match(login, /if \(!cliMayProceed\(\)\) \{ process\.exitCode = 1; return; \}/);
  assert.match(login, /console\.error\(`\\n✗ \$\{friendlyMessage\(error\)\}`\);\r?\n {2}process\.exit\(1\);/);
});

test('hooks.mjs install still goes through ensureHooks and heads each outcome with ✓, ⚠ or the busy line', () => {
  const hooks = read('scripts', 'hooks.mjs');
  for (const fragment of [
    "if (action === 'install') return runInstall(force);",
    'const result = ensureHooks();',
    "console.log('✓ Beezi: analytics hooks are already installed and current — nothing to change.');",
    "console.log('✓ Beezi: analytics hooks updated to this plugin version.');",
    '? `✓ Beezi: analytics hooks installed in ${result.status.hooksFile}`',
    '`⚠ Beezi: ${status.broken.length} registered hook entr',
    'if (result.skipped) return reportBusy();',
    "console.log('Beezi: another Beezi process is updating the hook registry right now",
  ]) assert.ok(hooks.includes(fragment), fragment);
});

test('accounts.mjs list rows read back as the accounts the setup offers', async (t) => {
  const home = makeHome(t);
  linkAccount(home, 'a1b2c3d4', { name: 'Ann', email: 'ann@example.com', tenantName: 'Acme' });
  linkAccount(home, '99887766', { name: 'Bob', email: 'bob@example.com', tenantName: 'Beta - EU', status: 'revoked' });
  const offline = { run: () => { throw new Error('the list must not touch the credential store'); } };
  assert.deepEqual(parseLinkedAccounts(await renderList(offline)), [
    { description: 'Ann <ann@example.com> - Acme', key: 'a1b2c3d4', isDefault: true, revoked: false },
    { description: 'Bob <bob@example.com> - Beta - EU', key: '99887766', isDefault: false, revoked: true },
  ]);
});

test('settings.mjs keys still carries the crash= line the setup reads', async (t) => {
  const home = makeHome(t);
  linkAccount(home, 'a1b2c3d4');
  assert.equal(crashModeOf((await keysLines({})).join('\n')), CRASH_MODES.OFF);
});

test("the tier question offers the login skill's table, label for label and value for value", () => {
  const skill = read('skills', 'login', 'SKILL.md');
  assert.ok(skill.includes('How does this machine pay for Codex: '));
  for (const choice of TIER_CHOICES) {
    assert.match(skill, new RegExp(`\\| ${escapeRe(choice.label)} +\\| \`${choice.value}\` +\\|`), choice.label);
  }
});

test("the crash question is the settings skill's four-way sentence, one choice per telemetry mode", () => {
  const sentence = read('skills', 'settings', 'SKILL.md').replace(/\r?\n> /g, ' ');
  assert.ok(sentence.includes('How should Beezi crash reports work: '));
  for (const choice of CRASH_CHOICES) {
    const words = choice.mode === CRASH_MODES.CORRELATE
      ? `Correlate (recommended; ${choice.description})`
      : `${choice.label} (${choice.description})`;
    assert.ok(sentence.includes(words), words);
  }
  assert.deepEqual(CRASH_CHOICES.map((choice) => choice.mode), Object.values(CRASH_MODES));
});
