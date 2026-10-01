import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  LAUNCHER_FILE,
  buildHookEntries,
  hookCommand,
  hookOwner,
  hooksStatus,
  installHooks,
  launcherPath,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

// G-1-7 / R1 — sibling hook isolation.
//
// `~/.codex/hooks.json` belongs to Codex and is NOT namespaced by BEEZI_ENV, so every installed
// variant merges into the same file. The defect R1 reproduced: one recogniser matched ANY variant's
// handler, so installing beezi-staging stripped beezi's entries and vice versa. These tests are the
// regression lock, and they run the matrix R1 asks for — install, upgrade and uninstall of prod and
// staging in BOTH orders, with a sibling and a user hook present throughout.
//
// `owner` is injected rather than resolved from the environment: lib/paths.mjs freezes BEEZI_ENV at
// module load, so reading it would force one child process per variant for what is a pure merge.

const PROD = 'beezi';
const STAGING = 'beezi-staging';
const DEV = 'beezi-dev';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LAUNCHER_SOURCE = path.join(HERE, 'fixtures', 'hooks', 'launcher.mjs.txt');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hookown-'));
}

// Each variant's launcher dir is hookLauncherDir() = ~/.beezi-codex<suffix>/hooks, already
// namespaced by G-2-2 — and now the ONLY thing a registered command names. Two variants therefore
// cannot collide on a command string, and neither can two versions of the same variant.
function variantLauncherDir(root, owner) {
  return path.join(root, owner === PROD ? '.beezi-codex' : `.beezi-codex-${owner.slice('beezi-'.length)}`, 'hooks');
}

// The real pre-launcher install layout, measured on a live machine:
//   ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/scripts
// Only entries that still name it are built from this now; it is the migration source, not a
// destination. The version segment moving on every upgrade is precisely what the launcher removes.
function variantScriptsDir(root, owner, version = '0.7.0') {
  const marketplace = owner === PROD ? 'beezi' : 'beezi-internal';
  return path.join(root, 'plugins', 'cache', marketplace, owner, version, 'scripts');
}

const USER_HOOK = { type: 'command', command: '/usr/local/bin/audit' };

function withUserHook(hooksFile) {
  fs.writeFileSync(hooksFile, JSON.stringify({
    hooks: { PreCompact: [{ matcher: '.*', hooks: [USER_HOOK] }] },
  }, null, 2));
}

function readRegistry(hooksFile) {
  return JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
}

// Every handler in the registry the given owner would claim, flattened across events.
function handlersOf(registry, owner, launcherDir) {
  const stripped = removeBeeziHooks(registry, launcherDir, owner);
  const before = [];
  const after = [];
  for (const groups of Object.values(registry.hooks || {})) {
    if (Array.isArray(groups)) for (const g of groups) before.push(...(g.hooks || []));
  }
  for (const groups of Object.values(stripped.hooks || {})) {
    if (Array.isArray(groups)) for (const g of groups) after.push(...(g.hooks || []));
  }
  return before.filter((h) => !after.includes(h));
}

function bench(t) {
  const root = tmpdir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  // `launcherSource` is not optional in a bench. Every entry names the launcher, so a variant
  // installed without one leaves entries pointing at a file that does not exist — which the next
  // variant's install correctly reads as an abandoned orphan and sweeps. The coexistence claims
  // below would then fail for a reason that has nothing to do with ownership.
  const opts = (owner) => ({
    launcherDir: variantLauncherDir(root, owner),
    launcherSource: LAUNCHER_SOURCE,
    hooksFile,
    owner,
  });
  return { root, hooksFile, opts };
}

test('hookOwner() is the plugin name, and the unsuffixed build resolves to it', () => {
  // The hermetic gate deletes BEEZI_ENV and the tree ships no env.json, so this process is the
  // production variant. That is the identity the shipped installer writes under.
  assert.equal(hookOwner(), PROD);
});

test('the unsuffixed build writes a composite command with no owner tag or relabel', () => {
  // Load-bearing: a changed entry is an entry Codex asks the user to re-trust through /hooks.
  const launcherDir = variantLauncherDir('/r', PROD);
  const entries = buildHookEntries({ launcherDir, owner: PROD });
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(launcherPath(launcherDir), script, PROD));
    assert.equal(handler.command.indexOf('--beezi-owner='), -1, 'production ownership stays implicit');
    assert.ok(handler.command.indexOf(LAUNCHER_FILE) !== -1, handler.command);
    assert.ok(!('arguments' in handler), 'no separate arguments on production');
    assert.equal(handler.statusMessage, BEEZI_STATUS_MESSAGE);
  }
});

