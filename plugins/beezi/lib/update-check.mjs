import fs from 'fs';
import path from 'path';
import url from 'url';
import { beeziCodexHome, environment } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';
import { compareVersions } from './version-compare.mjs';

// ── Stale-version check (G-8-4) ─────────────────────────────────────────────────────────────
//
// A reader and a sentence, not an updater — Codex has no `plugin update` verb; see updateNotice()
// for the command that stands in for one. It compares the installed version against the version in
// the `.codex-plugin/plugin.json` at the manifest URL this build was stamped with (env.json
// updateManifestUrl, written by scripts/make-variant.sh for a variant and scripts/sync-to-github.sh
// for the public build), once an hour at most. Nothing is invented: that version field is Codex's
// own schema, which is what R1 asked for instead of adding one to the marketplace schema.
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.

// How long a fetched reading is trusted. One hour, matching the Claude plugin: the internal
// pipeline publishes several times a day, so a longer window hides the very updates this exists
// to surface. The cost is bounded by FETCH_TIMEOUT_MS, which is tightened to match — at one
// request an hour it can land inside far more SessionStart hooks than a daily one could.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

const PLUGIN_JSON_FILE = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  '.codex-plugin',
  'plugin.json',
);

/** Where the last check is remembered. Root level: pruneStale() sweeps state/ at 14 days. */
function updateCheckFile() {
  return path.join(beeziCodexHome(), 'update-check.json');
}

/** This build's own identity, or null when the manifest cannot be read. */
export function installedPlugin(deps = {}) {
  const read = orDefault(deps.readPluginJson, () => {
    try {
      return JSON.parse(fs.readFileSync(PLUGIN_JSON_FILE, 'utf-8'));
    } catch {
      return null;
    }
  });
  const obj = read();
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.version !== 'string' || obj.version === '') return null;
  return { name: typeof obj.name === 'string' ? obj.name : 'beezi', version: obj.version };
}

/**
 * The published version, from the manifest this build was stamped with.
 *
 * Accepts the plugin manifest shape only. A marketplace.json arriving here answers `null` rather
 * than an invented version: its schema has no version field, and R1 forbids adding one.
 */
export function versionFromManifest(doc, expectedName) {
  if (!doc || typeof doc !== 'object') return null;
  if (typeof doc.version === 'string') {
    // A manifest for a DIFFERENT plugin is not this build's update — the internal repo holds
    // beezi-dev and beezi-staging side by side, and crossing them would nag every staging user
    // about a dev build.
    if (typeof doc.name === 'string' && expectedName && doc.name !== expectedName) return null;
    return doc.version;
  }
  return null;
}

function readState(deps) {
  const read = orDefault(deps.readJson, readJson);
  const file = orDefault(deps.updateCheckFile, updateCheckFile);
  const obj = read(file(), null);
  return obj && typeof obj === 'object' ? obj : {};
}

function writeState(state, deps) {
  const write = orDefault(deps.writeJsonSecure, writeJsonSecure);
  const file = orDefault(deps.updateCheckFile, updateCheckFile);
  try { write(file(), state); } catch { /* best-effort: a nag is never worth failing a hook */ }
}

/**
 * Is there a newer published build than this one?
 *
 * Returns `{ status, current, latest }`, where status is:
 *   'behind'     a newer version is published
 *   'current'    up to date, or ahead (a developer's local build)
 *   'skipped'    checked recently, no manifest URL, or the version could not be established
 *
 * A 'behind' result also carries `plugin`, the name this build answers to. Both behind branches
 * carry it — the cached one included, so a reader of the result is never told `undefined` is out
 * of date for a whole hour.
 *
 * Never throws, never blocks longer than FETCH_TIMEOUT_MS, and writes nothing but its own
 * timestamp. An offline machine is `skipped`, silently: a plugin that complains about its own
 * update check is worse than one that says nothing.
 */
export async function checkForUpdate(deps = {}) {
  const now = orDefault(deps.now, Date.now)();
  const manifestUrl = orDefault(deps.manifestUrl, environmentManifestUrl)();
  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest' };

  const installed = installedPlugin(deps);
  if (!installed) return { status: 'skipped', reason: 'no-version' };
  const behind = (latest, cached) => ({
    status: 'behind',
    current: installed.version,
    latest: latest,
    plugin: installed.name,
    cached: cached,
  });

  const state = readState(deps);
  const force = deps.force === true;
  if (!force && typeof state.checkedAt === 'number' && now - state.checkedAt < CHECK_INTERVAL_MS) {
    // Answer from the remembered result rather than going quiet: the user upgrading is what
    // clears the nag, and that can happen long before the next check is due.
    if (typeof state.latest === 'string') {
      const cmp = compareVersions(installed.version, state.latest);
      if (cmp === -1) return behind(state.latest, true);
    }
    return { status: 'skipped', reason: 'checked-recently' };
  }

  const fetchImpl = orDefault(deps.fetchImpl, fetchCompat);
  const controller = makeAbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* already settled */ } }, FETCH_TIMEOUT_MS);
  let doc = null;
  try {
    const res = await fetchImpl(manifestUrl, { signal: controller.signal });
    if (res && res.ok) doc = await res.json();
  } catch {
    doc = null;
  } finally {
    clearTimeout(timer);
  }

  // A failed check still stamps the clock. Otherwise an unreachable manifest costs a request on
  // every single session start, inside the hook's budget, forever.
  const latest = versionFromManifest(doc, installed.name);
  writeState({ checkedAt: now, latest: latest === null ? orDefault(state.latest, null) : latest }, deps);
  if (latest === null) return { status: 'skipped', reason: 'no-published-version' };

  const cmp = compareVersions(installed.version, latest);
  if (cmp === -1) return behind(latest, false);
  return { status: 'current', current: installed.version, latest };
}

/** The manifest URL baked into this build, or null for a build that was never stamped. */
function environmentManifestUrl() {
  const resolved = environment.resolveEnvironment({
    envJson: environment.readEnvJson(),
    env: process.env,
  });
  if (resolved.error) return null;
  return orDefault(resolved.updateManifestUrl, null);
}

/**
 * One line for SessionStart, or null. Names the exact command, because a version number alone is
 * not something a user can act on.
 *
 * Codex has no `plugin update` verb — verified from `codex plugin --help`, which lists
 * `add | list | marketplace | remove`, and `codex plugin marketplace --help`, which lists
 * `add | list | upgrade | remove`. Refreshing the marketplace is the whole upgrade: Codex picks
 * the newer build up from the refreshed snapshot, so there is nothing to re-add afterwards.
 *
 * Emitted WITHOUT a marketplace name, deliberately. Measured: `codex plugin marketplace upgrade
 * beezi` answers "Error: marketplace `beezi` is not configured as a Git marketplace" — a
 * marketplace can be present in the plugin cache and absent from config.toml, which is exactly the
 * state a clone-installed build leaves behind. The bare form ("omit MARKETPLACE_NAME to upgrade
 * all configured Git marketplaces") cannot hit that, and refreshing the others costs nothing.
 *
 * That same measurement is why the clone caveat is stated: `upgrade` touches GIT marketplaces
 * only, so for a clone install it reports nothing and the real step is a pull. Better said here
 * than discovered when the command appears to do nothing.
 */
export function updateNotice(result) {
  if (!result || result.status !== 'behind') return null;
  return `Beezi: version ${result.latest} is published; this machine runs ${result.current}.`
    + ' Run `codex plugin marketplace upgrade`, then start a new Codex thread to apply it.'
    + ' (Installed from a local clone? Pull it instead: `marketplace upgrade` only refreshes Git'
    + ' marketplaces.)';
}
