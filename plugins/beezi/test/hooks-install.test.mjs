import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  buildHookEntries,
  hooksStatus,
  installHooks,
  launcherBody,
  launcherName,
  mergeHooks,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hooks-'));
}

test('the registered event set is exactly the five Beezi hooks', () => {
  // SessionEnd stays out by choice: Stop already runs the identical checkpoint at every turn end,
  // so registering it would only cost the user another entry to review and trust.
  assert.deepEqual(BEEZI_HOOKS.map((h) => h.event),
    ['SessionStart', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']);
});

test('launcherName picks the right extension per platform', () => {
  assert.equal(launcherName('checkpoint.mjs', 'win32'), 'beezi-checkpoint.cmd');
  assert.equal(launcherName('checkpoint.mjs', 'linux'), 'beezi-checkpoint.sh');
});

test('launcherBody quotes both paths and uses CRLF on Windows', () => {
  const win = launcherBody('C:\\p l\\stop.mjs', { nodePath: 'C:\\n o\\node.exe', platform: 'win32' });
  assert.ok(win.includes('"C:\\n o\\node.exe" "C:\\p l\\stop.mjs"'));
  assert.ok(win.startsWith('@echo off\r\n'));

  const posix = launcherBody('/p l/stop.mjs', { nodePath: '/n o/node', platform: 'linux' });
  assert.ok(posix.startsWith('#!/bin/sh\n'));
  assert.ok(posix.includes('exec "/n o/node" "/p l/stop.mjs" "$@"'));
});

test('buildHookEntries stamps every handler so it can be found again', () => {
  const entries = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  assert.deepEqual(Object.keys(entries).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const groups of Object.values(entries)) {
    assert.equal(groups[0].hooks[0].statusMessage, BEEZI_STATUS_MESSAGE);
    assert.equal(groups[0].hooks[0].type, 'command');
    assert.ok(groups[0].hooks[0].commandWindows);
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
  const beezi = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  const once = mergeHooks({}, beezi);
  const twice = mergeHooks(once, beezi);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('mergeHooks keeps a user hook on an event Beezi also registers', () => {
  const mine = { matcher: 'x', hooks: [{ type: 'command', command: '/mine' }] };
  const merged = mergeHooks({ hooks: { Stop: [mine] } }, buildHookEntries({ launcherDir: '/h', platform: 'linux' }));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.hooks.Stop[0], mine);
});

test('installHooks writes launchers and a readable registry, then uninstall reverses it', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'codex', 'hooks.json');
  const launcherDir = path.join(root, 'launchers');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  const res = installHooks({ scriptsDir, nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  assert.equal(res.launchers.length, BEEZI_HOOKS.length);
  for (const l of res.launchers) assert.ok(fs.existsSync(l));

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.ok(fs.readFileSync(hooksFile, 'utf-8').includes('\n  '), 'registry stays hand-reviewable');

  uninstallHooks({ platform: 'linux', hooksFile, launcherDir });
  assert.ok(!fs.existsSync(hooksFile), 'a registry that held only our entries is removed, not emptied');
  for (const l of res.launchers) assert.ok(!fs.existsSync(l));
});

test('uninstallHooks keeps the registry file when other hooks remain', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  const res = uninstallHooks({ platform: 'linux', hooksFile, launcherDir });

  assert.equal(res.removed, true);
  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(kept.hooks.PreCompact[0].hooks[0].command, '/mine');
  assert.ok(!('Stop' in kept.hooks));
});

test('installHooks preserves a pre-existing unrelated registry', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir: path.join(root, 'l') });

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(written.hooks.PreCompact[0].hooks[0].command, '/mine');
});

test('hooksStatus reports installed only when registry and launchers agree', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'absent');

  installHooks({ scriptsDir, nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  const ok = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(ok.state, 'installed');
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.registered.sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(ok.missingLaunchers, []);
});

test('hooksStatus calls launchers left behind by a plugin upgrade stale, not absent', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');

  installHooks({ scriptsDir: path.join(root, 'v1', 'scripts'), nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });

  // Same install, but the plugin now lives under a new version directory.
  const status = hooksStatus({ scriptsDir: path.join(root, 'v2', 'scripts'), platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.complete, false);
  assert.equal(status.missingLaunchers.length, 0);
  assert.equal(status.staleLaunchers.length, BEEZI_HOOKS.length);
});

test('hooksStatus reports partial when the registry has our entries but a launcher is gone', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  const { launchers } = installHooks({ scriptsDir, nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  fs.rmSync(launchers[0]);

  const status = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'partial');
  assert.equal(status.missingLaunchers.length, 1);
});

test('an entry whose label the user reworded is still recognised as ours', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');

  installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  const edited = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const groups of Object.values(edited.hooks)) groups[0].hooks[0].statusMessage = 'my analytics';
  fs.writeFileSync(hooksFile, JSON.stringify(edited));

  // Ownership falls back to the launcher filename, so re-install stays idempotent…
  installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf-8')).hooks.Stop.length, 1);

  // …and uninstall does not silently leave firing hooks behind.
  assert.equal(uninstallHooks({ platform: 'linux', hooksFile, launcherDir }).removed, true);
  assert.ok(!fs.existsSync(hooksFile));
});

test('uninstallHooks on a machine that never installed reports nothing removed', () => {
  const root = tmpdir();
  const res = uninstallHooks({ platform: 'linux', hooksFile: path.join(root, 'hooks.json'), launcherDir: path.join(root, 'l') });
  assert.equal(res.removed, false);
});

test('an unreadable registry is refused, never silently replaced', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  // The install flow tells users to open and review this file, so a stray comma is a real state.
  fs.writeFileSync(hooksFile, '{ "hooks": { "PreToolUse": [ ] , } }');

  assert.throws(
    () => installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir: path.join(root, 'l') }),
    /not valid JSON/,
  );
  // Their file is exactly as they left it — merging onto `{}` would have deleted every hook in it.
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), '{ "hooks": { "PreToolUse": [ ] , } }');
});

test('a user script that merely starts with beezi- is not ours to remove', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const mine = { type: 'command', command: path.join(root, 'bin', 'beezi-notify.sh') };
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks({ scriptsDir: '/p/scripts', nodePath: process.execPath, platform: 'linux', hooksFile, launcherDir });
  uninstallHooks({ platform: 'linux', hooksFile, launcherDir });

  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.PreCompact[0].hooks, [mine], 'uninstall promised to leave their hooks alone');
});

test('a launcher whose interpreter has been upgraded away reads as stale', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  // Installed with a Node that no longer exists — every hook now fails at spawn, so reporting
  // "installed" would send the user to /hooks forever with the real cause invisible.
  installHooks({ scriptsDir, nodePath: path.join(root, 'nvm', 'v20', 'node'), platform: 'linux', hooksFile, launcherDir });

  const status = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.staleLaunchers.length, BEEZI_HOOKS.length);
});
