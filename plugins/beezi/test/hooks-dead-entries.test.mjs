import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {
  BEEZI_HOOKS,
  brokenBeeziEntries,
  ensureHooks,
  hooksStatus,
  installHooks,
  launcherPath,
  removeDeadBeeziEntries,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

// A registered hook whose target file is gone.
//
// Measured on a live Windows machine running the beezi-local variant: three launcher-style entries
// from an older PRODUCTION install were still in ~/.codex/hooks.json, pointing into a
// ~/.beezi-codex/hooks directory that had since been deleted. Codex spawned them every session.
// Through cmd.exe a missing .cmd is `The system cannot find the path specified.` and exit 1, so
// SessionStart, PostToolUse and Stop each reported `hook: <Event> Failed` — for every session, on
// a machine whose own `hooks.mjs status` said `✓ analytics hooks are installed`.
//
// It said that truthfully: `state` is owner-scoped, and the orphans belonged to `beezi` while the
// process asking belonged to `beezi-local`. These tests lock both halves: the REPORT, and — since
// the instruction it produced ("run that variant's uninstall") is unanswerable for a variant the
// user has already deleted — the automatic REMOVAL that install now performs across owners.
//
// WHAT THE STABLE LAUNCHER CHANGED HERE: the target every entry names is now that owner's single
// launcher file, not a versioned script path. So an upgrade produces NO dead entries at all (the
// first test below is the regression lock for that), and a variant that was removed root and branch
// still produces the five orphans this scan exists to find.

const PROD = 'beezi';
const LOCAL = 'beezi-local';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LAUNCHER_SOURCE = path.join(HERE, 'fixtures', 'hooks', 'launcher.mjs.txt');

function bench(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-dead-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const opts = (owner) => ({
    launcherDir: path.join(
      root, owner === PROD ? '.beezi-codex' : `.beezi-codex-${owner.slice('beezi-'.length)}`, 'hooks',
    ),
    launcherSource: LAUNCHER_SOURCE,
    hooksFile,
    owner,
  });
  return { root, hooksFile, opts };
}

/** A second launcher source with different bytes — what the next plugin version ships. */
function newerLauncher(root) {
  const file = path.join(root, `newer-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, `${fs.readFileSync(LAUNCHER_SOURCE, 'utf-8')}\n// newer\n`);
  return file;
}

/** The registry an abandoned pre-launcherless production install leaves behind. */
function writeLegacyProdLaunchers(hooksFile, launcherDir, { onDisk }) {
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`);
    hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: launcher,
        commandWindows: launcher,
        // The label is the anchor that survives across owners; see brokenBeeziEntries.
        statusMessage: 'Beezi analytics',
        timeout: 10,
      }],
    }];
  }
  if (onDisk) {
    fs.mkdirSync(launcherDir, { recursive: true });
    for (const { script } of BEEZI_HOOKS) {
      fs.writeFileSync(path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`), '@echo off\n');
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

/** The same launchers, merged into a registry that already has a healthy install in it. */
function injectLegacyProdLaunchers(hooksFile, launcherDir) {
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`);
    registry.hooks[event] = [
      ...(registry.hooks[event] || []),
      {
        matcher: '.*',
        hooks: [{
          type: 'command',
          command: launcher,
          commandWindows: launcher,
          statusMessage: 'Beezi analytics',
          timeout: 10,
        }],
      },
    ];
  }
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));
}

test('an upgrade produces neither a stale nor a dead entry — the whole ticket', (t) => {
  const { root, opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);
  const registry = fs.readFileSync(local.hooksFile, 'utf-8');

  // What a plugin upgrade is now: a new launcher file, and nothing else. The registry never named
  // the versioned cache directory, so there is nothing in it for the upgrade to invalidate.
  const upgraded = { ...local, launcherSource: newerLauncher(root) };
  const status = hooksStatus(upgraded);
  assert.equal(status.state, 'installed');
  assert.deepEqual(status.staleEvents, []);
  assert.deepEqual(status.broken, [], JSON.stringify(status.broken));
  assert.equal(status.launcher, 'stale');

  const result = ensureHooks(upgraded);
  assert.equal(result.repaired, false, 'no rewrite, so no re-trust');
  assert.equal(result.launcherRefreshed, true);
  assert.equal(fs.readFileSync(local.hooksFile, 'utf-8'), registry);
});

test('a healthy install of this owner reports no dead entries', (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);

  const status = hooksStatus(local);
  assert.equal(status.state, 'installed');
  assert.deepEqual(status.broken, [], JSON.stringify(status.broken));
  assert.ok(fs.existsSync(hooksFile));
});

test("a sibling's dead launchers are reported by this owner even while its own state is installed", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);

  // The measured sequence: local is installed and healthy, and production's launcher dir is
  // deleted AFTERWARDS — so nothing has run an install since, and the orphans are simply sitting
  // there. (An install run after this point sweeps them; that is a separate test below.)
  installHooks(local);
  injectLegacyProdLaunchers(hooksFile, prod.launcherDir);

  const status = hooksStatus(local);

  // Owner scoping is unchanged — local's own install really is complete, and says so.
  assert.equal(status.state, 'installed');
  assert.equal(status.complete, true);

  // …and the orphans are now named anyway. This is the whole defect: before this scan existed it
  // was `[]`, and three events failed on every session with nothing in the product saying why.
  assert.equal(status.broken.length, BEEZI_HOOKS.length);
  for (const entry of status.broken) {
    assert.equal(entry.owner, PROD);
    assert.ok(entry.target.endsWith('.cmd'), entry.target);
    assert.equal(fs.existsSync(entry.target), false);
  }
  assert.deepEqual(
    status.broken.map((b) => b.event).sort(),
    BEEZI_HOOKS.map((h) => h.event).sort(),
  );
});

test('a sibling whose launchers still exist is not reported', (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: true });
  installHooks(local);

  assert.deepEqual(hooksStatus(local).broken, []);
});

test("the owning variant's own uninstall clears the report — no cross-owner mutation needed", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  installHooks(local);
  injectLegacyProdLaunchers(hooksFile, prod.launcherDir);
  assert.equal(hooksStatus(local).broken.length, BEEZI_HOOKS.length);

  // The repair the report points at. It is `beezi`'s uninstall, run as `beezi` — the one-owner-
  // per-mutation rule is not relaxed by any of this.
  assert.equal(uninstallHooks(prod).removed, true);

  const after = hooksStatus(local);
  assert.deepEqual(after.broken, []);
  assert.equal(after.state, 'installed', 'local survived the sibling uninstall untouched');
});

test("a user's own broken hook is not ours to report", (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);

  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  registry.hooks.PreCompact = [{
    matcher: '.*',
    hooks: [{ type: 'command', command: path.join(opts(PROD).launcherDir, '..', 'audit.sh') }],
  }];
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));

  // Missing, but neither tagged, labelled, nor shaped like one of our entries — not ours.
  assert.deepEqual(hooksStatus(local).broken, []);
});

test('brokenBeeziEntries tolerates a registry it cannot walk', () => {
  assert.deepEqual(brokenBeeziEntries(null, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({}, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: 'nope' }, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: { Stop: 'nope' } }, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: { Stop: [null, { hooks: [null, 7] }] } }, '/nope'), []);
});

test('a PATH-resolved interpreter is never treated as a missing file', () => {
  // `command: 'node'` with no arguments names no path — statting it would report every such entry
  // as dead. Labelled as ours so only handlerTarget can be what excludes it.
  const registry = {
    hooks: {
      Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node', statusMessage: 'Beezi analytics' }] }],
    },
  };
  assert.deepEqual(brokenBeeziEntries(registry, '/nope'), []);
});

test("a variant's install sweeps a dead legacy launcher it does not own", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: false });

  installHooks(local);

  // The orphans are gone without anyone having found the production plugin to run its uninstall —
  // the case that matters, because a user who removed that variant no longer HAS it to run.
  const after = hooksStatus(local);
  assert.deepEqual(after.broken, []);
  assert.equal(after.state, 'installed');

  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const groups of Object.values(registry.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.match(
          handler.command,
          /^node ".+beezi-hook\.mjs" [a-z-]+\.mjs --beezi-owner=beezi-local$/,
          JSON.stringify(handler),
        );
        assert.ok(!('arguments' in handler), JSON.stringify(handler));
      }
    }
  }
});

test('a LIVE legacy launcher is never swept — only a dead one', (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: true });

  installHooks(local);

  // Production is still installed and its launchers still exist: removing them would break a
  // working sibling, which is the defect the owner-scoping rule exists to prevent.
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  const launchers = [];
  for (const groups of Object.values(registry.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (handler.command.indexOf('node "') !== 0) launchers.push(handler.command);
      }
    }
  }
  assert.equal(launchers.length, BEEZI_HOOKS.length, JSON.stringify(launchers));
});

test('the sweep will not touch a missing file that merely looks beezi-flavoured', (t) => {
  const { opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);

  // Each of these fails exactly one of the three conditions: wrong prefix, wrong parent dir,
  // wrong root dir.
  const notOurs = [
    path.join(opts(PROD).launcherDir, 'other-stop.cmd'),
    path.join(path.dirname(opts(PROD).launcherDir), 'beezi-stop.cmd'),
    path.join('/somewhere', '.config', 'hooks', 'beezi-stop.cmd'),
  ];
  const registry = JSON.parse(fs.readFileSync(local.hooksFile, 'utf-8'));
  registry.hooks.PreCompact = [{
    matcher: '.*',
    hooks: notOurs.map((command) => ({ type: 'command', command })),
  }];
  fs.writeFileSync(local.hooksFile, JSON.stringify(registry, null, 2));

  installHooks(local);

  const after = JSON.parse(fs.readFileSync(local.hooksFile, 'utf-8'));
  assert.deepEqual(
    after.hooks.PreCompact[0].hooks.map((h) => h.command),
    notOurs,
    'a non-matching entry survived install untouched',
  );
});

test('removeDeadBeeziEntries tolerates a registry it cannot walk', () => {
  assert.deepEqual(removeDeadBeeziEntries(null, '/nope'), {});
  assert.deepEqual(removeDeadBeeziEntries({}, '/nope'), {});
  assert.deepEqual(removeDeadBeeziEntries({ hooks: 'nope' }, '/nope'), { hooks: 'nope' });
  assert.deepEqual(
    removeDeadBeeziEntries({ hooks: { Stop: [null, { hooks: [7] }] } }, '/nope'),
    { hooks: { Stop: [null, { hooks: [7] }] } },
  );
});

// ── the sweep is not launcher-shaped, and never was only launcher-shaped ────
//
// A variant removed root and branch leaves current-format entries behind:
// `node "<gone>/.beezi-codex-staging/hooks/beezi-hook.mjs" stop.mjs --beezi-owner=beezi-staging`.
// They fail every spawn just as the old per-event launchers did, and the instruction they used to
// produce — "run that variant's uninstall" — is unanswerable once the variant is gone.

/** A sibling's current-format install, pointed at a launcher dir that is not on disk. */
function injectDeadSiblingEntries(hooksFile, owner, launcherDir) {
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    registry.hooks[event] = [
      ...(registry.hooks[event] || []),
      {
        matcher: '.*',
        hooks: [{
          type: 'command',
          command: `node "${launcherPath(launcherDir)}" ${script} --beezi-owner=${owner}`,
          statusMessage: 'Beezi analytics (staging)',
          timeout: 10,
        }],
      },
    ];
  }
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));
}

test("install sweeps a sibling's dead current-format entries, not only its launchers", (t) => {
  const { root, hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);
  injectDeadSiblingEntries(hooksFile, 'beezi-staging', path.join(root, 'gone', '.beezi-codex-staging', 'hooks'));
  assert.equal(hooksStatus(local).broken.length, BEEZI_HOOKS.length);

  const result = installHooks(local);

  assert.equal(result.swept.length, BEEZI_HOOKS.length);
  const after = hooksStatus(local);
  assert.deepEqual(after.broken, []);
  assert.equal(after.state, 'installed');
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, `${event} keeps only the live install`);
    assert.match(registry.hooks[event][0].hooks[0].command, /--beezi-owner=beezi-local$/);
  }
});

test("a LIVE sibling's current-format entries are never swept", (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  const prod = opts(PROD);
  installHooks(prod);
  installHooks(local);

  installHooks(local);

  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 2, `${event} still carries both variants`);
  }
  assert.equal(hooksStatus(prod).state, 'installed', 'the sibling is untouched');
});

// ── ensureHooks: repair without being asked, and without revoking trust ──────

test('ensureHooks installs when absent and migrates a pre-launcher registry', (t) => {
  const { root, opts } = bench(t);
  const local = opts(LOCAL);

  const first = ensureHooks(local);
  assert.equal(first.repaired, true);
  assert.equal(first.before, 'absent');
  assert.equal(first.state, 'installed');
  assert.equal(first.launcherRefreshed, true);

  // A registry written by a version that registered the versioned script path: `stale`, migrated
  // once, and then frozen for good.
  const legacyScripts = path.join(root, 'plugins', 'cache', 'beezi-internal', LOCAL, '0.8.0', 'scripts');
  fs.mkdirSync(legacyScripts, { recursive: true });
  const registry = JSON.parse(fs.readFileSync(local.hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    fs.writeFileSync(path.join(legacyScripts, script), '// stub\n');
    registry.hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: `node "${path.join(legacyScripts, script)}" --beezi-owner=${LOCAL}`,
        statusMessage: 'Beezi analytics (local)',
        timeout: 10,
      }],
    }];
  }
  fs.writeFileSync(local.hooksFile, JSON.stringify(registry, null, 2));
  assert.equal(hooksStatus(local).state, 'stale');

  const second = ensureHooks(local);
  assert.equal(second.repaired, true);
  assert.equal(second.before, 'stale');
  assert.equal(second.state, 'installed');
});

test('ensureHooks does not touch a healthy registry — trust is hash-keyed', (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  installHooks(local);

  const before = fs.readFileSync(hooksFile, 'utf-8');
  const mtime = fs.statSync(hooksFile).mtimeMs;

  const result = ensureHooks(local);

  assert.equal(result.repaired, false);
  assert.equal(result.launcherRefreshed, false, 'the launcher was already current');
  assert.equal(result.state, 'installed');
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), before);
  // A rewrite of identical entries would still change each hook's hash for Codex and send the user
  // back to /hooks for nothing, so the file must not be written at all.
  assert.equal(fs.statSync(hooksFile).mtimeMs, mtime);
});

test('ensureHooks repairs a healthy install that shares a registry with dead entries', (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  const prod = opts(PROD);
  installHooks(local);
  injectLegacyProdLaunchers(hooksFile, prod.launcherDir);

  // `state` is `installed` — owner-scoped, and local's own entries really are current. The dead
  // sibling entries are the only reason to write, and they are reason enough: they fail every
  // session until something removes them.
  assert.equal(hooksStatus(local).state, 'installed');

  const result = ensureHooks(local);

  assert.equal(result.repaired, true);
  assert.equal(result.swept.length, BEEZI_HOOKS.length);
  assert.deepEqual(hooksStatus(local).broken, []);
});
