// A stable, version-independent entry point for Beezi's Codex lifecycle hooks.
//
// WHY THIS FILE EXISTS — the trust hash. Codex trusts an entry in `~/.codex/hooks.json` by hashing
// the entry, so the `command` string IS the trust key. Registering the script inside the plugin
// cache (`~/.codex/plugins/cache/<marketplace>/<owner>/<version>/scripts/<name>.mjs`) bakes the
// version number into that key: every upgrade rewrites five entries, invalidates five hashes, and
// silently stops analytics until the user re-trusts in `/hooks`. An untrusted hook does not run and
// nothing reports it, so the failure is invisible until the numbers go missing.
//
// The fix is one level of indirection. The installer copies THIS file to a path that never moves —
// `~/.beezi-codex[-<env>]/hooks/beezi-hook.mjs` — and registers
// `node "<that path>" <script-name> [--beezi-owner=<owner>]`. The command string then depends only
// on the data root and the owner, both of which are fixed for the life of an install, so a plugin
// upgrade changes no hash and costs no re-trust. At run time the launcher finds the NEWEST installed
// version of the owner's plugin and imports the requested hook script in-process.
//
// WHY IT DUPLICATES lib/. CLAUDE.md's single-definition invariants say the answer to "where is
// Codex's home" and "which version is newer" each live in exactly one module. This file is the one
// sanctioned exception, because it runs from OUTSIDE the plugin tree: the copy under
// `~/.beezi-codex/hooks/` has no lib/ to import, and the whole point is that it keeps working when
// the version it was copied from has been deleted. So it has zero imports but Node builtins, and
// two answers are re-derived here:
//
//   * `defaultCacheRoot()` must agree with `codexHome()` in lib/paths.mjs;
//   * `compareVersions()` must agree with lib/version-compare.mjs.
//
// Both copies are pinned by test/hook-launcher.test.mjs, which imports the lib originals and
// asserts agreement. That test is the only thing keeping the duplication honest — do not weaken it.
//
// Node 13.2 floor applies (this lives under scripts/): no `?.`, no `??`, no `.at()`, no `node:`
// specifiers, no top-level await. See CLAUDE.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';

// The owner is a directory name under the cache root, taken from a hook command line we do not
// control the provenance of. Keep it to an alphabet that cannot escape a path segment.
const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
const OWNER_FLAG = '--beezi-owner=';
const DEFAULT_OWNER = 'beezi';

// ── paths ─────────────────────────────────────────────────────────────────────────────────────

// Mirrors codexHome() in lib/paths.mjs. Codex's root is NOT namespaced by BEEZI_ENV — every variant
// reads the same Codex install — so there is no environment suffix here.
function codexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** `<CODEX_HOME>/plugins/cache` — the root Codex unpacks every installed plugin version under. */
export function defaultCacheRoot() {
  return path.join(codexHomeDir(), 'plugins', 'cache');
}

/** Codex's user-level hook registry, named in the failure message so the user can find it. */
export function hooksFilePath() {
  return path.join(codexHomeDir(), 'hooks.json');
}

// ── version ordering ──────────────────────────────────────────────────────────────────────────
//
// A faithful, trimmed copy of lib/version-compare.mjs. Returning `null` for an unparseable side is
// part of the contract, not an oversight: the caller needs to tell "older" from "not a version" so
// a stray directory in the cache can be ranked last instead of accidentally winning.

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  };
}

function comparePre(a, b) {
  // Semver's rule, and the one the variants depend on: `0.10.19-local.5243` is BEHIND
  // `0.10.19-local.5249` (numeric identifiers compare numerically, so `.10` beats `.9`), and both
  // are behind the plain `0.10.19`.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank lower than alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 when a < b, 0 when equal, 1 when a > b. null when either side is not a version. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

// ── argument parsing ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the launcher's own arguments — `argv` is the TAIL, i.e. `process.argv.slice(2)`.
 *
 * Shape: `<script-name> [--beezi-owner=<owner>]`. The script name is deliberately NOT checked
 * against a hardcoded list of the five hook scripts: the list changes with the plugin, and the
 * launcher is the copy that does not get upgraded. What it does enforce is that the name can only
 * ever name a file directly inside the resolved `scripts/` directory — no separator, no `..`, no
 * drive letter — so a tampered hooks.json cannot turn the launcher into an arbitrary-file runner.
 *
 * Throws with a message fit for one line of stderr.
 */
export function parseLauncherArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let scriptName = null;
  let owner = DEFAULT_OWNER;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string' || arg === '') continue;
    if (arg.indexOf(OWNER_FLAG) === 0) {
      owner = arg.slice(OWNER_FLAG.length);
      continue;
    }
    if (arg.charAt(0) === '-') continue; // inert flags a future installer may append
    if (scriptName === null) scriptName = arg;
  }
  if (scriptName === null) {
    throw new Error('usage: node beezi-hook.mjs <script-name> [--beezi-owner=<owner>]');
  }
  if (!isPlainBasename(scriptName)) {
    throw new Error(`refusing script name '${describe(scriptName)}' — it must be a bare file name`);
  }
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error(`refusing owner '${describe(owner)}' — expected only letters, digits, - and _`);
  }
  return { scriptName, owner };
}

// A file name and nothing else. `path.basename` equality rejects every separator on both platforms
// (path.win32 treats `/` and `\` alike), and the explicit `.`/`..` cases cover the two names that
// survive basename intact but do not name a file.
function isPlainBasename(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value === '.' || value === '..') return false;
  if (value.indexOf('/') !== -1 || value.indexOf('\\') !== -1) return false;
  if (path.basename(value) !== value) return false;
  if (path.win32.basename(value) !== value) return false;
  return true;
}

