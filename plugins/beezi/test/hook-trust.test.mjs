import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TrustVerdict,
  classifyHooks,
  expectedHookCommands,
  mcpServerKey,
  probeHookTrust,
  readCachedVerdict,
  writeCachedVerdict,
} from '../lib/hook-trust.mjs';
import { buildHookEntries } from '../lib/hooks-install.mjs';

// Codex answers trust through `hooks/list` only (lib/codex-app-server.mjs). These tests drive the
// verdict from hand-built rows in the measured shape, so nothing here spawns Codex.

const LAUNCHER_DIR = '/fake/.beezi-codex/hooks';
const EXPECTED = expectedHookCommands({ launcherDir: LAUNCHER_DIR, owner: 'beezi' });

function row(command, trustStatus = 'trusted', extra = {}) {
  return { command, eventName: 'stop', enabled: true, trustStatus, ...extra };
}

function allRows(trustStatus = 'trusted') {
  return EXPECTED.map((command, index) => row(command, trustStatus, { eventName: `event${index}` }));
}

test('expectedHookCommands — every command buildHookEntries writes for this owner, and only those', () => {
  const entries = buildHookEntries({ launcherDir: LAUNCHER_DIR, owner: 'beezi' });
  const commands = [];
  Object.keys(entries).forEach((event) => entries[event].forEach((group) => {
    group.hooks.forEach((hook) => commands.push(hook.command));
  }));
  assert.deepEqual(EXPECTED.slice().sort(), commands.sort());
  const staging = expectedHookCommands({ launcherDir: LAUNCHER_DIR, owner: 'beezi-staging' });
  assert.equal(staging.some((command) => EXPECTED.indexOf(command) !== -1), false);
});

test('classifyHooks — every expected entry registered, enabled and trusted is TRUSTED', () => {
  const result = classifyHooks(allRows(), EXPECTED);
  assert.equal(result.verdict, TrustVerdict.TRUSTED);
  assert.deepEqual(result.untrusted, []);
});

test('classifyHooks — one untrusted entry makes the whole install UNTRUSTED and names its event', () => {
  const rows = allRows();
  rows[1] = { ...rows[1], trustStatus: 'untrusted' };
  const result = classifyHooks(rows, EXPECTED);
  assert.equal(result.verdict, TrustVerdict.UNTRUSTED);
  assert.deepEqual(result.untrusted, ['event1']);
});

test('classifyHooks — any status other than trusted counts as not trusted', () => {
  const rows = allRows();
  rows[0] = { ...rows[0], trustStatus: 'modified' };
  assert.equal(classifyHooks(rows, EXPECTED).verdict, TrustVerdict.UNTRUSTED);
});

test('classifyHooks — a disabled entry is DISABLED, not a reason to nag', () => {
  const rows = allRows();
  rows[2] = { ...rows[2], enabled: false, trustStatus: 'untrusted' };
  const result = classifyHooks(rows, EXPECTED);
  assert.equal(result.verdict, TrustVerdict.DISABLED);
  assert.deepEqual(result.disabled, ['event2']);
  assert.deepEqual(result.untrusted, []);
});

test('classifyHooks — untrusted outranks disabled', () => {
  const rows = allRows();
  rows[0] = { ...rows[0], enabled: false };
  rows[1] = { ...rows[1], trustStatus: 'untrusted' };
  assert.equal(classifyHooks(rows, EXPECTED).verdict, TrustVerdict.UNTRUSTED);
});

test('classifyHooks — an expected entry Codex has not registered is UNKNOWN', () => {
  assert.equal(classifyHooks(allRows().slice(1), EXPECTED).verdict, TrustVerdict.UNKNOWN);
});

test('classifyHooks — a build that reports no trustStatus is UNKNOWN, never UNTRUSTED', () => {
  const unreported = allRows().map(({ trustStatus, ...rest }) => rest);
  assert.equal(classifyHooks(unreported, EXPECTED).verdict, TrustVerdict.UNKNOWN);
});

test('classifyHooks — another owner\'s untrusted entries are ignored', () => {
  const staging = expectedHookCommands({ launcherDir: LAUNCHER_DIR, owner: 'beezi-staging' });
  const rows = allRows().concat(staging.map((command) => row(command, 'untrusted')));
  assert.equal(classifyHooks(rows, EXPECTED).verdict, TrustVerdict.TRUSTED);
});

// ── the cache ────────────────────────────────────────────────────────────────────────────────

function bench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-trust-'));
  const hooksFile = path.join(root, 'codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, '{"hooks":{}}');
  return { root, hooksFile, cacheFile: path.join(root, 'data', 'hook-trust.json') };
}

const UNTRUSTED_RESULT = { verdict: TrustVerdict.UNTRUSTED, untrusted: ['stop'], disabled: [] };

