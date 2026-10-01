import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import { runAudit, SYNC_MODE } from '../lib/session-audit.mjs';
import { makeHome, accountSession } from '../tools/account-fixtures.mjs';

// G-9-3: the repeatable sync surface. Two halves — the script's flag policy, which is the
// MECHANICAL enforcement of "sync is not a way around the one-time import", and the skill that
// drives it, whose two boundary paragraphs are the reason a model does not reach for sync the
// moment backfill refuses.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncScript = path.join(pluginRoot, 'scripts', 'sync.mjs');
const skillFile = path.join(pluginRoot, 'skills', 'sync', 'SKILL.md');
const skill = fs.readFileSync(skillFile, 'utf-8');

// The flag refusals happen in parseSyncArgs, before runAudit and therefore before any token read,
// filesystem scan or request. The child still gets a sandbox home so a regression that moved the
// check later fails loudly here instead of reading the developer's machine.
function runScript(t, script, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-syncsurf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.HOME = home;
  env.USERPROFILE = home;
  env.BEEZI_CODEX_HOME = home;
  env.CODEX_HOME = path.join(home, '.codex');
  const res = withoutGuard(() => spawnSync(process.execPath, [script, ...args], {
    cwd: pluginRoot, encoding: 'utf-8', timeout: 60_000, env,
  }));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const runSync = (t, args) => runScript(t, syncScript, args);

test('sync — --since is refused with a reason, not silently honoured', (t) => {
  const res = runSync(t, ['--since', '2026-01-01']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --since/);
  // The reason matters: --since filters on when a session RAN, which excludes exactly the old
  // half-uploaded sessions the command exists to repair.
  assert.match(res.stderr, /uploads exactly what Beezi is missing/);
});

test('sync — --force is refused, and says there is no seal to force past', (t) => {
  const res = runSync(t, ['--force']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --force/);
  assert.match(res.stderr, /no one-time seal to force past/);
});

test('sync — a rejected flag is refused before anything is read or sent', (t) => {
  const res = runSync(t, ['--force']);
  // No progress line, no summary: the refusal is the entire run.
  assert.equal(res.stdout, '');
});

test('sync — --via is not accepted as a quiet alias for anything', (t) => {
  // --via is parsed but never read on Claude's sync path. It is not documented here, and passing
  // it must not be a way to smuggle a mode in.
  const res = runSync(t, ['--via', 'login', '--force']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --force/);
});

// ── the one-time import's surface must not misread a lock refusal ───────────────────────────

test('backfill — a busy run lock is never reported as "no past sessions found"', () => {
  const script = fs.readFileSync(path.join(pluginRoot, 'scripts', 'backfill.mjs'), 'utf-8');
  // Every lock outcome comes back with scanned === 0, so each one must be handled BEFORE the
  // scanned-zero summary or the login flow tells the user a false thing about their machine.
  const scannedZero = script.indexOf('result.scanned === 0');
  for (const branch of ["result.reason === 'run-in-progress'", "result.reason === 'lock-order'", 'BackfillHalt.LOCK_LOST']) {
    const at = script.indexOf(branch);
    assert.ok(at > -1, `scripts/backfill.mjs must handle ${branch}`);
    assert.ok(at < scannedZero, `${branch} must be handled before the scanned-zero summary`);
  }
  assert.match(script, /already running on this machine/);
});

// The one-time import is spent per account and cannot be given back, so there is no default to
// fall back to: a run with no --account would burn whichever account the fallback landed on.
test('backfill — a run with no --account is refused before anything is uploaded', (t) => {
  const res = runScript(t, path.join(pluginRoot, 'scripts', 'backfill.mjs'), []);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /backfill needs --account/);
  assert.equal(res.stdout, '', 'nothing is read or sent before the refusal');
});

// Two-sided: backfill now REQUIRES the flag, and the login skill is the caller that always passes
// it. Either half alone passes happily while the login flow is broken at step 4.
test('backfill — the login skill passes the --account the script requires', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'login', 'SKILL.md'), 'utf-8');
  assert.match(skill, /scripts\/backfill\.mjs" --via login --account <key>/);
  assert.match(
    fs.readFileSync(path.join(pluginRoot, 'scripts', 'backfill.mjs'), 'utf-8'),
    /parseAccountFlag/,
  );
});

