import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inCodexSandbox, SANDBOXED_CREDENTIAL_STORE_MESSAGE, SANDBOXED_COMMAND_MESSAGE } from '../lib/codex-sandbox.mjs';
import { ensureEnvironmentMigrated, PRODUCTION_API_ORIGIN } from '../lib/env-migration.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { tmpHome } from '../tools/suite-fixtures.mjs';

// Codex runs the model's shell commands under Seatbelt on macOS, and the base profile has no
// com.apple.SecurityServer lookup: `security find-generic-password` comes back empty, exactly as a
// locked keychain does. These cases pin that the guard then says "sandbox, escalate" — the wording
// the skills and the workspace prompt tell the model to retry on — and says it for nothing else.

const SEATBELT = { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' };
const LEGACY_MESSAGE = 'Committed credentials could not be read; check access to the credential store and try again later';

function storeUnreadable() {
  const error = new Error(LEGACY_MESSAGE);
  error.code = 'CREDENTIALS_UNAVAILABLE';
  error.storeUnreadable = true;
  return error;
}

// A used root, so the guard has to read the credential store to classify it.
function usedRoot(t, readRawCredential, processEnv) {
  const home = tmpHome(t, 'codex-sandbox-');
  fs.mkdirSync(path.join(home, 'queue'));
  return { env: '', apiOrigin: PRODUCTION_API_ORIGIN, home: () => home, readRawCredential, processEnv };
}

test('inCodexSandbox reads the markers Codex sets on a sandboxed command', () => {
  assert.equal(inCodexSandbox({ CODEX_SANDBOX: 'seatbelt' }), true);
  assert.equal(inCodexSandbox({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true);
  assert.equal(inCodexSandbox({}), false);
  assert.equal(inCodexSandbox({ CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '0' }), false);
});

test('the Windows sandbox account counts as a sandbox with or without the env markers', () => {
  assert.equal(inCodexSandbox({}, 'CodexSandboxOffline'), true);
  assert.equal(inCodexSandbox({}, 'CodexSandboxOnline'), true);
  assert.equal(inCodexSandbox({}, 'codexsandboxoffline'), true);
  assert.equal(inCodexSandbox({}, 'DmytroKuryshko'), false);
  assert.equal(inCodexSandbox({}, 'CodexSandboxOfflineX'), false);
  assert.equal(inCodexSandbox({}, ''), false);
  assert.equal(inCodexSandbox(null, 'CodexSandboxOnline'), true);
});

// The OS account is the one input tools/hermetic-env.mjs cannot scrub: run from a sandboxed Codex
// shell on Windows, this test and every `env: {}` case below report a sandbox and fail.
test('the hermetic suite does not inherit a sandbox marker from the shell that runs it', () => {
  assert.equal(inCodexSandbox(), false);
});

test('a sandboxed command that cannot read the credential store is told to escalate', (t) => {
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw storeUnreadable(); }, SEATBELT));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'credential-store-sandboxed');
  assert.equal(result.message, SANDBOXED_CREDENTIAL_STORE_MESSAGE);
  assert.match(result.message, /sandbox/);
  assert.match(result.message, /run it again with escalated permissions/i);
  assert.doesNotMatch(result.message, /try again later/);
});

test('outside the sandbox the same failure keeps its existing message', (t) => {
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw storeUnreadable(); }, {}));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'inspection-or-migration-failed');
  assert.equal(result.message, `Beezi: environment verification failed (${LEGACY_MESSAGE}). No uploads are permitted.`);
});

test('inside the sandbox a different failure is not relabelled as a sandbox refusal', (t) => {
  const mismatch = new Error('Credential revision mismatch');
  mismatch.code = 'CREDENTIALS_UNAVAILABLE';
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw mismatch; }, SEATBELT));
  assert.equal(result.reason, 'inspection-or-migration-failed');
  assert.equal(result.message, 'Beezi: environment verification failed (Credential revision mismatch). No uploads are permitted.');
});

