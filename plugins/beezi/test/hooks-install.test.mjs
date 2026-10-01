import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  HOOK_COMMAND,
  LAUNCHER_FILE,
  buildHookEntries,
  ensureHooks,
  hookCommand,
  hooksStatus,
  installHooks,
  launcherPath,
  mergeHooks,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

// The launcher the installer copies. A fixture rather than scripts/hook-launcher.mjs itself, so
// these tests assert the COPY MECHANISM and not the launcher's contents — and so a test can stand
// a second, byte-different "newer plugin version" beside it.
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LAUNCHER_SOURCE = path.join(HERE, 'fixtures', 'hooks', 'launcher.mjs.txt');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hooks-'));
}

/** Everything installHooks/hooksStatus need, rooted in one throwaway dir. */
function bench() {
  const root = tmpdir();
  return {
    root,
    opts: {
      hooksFile: path.join(root, 'codex', 'hooks.json'),
      launcherDir: path.join(root, 'launchers'),
      launcherSource: LAUNCHER_SOURCE,
    },
  };
}

/** A second launcher source with different bytes — what a plugin upgrade ships. */
function newerLauncher(root) {
  const file = path.join(root, 'newer-launcher.mjs.txt');
  fs.writeFileSync(file, `${fs.readFileSync(LAUNCHER_SOURCE, 'utf-8')}\n// version 2\n`);
  return file;
}

// The scripts dir the pre-launcher installer registered: inside the VERSIONED plugin cache, which
// is exactly why every upgrade used to rewrite the registry.
function versionedScriptsDir(root, version = 'v1') {
  return path.join(root, 'plugins', 'cache', 'beezi', 'beezi', version, 'scripts');
}

/** The entries a pre-launcher version wrote: `node "<versioned scripts dir>/<script>"`. */
function versionedInstall(hooksFile, scriptsDir) {
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    fs.writeFileSync(path.join(scriptsDir, script), '// stub\n');
    hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: `${HOOK_COMMAND} "${path.join(scriptsDir, script)}"`,
        statusMessage: BEEZI_STATUS_MESSAGE,
        timeout: 10,
      }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

// The registry entry shape the oldest plugin versions wrote: a per-event launcher script named
// directly as the command, no interpreter and no `arguments`.
function legacyInstall(hooksFile, launcherDir) {
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.mkdirSync(launcherDir, { recursive: true });
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.sh`);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "/usr/bin/node" "/old/${script}" "$@"\n`);
    hooks[event] = [{
      matcher: '.*',
      hooks: [{ type: 'command', command: launcher, commandWindows: launcher, statusMessage: BEEZI_STATUS_MESSAGE, timeout: 10 }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

// The 0.8.x shape Codex accepted but did not execute correctly on Windows: it launched bare Node
// and did not pass the separate arguments array through to the command hook.
function brokenArgumentsInstall(hooksFile, scriptsDir) {
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: 'node',
        arguments: [path.join(scriptsDir, script)],
        statusMessage: BEEZI_STATUS_MESSAGE,
        timeout: 10,
      }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

test('the registered event set is exactly the five Beezi hooks', () => {
  // SessionEnd stays out by choice: Stop already runs the identical checkpoint at every turn end,
  // so registering it would only cost the user another entry to review and trust.
  assert.deepEqual(BEEZI_HOOKS.map((h) => h.event),
    ['SessionStart', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']);
});

test('buildHookEntries puts the complete invocation in command', () => {
  const launcherDir = path.join('/home', '.beezi-codex', 'hooks');
  const entries = buildHookEntries({ launcherDir });
  assert.deepEqual(Object.keys(entries).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, hookCommand(launcherPath(launcherDir), script, 'beezi'));
    // The quoted path is the ONE launcher; the script name rides after it as a bare token.
    assert.ok(handler.command.endsWith(`" ${script}`), handler.command);
    assert.equal(HOOK_COMMAND, 'node', 'interpreter comes from PATH, never an absolute path');
    assert.ok(!('arguments' in handler), 'Codex 0.154.0 does not pass this field to command hooks');
    assert.equal(handler.statusMessage, BEEZI_STATUS_MESSAGE);
    assert.equal(handler.timeout, 20, 'analytics hooks need enough time to finish network-backed work');
    assert.ok(!('commandWindows' in handler), 'one command works on every platform');
  }
});

test('no registered command names a plugin version — that is the whole point', () => {
  const launcherDir = path.join('/home', '.beezi-codex', 'hooks');
  const entries = buildHookEntries({ launcherDir });
  for (const { event } of BEEZI_HOOKS) {
    const { command } = entries[event][0].hooks[0];
    assert.ok(command.indexOf('plugins') === -1 && command.indexOf('cache') === -1, command);
  }
});

test('removeBeeziHooks leaves a user’s own hooks untouched', () => {
  const mine = { type: 'command', command: '/usr/local/bin/audit' };
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [mine] }],
      Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: '/x', statusMessage: BEEZI_STATUS_MESSAGE }] }],
    },
  };
  const out = removeBeeziHooks(existing);
  assert.deepEqual(out.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [mine] }]);
  assert.ok(!('Stop' in out.hooks), 'an event left with no groups is dropped');
});

