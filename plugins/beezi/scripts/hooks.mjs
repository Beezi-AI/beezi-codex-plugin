import path from 'path';
import url from 'url';
import { ensureHooks, installHooks, uninstallHooks, hooksStatus, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Dead entries are reported in EVERY branch, including `installed`.
//
// Codex spawns a registered hook whether or not its target still exists, and a failed spawn is
// reported as `hook: <Event> Failed` for the whole event — so one orphan left by a variant the user
// has since removed breaks that event's reporting for every session on the machine. This block is
// the only thing that names it: `state` is owner-scoped by design, so the owner that can see the
// orphan is usually not the owner that can remove it. `install` sweeps them itself.
//
// Collapsed BY TARGET, because every event of an install now points at that install's one launcher:
// an abandoned variant produces five rows naming one path, and printing that path five times reads
// as five separate faults.
function reportBroken(status) {
  if (!status.broken || !status.broken.length) return;

  const byTarget = collapseByTarget(status.broken);

  console.log('');
  console.log(`⚠ Beezi: ${status.broken.length} registered hook entr${status.broken.length === 1 ? 'y points' : 'ies point'} at a file that no longer exists.`);
  console.log('  Codex runs these every session and every run fails — check `hook: <Event> Failed`.');
  for (const entry of byTarget) {
    console.log(`    ${entry.events.join(', ')} · ${entry.owner} · ${entry.target}`);
  }
  console.log(`  Registry: ${status.hooksFile}`);
  console.log('  Run this script with `install` — it removes them, whichever variant left them.');
}

// What the sweep cleared, named rather than counted: the paths are the only way a user can tell
// this was their stale variant and not something of their own. Collapsed by target for the same
// reason reportBroken is — one abandoned install is one path, five times over.
function collapseByTarget(entries) {
  const out = [];
  for (const entry of entries) {
    const seen = out.filter((t) => t.target === entry.target && t.owner === entry.owner)[0];
    if (seen) seen.events.push(entry.event);
    else out.push({ target: entry.target, owner: entry.owner, events: [entry.event] });
  }
  return out;
}

function reportSwept(swept) {
  if (!swept || !swept.length) return;
  console.log(`  Removed ${swept.length} dead hook entr${swept.length === 1 ? 'y' : 'ies'} left by an older or deleted install:`);
  for (const entry of collapseByTarget(swept)) {
    console.log(`    ${entry.events.join(', ')} · ${entry.owner} · ${entry.target}`);
  }
}

// Which plugin version the registered entries would actually run right now.
//
// The registry no longer carries a version — that is the point of the launcher — so this is the one
// place a user can see which install their hooks resolve to, and the thing they would otherwise
// have to take on faith after an upgrade.
//
// Resolved through the launcher shipped IN THIS TREE, not the installed copy: on a healthy machine
// they are the same bytes, and when they are not, `launcher: 'stale'` has already said so —
// reporting through the stale copy would hide exactly the drift that line exists to surface.
// Dynamic import inside try/catch, so a launcher module that is missing or throws downgrades this
// to silence rather than taking `status` down with it.
const PLUGIN_SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));

async function describeResolution(owner) {
  try {
    const href = url.pathToFileURL(path.join(PLUGIN_SCRIPTS_DIR, 'hook-launcher.mjs')).href;
    const launcher = await import(href);
    const hit = launcher.resolveHookScript({
      owner,
      scriptName: 'session-start.mjs',
      cacheRoot: launcher.defaultCacheRoot(),
    });
    if (!hit) return '  Resolves to: nothing — no installed plugin version carries the hook scripts.';
    return `  Resolves to: ${owner} ${hit.version} (${hit.scriptPath})`;
  } catch {
    return null;
  }
}

// The launcher's own freshness, kept visually separate from `state` because the repairs differ: a
// stale launcher is replaced silently, a stale ENTRY costs a trip through /hooks.
function reportLauncher(status) {
  console.log(`  Launcher: ${status.launcherFile}`);
  if (status.launcher === 'current') console.log('            up to date with this plugin version.');
  else if (status.launcher === 'stale') console.log('            older than this plugin version — `install` refreshes it, no re-trust needed.');
  // With no entries registered nothing spawns the launcher, so its absence is expected, not a fault.
  else if (status.registered.length) console.log('            MISSING — every hook fails until `install` writes it back.');
  else console.log('            not written yet — `install` creates it.');
}