// THE ASSERTION ABOVE IS NOT ENOUGH, and shipping it as if it were is how this broke: it greps for
// the step-4 command string, while the `beezi_login`-tool outcome that told the model to run the
// remaining steps without the flag sits ~118 lines ABOVE it. On the path a Codex model actually
// takes, step 4 would have refused outright.
//
// WHAT THIS TEST IS, EXACTLY — because overclaiming is what produced that defect:
//   · a real STRUCTURAL property: every line invoking the script carries the flag. Complete.
//   · an ENUMERATED phrasing guard for prose that tells a path to skip it. Prose cannot be pinned
//     completely; this covers without/skip/omit/drop/leave off/leave out/no within 20 characters of
//     the flag. It is a family, not a proof.
//   · the positive: the keyless branch names where a key comes from.
//
// TWO KNOWN IMPRECISIONS, both stated rather than engineered away:
//   · The window was 40 and is now 20, which stops `Never drop a step; always run step 4 with
//     \`--account <key>\`` — prose INSISTING on the flag — failing the test. Every ENUMERATED
//     phrasing that should be caught still is; only the gap between verb and flag narrowed.
//   · A verb sitting right next to the flag in insisting prose (`Never drop the \`--account\`
//     flag.`) still matches. Separating that from a real instruction needs negative lookbehind for
//     never/always/must/don't, which is more pattern than this is worth: the failure is loud, in
//     the safe direction, and a one-word edit clears it.
const SKIPS_ACCOUNT_FLAG = /(without|skip|omit|drop|leave off|leave out|no)\b[^.\n]{0,20}`?--account/i;

test('backfill — every login-skill invocation carries --account, and no enumerated phrasing tells a path to skip it', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'login', 'SKILL.md'), 'utf-8');

  const invocations = skill.split('\n').filter((line) => line.includes('scripts/backfill.mjs'));
  assert.ok(invocations.length > 0, 'the skill still runs the one-time import');
  for (const line of invocations) {
    assert.match(line, /--account/, `backfill is invoked without --account: ${line}`);
  }

  const skipped = skill.match(SKIPS_ACCOUNT_FLAG);
  assert.equal(
    skipped, null,
    `the skill tells a path to run without --account, where the one-time import refuses: ${skipped && skipped[0]}`,
  );

  assert.match(skill, /get a key before continuing/);
  assert.match(skill, /the `accounts` skill's list/);
});

// ── the skill ───────────────────────────────────────────────────────────────────────────────

test('skill — declares the frontmatter the plugin loader reads', () => {
  assert.match(skill, /^---\r?\nname: sync\r?\ndescription: /);
});

test('skill — runs exactly the one script, derived from its own location', () => {
  assert.match(skill, /<plugin-root>\/skills\/sync\/SKILL\.md/);
  assert.match(skill, /node "<plugin-root>\/scripts\/sync\.mjs"/);
  const commands = skill.match(/^node /gm) || [];
  assert.equal(commands.length, 1, 'the house pattern is exactly one command');
});

// REWRITTEN. This used to assert the skill said "takes no flags" and named --since and --force as
// the two it refuses. The script now takes `--account`, so the old assertion pinned a sentence that
// had become false: a skill saying the command takes none would have the model drop the one flag
// the login flow and the user both need. The two refusals themselves are unchanged and still
// pinned — above, against the script, and here against the skill.
test('skill — states the flag policy in the same terms the script enforces', () => {
  assert.match(skill, /--account <account>/);
  assert.match(skill, /takes no other flags/i);
  assert.match(skill, /--since/);
  assert.match(skill, /--force/);
  assert.doesNotMatch(skill, /takes no flags/i, 'it takes --account — saying otherwise hides it');
});

test('skill — documents the per-account fan-out the script prints headings for', () => {
  const script = fs.readFileSync(syncScript, 'utf-8');
  assert.ok(script.includes('── Account: '), 'scripts/sync.mjs should still print the heading');
  assert.match(skill, /── Account: /, 'skills/sync/SKILL.md should explain the heading');
  assert.match(skill, /every linked\s+account in turn/);
});

// ── a scoped run's 'no-token' is about the ACCOUNT, never the machine ────────────────────────
//
// REACHABILITY FIRST, because this branch had no behavioural test at all and the false sentence it
// used to print survived a full green suite. auditSession returns null whenever the key names no
// entry in linkedSessions() — an account that is in the index and cannot produce a token right now
// — and runAudit reports that as 'no-token', the same code an unlinked machine gets.
test('a run scoped to an account that cannot produce a token answers no-token', async (t) => {
  makeHome(t);
  const result = await runAudit(
    { linkedSessions: async () => [accountSession('99887766', 'tok-b')] },
    { mode: SYNC_MODE, key: 'a1b2c3d4' },
  );
  assert.equal(result.reason, 'no-token');
  assert.equal(result.scanned, 0, 'nothing was read — the account was the whole problem');
});

test('sync and backfill word that as the account’s problem, from one definition', () => {
  const sync = fs.readFileSync(syncScript, 'utf-8');
  const backfill = fs.readFileSync(path.join(pluginRoot, 'scripts', 'backfill.mjs'), 'utf-8');
  // One definition, two callers: a second spelling leaves the skill relaying a sentence one of
  // them no longer prints — the same rule test/account-surfaces.test.mjs case 15 enforces.
  assert.match(
    fs.readFileSync(path.join(pluginRoot, 'lib', 'session-audit.mjs'), 'utf-8'),
    /export const ACCOUNT_TOKEN_UNUSABLE/,
  );
  for (const [name, script] of [['sync', sync], ['backfill', backfill]]) {
    assert.match(script, /ACCOUNT_TOKEN_UNUSABLE/, `scripts/${name}.mjs should import the one definition`);
  }
  // backfill REQUIRES --account, so every no-token it can reach is an account it already resolved.
  assert.doesNotMatch(backfill, /this machine is not linked/, 'backfill can no longer reach that state');
  // sync keeps it for the UNSCOPED run, which is the only one where it is still true.
  assert.match(sync, /key === null\s*\n?\s*\? 'Beezi: this machine is not linked/);
  assert.match(skill, /could not use the saved credentials for that account/);
  assert.match(skill, /Do not report it as the machine being unlinked/);
});

test('skill — carries the hard boundary against the one-time import', () => {
  assert.match(skill, /NOT the one-time import/);
  assert.match(skill, /does not consume, reopen, re-run or stand in for/);
  assert.match(skill, /decline/);
});

test('skill — carries the trust-gap framing and points at the cause, not just the symptom', () => {
  assert.match(skill, /trusts them in `\/hooks`/);
  assert.match(skill, /Trust survives a plugin upgrade/);
  assert.match(skill, /analytics-hooks/);
});

test('skill — "everything is already uploaded" is documented as a success, not a retry', () => {
  assert.match(skill, /everything is already uploaded/);
  assert.match(skill, /do not re-run hoping for a different answer/);
});

test('skill — the coverage-unknown notice is relayed, not treated as an error', () => {
  assert.match(skill, /could not reach Beezi to check what it already has/);
  assert.match(skill, /not an error and nothing was\s+lost or duplicated/);
});

test('sync — a deferred run never claims "everything is already uploaded"', () => {
  const script = fs.readFileSync(syncScript, 'utf-8');
  // The success phrase and the deferral count must be mutually exclusive branches: the skill
  // teaches the model that the phrase means "stop", so printing it over deferred history is the
  // one way this surface can tell a user to give up on work that is still recoverable.
  // The deferral branch is tested first, and the success phrase sits in the `else if` behind it,
  // so the two can never both print.
  assert.match(script, /if \(result\.sessionsImported === 0 && result\.deferred > 0\) \{/);
  assert.match(script, /\} else if \(result\.sessionsImported === 0\) \{[\s\S]{0,400}everything is already uploaded/);
  // And the success line's parenthetical must not mention deferred history at all.
  assert.doesNotMatch(script, /bits\.push\([^)]*deferred/);
});

test('skill — the deferred-gap outcome is documented as final, with no override to ask for', () => {
  assert.match(skill, /does not line up/);
  assert.match(skill, /there is no flag that overrides it/);
});

test('skill — every outcome the script can print is documented', () => {
  const script = fs.readFileSync(syncScript, 'utf-8');
  // Distinctive fragments of each user-visible line, paired with the phrase the skill must carry.
  const outcomes = [
    ['everything is already uploaded', /everything is already uploaded/],
    ['were left for a ', /were left for a later run/],
    ['could not reach Beezi to check', /could not reach Beezi to check/],
    ['does not line up', /does not line up/],
    ['was not re-checked', /sub-agent activity was not re-checked/],
    ['audit-only plan', /audit-only plan/],
    ['not linked', /not linked/],
    ['does not support history sync yet', /does not support history sync yet/],
    ['already-saved analytics have not reached Beezi', /already-saved analytics have not reached Beezi/],
  ];
  for (const [fragment, inSkill] of outcomes) {
    assert.ok(script.includes(fragment), `scripts/sync.mjs should still print "${fragment}"`);
    assert.match(skill, inSkill, `skills/sync/SKILL.md should explain "${fragment}"`);
  }
});

test('skill — track points at sync for history it cannot repair', () => {
  const track = fs.readFileSync(path.join(pluginRoot, 'skills', 'track', 'SKILL.md'), 'utf-8');
  assert.match(track, /the `sync` skill/);
  assert.match(track, /only ever saves \*\*the session it is run from\*\*/);
});