test('removeBeeziHooks strips only our handler from a shared group', () => {
  const mine = { type: 'command', command: '/usr/local/bin/audit' };
  const existing = {
    hooks: { Stop: [{ matcher: '.*', hooks: [mine, { type: 'command', command: '/x', statusMessage: BEEZI_STATUS_MESSAGE }] }] },
  };
  assert.deepEqual(removeBeeziHooks(existing).hooks.Stop, [{ matcher: '.*', hooks: [mine] }]);
});

test('removeBeeziHooks preserves unknown top-level keys', () => {
  const out = removeBeeziHooks({ hooks: {}, somethingElse: { keep: true } });
  assert.deepEqual(out.somethingElse, { keep: true });
});

test('mergeHooks is idempotent — re-install does not duplicate entries', () => {
  const beezi = buildHookEntries({ launcherDir: '/h/hooks' });
  const once = mergeHooks({}, beezi);
  const twice = mergeHooks(once, beezi);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('mergeHooks keeps a user hook on an event Beezi also registers', () => {
  const mine = { matcher: 'x', hooks: [{ type: 'command', command: '/mine' }] };
  const merged = mergeHooks({ hooks: { Stop: [mine] } }, buildHookEntries({ launcherDir: '/h/hooks' }));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.hooks.Stop[0], mine);
});

test('installHooks writes a readable registry and the launcher, then uninstall reverses both', () => {
  const { opts } = bench();
  const { hooksFile, launcherDir } = opts;

  const res = installHooks(opts);
  assert.deepEqual(res.events, BEEZI_HOOKS.map((h) => h.event));
  assert.equal(res.launcherRefreshed, true);

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = written.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(launcherPath(launcherDir), script, 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  assert.ok(fs.readFileSync(hooksFile, 'utf-8').includes('\n  '), 'registry stays hand-reviewable');

  // The launcher is a verbatim copy — the installer must never reshape plugin code.
  assert.deepEqual(
    fs.readFileSync(launcherPath(launcherDir)),
    fs.readFileSync(LAUNCHER_SOURCE),
  );

  uninstallHooks(opts);
  assert.ok(!fs.existsSync(hooksFile), 'a registry that held only our entries is removed, not emptied');
  assert.ok(!fs.existsSync(launcherDir), 'and the launcher goes with it');
});

test('a plugin upgrade changes the launcher and NOTHING in the registry', () => {
  // The ticket, in one test. Codex hashes each entry to key trust; if these bytes move, every
  // upgrade sends the user back to /hooks and analytics are dead until they go.
  const { root, opts } = bench();
  installHooks(opts);
  const registryBefore = fs.readFileSync(opts.hooksFile, 'utf-8');
  const mtimeBefore = fs.statSync(opts.hooksFile).mtimeMs;

  const upgraded = { ...opts, launcherSource: newerLauncher(root) };
  const status = hooksStatus(upgraded);
  assert.equal(status.state, 'installed', 'an upgrade is no longer a stale install');
  assert.deepEqual(status.staleEvents, []);
  assert.deepEqual(status.broken, []);
  assert.equal(status.launcher, 'stale', 'only the launcher file is behind');

  const result = ensureHooks(upgraded);
  assert.equal(result.repaired, false, 'the registry was not rewritten, so no trust was revoked');
  assert.equal(result.launcherRefreshed, true);
  assert.equal(fs.readFileSync(opts.hooksFile, 'utf-8'), registryBefore);
  assert.equal(fs.statSync(opts.hooksFile).mtimeMs, mtimeBefore, 'not even touched');
  assert.deepEqual(
    fs.readFileSync(launcherPath(opts.launcherDir), 'utf-8'),
    fs.readFileSync(upgraded.launcherSource, 'utf-8'),
  );
  assert.equal(hooksStatus(upgraded).launcher, 'current');
});

test('two installs from different plugin versions produce byte-identical registries', () => {
  const { root: rootA, opts: a } = bench();
  const { root: rootB, opts: b } = bench();
  // Same environment (same launcherDir), two different shipped launchers.
  const shared = path.join(rootA, 'shared-hooks');
  installHooks({ ...a, launcherDir: shared, launcherSource: LAUNCHER_SOURCE });
  const first = fs.readFileSync(a.hooksFile, 'utf-8');
  installHooks({ ...b, launcherDir: shared, launcherSource: newerLauncher(rootB) });
  assert.equal(fs.readFileSync(b.hooksFile, 'utf-8'), first);
});

test('uninstallHooks keeps the registry file when other hooks remain', () => {
  const { opts } = bench();
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  fs.writeFileSync(opts.hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks(opts);
  const res = uninstallHooks(opts);

  assert.equal(res.removed, true);
  const kept = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  assert.equal(kept.hooks.PreCompact[0].hooks[0].command, '/mine');
  assert.ok(!('Stop' in kept.hooks));
});

test('installHooks preserves a pre-existing unrelated registry', () => {
  const { opts } = bench();
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  fs.writeFileSync(opts.hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks(opts);

  const written = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  assert.equal(written.hooks.PreCompact[0].hooks[0].command, '/mine');
});

test('hooksStatus walks absent → installed with the registry alone', () => {
  const { opts } = bench();

  const empty = hooksStatus(opts);
  assert.equal(empty.state, 'absent');
  assert.equal(empty.launcher, 'missing', 'nothing installed means no launcher either');

  installHooks(opts);
  const ok = hooksStatus(opts);
  assert.equal(ok.state, 'installed');
  assert.equal(ok.complete, true);
  assert.equal(ok.launcher, 'current');
  assert.equal(ok.launcherFile, launcherPath(opts.launcherDir));
  assert.deepEqual(ok.registered.sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(ok.missingEvents, []);
  assert.deepEqual(ok.staleEvents, []);
});

test('a deleted launcher reads as missing and ensureHooks restores it without a rewrite', () => {
  const { opts } = bench();
  installHooks(opts);
  const registryBefore = fs.readFileSync(opts.hooksFile, 'utf-8');
  const mtimeBefore = fs.statSync(opts.hooksFile).mtimeMs;

  fs.unlinkSync(launcherPath(opts.launcherDir));
  const gone = hooksStatus(opts);
  assert.equal(gone.launcher, 'missing');
  // Every entry names the launcher, so a missing one makes all five read as dead. That must NOT
  // become a registry rewrite: the file is put back instead, and the entries keep their trust.
  assert.equal(gone.broken.length, BEEZI_HOOKS.length);

  const result = ensureHooks(opts);
  assert.equal(result.launcherRefreshed, true);
  assert.equal(result.repaired, false, 'the launcher came back, so there was nothing to repair');
  assert.ok(fs.existsSync(launcherPath(opts.launcherDir)));
  assert.equal(fs.readFileSync(opts.hooksFile, 'utf-8'), registryBefore);
  assert.equal(fs.statSync(opts.hooksFile).mtimeMs, mtimeBefore);
  assert.equal(hooksStatus(opts).state, 'installed');
});

test('hooksStatus reports partial when one event was hand-deleted from the registry', () => {
  const { opts } = bench();

  installHooks(opts);
  const edited = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  delete edited.hooks.Stop;
  fs.writeFileSync(opts.hooksFile, JSON.stringify(edited));

  const status = hooksStatus(opts);
  assert.equal(status.state, 'partial');
  assert.deepEqual(status.missingEvents, ['Stop']);
});

test('an entry whose label the user reworded is still recognised as ours', () => {
  const { opts } = bench();

  installHooks(opts);
  const edited = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const groups of Object.values(edited.hooks)) groups[0].hooks[0].statusMessage = 'my analytics';
  fs.writeFileSync(opts.hooksFile, JSON.stringify(edited));

  // Ownership falls back to the launcher path in `command`, so re-install stays idempotent.
  installHooks(opts);
  assert.equal(JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8')).hooks.Stop.length, 1);

  // …and uninstall does not silently leave firing hooks behind.
  assert.equal(uninstallHooks(opts).removed, true);
  assert.ok(!fs.existsSync(opts.hooksFile));
});

test('a user hook that runs their own checkpoint.mjs via node is not ours', () => {
  const { root, opts } = bench();
  const mine = { type: 'command', command: 'node', arguments: [path.join(root, 'home', 'me', 'checkpoint.mjs')] };
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  fs.writeFileSync(opts.hooksFile, JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks(opts);
  uninstallHooks(opts);

  const kept = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.PostToolUse[0].hooks, [mine], 'same script name, but not from a beezi directory');
});

test('a beezi-hook.mjs somewhere else on disk is not ours', () => {
  const { root, opts } = bench();
  // Right basename, wrong directory — the launcher anchor checks both, so this stays the user's.
  const mine = { type: 'command', command: `node "${path.join(root, 'elsewhere', LAUNCHER_FILE)}" stop.mjs` };
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  fs.writeFileSync(opts.hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks(opts);
  uninstallHooks(opts);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8')).hooks.PreCompact[0].hooks,
    [mine],
  );
});

test('uninstallHooks on a machine that never installed reports nothing removed', () => {
  const { opts } = bench();
  assert.equal(uninstallHooks(opts).removed, false);
});

test('an unreadable registry is refused, never silently replaced', () => {
  const { opts } = bench();
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  // The install flow tells users to open and review this file, so a stray comma is a real state.
  fs.writeFileSync(opts.hooksFile, '{ "hooks": { "PreToolUse": [ ] , } }');

  assert.throws(() => installHooks(opts), /not valid JSON/);
  // Their file is exactly as they left it — merging onto `{}` would have deleted every hook in it.
  assert.equal(fs.readFileSync(opts.hooksFile, 'utf-8'), '{ "hooks": { "PreToolUse": [ ] , } }');
});

test('a user script that merely starts with beezi- is not ours to remove', () => {
  const { root, opts } = bench();
  const mine = { type: 'command', command: path.join(root, 'bin', 'beezi-notify.sh') };
  fs.mkdirSync(path.dirname(opts.hooksFile), { recursive: true });
  fs.writeFileSync(opts.hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks(opts);
  uninstallHooks(opts);

  const kept = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.PreCompact[0].hooks, [mine], 'uninstall promised to leave their hooks alone');
});

test('entries naming the versioned plugin path read as stale and migrate in one write', () => {
  // The migration this change costs: ONE more re-trust, and never another.
  const { root, opts } = bench();
  const scriptsDir = versionedScriptsDir(root);
  versionedInstall(opts.hooksFile, scriptsDir);

  const before = hooksStatus(opts);
  assert.equal(before.state, 'stale');
  assert.equal(before.staleEvents.length, BEEZI_HOOKS.length);
  assert.deepEqual(before.broken, [], 'the old scripts are still on disk — stale, not dead');

  installHooks(opts);

  const registry = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, 'converted in place, not duplicated');
    assert.equal(registry.hooks[event][0].hooks[0].command,
      hookCommand(launcherPath(opts.launcherDir), script, 'beezi'));
  }
  assert.equal(hooksStatus(opts).state, 'installed');

  // And the migrated registry survives the next upgrade untouched — the whole point of migrating.
  const after = fs.readFileSync(opts.hooksFile, 'utf-8');
  ensureHooks({ ...opts, launcherSource: newerLauncher(root) });
  assert.equal(fs.readFileSync(opts.hooksFile, 'utf-8'), after);
});

test('hooksStatus reports a legacy launcher-style install as stale', () => {
  const { opts } = bench();
  legacyInstall(opts.hooksFile, opts.launcherDir);

  const status = hooksStatus(opts);
  assert.equal(status.state, 'stale');
  assert.equal(status.staleEvents.length, BEEZI_HOOKS.length);
});

test('hooksStatus marks entries with the old 10-second timeout stale so ensureHooks upgrades them', () => {
  const { opts } = bench();
  installHooks(opts);

  const registry = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const { event } of BEEZI_HOOKS) registry.hooks[event][0].hooks[0].timeout = 10;
  fs.writeFileSync(opts.hooksFile, JSON.stringify(registry, null, 2));

  const before = hooksStatus(opts);
  assert.equal(before.state, 'stale');
  assert.deepEqual(before.staleEvents.sort(), BEEZI_HOOKS.map((h) => h.event).sort());

  const result = ensureHooks(opts);
  assert.equal(result.repaired, true);
  const upgraded = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const { event } of BEEZI_HOOKS) assert.equal(upgraded.hooks[event][0].hooks[0].timeout, 20);
  assert.equal(hooksStatus(opts).state, 'installed');
});

test('hooksStatus reports broken node-plus-arguments entries as stale and install migrates them', () => {
  const { root, opts } = bench();
  brokenArgumentsInstall(opts.hooksFile, versionedScriptsDir(root));

  const before = hooksStatus(opts);
  assert.equal(before.state, 'stale');
  assert.equal(before.staleEvents.length, BEEZI_HOOKS.length);

  installHooks(opts);
  const registry = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, 'broken entry replaced, not duplicated');
    const handler = registry.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(launcherPath(opts.launcherDir), script, 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  assert.equal(hooksStatus(opts).state, 'installed');
});

test('installHooks converts a legacy install and sweeps the per-event launchers', () => {
  const { opts } = bench();
  legacyInstall(opts.hooksFile, opts.launcherDir);

  installHooks(opts);

  const written = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(written.hooks[event].length, 1, 'old entry replaced, not duplicated');
    const handler = written.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(launcherPath(opts.launcherDir), script, 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  // The DIRECTORY survives now — it holds the live launcher. Only the legacy files go.
  assert.deepEqual(fs.readdirSync(opts.launcherDir), [LAUNCHER_FILE]);
  assert.equal(hooksStatus(opts).state, 'installed');
});

test('uninstallHooks strips legacy launcher-style entries too', () => {
  const { opts } = bench();
  legacyInstall(opts.hooksFile, opts.launcherDir);
  // Rewords the label so removal has to rely on the legacy launcher recognition.
  const edited = JSON.parse(fs.readFileSync(opts.hooksFile, 'utf-8'));
  for (const groups of Object.values(edited.hooks)) delete groups[0].hooks[0].statusMessage;
  fs.writeFileSync(opts.hooksFile, JSON.stringify(edited));

  const res = uninstallHooks(opts);
  assert.equal(res.removed, true);
  assert.ok(!fs.existsSync(opts.hooksFile));
  assert.ok(!fs.existsSync(opts.launcherDir));
});
