import {
  migrationStatus,
  adoptAsProduction,
  preserveAndReset,
  rollbackMigration,
} from '../lib/env-migration.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The recovery surface for the production cutover (R1). R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// The guard in lib/env-guard.mjs decides the ordinary cases by itself and needs nobody. This
// script exists for the two it deliberately refuses to decide — a legacy root whose environment
// cannot be established from its stored credentials — and for the rollback R1 requires. Every one
// of them is a one-way-ish move of a user's own analytics data, so none of them happen without
// somebody typing the flag.

function usage() {
  console.log('Beezi — data-root environment tools\n');
  console.log('  node scripts/migrate-env.mjs                 show what this root is bound to');
  console.log('  node scripts/migrate-env.mjs --preserve      move the legacy data to the staging');
  console.log('                                              namespace and start production fresh');
  console.log('  node scripts/migrate-env.mjs --adopt         the legacy data IS production data;');
  console.log('                                              bind it and move nothing');
  console.log('  node scripts/migrate-env.mjs --rollback      undo a completed migration\n');
}

function showStatus() {
  const status = migrationStatus();
  console.log(`Environment:  ${status.env === '' ? 'production' : status.env}`);
  console.log(`Keyring:      ${status.service}`);
  console.log(`Root bound:   ${status.bound === null ? 'not bound yet' : (status.bound === '' ? 'production' : status.bound)}`
    + `${status.source ? ` (${status.source})` : ''}`);
  if (status.boundAt) console.log(`Bound at:     ${status.boundAt}`);
  if (status.migration) {
    console.log(`Migration:    ${status.migration.phase}`
      + `${status.migration.to ? ` → ${status.migration.to}` : ''} (${status.migration.at})`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.indexOf('--help') !== -1 || args.indexOf('-h') !== -1) return usage();

  if (args.indexOf('--adopt') !== -1) {
    const r = adoptAsProduction();
    if (!r.ok) {
      console.error(`✗ Nothing to adopt: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log('✓ This data root is now bound to production. Nothing was moved.');
    return;
  }

  if (args.indexOf('--preserve') !== -1) {
    const r = preserveAndReset();
    if (r.status === 'migrated') {
      console.log(r.message);
      return;
    }
    if (r.status === 'ok') {
      console.log('✓ Nothing to preserve — this root is already bound.');
      return;
    }
    console.error(r.message || `✗ ${r.status}: ${r.reason}`);
    process.exitCode = 1;
    return;
  }

  if (args.indexOf('--rollback') !== -1) {
    const r = rollbackMigration();
    if (!r.ok) {
      console.error(`✗ Could not roll back: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ Restored ${r.from} → ${r.to}.`);
    console.log('  The sign-in stayed with the staging namespace: run /beezi:login to re-link.');
    return;
  }

  showStatus();
}

try {
  main();
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exitCode = 1;
}