test('a named variant tags its command and namespaces the label', () => {
  const launcherDir = variantLauncherDir('/r', STAGING);
  const entries = buildHookEntries({ launcherDir, owner: STAGING });
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(launcherPath(launcherDir), script, STAGING));
    assert.match(handler.command, / --beezi-owner=beezi-staging$/);
    // The script name sits between the quoted launcher and the tag.
    assert.ok(handler.command.indexOf(`" ${script} --beezi-owner=`) !== -1, handler.command);
    assert.ok(!('arguments' in handler));
    // Visible in /hooks, so two installed variants are distinguishable while being reviewed —
    // the same reason the variant builder namespaces interface.displayName.
    assert.equal(handler.statusMessage, 'Beezi analytics (staging)');
  }
  const dev = buildHookEntries({ launcherDir: variantLauncherDir('/r', DEV), owner: DEV });
  assert.equal(dev.Stop[0].hooks[0].statusMessage, 'Beezi analytics (dev)');
  assert.match(dev.Stop[0].hooks[0].command, / --beezi-owner=beezi-dev$/);
});

test('install prod then staging: both variants are registered, neither stripped the other', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);

  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 2, `${event} carries one group per variant`);
  }
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK], 'the user hook is untouched');
});

test('install staging then prod: the other order behaves identically', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);

  installHooks(opts(STAGING));
  installHooks(opts(PROD));

  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 2);
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('each variant owns its own launcher file, in its own namespaced dir', (t) => {
  const { opts } = bench(t);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  assert.ok(fs.existsSync(launcherPath(opts(PROD).launcherDir)));
  assert.ok(fs.existsSync(launcherPath(opts(STAGING).launcherDir)));

  // Uninstalling one takes only its own launcher: hookLauncherDir() is namespaced, so the whole-dir
  // removal cannot reach a sibling's.
  uninstallHooks(opts(STAGING));
  assert.ok(!fs.existsSync(opts(STAGING).launcherDir));
  assert.ok(fs.existsSync(launcherPath(opts(PROD).launcherDir)));
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
});

test('upgrading one variant changes nothing in the registry, for either variant', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(STAGING));
  installHooks(opts(PROD));
  const before = fs.readFileSync(hooksFile, 'utf-8');

  // What an upgrade of prod used to do: move to a new versioned cache directory and rewrite five
  // entries. Now there is nothing version-shaped in the registry for it to move.
  installHooks(opts(PROD));

  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), before, 'byte for byte, both variants');
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed',
    'an upgrade of one variant is not a downgrade of the other');
});

test('uninstalling staging keeps prod and the user hook, and keeps the file', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  const res = uninstallHooks(opts(STAGING));

  assert.equal(res.removed, true);
  assert.equal(res.owner, STAGING);
  assert.ok(fs.existsSync(hooksFile), 'a sibling still owns entries — the registry must survive');
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'absent');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 1);
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('uninstalling prod keeps staging — the reverse order of the same claim', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(STAGING));
  installHooks(opts(PROD));

  uninstallHooks(opts(PROD));

  assert.ok(fs.existsSync(hooksFile));
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  assert.equal(hooksStatus(opts(PROD)).state, 'absent');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    const handler = registry.hooks[event][0].hooks[0];
    assert.match(handler.command, / --beezi-owner=beezi-staging$/);
  }
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('uninstalling the last variant still takes the file when nothing else is in it', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  uninstallHooks(opts(PROD));
  assert.ok(fs.existsSync(hooksFile), 'staging is still registered');
  uninstallHooks(opts(STAGING));
  assert.ok(!fs.existsSync(hooksFile), 'nothing left that we did not put there');
});

test('a sibling install does not make an uninstalled variant report as installed', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(STAGING));

  const prod = hooksStatus(opts(PROD));
  assert.equal(prod.state, 'absent');
  assert.deepEqual(prod.registered, []);
  assert.equal(prod.owner, PROD);
  assert.equal(uninstallHooks(opts(PROD)).removed, false, 'nothing of ours to remove');
  assert.ok(fs.existsSync(hooksFile), "and the sibling's registry is still there");
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
});

