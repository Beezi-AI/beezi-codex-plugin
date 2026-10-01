// Hermeticity gate for the Beezi Codex suite (G-10-1).
//
// The suite used to read the developer's machine through three distinct channels, all of them at
// the callers of `resolveSource` / `resolveBilling` in lib/billing-config.mjs:
//
//   L1  `deps` is not threaded into resolveSource/resolveBilling, so step 4 of the ladder
//       (billing-config.mjs:110-118) opens the REAL ~/.codex/auth.json via codexAuthFile() →
//       codexHome() → `process.env.CODEX_HOME || os.homedir()/.codex` (paths.mjs:57-59).
//   L2  direct `buildConfig` callers pass no deps at all, so they reach the same real file from
//       the test's own call site rather than from a lib default.
//   L3  `env = process.env` defaults (billing-capture.mjs:135, usage-report-codex.mjs:45) let a
//       host OPENAI_API_KEY short-circuit step 1 of the ladder (billing-config.mjs:101-102)
//       before auth.json is ever consulted.
//
// L1 and L3 are production defects in lib/ and are NOT fixed here — see S10 Part 1/Part 2. What
// this file does is make the *suite* immune to all three, and make a reopened channel loud:
//
//   * every root the plugin can resolve is redirected into a per-process sandbox (closes L1/L2
//     by construction: codexHome() can no longer name a path on the real machine);
//   * every environment variable that steers billing or endpoint choice is deleted (closes L3);
//   * a backstop RECORDS any filesystem, subprocess or non-loopback network call that still
//     escapes to the real home, and fails the process on exit.
//
// Recording rather than throwing is the whole point. billing-config.mjs:113 is
// `try { signals = readSignals(); } catch { signals = null; }` — a thrown error is swallowed
// there and the leak stays invisible. A recorded violation survives the catch and names the path.
//
// PLACEMENT: this file must not live in test/. Node's default test-file patterns include
// `**/test/**/*.?(c|m)js`, so anything under test/ is collected AND COUNTED as a test file
// (measured on this tree: 698 → 699). tools/ matches no pattern, and is outside the ban-gate's
// `['lib', 'scripts']` scan (test/compat-syntax.test.mjs:16), so modern syntax is fine here.
//
// Loaded two ways, and it is idempotent under both:
//   * `node --test --import ./tools/hermetic-env.mjs` (package.json `scripts.test`) — the gate;
//   * `import { ... } from '../tools/hermetic-env.mjs'` from a test file — the fixture helpers,
//     which also arms the gate for a bare `node --test` run of that file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';

const SLOT = Symbol.for('beezi.hermetic-env.v1');

// ── L3 ── Host environment that steers billing resolution or endpoint choice. Deleted, not
// blanked: detectBillingSource (billing.mjs:24-27) treats '' and undefined the same, but
// apiBase() and the environment reader do not, and a '' would still be a value the suite
// inherited from the developer.
const SCRUBBED_ENV_KEYS = Object.freeze([
  // Step 1 of the resolution ladder. This one key is the entire L3 channel.
  'OPENAI_API_KEY',
  // Not read by lib/ today, but they are the obvious next members of the same class and an
  // AI-tooling CI box exports them. Kept out so a future reader cannot inherit one silently.
  'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORGANIZATION',
  'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
  // Endpoint / environment selection (config.mjs:3, :59) and debug output.
  'BEEZI_API_URL', 'BEEZI_MCP_URL', 'BEEZI_ENV', 'BEEZI_DEBUG',
]);

// Filesystem entry points worth watching. Index 0 is a path for all of them; the rename/copy/link
// family takes a second one. Only declared indices are inspected, so a file's *contents* passed to
// writeFileSync can never be mistaken for a path.
const FS_SYNC_GUARDS = Object.freeze({
  readFileSync: [0], writeFileSync: [0], appendFileSync: [0],
  existsSync: [0], accessSync: [0], statSync: [0], lstatSync: [0],
  readdirSync: [0], opendirSync: [0], openSync: [0], mkdirSync: [0], mkdtempSync: [0],
  rmSync: [0], rmdirSync: [0], unlinkSync: [0], truncateSync: [0],
  chmodSync: [0], utimesSync: [0], realpathSync: [0],
  createReadStream: [0], createWriteStream: [0],
  renameSync: [0, 1], copyFileSync: [0, 1], linkSync: [0, 1], symlinkSync: [0, 1],
});

// The async surface. lib/ and scripts/ use none of it today (verified by test/hermetic.test.mjs,
// which fails if that changes), but R6 is explicit that the prototype only covered selected
// synchronous calls, so the promise API is covered rather than assumed absent.
const FS_ASYNC_GUARDS = Object.freeze({
  readFile: [0], writeFile: [0], appendFile: [0], access: [0], stat: [0], lstat: [0],
  readdir: [0], opendir: [0], open: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0],
  unlink: [0], chmod: [0], realpath: [0], rename: [0, 1], copyFile: [0, 1],
});

