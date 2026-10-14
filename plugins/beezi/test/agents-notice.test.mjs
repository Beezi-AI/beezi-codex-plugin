import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentsLockTarget, applyNotice, noticeMarkers, removeTrustNotice, syncTrustNotice } from '../lib/agents-notice.mjs';
import { TrustVerdict } from '../lib/hook-trust.mjs';

// The trust reminder lives in ~/.codex/AGENTS.md because that is the channel MEASURED to reach the
// model (2026-10-05, codex-cli 0.160.0): MCP `initialize.instructions` are dropped and MCP tool
// descriptions are deferred behind tool_search. AGENTS.md is the USER'S file, so every test here
// is about touching only our own marked block.

const USER = '# My rules\n\nAlways write tests.\n';
const { begin, end } = noticeMarkers('beezi');

function blockOf(text) {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  return from === -1 ? null : text.slice(from, to + end.length);
}

test('applyNotice — untrusted on a missing file writes just our block', () => {
  const out = applyNotice(null, 'beezi', TrustVerdict.UNTRUSTED);
  assert.ok(out.startsWith(begin), out);
  assert.ok(out.endsWith(`${end}\n`), out);
  assert.match(out, /\/hooks/);
});

test('applyNotice — untrusted appends after the user\'s content, which stays byte-identical', () => {
  const out = applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED);
  assert.ok(out.startsWith(`${USER}\n${begin}`), out);
});

test('applyNotice — untrusted with the same block already present is no change', () => {
  const once = applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(applyNotice(once, 'beezi', TrustVerdict.UNTRUSTED), null);
});

test('applyNotice — an outdated block is replaced in place, not duplicated', () => {
  const stale = `${USER}\n${begin}\nold wording\n${end}\n\n# Later user section\n`;
  const out = applyNotice(stale, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(out.split(begin).length, 2, 'exactly one block');
  assert.doesNotMatch(out, /old wording/);
  assert.match(out, /# Later user section/);
});

test('applyNotice — trusted removes our block and restores the user\'s file exactly', () => {
  const withBlock = applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(applyNotice(withBlock, 'beezi', TrustVerdict.TRUSTED), USER);
});

test('applyNotice — a block between user sections comes out cleanly', () => {
  const sandwich = `# A\n\n${begin}\nreminder\n${end}\n\n# B\n`;
  assert.equal(applyNotice(sandwich, 'beezi', TrustVerdict.TRUSTED), '# A\n\n# B\n');
});

test('applyNotice — disabled removes too: switching hooks off is the user\'s choice', () => {
  const withBlock = applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(applyNotice(withBlock, 'beezi', TrustVerdict.DISABLED), USER);
});

test('applyNotice — trusted with no block, and unknown with anything, change nothing', () => {
  assert.equal(applyNotice(USER, 'beezi', TrustVerdict.TRUSTED), null);
  assert.equal(applyNotice(null, 'beezi', TrustVerdict.TRUSTED), null);
  const withBlock = applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(applyNotice(withBlock, 'beezi', TrustVerdict.UNKNOWN), null);
});

test('applyNotice — removing the only content leaves an empty file, which sync deletes', () => {
  const only = applyNotice(null, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(applyNotice(only, 'beezi', TrustVerdict.TRUSTED), '');
});

test('applyNotice — another variant\'s block is never touched', () => {
  const staging = applyNotice(USER, 'beezi_staging', TrustVerdict.UNTRUSTED);
  const both = applyNotice(staging, 'beezi', TrustVerdict.UNTRUSTED);
  const back = applyNotice(both, 'beezi', TrustVerdict.TRUSTED);
  assert.equal(back, staging);
  assert.ok(blockOf(both) !== null);
});

test('applyNotice — a CRLF file keeps CRLF, block included', () => {
  const crlf = USER.replace(/\n/g, '\r\n');
  const out = applyNotice(crlf, 'beezi', TrustVerdict.UNTRUSTED);
  assert.equal(/[^\r]\n/.test(out), false, 'no bare LF');
  assert.equal(applyNotice(out, 'beezi', TrustVerdict.TRUSTED), crlf);
});

test('applyNotice — the block names its own server so the model calls the right status tool', () => {
  const out = applyNotice(null, 'beezi_staging', TrustVerdict.UNTRUSTED);
  assert.match(out, /mcp__beezi_staging__beezi_status/);
});

// ── the file ─────────────────────────────────────────────────────────────────────────────────

function bench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-agents-'));
  return { agentsFile: path.join(root, 'codex', 'AGENTS.md'), serverKey: 'beezi' };
}

test('syncTrustNotice — writes the block, then removes it and the file it created', () => {
  const b = bench();
  assert.equal(syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b).action, 'added');
  assert.match(fs.readFileSync(b.agentsFile, 'utf8'), /beezi_status/);
  assert.equal(syncTrustNotice({ verdict: TrustVerdict.TRUSTED }, b).action, 'removed');
  assert.equal(fs.existsSync(b.agentsFile), false);
});

test('syncTrustNotice — re-adds the block when the hooks become untrusted again', () => {
  const b = bench();
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  syncTrustNotice({ verdict: TrustVerdict.TRUSTED }, b);
  assert.equal(syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b).action, 'added');
  assert.match(fs.readFileSync(b.agentsFile, 'utf8'), /beezi_status/);
});

