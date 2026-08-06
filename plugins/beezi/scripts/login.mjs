import { performLogin } from '../lib/login.mjs';
import path from 'node:path';
import url from 'node:url';
import { hooksStatus, installCommand, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

function onStep(step) {
  if (step.type === 'already-linked') {
    console.log(`\n✓ This machine is already linked to Beezi${step.account ? ` as ${step.account}` : ''}.`);
    return;
  }
  if (step.type === 'authorize-url') {
    console.log('\nBeezi analytics — link this machine\n');
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
    return;
  }
  if (step.type === 'linked') {
    console.log(`\n✓ Beezi analytics linked${step.account ? ` as ${step.account}` : ''}. Credentials stored in ${step.storedIn}.`);
  }
}

// Linking is only half of setup: Codex refuses to load hooks bundled in a plugin, so nothing is
// reported until the hooks are installed into ~/.codex/hooks.json and trusted once. Say so here
// rather than leaving the user with a linked machine that silently sends nothing. This runs after
// the credentials are stored, so a failure here must never fail the login.
function reportHookStep() {
  let status = null;
  try {
    status = hooksStatus();
  } catch {
    return;
  }
  if (status.state === 'installed') {
    console.log(`  Analytics hooks are installed. If nothing arrives, ${TRUST_STEP}.`);
    return;
  }
  console.log('\nOne more step to start reporting analytics:');
  console.log(
    status.state === 'absent'
      ? `  1. ${installCommand()}`
      : `  1. ${installCommand()}   (the current install needs repair)`,
  );
  console.log(`  2. ${TRUST_STEP}.`);
}

performLogin({ onStep })
  .then(() => {
    reportHookStep();
    console.log('');
  })
  .catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