function resolveRepoRoot(start) {
  // The checkout normally lives INSIDE the home directory on Windows and macOS, and the suite
  // legitimately reads it (compat-syntax.test.mjs scans lib/ and scripts/, smoke.test.mjs
  // resolves every script entry point, repo-timeline walks up for .git). Allow the whole
  // checkout, not just cwd — a Linux-only verification never sees this, because there the
  // container checkout sits outside $HOME.
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(start);
}

function install() {
  // Captured BEFORE the redirect: os.homedir() follows $HOME on posix and %USERPROFILE% on
  // Windows, so after the next few lines it would report the sandbox.
  const realHome = os.homedir();
  const tmpRoot = path.resolve(os.tmpdir());
  const repoRoot = resolveRepoRoot(process.cwd());
  const sandbox = fs.mkdtempSync(path.join(tmpRoot, 'beezi-hermetic-'));
  const codexHome = path.join(sandbox, '.codex');
  const beeziHome = path.join(sandbox, '.beezi-codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(beeziHome, { recursive: true });

  // ── L1 + L2 ── Every root lib/paths.mjs can resolve now lands inside the sandbox, whether the
  // caller threaded `deps` or not. HOME/USERPROFILE cover os.homedir() for the fallbacks;
  // CODEX_HOME and BEEZI_CODEX_HOME cover the explicit overrides.
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.CODEX_HOME = codexHome;
  process.env.BEEZI_CODEX_HOME = beeziHome;

  // ── L3 ── see SCRUBBED_ENV_KEYS.
  for (const key of SCRUBBED_ENV_KEYS) delete process.env[key];

  const state = {
    realHome, sandbox, repoRoot, tmpRoot, codexHome, beeziHome,
    violations: [],
    suspended: 0,
    scrubbed: SCRUBBED_ENV_KEYS,
  };

  const inside = (candidate, root) => {
    const r = path.resolve(root);
    const a = path.resolve(candidate);
    return a === r || a.startsWith(r + path.sep);
  };
  const escapes = (candidate) => typeof candidate === 'string'
    && candidate !== ''
    && path.isAbsolute(candidate)
    && inside(candidate, realHome)
    && !inside(candidate, sandbox)
    && !inside(candidate, tmpRoot)
    && !inside(candidate, repoRoot);

  const record = (what) => {
    // test/hermetic.test.mjs deliberately spawns hostile child processes to prove the gate still
    // fires; those are the one legitimate escape, and they say so explicitly via withoutGuard().
    if (state.suspended > 0) return;
    // The stack is what makes a violation actionable: the path alone does not say which test
    // or which lib module reached for it.
    const stack = (new Error().stack || '').split('\n').slice(3, 7).join('\n');
    state.violations.push(`${what}\n${stack}`);
  };

  const wrapFs = (target, name, indices) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function hermetic(...args) {
      for (const i of indices) {
        const arg = args[i];
        // URL and Buffer paths are converted rather than guessed at; anything else is not a path.
        const asPath = typeof arg === 'string' ? arg
          : (arg instanceof URL && arg.protocol === 'file:') ? arg.pathname.replace(/^\/(?=[A-Za-z]:)/, '')
            : null;
        if (escapes(asPath)) record(`fs.${name}(${asPath})`);
      }
      return original.apply(this, args);
    };
  };

  // Every lib/ module imports the default binding (`import fs from 'fs'`), which for a core module
  // is the very object mutated here — so the wrappers land. test/hermetic.test.mjs asserts that no
  // lib/ or scripts/ module uses a NAMED fs import, because a named ESM binding is snapshotted at
  // instantiation and would bypass all of this.
  for (const [name, indices] of Object.entries(FS_SYNC_GUARDS)) wrapFs(fs, name, indices);
  if (fs.promises) for (const [name, indices] of Object.entries(FS_ASYNC_GUARDS)) wrapFs(fs.promises, name, indices);

  // Subprocess. lib/credentials.mjs (native keyring), lib/git.mjs and lib/login.mjs all shell out;
  // every test injects `deps.run` / `deps.gitImpl` instead, and a regression that stops injecting
  // would otherwise silently touch the developer's real keyring or git config.
  for (const name of ['spawnSync', 'execSync', 'execFileSync', 'spawn', 'exec', 'execFile', 'fork']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function hermetic(command, ...rest) {
      record(`child_process.${name}(${String(command)})`);
      return original.call(this, command, ...rest);
    };
  }

  // Network. The loopback OAuth receiver (lib/loopback.mjs) binds and fetches 127.0.0.1 for real
  // in test/loopback.test.mjs, so loopback is allowed and anything else is a violation.
  const LOOPBACK = /^(127\.(\d+)\.(\d+)\.(\d+)|::1|\[::1\]|localhost|0\.0\.0\.0)$/i;
  const hostOf = (value) => {
    try { return new URL(String(value)).hostname; } catch { return String(value); }
  };
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === 'function') {
    globalThis.fetch = function hermetic(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : String((input || {}).url);
      if (!LOOPBACK.test(hostOf(url))) record(`fetch(${url})`);
      return nativeFetch.call(this, input, init);
    };
  }
  for (const [mod, name] of [[http, 'http'], [https, 'https']]) {
    const original = mod.request;
    if (typeof original !== 'function') continue;
    mod.request = function hermetic(...args) {
      const first = args[0];
      const host = typeof first === 'string' || first instanceof URL
        ? hostOf(first)
        : String((first || {}).hostname || (first || {}).host || '');
      if (host && !LOOPBACK.test(host.replace(/:\d+$/, ''))) record(`${name}.request(${host})`);
      return original.apply(this, args);
    };
  }
  const nativeConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function hermetic(...args) {
    const opts = args[0];
    const host = opts && typeof opts === 'object' ? String(opts.host || '') : '';
    if (host && !LOOPBACK.test(host)) record(`net.connect(${host})`);
    return nativeConnect.apply(this, args);
  };

  process.on('exit', () => {
    // One sandbox per test-file child process (--test-isolation=process is the default), so
    // without this the suite leaves ~55 orphaned directories in %TEMP% on every run.
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (!state.violations.length) return;
    const unique = [...new Set(state.violations)];
    process.stderr.write(
      `\nHERMETICITY VIOLATION — the suite reached the real machine (home: ${realHome}):\n`
      + unique.map((v) => `  ${v}`).join('\n\n')
      + '\nInject the dependency, or point the path at a temp dir.\n',
    );
    // Set rather than thrown: see the header. A non-zero exit makes the test runner fail the
    // whole file, which is what CI reads. test/hermetic.test.mjs asserts the STATUS, not the
    // text, because process.exitCode is ignored once anything has called process.exit().
    process.exitCode = 1;
  });

  return state;
}

