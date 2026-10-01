// Self-test for the hermeticity gate (G-10-1). This is the file that fails when a leak channel
// reopens — the suite going green on the author's machine is exactly the symptom that hid the
// original bug, so every assertion here is about a machine the suite is NOT running on.
//
// The three channels, as traced in tools/hermetic-env.mjs and S10:
//   L1  resolveSource / resolveBilling callers drop `deps`, so the ladder's step 4 opens the real
//       ~/.codex/auth.json.
//   L2  direct buildConfig callers pass no deps at all, reaching the same file from the test.
//   L3  `env = process.env` defaults let a host OPENAI_API_KEY win at step 1 of the ladder.
//
// Importing the gate is itself part of the test: this file runs under the sandbox like any other.
import {
  SANDBOX, REAL_HOME, SCRUBBED_ENV, GUARDED_FS_CALLS, FD_ONLY_FS_CALLS, withoutGuard,
} from '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as paths from '../lib/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const PRELOAD_PATH = path.join(pluginRoot, 'tools', 'hermetic-env.mjs');
// A file:// URL, not a path: on Windows `--import C:\...` dies with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const PRELOAD = pathToFileURL(PRELOAD_PATH).href;

const inside = (candidate, root) => {
  const a = path.resolve(candidate);
  const r = path.resolve(root);
  return a === r || a.startsWith(r + path.sep);
};

const sources = (dir) => fs.readdirSync(path.join(pluginRoot, dir))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => [`${dir}/${name}`, fs.readFileSync(path.join(pluginRoot, dir, name), 'utf-8')]);

// Every spawn below is the experiment, not a leak, so the backstop is told so explicitly.
function run(args, env) {
  const childEnv = { ...process.env, ...env };
  // Node marks a test-file process with NODE_TEST_CONTEXT=child-v8, and a runner that inherits it
  // prints "run() is being called recursively within a test file. skipping running files" and
  // exits 0 WITHOUT RUNNING ANYTHING. Every trap below would then pass vacuously — which is how
  // the first version of this file reported green while proving nothing.
  delete childEnv.NODE_TEST_CONTEXT;
  return withoutGuard(() => spawnSync(process.execPath, args, {
    cwd: pluginRoot, encoding: 'utf8', timeout: 120_000, env: childEnv,
  }));
}

// The test runner re-emits a child test-file's stderr on its own stdout, so a trap that looks for
// the violation block has to read both streams.
const out = (res) => `${res.stdout || ''}\n${res.stderr || ''}`;

// A throwaway test file in the OS temp dir. It must NOT live under test/ — Node's default patterns
// include `**/test/**/*.?(c|m)js`, so anything there is collected and counted as a test file.
function probeFile(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-trap-'));
  const file = path.join(dir, 'probe.test.mjs');
  fs.writeFileSync(file, source);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

// A home with nothing in it — no .codex, no .beezi-codex — which is what CI actually has.
function emptyHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-clean-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A believable "real machine" for a child to protect, built rather than borrowed.
//
// Two reasons not to just hand the child this process's REAL_HOME. It would make the trap depend
// on the developer's actual disk, which is the habit this whole gate exists to break; and the
// backstop necessarily exempts os.tmpdir(), which on Windows lives INSIDE the home
// (%USERPROFILE%\AppData\Local\Temp) - so a run whose HOME has been redirected into a temp dir
// (exactly what a clean-machine verification does) would find every probe path already exempt and
// record nothing. Giving the child a home and a tmpdir that are siblings removes both problems.
//
// The residual limitation this makes visible, and it is inherent to a path-prefix guard: a read of
// something under %TEMP% is never flagged even though %TEMP% is under the home. Neither ~/.codex
// nor ~/.beezi-codex is ever there, so no leak channel hides in that gap.
function pretendMachine(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-machine-'));
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

// ── the acceptance trap ───────────────────────────────────────────────────────────────────────
// This is the one that matters. It runs the three files that carried all ten machine-dependent
// tests, with NO preload, against the most hostile environment S10 could construct: an api-key
// auth.json holding a stored key, an exported OPENAI_API_KEY, and a home with nothing in it.
// Green here means the suite no longer has an opinion about the machine it runs on.
//
// Explicit file paths, never a bare --test: a child that rediscovered the suite would re-enter
// this file and recurse.
test('the billing tests pass unchanged on a hostile machine, with no preload', (t) => {
  const home = emptyHome(t);
  const codexHome = path.join(emptyHome(t), '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-stored', tokens: {} }),
  );
  const res = run(
    ['--test', 'test/billing-capture.test.mjs', 'test/session-start.test.mjs', 'test/usage-report-codex.test.mjs'],
    {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,                              // L1: a hostile step-4 answer
      BEEZI_CODEX_HOME: path.join(home, '.beezi-codex'),
      OPENAI_API_KEY: 'sk-x',                             // L3: a hostile step-1 answer
    },
  );
  assert.equal(res.status, 0, `a leak channel reopened:\n${out(res)}`);
});

