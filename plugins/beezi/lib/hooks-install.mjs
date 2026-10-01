import fs from 'fs';
import path from 'path';
import url from 'url';
import { codexHooksFile, hookLauncherDir, environment } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import { UserError } from './friendly-error.mjs';
import { removeFileSync, removeDirSync } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

// Codex does not load hooks bundled inside a plugin — the `plugin_hooks` feature is `removed`, and
// an installed plugin contributes zero entries to the engine's `hooks/list`. Only `skills/` and
// `.mcp.json` travel with the package. So Beezi's lifecycle hooks have to be written into the
// user-level registry (`~/.codex/hooks.json`) by this installer, and trusted once via `/hooks`.

// The base label Codex shows next to each entry. A named variant suffixes it (see ownerLabel), so
// a user with two variants installed can tell in `/hooks` which one is which — the same reason the
// variant builder namespaces `.codex-plugin/plugin.json`'s interface.displayName. It is ONE of the
// ways we recognise our own handlers, never the only one: the install flow invites the user to open
// `/hooks` and read (and potentially edit) this text.
export const BEEZI_STATUS_MESSAGE = 'Beezi analytics';

// The one instruction every caller has to pass on: Codex will not run a hook it has not been shown.
export const TRUST_STEP = 'run /hooks in Codex, review the Beezi entries, and trust them';

// The events Beezi registers.
//
// `SessionEnd` is deliberately absent, and out of scope for this release. The reason that holds is
// `Stop`: it already runs the identical checkpoint (timeline included) at every turn end, so a
// `SessionEnd` entry would cost the user one more hook to review and trust for work already done.
// Whether Codex registers `SessionEnd` on current builds is UNMEASURED — it was measured as
// silently dropped from the registry on 2026-07-27 and nothing has re-run that check since, so
// neither "it works now" nor "it still does not exist" is established. See measurement task M-1-1.
// It could not cover a SIGKILL either way, which is the case a last-chance flush would have to
// survive. The residual is real but small: on a mid-turn kill, segments already queued on disk
// survive and the next session's start-up flush retries them (a queue is per ACCOUNT, never per
// project), while the tail since the last checkpoint waits for a later checkpoint of that
// session or for the manual track flow. That is a cost, not "nothing is lost".
//
// SubagentStart/SubagentStop record identity and timing for spawned agents. They do NOT bill them —
// the parent's own checkpoint does that, so the wall-clock union is computed in one process. See
// scripts/subagent-start.mjs for why they are still worth registering.
export const BEEZI_HOOKS = Object.freeze([
  { event: 'SessionStart', script: 'session-start.mjs' },
  { event: 'PostToolUse', script: 'checkpoint.mjs' },
  { event: 'SubagentStart', script: 'subagent-start.mjs' },
  { event: 'SubagentStop', script: 'subagent-stop.mjs' },
  { event: 'Stop', script: 'stop.mjs' },
]);

const BEEZI_EVENTS = BEEZI_HOOKS.map((h) => h.event);
const SCRIPT_NAMES = BEEZI_HOOKS.map((h) => h.script);

// Every tool, because the tool's *name* differs across Codex's two live tool surfaces
// (`shell_command` on the legacy one, `exec` under unified exec) and has not been measured from a
// real payload yet. `checkpoint.mjs` exits before loading the engine unless the payload carries a
// git checkpoint command OR the mid-turn heartbeat's interval has elapsed for this session
// (lib/timing.mjs) — so the common case is still a short-lived process that stats one marker file
// and exits; guessing the name instead would fail silently by never firing.
const MATCH_ALL = '.*';
// The timeout Codex records for each Beezi hook. Exported because the hooks themselves have to
// finish inside it — Codex kills what overruns and reports the kill as a failed hook — so the
// checkpoint's own budget is derived from this number rather than guessed alongside it.
export const HOOK_TIMEOUT_SEC = 20;

// The interpreter for every hook entry: bare `node`, resolved from the hook's PATH at spawn time.
// Deliberately not process.execPath — an absolute interpreter path goes stale the moment the user
// upgrades Node (nvm and installers both move the directory), which is exactly how the previous
// launcher design kept ending up in the `stale` state. Codex command hooks execute a command
// string, so the script path is quoted below as part of that string.
export const HOOK_COMMAND = 'node';

// Older plugin versions wrote per-event launcher scripts (`beezi-<script>.cmd` / `.sh`) into
// hookLauncherDir() and registered those as the command. Those baked an ABSOLUTE node path and went
// stale on every Node upgrade. The prefix survives only to recognise and clean up those installs.
const LAUNCHER_PREFIX = 'beezi-';
// …and those are the only two extensions they ever had. The filter is load-bearing, not cosmetic:
// LAUNCHER_FILE below also starts with `beezi-`, and a "simplification" to the prefix alone would
// make every install delete the live launcher it had just written.
const LEGACY_LAUNCHER_EXTENSIONS = ['.cmd', '.sh'];