test('an untagged launcher entry is prod’s, a tagged one is the variant’s — even unlabelled', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  // The install flow invites the user into /hooks, so a hand-edited label is a real state. Strip
  // it entirely and BOTH owners must still be recognised: staging by its tag, production by the
  // launcher-dir anchor that replaced the old versioned-script-path one.
  const edited = readRegistry(hooksFile);
  for (const groups of Object.values(edited.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) delete handler.statusMessage;
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify(edited, null, 2));

  assert.equal(handlersOf(edited, PROD, opts(PROD).launcherDir).length, BEEZI_HOOKS.length);
  assert.equal(handlersOf(edited, STAGING, opts(STAGING).launcherDir).length, BEEZI_HOOKS.length);
  assert.deepEqual(handlersOf(edited, STAGING, opts(STAGING).launcherDir)
    .filter((h) => h.command.indexOf('--beezi-owner=beezi-staging') === -1), []);

  // …so prod's uninstall still cannot reach staging's entries.
  uninstallHooks(opts(PROD));
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1);
    assert.match(registry.hooks[event][0].hooks[0].command, / --beezi-owner=beezi-staging$/);
  }
});

test('legacy unsuffixed entries are recognised only by the unsuffixed owner', (t) => {
  const { hooksFile, opts } = bench(t);
  // What the shipped 0.6.x installer left behind: launcher scripts under ~/.beezi-codex/hooks,
  // no `arguments`, and a label the user may since have reworded away.
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(opts(PROD).launcherDir, `beezi-${path.basename(script, '.mjs')}.sh`);
    hooks[event] = [{ matcher: '.*', hooks: [{ type: 'command', command: launcher, timeout: 10 }] }];
  }
  fs.mkdirSync(opts(PROD).launcherDir, { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));

  // Staging must not adopt — or delete — a legacy install that predates variants.
  const stagingStatus = hooksStatus(opts(STAGING));
  assert.equal(stagingStatus.state, 'absent');
  assert.equal(uninstallHooks(opts(STAGING)).removed, false);
  assert.ok(fs.existsSync(hooksFile), 'the legacy install survived a staging uninstall');
  assert.equal(readRegistry(hooksFile).hooks.Stop[0].hooks[0].command,
    path.join(opts(PROD).launcherDir, 'beezi-stop.sh'));

  // The unsuffixed owner is the migration path, and it does claim them.
  assert.equal(hooksStatus(opts(PROD)).state, 'stale');
  installHooks(opts(PROD));
  const registry = readRegistry(hooksFile);
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, 'converted in place, not duplicated');
    assert.equal(registry.hooks[event][0].hooks[0].command,
      hookCommand(launcherPath(opts(PROD).launcherDir), script, PROD));
  }
});

test("a staging install does not adopt production's untagged versioned-path entries", (t) => {
  // The migration case with two variants present: prod is still on the old form, staging installs.
  const { root, hooksFile, opts } = bench(t);
  const prodScripts = variantScriptsDir(root, PROD);
  fs.mkdirSync(prodScripts, { recursive: true });
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    fs.writeFileSync(path.join(prodScripts, script), '// stub\n');
    hooks[event] = [{
      matcher: '.*',
      hooks: [{ type: 'command', command: `node "${path.join(prodScripts, script)}"`, timeout: 10 }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
  const before = readRegistry(hooksFile);

  // Everything staging can see of prod is an untagged handler whose path says `beezi`. It must
  // resolve to the unsuffixed owner alone.
  assert.deepEqual(handlersOf(before, STAGING, opts(STAGING).launcherDir), []);
  assert.equal(handlersOf(before, PROD, opts(PROD).launcherDir).length, BEEZI_HOOKS.length);

  installHooks(opts(STAGING));
  const after = readRegistry(hooksFile);
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(after.hooks[event].length, 2);
    assert.equal(after.hooks[event][0].hooks[0].command,
      `node "${path.join(prodScripts, script)}"`,
      "prod's entry is unchanged, byte for byte — staging does not migrate it");
  }
});

test('dev, staging and prod coexist — three variants, one registry', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(DEV));
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  for (const owner of [DEV, PROD, STAGING]) {
    assert.equal(hooksStatus(opts(owner)).state, 'installed', `${owner} is installed`);
  }
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 3);

  uninstallHooks(opts(DEV));
  assert.equal(hooksStatus(opts(DEV)).state, 'absent');
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  assert.deepEqual(readRegistry(hooksFile).hooks.PreCompact[0].hooks, [USER_HOOK]);
});