// Never echo an untrusted value verbatim into a log line — same reasoning as describeName() in
// lib/paths.mjs. Everything outside a conservative alphabet becomes '?'.
function describe(value) {
  const text = typeof value === 'string' ? value : Object.prototype.toString.call(value);
  return text.slice(0, 48).replace(/[^A-Za-z0-9_.-]/g, '?');
}

// ── resolution ────────────────────────────────────────────────────────────────────────────────

// Every read below is best-effort: the cache root may not exist yet, a marketplace directory may be
// half-written by a concurrent install, and a hook must never fail because of either. A throw here
// would surface as a broken hook with no analytics and no explanation, so every probe swallows.
function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    // isDirectory() is false for a symlinked version dir; stat through it rather than skip it.
    if (entry.isDirectory()) { out.push(entry.name); continue; }
    if (!entry.isSymbolicLink()) continue;
    try {
      if (fs.statSync(path.join(dir, entry.name)).isDirectory()) out.push(entry.name);
    } catch (error) { /* dangling link — not a candidate */ }
  }
  return out;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    return false;
  }
}

// Is `value` something compareVersions can rank at all? Comparing a value with itself answers it
// without a second parser: 0 when parseable, null when not.
function isRankable(value) {
  return compareVersions(value, value) !== null;
}

// Strict "is a better than b", total and deterministic. A parseable version always beats an
// unparseable one (a stray directory in the cache must never outrank a real install); equal
// versions fall back to the lexicographically smallest marketplace name, then the smallest path, so
// two marketplaces publishing the same version resolve the same way on every run.
function isBetter(a, b) {
  const ra = isRankable(a.version);
  const rb = isRankable(b.version);
  if (ra !== rb) return ra;
  if (ra) {
    const c = compareVersions(a.version, b.version);
    if (c !== 0) return c === 1;
  }
  if (a.marketplace !== b.marketplace) return a.marketplace < b.marketplace;
  return a.scriptPath < b.scriptPath;
}

/**
 * Find the newest installed copy of `<owner>`'s `scripts/<scriptName>`.
 *
 * Scans `<cacheRoot>/<marketplace>/<owner>/<version>/scripts/<scriptName>` across EVERY marketplace
 * directory, because the marketplace name is the one thing the cache path carries that we cannot
 * predict: the same plugin installed from `beezi` and from `beezi-internal` lands in two trees.
 *
 * A version directory is a candidate only when the script actually exists as a file in it, so a
 * newer version that is mid-unpack, or one that dropped the script, is skipped rather than chosen
 * and then failed on.
 *
 * Returns `{ scriptPath, scriptsDir, version, marketplace }`, or null when nothing matches.
 * Never throws.
 */
export function resolveHookScript(options) {
  const opts = options || {};
  const owner = opts.owner;
  const scriptName = opts.scriptName;
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) return null;
  if (!isPlainBasename(scriptName)) return null;
  const cacheRoot = opts.cacheRoot ? opts.cacheRoot : defaultCacheRoot();

  let best = null;
  for (const marketplace of listDirs(cacheRoot)) {
    const ownerDir = path.join(cacheRoot, marketplace, owner);
    for (const version of listDirs(ownerDir)) {
      const scriptsDir = path.join(ownerDir, version, 'scripts');
      const scriptPath = path.join(scriptsDir, scriptName);
      if (!isFile(scriptPath)) continue;
      const candidate = { scriptPath, scriptsDir, version, marketplace };
      if (best === null || isBetter(candidate, best)) best = candidate;
    }
  }
  return best;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

function fail(message) {
  // ONE line. This lands in Codex's hook output, where a stack trace is noise and a sentence the
  // user can act on is not.
  process.stderr.write(`Beezi: ${message}\n`);
  process.exit(1);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseLauncherArgs(argv);
  } catch (error) {
    fail(`${error && error.message ? error.message : 'bad hook launcher arguments'}`);
    return;
  }
  const found = resolveHookScript({ owner: parsed.owner, scriptName: parsed.scriptName });
  if (!found) {
    fail(
      `no installed ${parsed.owner} plugin has scripts/${parsed.scriptName};`
      + ` remove the Beezi entries from ${hooksFilePath()} or reinstall the plugin.`,
    );
    return;
  }
  // Hand the process over. The hook scripts read stdin and call process.exit themselves, so the
  // launcher deliberately does NOT touch stdin, does not rewrite process.argv, and prints nothing
  // on success — anything it wrote would be parsed by Codex as the hook's own output.
  import(url.pathToFileURL(found.scriptPath).href).catch((error) => {
    fail(`could not run ${found.scriptPath}: ${error && error.message ? error.message : error}`);
  });
}

// Run only when executed directly, so the test can import the module without launching a hook.
// Compare hrefs rather than paths: on Windows process.argv[1] and import.meta.url differ in
// separators and drive-letter casing, and only the URL form normalises both. argv[1] can be absent
// (`node --eval`), and pathToFileURL can throw on a degenerate value, so both are guarded.
function isDirectRun() {
  const invoked = process.argv[1];
  if (typeof invoked !== 'string' || invoked === '') return false;
  try {
    return import.meta.url === url.pathToFileURL(invoked).href;
  } catch (error) {
    return false;
  }
}

if (isDirectRun()) main(process.argv.slice(2));