test('syncTrustNotice — a user file is kept when our block leaves', () => {
  const b = bench();
  fs.mkdirSync(path.dirname(b.agentsFile), { recursive: true });
  fs.writeFileSync(b.agentsFile, USER);
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  syncTrustNotice({ verdict: TrustVerdict.TRUSTED }, b);
  assert.equal(fs.readFileSync(b.agentsFile, 'utf8'), USER);
});

test('syncTrustNotice — nothing to change means no write at all', () => {
  const b = bench();
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  const before = fs.statSync(b.agentsFile).mtimeMs;
  const result = syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  assert.equal(result.action, 'none');
  assert.equal(fs.statSync(b.agentsFile).mtimeMs, before);
});

test('syncTrustNotice — never throws, even when the file cannot be written', () => {
  const b = bench();
  // A directory where the file should be: every read and write fails.
  fs.mkdirSync(b.agentsFile, { recursive: true });
  assert.equal(syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b).action, 'error');
});

test('syncTrustNotice — no verdict, or unknown, does nothing', () => {
  const b = bench();
  assert.equal(syncTrustNotice(null, b).action, 'none');
  assert.equal(syncTrustNotice({ verdict: TrustVerdict.UNKNOWN }, b).action, 'none');
  assert.equal(fs.existsSync(b.agentsFile), false);
});

test('removeTrustNotice — uninstalling the hooks takes the reminder out too', () => {
  // `hooks.mjs uninstall` leaves nothing to trust; a block left behind would nag about hooks that
  // no longer exist.
  const b = bench();
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  assert.equal(removeTrustNotice(b).action, 'removed');
  assert.equal(fs.existsSync(b.agentsFile), false);
  assert.equal(removeTrustNotice(b).action, 'none');
});

// Codex 0.160 reads ~/.codex/AGENTS.override.md INSTEAD of AGENTS.md when it exists (binary:
// codex-home/src/instructions — "AGENTS.override.md", then "AGENTS.md"). A block in the file Codex
// skips would never be seen.
test('syncTrustNotice — with an AGENTS.override.md present, the block goes there', () => {
  const b = bench();
  const override = path.join(path.dirname(b.agentsFile), 'AGENTS.override.md');
  fs.mkdirSync(path.dirname(b.agentsFile), { recursive: true });
  fs.writeFileSync(override, USER);
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  assert.match(fs.readFileSync(override, 'utf8'), /beezi_status/);
  assert.equal(fs.existsSync(b.agentsFile), false);
});

test('syncTrustNotice — trusted clears the block from both files, wherever it landed', () => {
  const b = bench();
  const override = path.join(path.dirname(b.agentsFile), 'AGENTS.override.md');
  syncTrustNotice({ verdict: TrustVerdict.UNTRUSTED }, b);
  fs.writeFileSync(override, applyNotice(USER, 'beezi', TrustVerdict.UNTRUSTED));
  syncTrustNotice({ verdict: TrustVerdict.TRUSTED }, b);
  assert.equal(fs.existsSync(b.agentsFile), false);
  assert.equal(fs.readFileSync(override, 'utf8'), USER);
});

test('agentsLockTarget — the lock sits beside AGENTS.md, so every variant takes the same one', () => {
  // A lock under each variant's own data root would not serialize `beezi` against `beezi-staging`,
  // and both bridges start — and sync — at the same moment every session.
  const b = bench();
  assert.equal(path.dirname(agentsLockTarget(b.agentsFile).file), path.dirname(b.agentsFile));
});