// ── L1: the backstop names a read of the real home, and fails the process for it ───────────────
// Recorded rather than thrown, because billing-config.mjs:113 is
// `try { signals = readSignals(); } catch { signals = null; }` — a throw is swallowed there.
// The assertion is on the EXIT STATUS, not only the printed block: process.exitCode set inside an
// 'exit' handler is honoured on a natural exit but ignored once anything has called process.exit().
test('L1 — a deliberate read of the real home is recorded and fails the run', (t) => {
  const probe = probeFile(t, `
    import { test } from 'node:test';
    import fs from 'node:fs';
    import path from 'node:path';
    test('reads the real ~/.codex/auth.json the way an un-threaded resolveSource would', () => {
      // Swallowed exactly like the production call site does. The gate must still notice.
      try { fs.readFileSync(path.join(process.env.BEEZI_TRAP_REAL_HOME, '.codex', 'auth.json')); }
      catch { /* absent or unreadable — irrelevant, the reach is the violation */ }
    });
  `);
  const machine = pretendMachine(t);
  const res = run(['--import', PRELOAD, '--test', probe], {
    ...machine,
    BEEZI_TRAP_REAL_HOME: machine.HOME,
  });
  assert.notEqual(res.status, 0, `the gate let a real-home read pass:\n${out(res)}`);
  assert.match(out(res), /HERMETICITY VIOLATION/);
  assert.match(out(res), /fs\.readFileSync\(.*auth\.json\)/, 'the violation names the offending call');
});

test('L1 — the same read INSIDE the sandbox is not a violation', (t) => {
  // The negative control. Without it, a guard that flagged everything would look like a pass.
  const probe = probeFile(t, `
    import { test } from 'node:test';
    import fs from 'node:fs';
    import { codexAuthFile } from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, 'lib', 'paths.mjs')).href)};
    test('the redirected root is readable without tripping the gate', () => {
      try { fs.readFileSync(codexAuthFile()); } catch { /* absent is fine */ }
    });
  `);
  const res = run(['--import', PRELOAD, '--test', probe], pretendMachine(t));
  assert.equal(res.status, 0, `false positive:\n${out(res)}`);
});

// ── L2: redirection, so a deps-less caller CANNOT name the real machine ────────────────────────
// L2 is `buildConfig(...)` with no deps: there is no injection point at all, so the only defence
// is that codexHome() has nowhere real to point. This asserts that for the whole path surface —
// which is also the direct evidence that a run never writes to ~/.codex or ~/.beezi-codex.
test('L2 — every root lib/paths.mjs resolves is inside the sandbox', () => {
  const roots = Object.entries(paths).filter(([, v]) => typeof v === 'function');
  // The EXACT count, not a floor that stopped meaning anything as the surface grew (it said 15
  // while there were 29). A new accessor has to be added here deliberately, which is the point:
  // this sweep is the evidence that no root escapes the sandbox, and an accessor nobody added to
  // the count is an accessor nobody proved anything about.
  assert.equal(roots.length, 26, `the path surface changed — add the new accessor's reasoning here`);
  // The two roots a run must never touch, named rather than the whole home: on Windows the temp
  // directory sits under %USERPROFILE%, so "not under the home" would also forbid the sandbox.
  const forbidden = [path.join(REAL_HOME, '.codex'), path.join(REAL_HOME, '.beezi-codex')];
  // Keyed accessors REFUSE a missing key, so the sweep supplies one rather than skipping them:
  // an account directory that escaped the sandbox would be exactly as damaging as a root that
  // did, and skipping them would quietly shrink the surface this test proves.
  const PROBE_KEY = '0123abcd';
  for (const [name, fn] of roots) {
    const resolved = fn.length > 0 ? fn(PROBE_KEY) : fn();
    assert.ok(inside(resolved, SANDBOX), `${name}() → ${resolved} escaped the sandbox`);
    for (const root of forbidden) {
      assert.equal(inside(resolved, root), false, `${name}() → ${resolved} is the real ${root}`);
    }
  }
});