async function reportStatus() {
  const status = hooksStatus();

  if (status.state === 'installed') {
    console.log('✓ Beezi: analytics hooks are installed.');
    console.log(`  Registry: ${status.hooksFile}`);
    console.log(`  Events:   ${status.registered.join(', ')}`);
    reportLauncher(status);
    const resolved = await describeResolution(status.owner);
    if (resolved) console.log(resolved);
    console.log(`  If analytics are not arriving, ${TRUST_STEP}.`);
    reportBroken(status);
    return;
  }

  if (status.state === 'absent') {
    console.log('Beezi: analytics hooks are not installed. Run this script with `install`.');
    reportLauncher(status);
    reportBroken(status);
    return;
  }

  console.log(
    status.state === 'stale'
      ? '⚠ Beezi: the analytics hooks were written by a version that registered the plugin path directly.'
      : '⚠ Beezi: the analytics hook install is incomplete.',
  );
  if (status.registered.length) console.log(`  Registered: ${status.registered.join(', ')}`);
  if (status.missingEvents.length) console.log(`  Missing:    ${status.missingEvents.join(', ')}`);
  if (status.staleEvents.length) console.log(`  Stale:      ${status.staleEvents.join(', ')}`);
  reportLauncher(status);
  console.log('  Run this script with `install` to repair — the last time it has to change the entries.');
  reportBroken(status);
}

// `install` goes through ensureHooks, so a healthy install is left untouched.
//
// That is not a saved write. Codex records trust against each entry's HASH, so rewriting five
// identical entries revokes the trust the user has already granted and sends them back to `/hooks`
// for nothing. `--force` exists for the one case the no-op cannot serve: a registry that reads as
// installed but that the user wants rewritten anyway.
function runInstall(force) {
  if (force) {
    const forced = installHooks();
    if (forced.skipped) return reportBusy();
    console.log(`✓ Beezi: analytics hooks rewritten in ${forced.hooksFile}`);
    console.log(`  Events: ${forced.events.join(', ')}`);
    reportSwept(forced.swept);
    reportTrust();
    return;
  }

  const result = ensureHooks();
  if (result.skipped) return reportBusy();

  if (!result.repaired) {
    // The ordinary post-upgrade outcome: new plugin code behind unchanged registry entries.
    if (result.launcherRefreshed) {
      console.log('✓ Beezi: analytics hooks updated to this plugin version.');
      console.log(`  Launcher: ${result.status.launcherFile}`);
      console.log('  The registry entries did not change, so there is NOTHING to re-trust — /hooks can stay closed.');
      return;
    }
    console.log('✓ Beezi: analytics hooks are already installed and current — nothing to change.');
    console.log(`  Registry: ${result.status.hooksFile}`);
    console.log(`  Events:   ${result.status.registered.join(', ')}`);
    console.log('  Left untouched on purpose: a rewrite would change each hook’s hash and revoke the trust you already granted.');
    console.log(`  If analytics still are not arriving, ${TRUST_STEP}.`);
    return;
  }

  console.log(result.before === 'absent'
    ? `✓ Beezi: analytics hooks installed in ${result.status.hooksFile}`
    : `✓ Beezi: analytics hooks repaired in ${result.status.hooksFile} (was ${result.before}).`);
  console.log(`  Events: ${result.status.registered.join(', ')}`);
  reportSwept(result.swept);
  reportTrust();
  reportBroken(result.status);
}

function reportTrust() {
  console.log('');
  console.log('  One more step — Codex will not run a hook it has not been shown:');
  console.log(`    ${TRUST_STEP}.`);
  console.log('  Once is enough. The entries name a fixed launcher rather than the plugin’s versioned');
  console.log('  directory, so an upgrade no longer changes them and no longer asks for trust again.');
}

// Contention on the registry lock is not a failure: another Beezi process is writing the very same
// entries. Say so plainly rather than reporting success for a write that did not happen.
function reportBusy() {
  console.log('Beezi: another Beezi process is updating the hook registry right now — nothing was changed.');
  console.log('  It is writing the same entries. Re-run this in a moment to see the result.');
}

async function main() {
  const action = process.argv[2] || 'status';
  const force = process.argv.indexOf('--force') !== -1;

  if (action === 'status') return reportStatus();
  if (action === 'install') return runInstall(force);

  if (action === 'uninstall') {
    const { hooksFile, removed, skipped } = uninstallHooks();
    if (skipped) return reportBusy();
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

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
