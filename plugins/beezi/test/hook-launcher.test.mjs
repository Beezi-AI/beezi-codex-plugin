import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import { compareVersions as libCompareVersions } from '../lib/version-compare.mjs';
import { codexHome } from '../lib/paths.mjs';
import {
  compareVersions,
  defaultCacheRoot,
  parseLauncherArgs,
  resolveHookScript,
} from '../scripts/hook-launcher.mjs';

// scripts/hook-launcher.mjs is the one file in the plugin that is DELIBERATELY duplicated: the
// installer copies it to `~/.beezi-codex[-env]/hooks/beezi-hook.mjs`, where it has no lib/ to import
// and must still answer "where is Codex's cache" and "which version is newest". This file is what
// keeps the two copies from drifting — the parity tests below import the lib originals — and what
// proves the copy still works from outside the plugin tree.

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const LAUNCHER_SOURCE = path.join(pluginRoot, 'scripts', 'hook-launcher.mjs');

// A temp tree per test. os.tmpdir() is inside the hermetic gate's allowed roots, so nothing here
// touches the developer's real ~/.codex.
function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-launcher-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Create `<cacheRoot>/<marketplace>/<owner>/<version>/scripts/<name>` with the given body. */
function plant(cacheRoot, marketplace, owner, version, name, body = '// hook\n') {
  const scriptsDir = path.join(cacheRoot, marketplace, owner, version, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const file = path.join(scriptsDir, name);
  fs.writeFileSync(file, body);
  return file;
}

// ── resolution ────────────────────────────────────────────────────────────────────────────────

test('picks the highest version across two marketplace directories', (t) => {
  const cacheRoot = path.join(tempRoot(t), 'cache');
  plant(cacheRoot, 'beezi', 'beezi', '0.10.18', 'checkpoint.mjs');
  const newer = plant(cacheRoot, 'beezi-internal', 'beezi', '0.10.19', 'checkpoint.mjs');

  const found = resolveHookScript({ owner: 'beezi', scriptName: 'checkpoint.mjs', cacheRoot });
  assert.ok(found, 'nothing resolved');
  assert.equal(found.scriptPath, newer);
  assert.equal(found.version, '0.10.19');
  assert.equal(found.marketplace, 'beezi-internal');
  assert.equal(found.scriptsDir, path.dirname(newer));
});

test('prerelease builds rank behind the release, and numerically among themselves', (t) => {
  const cacheRoot = path.join(tempRoot(t), 'cache');
  plant(cacheRoot, 'm', 'beezi-local', '0.10.19-local.5243', 'stop.mjs');
  const mid = plant(cacheRoot, 'm', 'beezi-local', '0.10.19-local.5249', 'stop.mjs');

  // 5249 > 5243 — a string compare would already be right here, but not at the tens boundary.
  assert.equal(
    resolveHookScript({ owner: 'beezi-local', scriptName: 'stop.mjs', cacheRoot }).scriptPath,
    mid,
  );

  // The plain release outranks every `-local.N` build of the same core version.
  const release = plant(cacheRoot, 'm', 'beezi-local', '0.10.19', 'stop.mjs');
  assert.equal(
    resolveHookScript({ owner: 'beezi-local', scriptName: 'stop.mjs', cacheRoot }).scriptPath,
    release,
  );

  // ...and a higher core version wins even as a prerelease.
  const next = plant(cacheRoot, 'm', 'beezi-local', '0.10.20-local.1', 'stop.mjs');
  assert.equal(
    resolveHookScript({ owner: 'beezi-local', scriptName: 'stop.mjs', cacheRoot }).scriptPath,
    next,
  );
});

test('a version directory missing the script is skipped even when it is the highest', (t) => {
  const cacheRoot = path.join(tempRoot(t), 'cache');
  const older = plant(cacheRoot, 'm', 'beezi', '0.10.18', 'session-start.mjs');
  // 0.10.19 exists and is newer, but only ships a different script — mid-unpack, or a release that
  // dropped the hook. Choosing it would fail at import time with nothing to say.
  plant(cacheRoot, 'm', 'beezi', '0.10.19', 'checkpoint.mjs');

  const found = resolveHookScript({ owner: 'beezi', scriptName: 'session-start.mjs', cacheRoot });
  assert.equal(found.scriptPath, older);
  assert.equal(found.version, '0.10.18');
});

test('an unparseable version directory never outranks a real install', (t) => {
  const cacheRoot = path.join(tempRoot(t), 'cache');
  const real = plant(cacheRoot, 'm', 'beezi', '0.9.1', 'stop.mjs');
  plant(cacheRoot, 'm', 'beezi', 'zzz-scratch', 'stop.mjs');
  assert.equal(
    resolveHookScript({ owner: 'beezi', scriptName: 'stop.mjs', cacheRoot }).scriptPath,
    real,
  );
});

test('returns null when no marketplace carries the owner, and never throws on a missing tree', (t) => {
  const cacheRoot = path.join(tempRoot(t), 'cache');
  plant(cacheRoot, 'm', 'beezi', '1.0.0', 'stop.mjs');

  assert.equal(resolveHookScript({ owner: 'beezi-staging', scriptName: 'stop.mjs', cacheRoot }), null);
  assert.equal(resolveHookScript({ owner: 'beezi', scriptName: 'nope.mjs', cacheRoot }), null);
  assert.equal(
    resolveHookScript({
      owner: 'beezi', scriptName: 'stop.mjs', cacheRoot: path.join(cacheRoot, 'does-not-exist'),
    }),
    null,
  );
  // A MISSING argument must return null, not throw: resolveHookScript is exported and the installer
  // calls it directly. `String(undefined)` is all letters, so an owner guard that stringifies first
  // sails past the pattern and then throws inside path.join.
  assert.equal(resolveHookScript({ scriptName: 'stop.mjs', cacheRoot }), null);
  assert.equal(resolveHookScript({ owner: 'beezi', cacheRoot }), null);
  assert.equal(resolveHookScript(), null);
});

// ── the duplicated answers ────────────────────────────────────────────────────────────────────

test('defaultCacheRoot agrees with lib/paths.mjs codexHome()', () => {
  assert.equal(defaultCacheRoot(), path.join(codexHome(), 'plugins', 'cache'));
});

test('compareVersions agrees with lib/version-compare.mjs', () => {
  const pairs = [
    ['1.0.0', '1.0.0'],
    ['1.0.1', '1.0.0'],
    ['1.0.0', '1.1.0'],
    ['2.0.0', '10.0.0'],
    ['0.10.19', '0.10.19-local.5249'],
    ['0.10.19-local.5243', '0.10.19-local.5249'],
    ['0.10.19-local.9', '0.10.19-local.10'],
    ['0.10.19-local.5249', '0.10.20-local.1'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-beta'],
    ['1.0.0-1', '1.0.0-alpha'],
    ['1.0.0+build.7', '1.0.0'],
    ['1.2', '1.2.3'],
    ['zzz-scratch', '1.0.0'],
    [null, '1.0.0'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(compareVersions(a, b), libCompareVersions(a, b), `forward: ${a} vs ${b}`);
    assert.equal(compareVersions(b, a), libCompareVersions(b, a), `reverse: ${b} vs ${a}`);
  }
});

// ── argument parsing ──────────────────────────────────────────────────────────────────────────

test('parseLauncherArgs defaults the owner and accepts the ownership tag', () => {
  assert.deepEqual(parseLauncherArgs(['checkpoint.mjs']), {
    scriptName: 'checkpoint.mjs', owner: 'beezi',
  });
  assert.deepEqual(parseLauncherArgs(['stop.mjs', '--beezi-owner=beezi-local']), {
    scriptName: 'stop.mjs', owner: 'beezi-local',
  });
});

test('parseLauncherArgs refuses a traversing script name and a bad owner', () => {
  // hooks.json is a plain file on disk; a launcher that resolved `../x.mjs` would be an
  // arbitrary-file runner for anyone who could edit it.
  assert.throws(() => parseLauncherArgs(['../x.mjs']), /bare file name/);
  assert.throws(() => parseLauncherArgs(['sub/x.mjs']), /bare file name/);
  assert.throws(() => parseLauncherArgs(['..\\x.mjs']), /bare file name/);
  assert.throws(() => parseLauncherArgs([]), /usage:/);
  assert.throws(() => parseLauncherArgs(['stop.mjs', '--beezi-owner=../beezi']), /refusing owner/);
  assert.throws(() => parseLauncherArgs(['stop.mjs', '--beezi-owner=']), /refusing owner/);
});

// ── end to end, from outside the plugin tree ──────────────────────────────────────────────────

// The fixture stands in for a real hook script: it reads stdin itself and exits, exactly as
// scripts/checkpoint.mjs does. Written at run time rather than into test/fixtures/, because
// test/hermetic.test.mjs forbids a non-test .mjs anywhere under test/.
const FIXTURE_SOURCE = [
  "import fs from 'fs';",
  // Reads fd 0 SYNCHRONOUSLY at module top level, exactly as readHookInput() in lib/hook-input.mjs
  // does. That is the read the real hook scripts perform, and it is the one the launcher's new
  // async hop — dynamic import resolution — now sits in front of.
  "const data = fs.readFileSync(0, 'utf-8');",
  '  fs.writeFileSync(process.env.BEEZI_FIXTURE_OUT, JSON.stringify({ stdin: data, argv: process.argv }));',
  'process.exit(0);',
  '',
].join('\n');

function runLauncher(t, { cacheContents, args, input }) {
  const root = tempRoot(t);
  const codex = path.join(root, 'codex');
  fs.mkdirSync(codex, { recursive: true });
  const outFile = path.join(root, 'fixture-out.json');

  // Copy the launcher OUT of the plugin tree first — that is the whole claim being tested: it has
  // to work from the stable path the installer copies it to, with no plugin around it.
  const launcherDir = path.join(root, 'beezi-home', 'hooks');
  fs.mkdirSync(launcherDir, { recursive: true });
  const launcher = path.join(launcherDir, 'beezi-hook.mjs');
  fs.copyFileSync(LAUNCHER_SOURCE, launcher);

  if (cacheContents) cacheContents(path.join(codex, 'plugins', 'cache'));

  const env = Object.assign({}, process.env, {
    CODEX_HOME: codex,
    BEEZI_FIXTURE_OUT: outFile,
  });
  // withoutGuard: spawning a child `node` is the experiment here, not a leak. Same sanctioned use
  // as test/sync-surface.test.mjs.
  const res = withoutGuard(() => spawnSync(process.execPath, [launcher].concat(args), {
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    env,
  }));
  return { res, outFile, codex, launcher };
}

test('end to end: the launcher runs the newest installed hook script with stdin intact', (t) => {
  const stdin = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
  const { res, outFile, launcher } = runLauncher(t, {
    cacheContents: (cacheRoot) => {
      plant(cacheRoot, 'm', 'beezi-local', '1.2.3', 'fixture.mjs', FIXTURE_SOURCE);
    },
    args: ['fixture.mjs', '--beezi-owner=beezi-local'],
    input: stdin,
  });

  assert.equal(res.status, 0, `launcher failed:\n${res.stdout}\n${res.stderr}`);
  assert.equal(res.stdout, '', 'the launcher printed on success — Codex would parse that as hook output');
  // Asserting the output FILE, not just the exit status: a broken import.meta.url comparison on
  // Windows makes the guard fall through silently, which also exits 0 with no output.
  assert.equal(fs.existsSync(outFile), true, 'the hook script never ran');
  const recorded = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.equal(recorded.stdin, stdin, 'the launcher consumed or mangled stdin');
  // process.argv is handed through untouched: argv[1] is still the launcher, and the launcher's own
  // arguments trail it. No hook script reads them, and this pins that they are left alone.
  assert.equal(recorded.argv[1], launcher);
  assert.deepEqual(recorded.argv.slice(2), ['fixture.mjs', '--beezi-owner=beezi-local']);
});

test('end to end: no installed plugin exits 1 and points at hooks.json', (t) => {
  const { res, codex } = runLauncher(t, {
    cacheContents: null,
    args: ['fixture.mjs', '--beezi-owner=beezi-local'],
    input: '{}',
  });

  assert.equal(res.status, 1);
  assert.match(res.stderr, /^Beezi: no installed beezi-local plugin has scripts\/fixture\.mjs;/);
  assert.match(res.stderr, /hooks\.json/);
  assert.ok(res.stderr.includes(path.join(codex, 'hooks.json')), `stderr: ${res.stderr}`);
  assert.equal(res.stderr.trim().split('\n').length, 1, 'the failure must be ONE line');
});

test('end to end: a rejected script name exits 1 without running anything', (t) => {
  const { res, outFile } = runLauncher(t, {
    cacheContents: (cacheRoot) => {
      plant(cacheRoot, 'm', 'beezi', '1.2.3', 'fixture.mjs', FIXTURE_SOURCE);
    },
    args: ['../fixture.mjs'],
    input: '{}',
  });

  assert.equal(res.status, 1);
  assert.match(res.stderr, /^Beezi: refusing script name/);
  assert.equal(fs.existsSync(outFile), false);
});
