import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  startWatcher, isWatcherEnabled, WATCHER_ENV_VAR, observationFile,
} from '../lib/rollout-watcher.mjs';
import { locksDir } from '../lib/single-instance-lock.mjs';

// Terminal Codex API failures do not fire Stop, so the watcher is now their default delivery path.
// These tests also pin the explicit opt-out: it must load nothing and touch nothing.
//
// "Nothing at all" is asserted three ways, because each catches a different way of getting it
// wrong: no timer is armed (a resident loop), no filesystem call is made (a scan or a state read),
// and no lock is taken (an election that would exclude a real watcher on a machine that never
// asked for one).

const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An `fs` whose every member throws. Injected rather than mocked per method so a NEW call site
// added later is caught too — the assertion is "no filesystem access", not "not these six calls".
function explodingFs() {
  return new Proxy({}, {
    get(_target, prop) {
      return () => { throw new Error(`the watcher touched fs.${String(prop)} on an opted-out machine`); };
    },
  });
}

test('1. an opted-out machine arms no timer, touches no filesystem and takes no lock', () => {
  const armed = [];
  const locked = [];
  const handle = startWatcher({
    env: { [WATCHER_ENV_VAR]: '0' },
    fs: explodingFs(),
    setTimeoutImpl: (fn, ms) => { armed.push(ms); return { fake: true }; },
    clearTimeoutImpl: () => {},
    acquireLockImpl: (target) => { locked.push(target); throw new Error('no lock may be taken'); },
    linkedSessions: async () => { throw new Error('no account may be resolved'); },
    runCheckpoint: async () => { throw new Error('no checkpoint may run'); },
    runAudit: async () => { throw new Error('no audit may run'); },
    pruneStale: () => { throw new Error('no prune may run'); },
  });

  assert.equal(handle.started, false, 'startWatcher must report that it did not start');
  assert.equal(handle.reason, 'disabled');
  assert.deepEqual(armed, [], 'no timer may be armed on an opted-out machine');
  assert.deepEqual(locked, [], 'no lock may be taken on an opted-out machine');
  assert.doesNotThrow(() => handle.stop(), 'stop() on a watcher that never started is a no-op');
});

test('2. the watcher defaults on and recognizes explicit opt-out values', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled', ' true ']) {
    assert.equal(isWatcherEnabled({ [WATCHER_ENV_VAR]: on }), true, `${JSON.stringify(on)} must enable`);
  }
  // Every one of these is a truthy JavaScript string. A `if (env.X)` gate would start the watcher
  // on a machine whose owner typed the value that means "off".
  for (const off of ['0', 'false', 'no', 'off', 'disabled']) {
    assert.equal(isWatcherEnabled({ [WATCHER_ENV_VAR]: off }), false, `${JSON.stringify(off)} must not enable`);
  }
  assert.equal(isWatcherEnabled({}), true, 'absent means on');
  assert.equal(isWatcherEnabled(undefined), true, 'no env object means on');
  assert.equal(isWatcherEnabled({ [WATCHER_ENV_VAR]: '' }), true, 'an empty value does not opt out');
  assert.equal(isWatcherEnabled({ [WATCHER_ENV_VAR]: 'maybe' }), true, 'only an explicit off value opts out');
});

test('3. an opted-out machine leaves the data root untouched on a REAL filesystem', (t) => {
  const home = tmp(t, 'watcher-optin-home-');
  const codex = tmp(t, 'watcher-optin-codex-');
  const previousHome = process.env.BEEZI_CODEX_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = home;
  process.env.CODEX_HOME = codex;
  t.after(() => {
    if (previousHome === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previousHome;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  });

  // A rollout that a running watcher would certainly pick up.
  const day = path.join(codex, 'sessions', '2026', '09', '10');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, 'rollout-2026-09-10T00-00-00-11111111-2222-3333-4444-555555555555.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: '11111111-2222-3333-4444-555555555555', cwd: codex } })}\n`,
  );

  const handle = startWatcher({ env: { [WATCHER_ENV_VAR]: 'false' } });
  t.after(() => handle.stop());

  assert.equal(handle.started, false);
  assert.equal(fs.existsSync(observationFile()), false, 'no observation watermark may be written');
  assert.equal(fs.existsSync(locksDir()), false, 'no election lock directory may be created');
  assert.deepEqual(fs.readdirSync(home), [], 'the data root must be untouched');
});

test('4. scripts/mcp.mjs starts no watcher when the machine explicitly opts out', (t) => {
  const home = tmp(t, 'watcher-mcp-home-');
  const codex = tmp(t, 'watcher-mcp-codex-');
  const env = { ...process.env, BEEZI_CODEX_HOME: home, CODEX_HOME: codex };
  env[WATCHER_ENV_VAR] = 'off';
  delete env.NODE_TEST_CONTEXT;

  // stdin closes immediately: the server must leave of its own accord. A resident tick timer that
  // was never cleared would hold the loop open and this would time out instead.
  const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'mcp.mjs')], {
    cwd: PLUGIN_ROOT, encoding: 'utf-8', timeout: 30_000, env, input: '',
  });

  assert.equal(run.signal, null, `the server was killed: ${run.stderr}`);
  assert.equal(run.status, 0, `the server did not exit cleanly: ${run.stderr}`);
  assert.equal(run.stdout, '', 'nothing may be written to the JSON-RPC channel');
  assert.equal(fs.existsSync(path.join(home, 'locks')), false, 'no election lock was taken');
  assert.equal(fs.existsSync(path.join(home, 'watcher.json')), false, 'no watermark was written');
});