// ── the stable launcher (the thing hooks.json actually names) ────────────────
//
// ONE file per environment, at a path that never moves. Every registered entry runs
// `node "<launcherDir>/beezi-hook.mjs" <script-name>`, and the launcher finds the newest installed
// plugin version for itself at spawn time.
//
// WHY THIS EXISTS: Codex keys hook TRUST to each entry's hash. While the entries named the
// versioned plugin cache directory (`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/…`),
// every plugin upgrade moved that path, every upgrade therefore rewrote all five entries, and every
// upgrade sent the user back to `/hooks` to re-trust hooks they had already trusted — with analytics
// silently dead in between. Indirecting through a fixed path makes an upgrade change NOTHING in the
// registry.
//
// It is NOT the old per-event launcher design coming back. Those baked an absolute interpreter path
// and one file per event; this is one file, invoked by the same PATH-resolved `node` as before, and
// it resolves the plugin version at runtime instead of at install time.
export const LAUNCHER_FILE = 'beezi-hook.mjs';

/** The single launcher this environment's entries point at. */
export function launcherPath(launcherDir = hookLauncherDir()) {
  return path.join(launcherDir, LAUNCHER_FILE);
}

// ── owner identity (G-1-7) ──────────────────────────────────────────────────
//
// `~/.codex/hooks.json` is Codex's, not ours, and it is NOT namespaced by BEEZI_ENV the way
// `~/.beezi-codex<suffix>` is — every installed variant merges into the same file. Until this block
// existed, one recogniser matched any variant's handler by the shared status message or by a
// `beezi`-flavoured script path, so installing beezi-staging stripped beezi's entries and vice
// versa (R1 reproduced it). Every mutation below is now scoped to ONE owner. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// The owner is the variant's plugin name: 'beezi' | 'beezi-dev' | 'beezi-staging' — the same string
// the variant builder writes into `.codex-plugin/plugin.json` `name`, so the identity a user sees
// in the plugin list is the identity that owns their hook entries.
const UNSUFFIXED_OWNER = 'beezi';

/**
 * The owner this process installs, uninstalls and reports for.
 *
 * Resolved lazily, NEVER at module load: envSuffix() throws on unresolvable variant metadata, and a
 * top-level const would turn that into a throw-on-import for lib/link-status.mjs, scripts/hooks.mjs
 * and scripts/login.mjs. hookLauncherDir() is deferred for exactly the same reason.
 */
export function hookOwner() {
  return UNSUFFIXED_OWNER + environment.envSuffix();
}

// How a named variant tags its handlers: an inert flag appended to the command string.
//
// DELIBERATELY NOT A NEW JSON KEY. R1 refuses unverified extensions to Codex's schemas, and the
// hook registry is read by the same engine as the marketplace: a key its loader rejects could take
// the whole entry with it. A command argument is data, not schema, and none of the five hook
// scripts reads process.argv
// (session-start, checkpoint, subagent-start, subagent-stop, stop), so the tag is inert at runtime
// while being exact, machine-readable, and immune to a label the user reworded.
const OWNER_FLAG = '--beezi-owner=';

