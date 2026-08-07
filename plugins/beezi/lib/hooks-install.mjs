import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { codexHooksFile, hookLauncherDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import { UserError } from './friendly-error.mjs';

// Codex does not load hooks bundled inside a plugin — the `plugin_hooks` feature is `removed`, and
// an installed plugin contributes zero entries to the engine's `hooks/list`. Only `skills/` and
// `.mcp.json` travel with the package. So Beezi's lifecycle hooks have to be written into the
// user-level registry (`~/.codex/hooks.json`) by this installer, and trusted once via `/hooks`.

// Shown by Codex next to each entry. Also one of the two ways we recognise our own handlers — see
// isBeeziHandler, which does not rely on it alone precisely because the install flow invites the
// user to open `/hooks` and read (and potentially edit) this text.
export const BEEZI_STATUS_MESSAGE = 'Beezi analytics';

// The one instruction every caller has to pass on: Codex will not run a hook it has not been shown.
export const TRUST_STEP = 'run /hooks in Codex, review the Beezi entries, and trust them';

// The events Beezi registers.
//
// `SessionEnd` is deliberately absent. It was once absent because Codex dropped it from the registry;
// current builds do implement it, so the reason is now simply that `Stop` already runs the identical
// checkpoint (timeline included) at every turn end. Registering it would buy nothing and cost the
// user another entry to review and trust.
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

// Every tool, because the tool's *name* differs across Codex's two live tool surfaces
// (`shell_command` on the legacy one, `exec` under unified exec) and has not been measured from a
// real payload yet. `checkpoint.mjs` exits before loading the engine unless the payload carries a
// git checkpoint command, so the cost is a short-lived process; guessing the name instead would
// fail silently by never firing.
const MATCH_ALL = '.*';
// The timeout Codex records for each Beezi hook. Exported because the hooks themselves have to
// finish inside it — Codex kills what overruns and reports the kill as a failed hook — so the
// checkpoint's own budget is derived from this number rather than guessed alongside it.
export const HOOK_TIMEOUT_SEC = 10;

// This module sits in <pluginRoot>/lib, so its own location is the single source of truth for where
// the plugin's scripts are — no caller has to rediscover the layout.
const DEFAULT_SCRIPTS_DIR = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'scripts',
);

// The exact command that installs the hooks, absolute and copy-pasteable. Every message that asks
// the user to install has to quote this one: their cwd is the repository they are working in, not
// the plugin root, so a relative `scripts/hooks.mjs` resolves to nothing.
export function installCommand(scriptsDir = DEFAULT_SCRIPTS_DIR) {
  return `node "${path.join(scriptsDir, 'hooks.mjs')}" install`;
}

// A launcher is a single-token executable, so the `command` field never depends on how Codex
// splits arguments or on `node` being resolvable from the hook's PATH.
const LAUNCHER_PREFIX = 'beezi-';

export function launcherName(script, platform = process.platform) {
  const stem = `${LAUNCHER_PREFIX}${path.basename(script, '.mjs')}`;
  return platform === 'win32' ? `${stem}.cmd` : `${stem}.sh`;
}

function launcherPath(script, launcherDir, platform) {
  return path.join(launcherDir, launcherName(script, platform));
}

export function launcherBody(scriptPath, { nodePath, platform = process.platform }) {
  if (platform === 'win32') {
    // CRLF: cmd.exe mis-parses a batch file with bare LF line endings on some shells.
    return ['@echo off', `"${nodePath}" "${scriptPath}" %*`, ''].join('\r\n');
  }
  return ['#!/bin/sh', `exec "${nodePath}" "${scriptPath}" "$@"`, ''].join('\n');
}

// The `{ hooks: { <Event>: [ { matcher, hooks: [handler] } ] } }` fragment for Beezi's events.
export function buildHookEntries({ launcherDir, platform = process.platform }) {
  const out = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const command = launcherPath(script, launcherDir, platform);
    out[event] = [
      {
        matcher: MATCH_ALL,
        hooks: [
          {
            type: 'command',
            command,
            commandWindows: command,
            statusMessage: BEEZI_STATUS_MESSAGE,
            timeout: HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ];
  }
  return out;
}

// Ours if it is labelled ours, or if it runs one of our launchers. The second test is what keeps
// re-install idempotent and uninstall honest when a user reworded the label while reviewing the
// registry: the launcher filename is ours by construction and, unlike the script path inside it,
// carries no plugin version, so it survives upgrades.
function isBeeziHandler(handler, launcherDir = hookLauncherDir()) {
  if (handler?.statusMessage === BEEZI_STATUS_MESSAGE) return true;
  const command = handler?.command ?? handler?.commandWindows;
  if (typeof command !== 'string') return false;
  // Anchored to our own directory: a user's ~/bin/beezi-notify.sh is not ours to remove, and
  // uninstall promises it will leave their hooks alone.
  return path.basename(command).startsWith(LAUNCHER_PREFIX)
    && path.resolve(path.dirname(command)) === path.resolve(launcherDir);
}

// The events a registry currently carries Beezi handlers for.
function beeziEvents(registry, launcherDir) {
  const out = [];
  for (const [event, groups] of Object.entries(registry?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isBeeziHandler(h, launcherDir)))) {
      out.push(event);
    }
  }
  return out;
}

