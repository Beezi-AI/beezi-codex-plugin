import fs from 'fs';
import path from 'path';
import { TrustVerdict, mcpServerKey } from './hook-trust.mjs';
import { trustInstructions } from './link-status.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';
import { codexAgentsFile } from './paths.mjs';

// The hook-trust reminder, kept in ~/.codex/AGENTS.md while Codex has not trusted our hooks.
//
// WHY THIS FILE: it is the one channel MEASURED to reach the model at session start (2026-10-05,
// codex-cli 0.160.0). MCP `initialize.instructions` are dropped, and MCP tool descriptions are
// deferred behind tool_search, so neither can carry a reminder. AGENTS.md can — but it is the
// USER'S file, so this module only ever touches its own marked block:
//
//   untrusted          → the block is present (added, or refreshed in place)
//   trusted / disabled → the block is gone; a file left empty by that is deleted
//   unknown            → nothing changes ("could not tell" must neither nag nor un-nag)
//
// It works one session late by design: Codex reads AGENTS.md when a session starts, and the verdict
// arrives after that. "Trusted again → removed, untrusted again → re-added" is just each sync
// moving the file to match the latest measured verdict.
//
// The marker carries the server key, so `beezi` and a `beezi_staging` variant each own one block.

const LOCK_NAME = 'codex-agents-md';

export function noticeMarkers(serverKey) {
  return {
    begin: `<!-- ${serverKey}:hook-trust begin (managed by the Beezi plugin; removed automatically once the hooks are trusted) -->`,
    end: `<!-- ${serverKey}:hook-trust end -->`,
  };
}

function buildBlock(serverKey, eol) {
  const { begin, end } = noticeMarkers(serverKey);
  // The text is '\n'-joined lines; re-joined here with the file's own line ending.
  return [begin, '## Beezi analytics hooks — required first step', '', ...trustInstructions(serverKey).split('\n'), end].join(eol);
}

// Pure: the file's next text, or null when nothing changes. `text` null means the file is absent.
// '' means "the file held only our block" — the caller deletes it rather than leave an empty file.
export function applyNotice(text, serverKey, verdict) {
  const current = typeof text === 'string' ? text : '';
  const eol = current.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const { begin, end } = noticeMarkers(serverKey);
  const from = current.indexOf(begin);
  const to = from === -1 ? -1 : current.indexOf(end, from);
  const present = from !== -1 && to !== -1;

  if (verdict === TrustVerdict.UNTRUSTED) {
    const block = buildBlock(serverKey, eol);
    if (present) {
      const stop = to + end.length;
      if (current.slice(from, stop) === block) return null;
      return current.slice(0, from) + block + current.slice(stop);
    }
    if (current === '') return block + eol;
    const base = current.slice(-eol.length) === eol ? current : current + eol;
    // A blank line before the block, so it never runs into the user's last paragraph.
    return base + eol + block + eol;
  }

  if (verdict === TrustVerdict.TRUSTED || verdict === TrustVerdict.DISABLED) {
    if (!present) return null;
    let before = current.slice(0, from);
    let after = current.slice(to + end.length);
    // Undo exactly what adding did: the block's own line ending, then the blank line before it.
    if (after.slice(0, eol.length) === eol) after = after.slice(eol.length);
    const blankBefore = before === '' || before.slice(-2 * eol.length) === eol + eol;
    if (blankBefore && after.slice(0, eol.length) === eol) after = after.slice(eol.length);
    else if (blankBefore && after === '' && before !== '') before = before.slice(0, -eol.length);
    return before + after;
  }

  return null;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Codex reads AGENTS.override.md INSTEAD of AGENTS.md when it exists (codex-cli 0.160.0 binary:
// codex-home/src/instructions). A block in the file Codex skips is a block nobody sees.
const OVERRIDE_FILE = 'AGENTS.override.md';

/**
 * The lock for both files: BESIDE them, in Codex's home, not under this variant's data root.
 * `beezi` and `beezi-staging` each have their own data root — and so their own locks directory —
 * but share one AGENTS.md, and both bridges start and sync at the same moment every session. A
 * per-variant lock would let one overwrite the other's read-modify-write.
 */
export function agentsLockTarget(agentsFile) {
  return { ...sharedLock(LOCK_NAME), file: path.join(path.dirname(agentsFile), '.beezi-agents-md.lock') };
}

function writeOrDelete(file, next) {
  if (next === '') {
    fs.unlinkSync(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
}

/**
 * Move ~/.codex/AGENTS.md (or AGENTS.override.md, when that is the one Codex reads) to match
 * `trust` (lib/hook-trust.mjs's verdict). Untrusted puts the block in the file Codex reads and takes
 * it out of the other; trusted or disabled takes it out of both.
 *
 * Returns `{ action }`: 'added' | 'updated' | 'removed' | 'none' | 'busy' | 'error'. Never throws:
 * every caller is a status path or the MCP bridge, and a reminder that cannot be written must not
 * cost either one its answer. No write at all when nothing changes, so a healthy machine's files
 * keep their bytes and their mtimes.
 */
export function syncTrustNotice(trust, deps = {}) {
  const verdict = trust ? trust.verdict : null;
  if (verdict !== TrustVerdict.UNTRUSTED && verdict !== TrustVerdict.TRUSTED && verdict !== TrustVerdict.DISABLED) {
    return { action: 'none' };
  }
  try {
    const file = deps.agentsFile || codexAgentsFile();
    const override = path.join(path.dirname(file), OVERRIDE_FILE);
    const serverKey = deps.serverKey || mcpServerKey();
    const { begin } = noticeMarkers(serverKey);
    const locked = withLock(agentsLockTarget(file), {}, () => {
      const texts = { [file]: readOrNull(file), [override]: readOrNull(override) };
      const home = texts[override] !== null ? override : file;
      let action = 'none';
      [file, override].forEach((target) => {
        const current = texts[target];
        const wanted = verdict === TrustVerdict.UNTRUSTED && target === home ? TrustVerdict.UNTRUSTED : TrustVerdict.TRUSTED;
        const next = applyNotice(current, serverKey, wanted);
        if (next === null) return;
        writeOrDelete(target, next);
        if (wanted === TrustVerdict.UNTRUSTED) action = current !== null && current.indexOf(begin) !== -1 ? 'updated' : 'added';
        else if (action === 'none') action = 'removed';
      });
      return action;
    });
    if (!locked.ok) return { action: 'busy' };
    return { action: locked.value };
  } catch {
    return { action: 'error' };
  }
}

// Take our block out whatever the verdict — for `hooks.mjs uninstall`, which leaves no hooks to
// trust. Same return shape as syncTrustNotice; never throws.
export function removeTrustNotice(deps = {}) {
  return syncTrustNotice({ verdict: TrustVerdict.DISABLED }, deps);
}