function quoteCommandArgument(value) {
  const text = String(value);
  // Windows paths cannot contain a double quote. On POSIX, escape the characters that retain
  // special meaning inside double quotes so a plugin path remains one literal argument.
  if (process.platform === 'win32') return '"' + text.replace(/"/g, '\\"') + '"';
  return '"' + text.replace(/([\\$"\x60])/g, '\\$1') + '"';
}

// Codex 0.154.0 on Windows accepts `arguments` in hooks.json but does not pass them to command
// hooks. Keep the interpreter PATH-resolved, but put the complete invocation in `command`.
//
// `node "<launcher>" <script-name>`: the QUOTED path is the stable launcher, and the script name
// follows as a bare token (it is one of SCRIPT_NAMES — no spaces, nothing to quote). Nothing in the
// string names a plugin version, which is the whole point: an upgrade leaves every entry, and so
// every entry's trust hash, untouched.
//
// THE UNSUFFIXED BUILD WRITES NO TAG. Production ownership remains implicit, and "absent means
// production" matches env.json's own convention in lib/paths.mjs. It also makes R1's "recognise
// legacy unsuffixed entries only in the unsuffixed migration path" fall out by construction: an
// untagged, unlabelled legacy entry can only ever resolve to 'beezi'.
export function hookCommand(launcherFile, scriptName, owner = hookOwner()) {
  const parts = [HOOK_COMMAND, quoteCommandArgument(launcherFile), String(scriptName)];
  if (owner !== UNSUFFIXED_OWNER) parts.push(OWNER_FLAG + owner);
  return parts.join(' ');
}

/** 'Beezi analytics' for production, 'Beezi analytics (staging)' for a named variant. */
function ownerLabel(owner) {
  if (owner === UNSUFFIXED_OWNER) return BEEZI_STATUS_MESSAGE;
  return `${BEEZI_STATUS_MESSAGE} (${owner.slice(UNSUFFIXED_OWNER.length + 1)})`;
}

/** Every owner name this build considers well formed, driven by paths.mjs's validated list. */
function knownOwners() {
  return environment.KNOWN_ENVIRONMENTS.map(
    (name) => (name === '' ? UNSUFFIXED_OWNER : `${UNSUFFIXED_OWNER}-${name}`),
  );
}

/** The inverse of ownerLabel, so the label and its parser cannot drift apart. */
function ownerFromLabel(label) {
  if (typeof label !== 'string') return null;
  const owners = knownOwners();
  for (let i = 0; i < owners.length; i += 1) {
    if (label === ownerLabel(owners[i])) return owners[i];
  }
  return null;
}

/** The owner tag a named variant wrote into the legacy `arguments` array, or null. */
function ownerFromArguments(handler) {
  if (!Array.isArray(handler.arguments)) return null;
  for (let i = 1; i < handler.arguments.length; i += 1) {
    const arg = String(handler.arguments[i]);
    if (arg.indexOf(OWNER_FLAG) === 0) return arg.slice(OWNER_FLAG.length);
  }
  return null;
}

function ownerFromCommand(handler) {
  const command = handler && typeof handler.command === 'string' ? handler.command : '';
  const match = /(?:^|\s)--beezi-owner=([A-Za-z0-9_-]+)(?:\s|$)/.exec(command);
  return match ? match[1] : null;
}

// The QUOTED path inside a `node "<path>" …` command — today the stable launcher, on an entry this
// build has not rewritten yet the versioned `…/scripts/<name>.mjs`. Both forms are read, plus the
// broken 0.8.x `arguments` form, so install and uninstall can migrate existing entries without
// losing ownership information. What follows the quoted path (the script name, the owner tag) is
// not parsed here: no caller needs it, and command equality is what `hooksStatus` compares.
function handlerScript(handler) {
  if (!handler || typeof handler !== 'object') return null;
  if (Array.isArray(handler.arguments) && handler.arguments.length) {
    return String(handler.arguments[0]);
  }
  const command = typeof handler.command === 'string' ? handler.command : '';
  const prefix = HOOK_COMMAND + ' "';
  if (command.indexOf(prefix) !== 0) return null;
  let script = '';
  for (let i = prefix.length; i < command.length; i += 1) {
    const char = command[i];
    if (char === '"') return script;
    if (process.platform !== 'win32' && char === '\\' && i + 1 < command.length
      && '\\$"`'.indexOf(command[i + 1]) !== -1) {
      script += command[i + 1];
      i += 1;
    } else {
      script += char;
    }
  }
  return null;
}

/**
 * Which variant owns this handler — 'beezi' or one of the 'beezi-<env>' names knownOwners()
 * derives from paths.mjs KNOWN_ENVIRONMENTS ('beezi-dev', 'beezi-staging', 'beezi-local') — or null.
 *
 * The ORDER is the whole guarantee. The explicit tag is consulted FIRST, so a tagged beezi-staging
 * entry can never be swept up by the unsuffixed build's loose legacy match below. The label is
 * next, so a variant running out of a source checkout — whose script path carries no variant
 * segment — is still attributed to itself. Only then the two legacy anchors, which pre-date
 * variants entirely and therefore attribute to the unsuffixed owner alone.
 */
function handlerOwner(handler, launcherDir) {
  if (!handler || typeof handler !== 'object') return null;

  const tagged = ownerFromArguments(handler);
  if (tagged !== null) return tagged;

  const commandTagged = ownerFromCommand(handler);
  if (commandTagged !== null) return commandTagged;

  const labelled = ownerFromLabel(handler.statusMessage);
  if (labelled !== null) return labelled;

  const script = handlerScript(handler);
  if (script !== null) {
    // The current untagged production form: our launcher, in OUR launcher dir. Both halves are
    // needed and both are exact — hookLauncherDir() is namespaced per environment, so a sibling
    // variant asking this question compares against its own dir and correctly answers "not mine",
    // and a file of the user's that happens to be called beezi-hook.mjs elsewhere is not claimed.
    // This is what keeps production recognisable after the user rewords its label in /hooks.
    if (
      path.basename(script) === LAUNCHER_FILE
      && path.resolve(path.dirname(script)) === path.resolve(launcherDir)
    ) return UNSUFFIXED_OWNER;

    // The pre-launcher form, still in registries this build has not rewritten yet:
    // <...beezi...>/scripts/<one of SCRIPT_NAMES>. Both anchors are needed — a user's own
    // checkpoint.mjs may share the name, and a beezi-flavoured path alone (say, a repo checkout
    // with "beezi" in it) is not proof either. Kept so those entries can be MIGRATED.
    if (
      SCRIPT_NAMES.indexOf(path.basename(script)) !== -1
      && path.basename(path.dirname(script)) === 'scripts'
      && /beezi/i.test(script)
    ) return UNSUFFIXED_OWNER;
  }

  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string') return null;
  // Anchored to our own directory: a user's ~/bin/beezi-notify.sh is not ours to remove, and
  // uninstall promises it will leave their hooks alone. Launchers only ever existed on the
  // unsuffixed build, and hookLauncherDir() is itself namespaced, so this can only fire for the
  // migration path it exists to serve.
  if (
    path.basename(command).startsWith(LAUNCHER_PREFIX)
    && path.resolve(path.dirname(command)) === path.resolve(launcherDir)
  ) return UNSUFFIXED_OWNER;

  return null;
}

/** Is this handler THIS variant's? A sibling variant's handler answers false. */
function isOwnedHandler(handler, owner, launcherDir) {
  return handlerOwner(handler, launcherDir) === owner;
}

// ── dead entries ────────────────────────────────────────────────────────────
//
// `~/.codex/hooks.json` outlives the install that wrote it, and a dead entry is not inert —
// `isDeadBeeziEntry` below states why. Measured on a live machine: three launcher-style entries left
// by a pre-launcherless production install, pointing into a `~/.beezi-codex/hooks` directory that no
// longer exists. Through cmd.exe that is exactly `The system cannot find the path specified.` and
// exit 1, on SessionStart, PostToolUse and Stop, for every session on that machine, while
// `hooksStatus()` reported `installed` — it is owner-scoped and the orphans had a DIFFERENT owner.
//
// The scan below is deliberately READ-ONLY and deliberately NOT owner-scoped. Reporting across
// owners is safe; removing across owners is not, and the one-owner-per-mutation rule above stays
// exactly as it is. The repair is the owning variant's own `uninstall`, which already handles it
// correctly — the defect was never that the removal could not be done, only that nothing said it
// needed doing.

/**
 * The filesystem path a handler actually spawns, or null when it names none.
 *
 * Current-format entries keep `node` PATH-resolved and quote the script inside `command`, so the
 * script is the thing to check. Legacy launcher entries put only the launcher path in
 * `command`/`commandWindows`.
 */
function handlerTarget(handler) {
  if (!handler || typeof handler !== 'object') return null;
  const script = handlerScript(handler);
  if (script !== null) return script;
  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string' || command === '') return null;
  // A single-token command (`node`, `pwsh`) is resolved from the hook's PATH at spawn time and is
  // not a path this process can check. Only a command that names a directory is stat-able.
  if (command.indexOf('/') === -1 && command.indexOf('\\') === -1) return null;
  return command;
}

/**
 * Every Beezi-recognised handler in a registry whose target file is missing, across ALL owners.
 *
 * The recogniser is `handlerOwner`, so an entry is only ever claimed by the same three anchors the
 * mutations use. One consequence is worth stating plainly rather than discovering later: the
 * launcher-dir anchor compares against the CALLER's `launcherDir`, which is namespaced per
 * environment, so a legacy production launcher is invisible to a beezi-local process through that
 * anchor and is caught by its `statusMessage` label instead. A user who reworded the label of a
 * sibling variant's dead launcher entry gets no report of it. Accepted: the label is the only
 * cross-owner anchor that exists, and widening the recogniser to "any path with beezi in it" would
 * start claiming entries that are not ours.
 */
export function brokenBeeziEntries(registry, launcherDir = hookLauncherDir()) {
  const out = [];
  const source = registry && registry.hooks && typeof registry.hooks === 'object' ? registry.hooks : {};
  const owners = knownOwners();
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        const owner = handlerOwner(handler, launcherDir);
        if (owner === null || owners.indexOf(owner) === -1) continue;
        const target = handlerTarget(handler);
        if (target === null) continue;
        if (fs.existsSync(target)) continue;
        out.push({ event, owner, target });
      }
    }
  }
  return out;
}

// This module sits in <pluginRoot>/lib, so its own location is the single source of truth for where
// the plugin's scripts are — no caller has to rediscover the layout.
const DEFAULT_SCRIPTS_DIR = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'scripts',
);