test('5. scripts/mcp.mjs defaults the watcher on and clears its timer at shutdown', (t) => {
  const home = tmp(t, 'watcher-mcp-on-home-');
  const codex = tmp(t, 'watcher-mcp-on-codex-');
  const env = { ...process.env, BEEZI_CODEX_HOME: home, CODEX_HOME: codex };
  delete env[WATCHER_ENV_VAR];
  delete env.NODE_TEST_CONTEXT;

  // The G-10-2 shape, in the one place a resident loop could reintroduce it: `unref()` would let
  // the loop drain (this passes for the wrong reason only if nothing is armed at all, which test 1
  // and the election tests rule out), while a ref'd timer that shutdown forgets to CLEAR hangs the
  // process until the tick fires — 20 s, past nothing here, but forever in a real session.
  const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'mcp.mjs')], {
    cwd: PLUGIN_ROOT, encoding: 'utf-8', timeout: 30_000, env, input: '',
  });

  assert.equal(run.signal, null, `the server hung with the watcher on: ${run.stderr}`);
  assert.equal(run.status, 0, `the server did not exit cleanly: ${run.stderr}`);
  assert.equal(run.stdout, '', 'the watcher must never write to the JSON-RPC channel');
});

test('6. the literal opt-out gate in scripts/mcp.mjs cannot drift from isWatcherEnabled', () => {
  // scripts/mcp.mjs decides by literal name AND literal value list, so an opted-out machine never
  // even loads the watcher's module graph — asking the module would defeat the gate. Both copies
  // are pinned here, in both directions: the file's list must be exactly the vocabulary
  // isWatcherEnabled accepts, no wider and no narrower.
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'mcp.mjs'), 'utf-8');
  assert.match(
    source,
    new RegExp(`process\\.env\\.${WATCHER_ENV_VAR}`),
    'scripts/mcp.mjs must gate on the same variable lib/rollout-watcher.mjs documents',
  );
  assert.match(source, /watcher\.stop\(\)/, 'the shutdown path must stop the watcher');

  const literal = /\[((?:\s*'[a-z0-9]+'\s*,?)+)\]\.indexOf\(/.exec(source);
  assert.ok(literal, 'scripts/mcp.mjs must decide against an inline list of opt-out values');
  const inline = literal[1].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);

  // Every value the script treats as off must also disable the module.
  for (const value of inline) {
    assert.equal(
      isWatcherEnabled({ [WATCHER_ENV_VAR]: value }), false,
      `scripts/mcp.mjs disables ${JSON.stringify(value)} but isWatcherEnabled does not`,
    );
  }
  // Every value the module treats as off must prevent the script's dynamic import.
  for (const value of ['0', 'false', 'no', 'off', 'disabled']) {
    assert.ok(
      inline.indexOf(value) !== -1,
      `isWatcherEnabled disables ${JSON.stringify(value)} but scripts/mcp.mjs would still import`,
    );
  }
  // Ordinary truthy and unknown values are not opt-outs.
  for (const on of ['1', 'true', 'yes', 'on', 'enabled', 'maybe']) {
    assert.equal(inline.indexOf(on), -1, `${JSON.stringify(on)} must not opt out`);
    assert.equal(isWatcherEnabled({ [WATCHER_ENV_VAR]: on }), true);
  }
});

test('7. .mcp.json and the module agree about whether Codex can forward the opt-out', () => {
  // `env_vars` is an allowlist. Without this entry, Codex silently discards the user's opt-out.
  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf-8'));
  const declared = config.mcpServers.beezi.env_vars;
  assert.ok(Array.isArray(declared), '.mcp.json must declare an env_vars allowlist');
  assert.ok(declared.indexOf(WATCHER_ENV_VAR) !== -1, 'Codex must forward the watcher opt-out');
});

test('8. a value that means OFF does not even load the watcher\'s module graph', (t) => {
  // `BEEZI_CODEX_WATCHER=0` is what a user types to turn something off, and it is a truthy
  // string. A bare `if (process.env.X)` gate reaches startWatcher(), which refuses correctly —
  // so nothing observable on disk differs, and every assertion in test 4's style passes on the
  // broken gate too. The cost is real but invisible: the watcher's whole module graph
  // (checkpoint, session-audit, coverage, the lock primitive) is parsed and evaluated in every
  // session of a machine that said no. V8 coverage is what makes "was this module loaded" an
  // observable, so that is what this asserts.
  const home = tmp(t, 'watcher-off-home-');
  const codex = tmp(t, 'watcher-off-codex-');
  const coverage = tmp(t, 'watcher-off-cov-');
  const env = {
    ...process.env, BEEZI_CODEX_HOME: home, CODEX_HOME: codex, NODE_V8_COVERAGE: coverage,
  };
  env[WATCHER_ENV_VAR] = '0';
  delete env.NODE_TEST_CONTEXT;

  const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'mcp.mjs')], {
    cwd: PLUGIN_ROOT, encoding: 'utf-8', timeout: 30_000, env, input: '',
  });
  assert.equal(run.status, 0, `the server did not exit cleanly: ${run.stderr}`);

  const reports = fs.readdirSync(coverage).map((f) => fs.readFileSync(path.join(coverage, f), 'utf-8'));
  assert.notEqual(reports.length, 0, 'V8 wrote no coverage — this test proves nothing without it');
  const loaded = reports.join('\n');
  // Positive control: the bridge IS loaded, so an empty match below means "not loaded", never
  // "coverage did not see this process".
  assert.ok(loaded.includes('mcp-bridge.mjs'), 'coverage must cover the server it ran');
  assert.ok(
    !loaded.includes('rollout-watcher.mjs'),
    'BEEZI_CODEX_WATCHER=0 must not import lib/rollout-watcher.mjs',
  );
});
