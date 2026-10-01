import { performLogin, refusedSameTenantMessage } from '../lib/login.mjs';
import url from 'url';
import { ensureHooks, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { listAccounts, getDefaultKey, describeAccount } from '../lib/accounts.mjs';

function onStep(step) {
  if (step.type === 'authorize-url') {
    console.log('Opening your browser to sign in with your Beezi account…');
    console.log(`If it does not open, go to:\n  ${step.url}\n`);
    return;
  }
  // The launcher failed — a sandboxed shell, no http association, no PowerShell. Say so plainly
  // instead of leaving the user watching a prompt that looks like it is still working.
  if (step.type === 'browser-failed') {
    console.log('✗ Could not open a browser automatically'
      + `${step.detail ? ` (${step.detail})` : ''}.`);
    console.log(`  Open this URL yourself to finish signing in:\n  ${step.url}\n`);
    console.log('  Waiting for you to complete the sign-in…\n');
  }
}

// What the user has to know BEFORE the browser opens, because afterwards it is too late: Clerk's
// authorize endpoint offers no documented way to force the account picker (decision 5), so the
// round-trip signs in as whoever the browser is already signed in as. Naming the accounts already
// linked is what makes "I meant to add my other workspace" recoverable in one step.
//
// Best-effort: a machine that cannot read its own index can still sign in.
async function preamble() {
  console.log('\nBeezi analytics — link this machine\n');
  let accounts = [];
  let defaultKey = null;
  try {
    accounts = await listAccounts();
    defaultKey = await getDefaultKey();
  } catch { return; }
  if (!accounts.length) return;

  console.log(`Already linked on this machine (${accounts.length}):`);
  for (let i = 0; i < accounts.length; i += 1) {
    const marker = accounts[i].key === defaultKey ? ' — analytics default' : '';
    console.log(`  ${i + 1}. ${describeAccount(accounts[i])}${marker}`);
  }
  console.log('\nThe browser signs in as whichever Beezi account it is already signed in as.');
  console.log('To add a different one, sign out of Beezi in the browser first, or use a private window.\n');
}

// The branch's message. Returns false when nothing was linked, so the caller prints no key.
function reportOutcome(result) {
  if (result.outcome === 'refused-same-tenant') {
    console.log(`\n✗ ${refusedSameTenantMessage(result)}`);
    return false;
  }
  const who = describeAccount(result.account);
  if (result.outcome === 'already-linked') {
    console.log(`\n✓ already linked as ${who}. Nothing changed — the sign-in you just completed was handed back.`);
  } else if (result.outcome === 'relinked') {
    console.log(`\n✓ Beezi analytics re-linked as ${who}. Credentials stored in ${result.storedIn}.`);
  } else {
    console.log(`\n✓ Beezi analytics linked as ${who}. Credentials stored in ${result.storedIn}.`);
  }
  // Login never switches the default (decision 2); the accounts skill does.
  if (result.defaultKey !== result.key) {
    console.log('  The analytics skill still reads from this machine\'s default account.');
  }
  return true;
}

// Linking is only half of setup: Codex refuses to load hooks bundled in a plugin, so nothing is
// reported until the hooks are installed into ~/.codex/hooks.json and trusted once.
//
// So install them HERE, rather than printing the command and leaving the user to run it. Signing in
// is an unambiguous "I want my analytics reported" — there is no version of this flow where the
// answer to "install the hooks?" is no, and the step the user was being handed is one they can only
// get wrong by forgetting it. ensureHooks() is a no-op on a healthy install, so a repeat login does
// not rewrite the registry and does not revoke trust.
//
// This runs after the credentials are stored, so a failure here must never fail the login.
function reportHookStep() {
  let result = null;
  try {
    result = ensureHooks();
  } catch {
    return;
  }
  if (result.skipped) {
    console.log('  Another Beezi process is updating the hook registry; it will be current in a moment.');
    return;
  }
  if (!result.repaired) {
    console.log(`  Analytics hooks are installed. If nothing arrives, ${TRUST_STEP}.`);
    return;
  }
  console.log(result.before === 'absent'
    ? '\n  Analytics hooks installed for you.'
    : `\n  Analytics hooks repaired for you (they were ${result.before}).`);
  // The one thing that cannot be done for them: Codex has no non-interactive way to grant trust.
  console.log(`  One step left — ${TRUST_STEP}.`);
}

// R1 names login first among the things the guard precedes, and for the sharpest reason: a
// production sign-in on a machine whose queue was captured against staging is the exact sequence
// that flushes one tenant's segments to another. The migration therefore happens BEFORE the browser
// opens, not after the token lands. R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  await preamble();
  const result = await performLogin({ onStep });
  if (!reportOutcome(result)) return;
  reportHookStep();
  // LAST LINE, on every path that produced or kept an account. The login skill reads the key off
  // this line and threads it into the check-in and the history pull, both of which are per account.
  console.log(`account=${result.key}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