// The launcher we install is a verbatim copy of the one shipped in this plugin version. Injectable
// so tests can point at a fixture without a build step — the same reason `owner`, `hooksFile` and
// `launcherDir` are.
const DEFAULT_LAUNCHER_SOURCE = path.join(DEFAULT_SCRIPTS_DIR, 'hook-launcher.mjs');

// The exact command for the read-only action, absolute and copy-pasteable. Derived rather than
// hand-written: a message that reaches the MCP tool is read by a model that will try to RUN what it
// is given, and a relative path — or worse, a `<plugin>` placeholder — resolves to nothing from the
// user's cwd, which is the repository they are working in, not the plugin root.
export function statusCommand(scriptsDir = DEFAULT_SCRIPTS_DIR) {
  return `node "${path.join(scriptsDir, 'hooks.mjs')}" status`;
}

// The `{ hooks: { <Event>: [ { matcher, hooks: [handler] } ] } }` fragment for Beezi's events.
//
// Derived from `launcherDir` and `owner` ALONE. No plugin path, no version, nothing that an upgrade
// can move — two installs of different plugin versions produce byte-identical entries, which is
// what stops an upgrade revoking hook trust. `owner` is injectable for the same reason `hooksFile`
// and `launcherDir` are: lib/paths.mjs freezes the environment at module load, so a both-orders
// variant matrix would otherwise need one child process per variant.
export function buildHookEntries({ launcherDir = hookLauncherDir(), owner = hookOwner() } = {}) {
  const launcher = launcherPath(launcherDir);
  const out = {};
  for (const { event, script } of BEEZI_HOOKS) {
    out[event] = [
      {
        matcher: MATCH_ALL,
        hooks: [
          {
            type: 'command',
            command: hookCommand(launcher, script, owner),
            statusMessage: ownerLabel(owner),
            timeout: HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ];
  }
  return out;
}

// ── keeping the launcher file current ───────────────────────────────────────
//
// The registry is frozen across upgrades; the launcher file is NOT. It is plugin code, shipped in
// the version being installed, so every install and every ensureHooks() overwrites it with the
// current bytes. That split is the whole design: the thing Codex hashes never changes, the thing
// that carries the logic always does.

function readFileOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

/**
 * 'current' | 'stale' | 'missing' — the installed launcher against the one this build ships.
 *
 * An UNREADABLE SOURCE reads as 'current' whenever a launcher is on disk. We cannot tell whether it
 * differs, and guessing 'stale' would make every caller rewrite a file it has nothing better to
 * write. With no launcher on disk either, 'missing' is still the truthful answer.
 */
function launcherState(launcherDir, launcherSource) {
  const installed = readFileOrNull(launcherPath(launcherDir));
  if (installed === null) return 'missing';
  const source = readFileOrNull(launcherSource);
  if (source === null) return 'current';
  return source.equals(installed) ? 'current' : 'stale';
}

/**
 * Replace the launcher with this build's copy. Returns whether anything was written.
 *
 * WHY renameSync HERE, when lib/single-instance-lock.mjs states at length that on Windows a rename
 * is not an exclusivity signal: exclusion is not what it is being asked for. Every caller of this
 * already holds the `codex-hooks` lock, so there is exactly one writer. The rename is used only for
 * ATOMIC REPLACEMENT — a hook spawned mid-write must never see a half-copied launcher — and for
 * that its return value is not being interpreted as "I won" at all.
 *
 * The retry is Windows-specific and real: a hook process may have the file open, and Windows then
 * fails the replace with EPERM/EBUSY rather than swapping underneath it. A few immediate retries
 * cover the microseconds a short-lived hook holds it; past that we give up and leave the existing
 * launcher in place, because the next session tries again.
 */
function writeLauncher(launcherDir, launcherSource) {
  const source = readFileOrNull(launcherSource);
  if (source === null) return false;

  fs.mkdirSync(launcherDir, { recursive: true });
  const target = launcherPath(launcherDir);
  const temp = path.join(launcherDir, `.${LAUNCHER_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temp, source);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return true;
    } catch (error) {
      const code = error && error.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
    }
  }
  removeFileSync(temp);
  return false;
}

/**
 * Delete the per-event launchers a pre-0.9 install left in this dir — and NOTHING else.
 *
 * It used to be `removeDirSync(launcherDir)`, which is no longer possible: the dir now holds the
 * live launcher this very install just wrote. The extension filter is what separates them, since
 * `beezi-hook.mjs` matches the `beezi-` prefix too.
 */
function sweepLegacyLaunchers(launcherDir) {
  let names;
  try { names = fs.readdirSync(launcherDir); } catch { return; }
  for (const name of names) {
    if (name.indexOf(LAUNCHER_PREFIX) !== 0) continue;
    if (LEGACY_LAUNCHER_EXTENSIONS.indexOf(path.extname(name)) === -1) continue;
    removeFileSync(path.join(launcherDir, name));
  }
}

// The events a registry currently carries THIS OWNER's handlers for. A sibling variant's events
// are not listed, so uninstall never reports having removed what it left alone.
function beeziEvents(registry, launcherDir, owner) {
  const out = [];
  const source = registry && registry.hooks ? registry.hooks : {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((g) => g && Array.isArray(g.hooks)
      && g.hooks.some((h) => isOwnedHandler(h, owner, launcherDir)))) {
      out.push(event);
    }
  }
  return out;
}

// Drop THIS OWNER's handlers from a registry, leaving every other hook — a sibling variant's, the
// user's own, and any unknown top-level key — untouched. Groups are filtered handler-by-handler
// because a user may have hand-merged ours into a group of their own; a group left with no handlers
// is removed, as is an emptied event.
export function removeBeeziHooks(existing, launcherDir = hookLauncherDir(), owner = hookOwner()) {
  const source = existing ? existing.hooks : null;
  if (!source || typeof source !== 'object') return existing || {};
  const hooks = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const group of groups) {
      // A malformed group has no handlers to filter — pass it through rather than reshape it.
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isOwnedHandler(h, owner, launcherDir));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

// Re-install is idempotent: strip THIS OWNER's previous entries first, then append the current
// ones. Every other hook — the user's own and any sibling variant's — keeps its position and
// content. Stripping recognises both entry formats, so a re-install on a machine with the old
// launcher-style entries converts them in one write.
export function mergeHooks(existing, beeziHooks, launcherDir = hookLauncherDir(), owner = hookOwner()) {
  const base = removeBeeziHooks(existing, launcherDir, owner);
  const hooks = { ...(base.hooks || {}) };
  for (const [event, groups] of Object.entries(beeziHooks)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
  return { ...base, hooks };
}

// A registry we cannot parse must never be treated as an empty one. The file is the user's — the
// install flow tells them to open and review it — so a stray trailing comma is a realistic state,
// and merging onto `{}` would rewrite the file with the events in BEEZI_HOOKS and nothing else,
// deleting every hook they had configured. Refuse instead, and say which file to fix.
function readRegistry(hooksFile) {
  let raw;
  try { raw = fs.readFileSync(hooksFile, 'utf-8'); } catch { return {}; }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to the error below */ }
  throw new UserError(
    `${hooksFile} is not valid JSON. Fix or remove it, then run the install again — refusing to overwrite hooks that cannot be read.`,
  );
}

// Not writeJsonSecure: this file is Codex's, holds no secret, and must stay readable and
// hand-editable — the user is expected to review it before trusting it via `/hooks`.
function writeRegistry(hooksFile, registry) {
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

/**
 * Is this a launcher entry from a pre-launcherless install whose file is gone?
 *
 * The SHAPE-anchored half of the dead-entry sweep, and it is narrow on purpose. Past the legacy-form
 * check below, two facts have to hold, and together they make "it might still be a live sibling's"
 * impossible rather than unlikely:
 *
 *   * Our SHAPE — `<home>/.beezi-codex[-env]/hooks/beezi-<name>`. All three segments are checked,
 *     so a user's own `~/bin/beezi-notify.sh` is not ours and is not touched.
 *   * DEAD — the file is missing. A sibling variant that still works has a file there; an entry
 *     that fails its spawn on every session has nothing left to protect.
 *
 * It survives alongside the owner-anchored half below because it needs no label and no tag: a
 * sibling's dead launcher whose `statusMessage` the user reworded is recognised by shape alone.
 */
function isDeadLegacyLauncher(handler) {
  if (!handler || typeof handler !== 'object') return false;
  if (Array.isArray(handler.arguments) && handler.arguments.length) return false;
  // THE LINE THAT EXCLUDES THE CURRENT LAUNCHER. A legacy entry named the launcher directly, with
  // no interpreter and no quoting, so it has no quoted script; ours is always `node "<launcher>"
  // <script>` and returns a path here. Without this, a launcher dir deleted by hand would look like
  // five dead legacy entries and the sweep would strip a live install.
  if (handlerScript(handler) !== null) return false;

  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string' || command === '') return false;
  if (!path.basename(command).startsWith(LAUNCHER_PREFIX)) return false;

  const dir = path.dirname(command);
  if (path.basename(dir) !== 'hooks') return false;

  // `.beezi-codex` for the unsuffixed build, `.beezi-codex-<env>` for a named variant — the exact
  // set lib/paths.mjs beeziCodexHome() can produce. A BEEZI_CODEX_HOME override renames the root,
  // so an entry written under one is simply not swept; it is still reported by brokenBeeziEntries.
  const root = path.basename(path.dirname(dir));
  if (root !== '.beezi-codex' && root.indexOf('.beezi-codex-') !== 0) return false;

  return !fs.existsSync(command);
}

/**
 * Is this a Beezi-recognised entry whose target file is gone, whoever installed it?
 *
 * THE CROSS-OWNER REMOVAL THIS MODULE ALLOWS, widened from launchers alone to every form we write.
 * The recogniser is `handlerOwner`, the same three anchors every mutation uses, so a user's own
 * hook is never claimed; `handlerTarget` returns null for a PATH-resolved interpreter, so a
 * `command: 'node'` entry naming no path is never stat-ed and never swept.
 *
 * DEAD is what makes the cross-owner reach sound. The one-owner-per-mutation rule protects a
 * sibling variant that still works — and a sibling that still works has its file on disk. An entry
 * whose file is missing is not inert: Codex spawns it every session, the spawn fails, and the whole
 * event is reported as `hook: <Event> Failed`. It belongs to no working install, so removing it
 * cannot break one, and leaving it breaks every session on the machine.
 *
 * This is what removes the "go and run that variant's uninstall by hand" instruction: the variant
 * that left the orphans is usually the one the user has already deleted, so it is not there to run.
 *
 * And the one false positive left is self-correcting. `fs.existsSync` also answers false for a path
 * this process cannot stat, so a live sibling could in principle be swept — but that sibling's own
 * MCP server calls ensureHooks() at the start of its next session and puts its entries straight
 * back. The worst case is one re-trust, not a variant that stops reporting.
 */
function isDeadBeeziEntry(handler, launcherDir) {
  if (isDeadLegacyLauncher(handler)) return true;
  const owner = handlerOwner(handler, launcherDir);
  if (owner === null || knownOwners().indexOf(owner) === -1) return false;
  const target = handlerTarget(handler);
  if (target === null) return false;
  return !fs.existsSync(target);
}

/** Drop every dead Beezi entry from a registry, leaving everything else exactly where it is. */
export function removeDeadBeeziEntries(existing, launcherDir = hookLauncherDir()) {
  const source = existing ? existing.hooks : null;
  if (!source || typeof source !== 'object') return existing || {};
  const hooks = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isDeadBeeziEntry(h, launcherDir));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

// ── the registry lock ───────────────────────────────────────────────────────
//
// `~/.codex/hooks.json` is shared state and every mutation below is a read-modify-write, so R3's
// rule applies: one writer at a time, through lib/single-instance-lock.mjs. This used to be a rare
// hand-run command where a race was theoretical; ensureHooks() now fires from the MCP server of
// every session and from login, and two Codex windows opened together are exactly two interleaved
// rewrites of the same file — one of which would silently lose the other's entries.
//
// Contention DEFERS rather than waits. The work is idempotent and self-healing: whoever holds the
// lock is writing the same entries this process would have written, so skipping is not a failure,
// and the next session re-checks anyway.
//
// NEVER CALL FROM INSIDE A session: OR shared: SECTION. This is a rank-3 `shared` lock, and
// acquireLock refuses — `{ ok: false }`, not a wait — when a lock of equal or finer rank is already
// held. A caller that holds one would silently get `skipped: true` and no install. Today's callers
// (the MCP bridge, login, me, the hooks script) hold nothing.
const HOOKS_REGISTRY_LOCK = 'codex-hooks';

function withRegistry(fn) {
  return withLock(sharedLock(HOOKS_REGISTRY_LOCK), {}, fn);
}

export function installHooks({
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  launcherSource = DEFAULT_LAUNCHER_SOURCE,
  owner = hookOwner(),
} = {}) {
  const run = withRegistry(() => {
    // THE LAUNCHER IS WRITTEN FIRST, before anything reads the registry. Every entry we write names
    // it, so the dead-entry scan below would otherwise classify this owner's own entries as orphans
    // and report them as `swept` when they were merely replaced. With the file already on disk,
    // `swept` names only genuine cross-owner orphans.
    const launcherWritten = writeLauncher(launcherDir, launcherSource);

    const existing = readRegistry(hooksFile);
    const before = brokenBeeziEntries(existing, launcherDir);
    // The sweep runs BEFORE the merge, never after. Afterwards it would stat the entries this very
    // call just wrote and delete them all if the launcher is not on disk — an install that silently
    // produces an empty registry.
    writeRegistry(hooksFile, mergeHooks(
      removeDeadBeeziEntries(existing, launcherDir),
      buildHookEntries({ launcherDir, owner }),
      launcherDir,
      owner,
    ));

    // Clear out the per-event launchers an older version left beside ours. Only those files: the
    // directory itself is now live state, not a leftover.
    sweepLegacyLaunchers(launcherDir);
    return { before, launcherWritten };
  });

  // `swept` is what the sweep actually cleared, computed from the registry as it was BEFORE the
  // write, so a caller can name the orphans it removed rather than the ones it left.
  return {
    hooksFile,
    owner,
    events: BEEZI_EVENTS,
    swept: run.skipped ? [] : run.value.before,
    launcherRefreshed: run.skipped ? false : run.value.launcherWritten,
    skipped: !!run.skipped,
  };
}

export function uninstallHooks({
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  owner = hookOwner(),
} = {}) {
  const run = withRegistry(() => {
    const existing = readJson(hooksFile, null);
    const removed = beeziEvents(existing, launcherDir, owner).length > 0;
    if (existing) {
      const stripped = removeBeeziHooks(existing, launcherDir, owner);
      // If THIS OWNER's entries were the only reason this registry existed, take the file with them —
      // leaving an empty `{"hooks":{}}` behind would misreport as "the user configured hooks". A
      // sibling variant's entries survive removeBeeziHooks, so `hooks` is not empty and the file is
      // kept: uninstalling one variant must never delete the other's registry.
      const empty = Object.keys(stripped.hooks || {}).length === 0 && Object.keys(stripped).every((k) => k === 'hooks');
      if (empty) {
        removeFileSync(hooksFile);
      } else {
        writeRegistry(hooksFile, stripped);
      }
    }
    // The whole dir, launcher included: nothing of this environment's is left behind, and
    // hookLauncherDir() is namespaced per environment so this cannot reach a sibling's launcher.
    removeDirSync(launcherDir);
    return removed;
  });
  return { hooksFile, owner, removed: run.skipped ? false : run.value, skipped: !!run.skipped };
}

/**
 * Bring the hooks to a working state WITHOUT asking the user to run anything.
 *
 * The one entry point every caller that merely *noticed* a bad install should use, instead of
 * printing an install command for the user to run by hand.
 *
 * TWO INDEPENDENT REPAIRS, and keeping them independent is the point:
 *
 *   · the REGISTRY is refused a rewrite whenever there is nothing to fix. That refusal is
 *     load-bearing rather than an optimisation: Codex keys hook trust to each entry's HASH, so a
 *     pointless rewrite of identical entries would revoke the trust the user has already granted.
 *   · the LAUNCHER file is refreshed whenever its bytes are not this build's. It is plugin code,
 *     Codex hashes nothing about it, and the registry entry that names it does not change.
 *
 * So the expected outcome after a plugin upgrade is now `repaired: false, launcherRefreshed: true`:
 * new code, same entries, no re-trust. `stale` used to be the normal post-upgrade state; it is not
 * any more, and an entry that still reads `stale` is one written by a pre-launcher version, which
 * costs exactly one final re-trust to migrate.
 *
 * THE LAUNCHER IS REFRESHED FIRST, before the registry is judged. Every entry points at it, so a
 * missing launcher makes all five read as dead, and judging first would rewrite a perfectly good
 * registry — revoking trust over a file we were about to put back anyway.
 *
 * What it cannot do is grant the trust — there is no non-interactive way to, and `repaired: true`
 * is precisely the signal a caller needs to tell the user to run `/hooks` once.
 */
export function ensureHooks(options = {}) {
  const initial = hooksStatus(options);

  let launcherRefreshed = false;
  if (initial.launcher !== 'current') {
    const launcherDir = options.launcherDir || hookLauncherDir();
    const launcherSource = options.launcherSource || DEFAULT_LAUNCHER_SOURCE;
    const run = withRegistry(() => writeLauncher(launcherDir, launcherSource));
    // Contention is not success. Another Beezi process is writing the same bytes, but this one did
    // not, and a caller that reports "refreshed" for a write that did not happen is lying.
    if (run.skipped) {
      return {
        repaired: false, launcherRefreshed: false, before: initial.state, state: initial.state,
        swept: [], status: initial, skipped: true,
      };
    }
    launcherRefreshed = !!run.value;
  }

  const before = launcherRefreshed ? hooksStatus(options) : initial;
  const dead = before.broken.length > 0;
  if (before.state === 'installed' && !dead) {
    return {
      repaired: false, launcherRefreshed, before: before.state, state: before.state,
      swept: [], status: before,
    };
  }

  const result = installHooks(options);
  if (result.skipped) {
    return {
      repaired: false, launcherRefreshed, before: before.state, state: before.state,
      swept: [], status: before, skipped: true,
    };
  }
  const after = hooksStatus(options);
  return {
    repaired: true,
    launcherRefreshed: launcherRefreshed || result.launcherRefreshed,
    before: before.state,
    state: after.state,
    swept: result.swept,
    status: after,
  };
}

// Is the current install complete, and is it in the launcher form?
//
// `state` is driven by the REGISTRY ALONE — `installed | stale | partial | absent` — and is the
// classifier callers branch on. It no longer moves with the plugin version: the expected entries
// are derived from `launcherDir` and `owner`, neither of which an upgrade touches, so `stale` now
// means one thing only — an entry written by a version that registered the versioned script path
// (or the broken 0.8.x `arguments` form, or a per-event legacy launcher), all of which install
// migrates in one write.
//
// `launcher` is reported ALONGSIDE it, never folded into it: the file's freshness and the entries'
// correctness are independent, they are repaired independently, and only one of them costs a
// re-trust. The interpreter is still bare `node` on PATH and cannot be verified from here.
export function hooksStatus({
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  launcherSource = DEFAULT_LAUNCHER_SOURCE,
  owner = hookOwner(),
} = {}) {
  const registry = readJson(hooksFile, null);
  const source = registry && registry.hooks && typeof registry.hooks === 'object' ? registry.hooks : {};

  const registered = [];
  const missingEvents = [];
  const staleEvents = [];
  for (const { event, script } of BEEZI_HOOKS) {
    const groups = Array.isArray(source[event]) ? source[event] : [];
    const handlers = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        // Scoped to this owner: a sibling variant's complete install must not make ours read
        // `installed`, and ours must not make the sibling's read `stale`.
        if (isOwnedHandler(handler, owner, launcherDir)) handlers.push(handler);
      }
    }
    if (!handlers.length) { missingEvents.push(event); continue; }
    registered.push(event);
    // Current means the launcher form, byte for byte. A versioned script path, a legacy per-event
    // launcher or the broken node-plus-arguments form all fail this check, which is what routes an
    // old install through `stale` → "run install to repair" → migration, once.
    const expectedCommand = hookCommand(launcherPath(launcherDir), script, owner);
    const current = handlers.some((h) => h.command === expectedCommand
      && h.timeout === HOOK_TIMEOUT_SEC
      && !('arguments' in h));
    if (!current) staleEvents.push(event);
  }

  const complete = !missingEvents.length && !staleEvents.length;
  let state;
  if (complete) state = 'installed';
  else if (staleEvents.length) state = 'stale';
  else if (!registered.length) state = 'absent';
  else state = 'partial';

  // Reported alongside `state`, never folded into it. `state` answers "is THIS owner's install
  // usable"; `broken` answers "is anything in this registry failing every session", which a
  // healthy install of ours does not preclude — that gap is the whole reason this scan exists.
  const broken = brokenBeeziEntries(registry, launcherDir);

  return {
    hooksFile,
    owner,
    state,
    complete,
    registered,
    missingEvents,
    staleEvents,
    broken,
    launcher: launcherState(launcherDir, launcherSource),
    launcherFile: launcherPath(launcherDir),
  };
}
