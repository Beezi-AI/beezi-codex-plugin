import { installHooks, uninstallHooks, hooksStatus, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

function reportStatus() {
  const status = hooksStatus();

  if (status.state === 'installed') {
    console.log('✓ Beezi: analytics hooks are installed.');
    console.log(`  Registry: ${status.hooksFile}`);
    console.log(`  Events:   ${status.registered.join(', ')}`);
    console.log(`  If analytics are not arriving, ${TRUST_STEP}.`);
    return;
  }

  if (status.state === 'absent') {
    console.log('Beezi: analytics hooks are not installed. Run this script with `install`.');
    return;
  }

  console.log(
    status.state === 'stale'
      ? '⚠ Beezi: the analytics hooks point at an older plugin version.'
      : '⚠ Beezi: the analytics hook install is incomplete.',
  );
  if (status.registered.length) console.log(`  Registered: ${status.registered.join(', ')}`);
  for (const l of status.missingLaunchers) console.log(`  Missing:    ${l}`);
  for (const l of status.staleLaunchers) console.log(`  Stale:      ${l}`);
  console.log('  Run this script with `install` to repair.');
}

function main() {
  const action = process.argv[2] ?? 'status';

  if (action === 'status') return reportStatus();

  if (action === 'install') {
    const { hooksFile, events } = installHooks();
    console.log(`✓ Beezi: analytics hooks written to ${hooksFile}`);
    console.log(`  Events: ${events.join(', ')}`);
    console.log('');
    console.log('  One more step — Codex will not run a hook it has not been shown:');
    console.log(`    ${TRUST_STEP}.`);
    console.log('  Trust is recorded against each hook’s hash, so repeat this after any upgrade.');
    return;
  }

  if (action === 'uninstall') {
    const { hooksFile, removed } = uninstallHooks();
    console.log(
      removed
        ? `✓ Beezi: analytics hooks removed from ${hooksFile}. Your other hooks were left alone.`
        : 'Beezi: no analytics hooks were installed — nothing to remove.',
    );
    return;
  }

  console.error(`✗ Beezi: unknown action '${action}'. Use install, uninstall, or status.`);
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