test('cache — a written verdict reads back while hooks.json is unchanged', () => {
  const b = bench();
  writeCachedVerdict(UNTRUSTED_RESULT, b);
  const cached = readCachedVerdict(b);
  assert.equal(cached.verdict, TrustVerdict.UNTRUSTED);
  assert.deepEqual(cached.untrusted, ['stop']);
});

test('cache — goes stale the moment hooks.json changes', () => {
  const b = bench();
  writeCachedVerdict(UNTRUSTED_RESULT, b);
  fs.writeFileSync(b.hooksFile, '{"hooks":{"Stop":[]}}');
  assert.equal(readCachedVerdict(b), null);
});

test('cache — a config.toml change does not touch it (Codex rewrites that file for unrelated reasons)', () => {
  const b = bench();
  writeCachedVerdict(UNTRUSTED_RESULT, b);
  fs.writeFileSync(path.join(path.dirname(b.hooksFile), 'config.toml'), 'model = "x"\n');
  assert.equal(readCachedVerdict(b).verdict, TrustVerdict.UNTRUSTED);
});

test('cache — a corrupt or missing file reads as no cache', () => {
  const b = bench();
  assert.equal(readCachedVerdict(b), null);
  fs.mkdirSync(path.dirname(b.cacheFile), { recursive: true });
  fs.writeFileSync(b.cacheFile, '{not json');
  assert.equal(readCachedVerdict(b), null);
});

test('cache — UNKNOWN is never written over a verdict that was actually measured', () => {
  const b = bench();
  writeCachedVerdict(UNTRUSTED_RESULT, b);
  writeCachedVerdict({ verdict: TrustVerdict.UNKNOWN, untrusted: [], disabled: [] }, b);
  assert.equal(readCachedVerdict(b).verdict, TrustVerdict.UNTRUSTED);
});

// ── the probe ────────────────────────────────────────────────────────────────────────────────

function probeDeps(b, listResult) {
  const calls = [];
  return {
    calls,
    deps: {
      ...b,
      expected: EXPECTED,
      listHooks: () => { calls.push(1); return Promise.resolve(listResult); },
    },
  };
}

test('probeHookTrust — classifies the live answer and caches it', async () => {
  const b = bench();
  const rows = allRows();
  rows[0] = { ...rows[0], trustStatus: 'untrusted' };
  const { deps } = probeDeps(b, { ok: true, reason: 'ok', hooks: rows });
  const result = await probeHookTrust(deps);
  assert.equal(result.verdict, TrustVerdict.UNTRUSTED);
  assert.equal(readCachedVerdict(b).verdict, TrustVerdict.UNTRUSTED);
});

test('probeHookTrust — a failed app-server read is UNKNOWN and carries the reason', async () => {
  const b = bench();
  const { deps } = probeDeps(b, { ok: false, reason: 'unavailable', hooks: [] });
  const result = await probeHookTrust(deps);
  assert.equal(result.verdict, TrustVerdict.UNKNOWN);
  assert.equal(result.reason, 'unavailable');
});

test('probeHookTrust — a reader that throws is UNKNOWN, never a rejection', async () => {
  const b = bench();
  const result = await probeHookTrust({ ...b, expected: EXPECTED, listHooks: () => { throw new Error('boom'); } });
  assert.equal(result.verdict, TrustVerdict.UNKNOWN);
});

test('mcpServerKey — the .mcp.json key make-variant.sh writes for this owner', () => {
  assert.equal(mcpServerKey('beezi'), 'beezi');
  assert.equal(mcpServerKey('beezi-staging'), 'beezi_staging');
  assert.equal(mcpServerKey('beezi-dev'), 'beezi_dev');
});

test('cache — a TRUSTED verdict expires after a day, so trust lost via config.toml is noticed', () => {
  // Only hooks.json stamps the cache, and a trusted cache skips the probe. Without an age limit a
  // user who untrusts in /hooks (or a Codex upgrade that changes the hash) would never be re-checked.
  const b = bench();
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  writeCachedVerdict({ verdict: TrustVerdict.TRUSTED, untrusted: [], disabled: [] }, { ...b, now: () => t0 });
  assert.equal(readCachedVerdict({ ...b, now: () => t0 + DAY - 1 }).verdict, TrustVerdict.TRUSTED);
  assert.equal(readCachedVerdict({ ...b, now: () => t0 + DAY + 1 }), null);
});

test('cache — an UNTRUSTED verdict does not expire (the probe runs every session anyway)', () => {
  const b = bench();
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  writeCachedVerdict(UNTRUSTED_RESULT, { ...b, now: () => t0 });
  assert.equal(readCachedVerdict({ ...b, now: () => t0 + 30 * 24 * 60 * 60 * 1000 }).verdict, TrustVerdict.UNTRUSTED);
});