const state = globalThis[SLOT] || (globalThis[SLOT] = install());

/** Absolute path of this process's sandbox home. Everything the plugin resolves lives under it. */
export const SANDBOX = state.sandbox;
/** The developer's real home, captured before the redirect. Nothing in the suite may read it. */
export const REAL_HOME = state.realHome;
/** Env keys deleted on install — the L3 channel, enumerated so the self-test can check them. */
export const SCRUBBED_ENV = state.scrubbed;
/** Recorded escapes, for the self-test. Live array; also printed and exit-coded on process exit. */
export const violations = state.violations;
/** Names of the fs entry points the backstop wraps, so the self-test can prove the list is total. */
export const GUARDED_FS_CALLS = Object.freeze([
  ...Object.keys(FS_SYNC_GUARDS),
  ...Object.keys(FS_ASYNC_GUARDS),
]);
/**
 * fs calls that take a file DESCRIPTOR rather than a path. They cannot name a location, so they
 * need no guard — but the self-test has to know that, or it would demand one.
 */
export const FD_ONLY_FS_CALLS = Object.freeze([
  'closeSync', 'close', 'fstatSync', 'fstat', 'readSync', 'read', 'writeSync', 'write',
  'fsyncSync', 'fsync', 'ftruncateSync', 'ftruncate', 'fchmodSync', 'fchmod',
]);

/**
 * Run `fn` with the backstop's recorder suspended.
 *
 * The ONLY sanctioned use is test/hermetic.test.mjs spawning a child `node` to prove the gate
 * still fires — the spawn is the experiment, not a leak. Anything else that needs this is a leak
 * being hidden, which is the failure this file exists to prevent.
 */
export function withoutGuard(fn) {
  state.suspended += 1;
  try { return fn(); } finally { state.suspended -= 1; }
}

/**
 * A controlled ~/.codex for one test, in place of the developer's.
 *
 * Closes L1 and L2 at the point where redirection alone is not enough: the ten tests that assert
 * a *subscription* outcome need step 4 of the ladder to answer, and a sandbox with no auth.json
 * answers `unknown`. Passing an auth.json fixture makes them assert the ladder's behaviour
 * instead of the author's sign-in state.
 *
 * `auth` is written verbatim, so a test can also pin the api-key or the no-file case.
 * Restores the previous CODEX_HOME (the sandbox) and removes the fixture via `t.after`.
 */
export function withCodexAuth(t, auth = { auth_mode: 'chatgpt' }) {
  const dir = fs.mkdtempSync(path.join(state.tmpRoot, 'beezi-codexauth-'));
  if (auth != null) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * The same fixture for a callback with no `t` to hang cleanup off.
 *
 * ASYNC-AWARE, and it has to be: the billing capture became async when `codex app-server` was added
 * as its first tier. With a plain try/finally the cleanup runs at the first await — CODEX_HOME is
 * restored and the sandbox deleted while the callback is still reading from it, so the test silently
 * resolves against the developer's real ~/.codex instead of the fixture.
 */
export function underCodexAuth(auth, fn) {
  const dir = fs.mkdtempSync(path.join(state.tmpRoot, 'beezi-codexauth-'));
  if (auth != null) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  const restore = () => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(dir);
  } catch (error) {
    restore();
    throw error;
  }
  if (result !== null && result !== undefined && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value; },
      (error) => { restore(); throw error; },
    );
  }
  restore();
  return result;
}
