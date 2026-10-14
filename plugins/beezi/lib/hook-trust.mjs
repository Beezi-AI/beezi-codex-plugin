import fs from 'fs';
import { listHooksViaAppServer as _listHooks } from './codex-app-server.mjs';
import { buildHookEntries, hookOwner } from './hooks-install.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';
import { codexHooksFile, hookTrustFile } from './paths.mjs';
import { orDefault } from './compat.mjs';

// "Does Codex trust OUR hooks" — the one place that answers it.
//
// An untrusted hook does not run and nothing reports it, so a machine can install the plugin, skip
// `/hooks`, and send nothing for weeks. The hooks cannot say so themselves (they are the thing not
// running); the MCP bridge can, because it needs no trust. This module gives it the verdict.
//
// THE SOURCE IS `hooks/list`, NEVER config.toml. Codex keys trust there by POSITION
// (`<hooks.json>:<event>:<group>:<idx>`) against a hash we could not reproduce from the entry, so a
// file read would misjudge any machine where another tool's hook sits before ours.

export const TrustVerdict = Object.freeze({
  TRUSTED: 'trusted',      // every expected entry registered, enabled and trusted
  UNTRUSTED: 'untrusted',  // at least one enabled entry Codex has not trusted
  DISABLED: 'disabled',    // trusted, but the user switched at least one off — their call, never nagged
  UNKNOWN: 'unknown',      // could not tell: probe off or failed, field missing, entries not registered
});

const CACHE_VERSION = 1;
// How long a TRUSTED verdict may stand in for a fresh probe — at most one probe a day on a healthy machine.
const TRUSTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The exact `command` strings this owner writes. Matched by command, never by `key`: the key is
// positional and shifts whenever another tool's hook lands before ours.
export function expectedHookCommands(options = {}) {
  const entries = buildHookEntries(options);
  const commands = [];
  Object.keys(entries).forEach((event) => {
    entries[event].forEach((group) => {
      group.hooks.forEach((hook) => commands.push(hook.command));
    });
  });
  return commands;
}

// This server's key in `.mcp.json`: `beezi`, or `beezi_<env>` on a variant — the key
// scripts/make-variant.sh writes, because Codex skips a plugin MCP server whose key another plugin
// already took. The trust instructions name it so the model calls the right server's status tool.
export function mcpServerKey(owner = hookOwner()) {
  return String(owner).replace('-', '_');
}

function eventOf(hook) {
  return typeof hook.eventName === 'string' ? hook.eventName : 'unknown';
}

// Pure: `hooks` is the flattened hooks/list answer, `expected` this owner's commands.
export function classifyHooks(hooks, expected) {
  const mine = hooks.filter((hook) => hook && expected.indexOf(hook.command) !== -1);
  const untrusted = [];
  const disabled = [];
  let unreported = false;
  mine.forEach((hook) => {
    if (hook.enabled === false) { disabled.push(eventOf(hook)); return; }
    // A build that does not report trust says nothing about it. Reading the missing field as
    // "untrusted" would nag every user of that build forever.
    if (typeof hook.trustStatus !== 'string') { unreported = true; return; }
    if (hook.trustStatus !== 'trusted') untrusted.push(eventOf(hook));
  });
  const shape = (verdict) => ({ verdict, untrusted, disabled });
  if (untrusted.length) return shape(TrustVerdict.UNTRUSTED);
  if (unreported) return shape(TrustVerdict.UNKNOWN);
  if (disabled.length) return shape(TrustVerdict.DISABLED);
  const registered = expected.every((command) => mine.some((hook) => hook.command === command));
  return shape(registered ? TrustVerdict.TRUSTED : TrustVerdict.UNKNOWN);
}

// ── the cache ────────────────────────────────────────────────────────────────────────────────
//
// Stamped by hooks.json ONLY. config.toml is where trust lands, but Codex rewrites it for unrelated
// reasons (project trust levels, settings), so stamping it would drop the verdict nearly every
// session and the reminder would rarely fire. The cost: trust granted outside the done/skip flow
// can earn one outdated reminder, which the forced probe in `beezi_status` then clears.

function stampOf(file) {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameStamp(a, b) {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function cachePaths(deps) {
  return {
    cacheFile: orDefault(deps.cacheFile, null) || hookTrustFile(),
    hooksFile: orDefault(deps.hooksFile, null) || codexHooksFile(),
  };
}

// The cached verdict, or null when absent, corrupt, or older than the current hooks.json.
export function readCachedVerdict(deps = {}) {
  try {
    const where = cachePaths(deps);
    const cached = readJson(where.cacheFile, null);
    if (!cached || cached.version !== CACHE_VERSION || typeof cached.verdict !== 'string') return null;
    if (!sameStamp(orDefault(cached.stamp, null), stampOf(where.hooksFile))) return null;
    // A TRUSTED answer is what lets the bridge skip the probe, so it must not live forever: trust
    // can be lost without hooks.json changing (untrusted in /hooks, a Codex upgrade that rehashes,
    // a reset config.toml). Other verdicts never skip the probe, so they need no limit.
    if (cached.verdict === TrustVerdict.TRUSTED) {
      const now = orDefault(deps.now, Date.now);
      const age = now() - Date.parse(cached.checkedAt);
      if (!(age >= 0 && age <= TRUSTED_MAX_AGE_MS)) return null;
    }
    return {
      verdict: cached.verdict,
      untrusted: Array.isArray(cached.untrusted) ? cached.untrusted : [],
      disabled: Array.isArray(cached.disabled) ? cached.disabled : [],
      checkedAt: cached.checkedAt,
    };
  } catch {
    return null;
  }
}

// Best-effort. UNKNOWN is never written: "could not tell this time" must not erase what was measured.
export function writeCachedVerdict(result, deps = {}) {
  if (!result || result.verdict === TrustVerdict.UNKNOWN) return;
  try {
    const where = cachePaths(deps);
    const now = orDefault(deps.now, Date.now);
    withLock(sharedLock('hook-trust'), {}, () => {
      writeJsonSecure(where.cacheFile, {
        version: CACHE_VERSION,
        verdict: result.verdict,
        untrusted: result.untrusted,
        disabled: result.disabled,
        checkedAt: new Date(now()).toISOString(),
        stamp: stampOf(where.hooksFile),
      });
    });
  } catch { /* a lost cache write costs one more probe, nothing else */ }
}

// Ask Codex, classify, cache. Never rejects: every failure is `{ verdict: UNKNOWN, reason }`.
export function probeHookTrust(deps = {}) {
  const unknown = (reason) => ({ verdict: TrustVerdict.UNKNOWN, untrusted: [], disabled: [], reason });
  let pending;
  try {
    pending = Promise.resolve((deps.listHooks || _listHooks)(deps.appServer || {}));
  } catch {
    return Promise.resolve(unknown('error'));
  }
  return pending.then((answer) => {
    if (!answer || !answer.ok) return unknown(answer ? answer.reason : 'error');
    const expected = deps.expected || expectedHookCommands();
    const result = { ...classifyHooks(answer.hooks, expected), reason: 'ok' };
    writeCachedVerdict(result, deps);
    return result;
  }, () => unknown('error'));
}