// ── L3: the environment that steers the ladder is gone, not merely blanked ─────────────────────
test('L3 — OPENAI_API_KEY and friends are deleted from process.env', () => {
  for (const key of SCRUBBED_ENV) {
    assert.equal(key in process.env, false, `${key} survived the scrub`);
  }
});

test('L3 — an exported OPENAI_API_KEY does not survive the preload', () => {
  const res = run(
    ['--import', PRELOAD, '-e', 'process.stdout.write(String(process.env.OPENAI_API_KEY))'],
    { OPENAI_API_KEY: 'sk-x' },
  );
  assert.equal(res.stdout, 'undefined', `the host key reached the process:\n${out(res)}`);
});

// ── the backstop's own coverage ────────────────────────────────────────────────────────────────
// R6 is explicit that the prototype "records selected synchronous filesystem calls" and proves
// nothing about network, subprocess, native-keyring, named-import or asynchronous access. These
// four tests are what keeps that honest instead of assumed.

test('every fs call lib/ and scripts/ actually make is guarded', () => {
  const used = new Set();
  for (const [, src] of [...sources('lib'), ...sources('scripts')]) {
    for (const m of src.matchAll(/\bfs\.([a-zA-Z]+)\s*\(/g)) used.add(m[1]);
  }
  assert.ok(used.size > 5, `expected real fs usage, found ${used.size}`);
  const unguarded = [...used].filter((n) => !GUARDED_FS_CALLS.includes(n) && !FD_ONLY_FS_CALLS.includes(n));
  assert.deepEqual(unguarded, [], 'add these to FS_SYNC_GUARDS in tools/hermetic-env.mjs');
});

test('no lib/ or scripts/ module takes a NAMED fs or child_process import', () => {
  // The backstop patches the `fs` and `child_process` objects. `import fs from 'fs'` on a core
  // module hands back that very object, so the patch lands. A named import is a binding snapshotted
  // when the module is instantiated, and a preload cannot reach it — measured on Node 24: patching
  // cp.execFileSync in an --import preload leaves a LATER module's `import { execFileSync }`
  // pointing at the original. So a named import of either module anywhere in lib/ or scripts/ would
  // walk straight past the guard.
  //
  // child_process was added to this ban after `npm test` was measured adding a keyed keychain entry
  // and DELETING the developer's own pre-0.13 `beezi-codex`/`token` login, with zero failures
  // reported: lib/credentials.mjs took `import { execFileSync }`, so every `security` call it made
  // was invisible to the backstop. Recording is not preventing — a recorded call still runs — but a
  // recorded call fails the run, which is what stops the next one shipping unnoticed.
  const offenders = [];
  for (const [name, src] of [...sources('lib'), ...sources('scripts')]) {
    if (/import\s*\{[^}]*\}\s*from\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process)['"]/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'a named fs or child_process import bypasses the hermeticity backstop');
});

test('every subprocess call site in lib/ is behind an injectable seam, and no test reaches one', () => {
  // The backstop now SEES every subprocess call site — the ban above keeps them all on the default
  // import — but seeing is not stopping: tools/hermetic-env.mjs records the call and then calls
  // through, so a recorded `security` delete has already happened by the time the run goes red.
  // These two assertions are what actually protect the native keyring, the real git config and the
  // browser launcher, and they are the honest answer to R6's caveat; the backstop is the net that
  // catches whatever gets past them, once.
  const SEAMS = {
    // deps.run || defaultRun (credentials.mjs:233) — every credentials test injects `run`.
    'lib/credentials.mjs': /deps\.run\s*\|\|/,
    // gitImpl parameter, defaulted (git.mjs:31-37) — every git-touching test passes gitImpl.
    'lib/git.mjs': /gitImpl/,
    // performLogin is itself the injected unit (mcp-bridge.test.mjs:226-239); nothing in the suite
    // enters launch()/openBrowser, which is the only spawn site.
    'lib/login.mjs': /deps\.startLoopback/,
    // deps.spawn || _spawn (codex-app-server.mjs) — the `codex app-server` probe. Unseamed it
    // would launch a REAL Codex against the developer's own ~/.codex from any test that reaches
    // captureFromCodexAccount, so every caller of it in the suite injects this.
    'lib/codex-app-server.mjs': /deps\.spawn/,
  };
  for (const [name, src] of sources('lib')) {
    if (!/from\s*['"](?:node:)?child_process['"]/.test(src)) continue;
    assert.ok(SEAMS[name], `${name} newly shells out — give it a deps seam and list it here`);
    assert.match(src, SEAMS[name], `${name} lost its injectable runner`);
  }
  // A test may spawn `process.execPath` — that is how this file and the bridge-timer test drive a
  // child Node. Naming any other command is what would reach the keyring, git or a browser.
  const reachers = [];
  for (const name of fs.readdirSync(path.join(pluginRoot, 'test'))) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(pluginRoot, 'test', name), 'utf-8');
    if (!/from\s*['"](?:node:)?child_process['"]/.test(src)) continue;
    for (const m of src.matchAll(/(?:spawnSync|execFileSync|execSync|spawn|execFile|exec)\s*\(\s*(['"`])/g)) {
      reachers.push(`${name}: ${m[0]}…`);
    }
  }
  assert.deepEqual(reachers, [], 'a test naming a real command can touch the keyring, git or a browser');
});

test('the backstop records subprocess and non-loopback network escapes it CAN see', (t) => {
  // Not one of the three channels, but R6 names both as unproven in the prototype. A recorded
  // escape is a failed run, so this asserts the status as well as the named calls.
  // The probe uses a DEFAULT child_process import — the form the guard can see. `.invalid` is
  // reserved by RFC 2606, so the DNS lookup fails immediately instead of waiting on a connect.
  const probe = probeFile(t, `
    import { test } from 'node:test';
    import cp from 'node:child_process';
    test('reaches the machine two other ways', async () => {
      cp.spawnSync(process.execPath, ['-e', '0']);
      await fetch('http://beezi-hermetic.invalid/').catch(() => {});
    });
  `);
  const res = run(['--import', PRELOAD, '--test', probe], pretendMachine(t));
  assert.notEqual(res.status, 0, `the gate let a subprocess and an outbound request pass:\n${out(res)}`);
  assert.match(out(res), /child_process\.spawnSync/);
  assert.match(out(res), /fetch\(http:\/\/beezi-hermetic\.invalid/);
});

// ── the gate stays armed ──────────────────────────────────────────────────────────────────────
// Only the handful of test files that import the helper carry the sandbox under a bare
// `node --test`; every other file is guarded solely because `npm test` preloads it. Dropping the
// flag would disarm the gate for ~50 files with nothing going red, so the flag itself is asserted.
test('npm test still preloads the gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf-8'));
  assert.match(
    pkg.scripts.test, /--import \.\/tools\/hermetic-env\.mjs/,
    'npm test no longer preloads the gate; every file that does not import it runs unguarded',
  );
});

// ── placement ─────────────────────────────────────────────────────────────────────────────────
test('the preload does not live under test/, where Node would count it as a test file', () => {
  assert.equal(fs.existsSync(PRELOAD_PATH), true, 'tools/hermetic-env.mjs is missing');
  const strays = fs.readdirSync(path.join(pluginRoot, 'test'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(c|m)?js$/.test(e.name) && !/\.test\.(c|m)?js$/.test(e.name))
    .map((e) => path.join(e.parentPath || e.path, e.name));
  assert.deepEqual(strays, [], 'a non-test .mjs under test/ is collected AND counted by node --test');
});