// Drop Beezi's handlers from a registry, leaving every other hook — and any unknown top-level key
// — untouched. Groups are filtered handler-by-handler because a user may have hand-merged ours
// into a group of their own; a group left with no handlers is removed, as is an emptied event.
export function removeBeeziHooks(existing, launcherDir = hookLauncherDir()) {
  const source = existing?.hooks;
  if (!source || typeof source !== 'object') return existing ?? {};
  const hooks = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const group of groups) {
      // A malformed group has no handlers to filter — pass it through rather than reshape it.
      if (!Array.isArray(group?.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isBeeziHandler(h, launcherDir));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

// Re-install is idempotent: strip our previous entries first, then append the current ones. The
// user's own hooks keep their position and content.
export function mergeHooks(existing, beeziHooks, launcherDir = hookLauncherDir()) {
  const base = removeBeeziHooks(existing, launcherDir);
  const hooks = { ...(base.hooks ?? {}) };
  for (const [event, groups] of Object.entries(beeziHooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { ...base, hooks };
}

// A registry we cannot parse must never be treated as an empty one. The file is the user's — the
// install flow tells them to open and review it — so a stray trailing comma is a realistic state,
// and merging onto `{}` would rewrite the file with Beezi's three events and nothing else,
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

export function installHooks({
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  nodePath = process.execPath,
  platform = process.platform,
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
} = {}) {
  fs.mkdirSync(launcherDir, { recursive: true });

  const launchers = [];
  for (const { script } of BEEZI_HOOKS) {
    const launcher = launcherPath(script, launcherDir, platform);
    fs.writeFileSync(launcher, launcherBody(path.join(scriptsDir, script), { nodePath, platform }), 'utf-8');
    if (platform !== 'win32') {
      try { fs.chmodSync(launcher, 0o755); } catch { /* best effort */ }
    }
    launchers.push(launcher);
  }

  writeRegistry(hooksFile, mergeHooks(readRegistry(hooksFile), buildHookEntries({ launcherDir, platform }), launcherDir));

  return { hooksFile, launchers, events: BEEZI_EVENTS };
}

export function uninstallHooks({
  platform = process.platform,
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
} = {}) {
  const existing = readJson(hooksFile, null);
  const removed = beeziEvents(existing, launcherDir).length > 0;
  if (existing) {
    const stripped = removeBeeziHooks(existing, launcherDir);
    // If Beezi's entries were the only reason this registry existed, take the file with them —
    // leaving an empty `{"hooks":{}}` behind would misreport as "the user configured hooks".
    const empty = Object.keys(stripped.hooks ?? {}).length === 0 && Object.keys(stripped).every((k) => k === 'hooks');
    if (empty) {
      try { fs.rmSync(hooksFile); } catch { /* already gone */ }
    } else {
      writeRegistry(hooksFile, stripped);
    }
  }
  for (const { script } of BEEZI_HOOKS) {
    try { fs.rmSync(launcherPath(script, launcherDir, platform)); } catch { /* already gone */ }
  }
  return { hooksFile, removed };
}

// Is the current install complete and pointing at scripts that still exist? A plugin upgrade moves
// the versioned cache directory out from under the launchers, so a stale install is the expected
// failure and is named as such rather than reported as "not installed". `state` is the classifier
// callers should branch on — deriving it from the raw lists twice, differently, is how the setup
// and repair messages drift apart.
// The interpreter path baked into a launcher, if it still resolves.
function nodePathIn(body) {
  const match = /"([^"]+)"/.exec(body);
  if (!match) return false;
  try { return fs.existsSync(match[1]); } catch { return false; }
}

export function hooksStatus({
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  platform = process.platform,
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
} = {}) {
  const registered = beeziEvents(readJson(hooksFile, null), launcherDir);

  const missingLaunchers = [];
  const staleLaunchers = [];
  for (const { script } of BEEZI_HOOKS) {
    const launcher = launcherPath(script, launcherDir, platform);
    let body;
    // Read rather than stat: a launcher left by an older plugin version exists but points at a
    // scripts directory that no longer does, and only its contents distinguish the two.
    try { body = fs.readFileSync(launcher, 'utf-8'); } catch { missingLaunchers.push(launcher); continue; }
    // Both halves of the launcher have to still exist. A Node upgrade removes the interpreter
    // directory the launcher was written with, and every hook then fails at spawn while the
    // registry still looks perfect — reporting "installed" would send the user to /hooks forever.
    if (!body.includes(path.join(scriptsDir, script)) || !nodePathIn(body)) staleLaunchers.push(launcher);
  }

  const complete =
    BEEZI_EVENTS.every((e) => registered.includes(e)) && !missingLaunchers.length && !staleLaunchers.length;
  let state;
  if (complete) state = 'installed';
  else if (staleLaunchers.length) state = 'stale';
  else if (!registered.length && missingLaunchers.length === BEEZI_HOOKS.length) state = 'absent';
  else state = 'partial';

  return { hooksFile, state, complete, registered, missingLaunchers, staleLaunchers };
}