test('a CLI error from an unreadable store under the sandbox reads as the escalation hint', () => {
  assert.equal(friendlyMessage(storeUnreadable(), { env: SEATBELT }), SANDBOXED_CREDENTIAL_STORE_MESSAGE);
  assert.equal(friendlyMessage(storeUnreadable(), { env: {} }),
    'Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.');
});

// Every script reads the credential store through the env guard and touches the data root under the
// user's home, so there is no script a skill can safely start inside the sandbox: a skill that scoped
// escalation to "the commands that change a setting" sent `accounts.mjs list` into the sandbox, and on
// Windows it failed there. One block, the same in every skill, ahead of the first command: the
// preflight (lib/codex-permissions.mjs), which runs inside the sandbox, then the escalation rule.
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const PREFLIGHT_LEAD = '**Check this session first.**';
const ESCALATE_LEAD = '**Run every other script outside the sandbox.**';
const PREFLIGHT_COMMAND = 'node "<plugin-root>/scripts/preflight.mjs"';

test('every skill that runs a script runs the preflight, then says to run the rest escalated, before its first command', () => {
  const blocks = new Set();
  let checked = 0;
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const withoutPreflight = text.split(PREFLIGHT_COMMAND).join('');
    const firstCommand = withoutPreflight.indexOf('node "<plugin-root>/scripts/');
    if (firstCommand < 0) continue;
    checked += 1;
    const pre = text.indexOf(PREFLIGHT_LEAD);
    const at = text.indexOf(ESCALATE_LEAD);
    assert.ok(pre >= 0, `${name}: no preflight paragraph`);
    assert.ok(at > pre, `${name}: no escalation paragraph after the preflight`);
    assert.ok(withoutPreflight.indexOf(ESCALATE_LEAD) < firstCommand,
      `${name}: the escalation paragraph comes after the first command`);
    blocks.add(text.slice(pre, text.indexOf('\n\n', at)));
    assert.doesNotMatch(text, /commands that change a setting read/, `${name}: a scoped escalation rule is back`);
  }
  assert.ok(checked >= 7, `only ${checked} skills run a script`);
  assert.equal(blocks.size, 1, 'the preflight and escalation block differs between skills');
  const [block] = blocks;
  assert.match(block, /preflight\.mjs"` as it is, inside the sandbox and not escalated/);
  assert.match(block, /`preflight=blocked`[\s\S]*run no other Beezi script/);
  // The ✗ text offers /permissions for this session, so a blocked answer must not stick for it.
  assert.match(block, /run the preflight again before the next Beezi script/);
  assert.doesNotMatch(block, /Once per session|in this session, because/);
  assert.match(block, /codex --sandbox workspace-write --ask-for-approval on-request/);
  const paragraph = block.slice(block.indexOf(ESCALATE_LEAD));
  assert.match(paragraph, /require_escalated/);
  assert.match(paragraph, /from the first attempt/);
  assert.match(paragraph, /no sandbox \(full access\), run the commands as they are/);
  // One retry, never a loop: an escalated run that still fails is not the sandbox.
  assert.match(paragraph, /already\s+ran escalated and still fails is not retried/);
});

test('under the sandbox a lost network or a refused write reads as the escalation hint too', () => {
  const fetchFailed = new TypeError('fetch failed');
  fetchFailed.cause = { code: 'ECONNREFUSED' };
  const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  for (const error of [fetchFailed, eperm, aborted]) {
    assert.equal(friendlyMessage(error, { env: SEATBELT }), SANDBOXED_COMMAND_MESSAGE);
  }
  assert.match(SANDBOXED_COMMAND_MESSAGE, /run it again with escalated permissions/i);
  assert.match(SANDBOXED_COMMAND_MESSAGE, /already ran with escalated permissions, the sandbox is not the cause/);
  // A missing file is not the sandbox's doing, and outside the sandbox nothing changes.
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  assert.match(friendlyMessage(enoent, { env: SEATBELT }), /Could not access Beezi's local data \(ENOENT\)/);
  assert.equal(friendlyMessage(fetchFailed, { env: {} }),
    'Could not reach the Beezi server. Check your internet connection and try again.');
});
