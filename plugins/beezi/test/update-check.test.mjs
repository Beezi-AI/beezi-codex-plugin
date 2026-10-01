import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  versionFromManifest,
  installedPlugin,
  checkForUpdate,
  updateNotice,
} from '../lib/update-check.mjs';

// G-8-4. The audit called it "blocked upstream" and half of that holds: nothing here updates
// anything. What is tested is the half that was never blocked — the plugin carries a version, and
// now something reads it, and the notice names the commands that install the newer build.
//
// The version comparison moved to lib/version-compare.mjs; its tests moved with it, to
// test/version-compare.test.mjs.

function stateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-update-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return () => path.join(dir, 'update-check.json');
}

function manifestResponse(doc, ok = true) {
  return async () => ({ ok, json: async () => doc });
}

// ── the manifest ────────────────────────────────────────────────────────────────────────────

test('manifest — a plugin manifest answers its version', () => {
  assert.equal(versionFromManifest({ name: 'beezi', version: '0.8.0' }, 'beezi'), '0.8.0');
});

test('manifest — a manifest for a SIBLING variant is not this build\'s update', () => {
  // The internal repo holds beezi-dev and beezi-staging side by side.
  assert.equal(versionFromManifest({ name: 'beezi-dev', version: '9.9.9' }, 'beezi-staging'), null);
});

test('manifest — a marketplace document answers null: its schema has no version (R1)', () => {
  const marketplace = { name: 'beezi', plugins: [{ name: 'beezi', source: { source: 'local' } }] };
  assert.equal(versionFromManifest(marketplace, 'beezi'), null);
});

test('manifest — garbage answers null', () => {
  assert.equal(versionFromManifest(null, 'beezi'), null);
  assert.equal(versionFromManifest('0.8.0', 'beezi'), null);
  assert.equal(versionFromManifest({ version: 7 }, 'beezi'), null);
});

test('the installed plugin reports this build\'s own name and version', () => {
  const me = installedPlugin();
  assert.ok(me, '.codex-plugin/plugin.json is readable from the module');
  assert.equal(me.name, 'beezi');
  assert.match(me.version, /^\d+\.\d+\.\d+/);
});

// ── the check ───────────────────────────────────────────────────────────────────────────────

test('check — a newer published version is reported, with both versions named', async (t) => {
  const result = await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: manifestResponse({ name: 'beezi', version: '0.8.0' }),
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'behind');
  assert.equal(result.current, '0.7.0');
  assert.equal(result.latest, '0.8.0');
  const notice = updateNotice(result);
  assert.ok(notice.includes('0.8.0'));
  assert.ok(notice.includes('0.7.0'));
});

test('check — the same version is silent, and so is a LOCAL build that runs ahead', async (t) => {
  const base = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    fetchImpl: manifestResponse({ name: 'beezi', version: '0.7.0' }),
  };
  const same = await checkForUpdate({ ...base, readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }), updateCheckFile: stateFile(t) });
  assert.equal(same.status, 'current');
  assert.equal(updateNotice(same), null);

  const ahead = await checkForUpdate({ ...base, readPluginJson: () => ({ name: 'beezi', version: '0.9.0' }), updateCheckFile: stateFile(t) });
  assert.equal(ahead.status, 'current');
  assert.equal(updateNotice(ahead), null);
});

test('check — a build that was never stamped makes NO request at all', async (t) => {
  let requests = 0;
  const result = await checkForUpdate({
    manifestUrl: () => null,
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; return { ok: true, json: async () => ({}) }; },
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no-manifest');
  assert.equal(requests, 0);
});

test('check — at most one request an hour, and the answer survives the quiet period', async (t) => {
  const file = stateFile(t);
  let requests = 0;
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; return { ok: true, json: async () => ({ name: 'beezi', version: '0.8.0' }) }; },
    updateCheckFile: file,
    now: () => 1_000_000,
  };
  assert.equal((await checkForUpdate(deps)).status, 'behind');
  assert.equal(requests, 1);

  // Half an hour later: no second request, and the nag still stands — the user upgrading is what
  // clears it, not the clock.
  const soon = await checkForUpdate({ ...deps, now: () => 1_000_000 + 1_800_000 });
  assert.equal(soon.status, 'behind');
  assert.equal(soon.cached, true);
  assert.equal(requests, 1);

  // Just over an hour, and it asks again. The window is one hour, not one day, because the
  // internal pipeline publishes several times a day.
  await checkForUpdate({ ...deps, now: () => 1_000_000 + 3_600_001 });
  assert.equal(requests, 2);
});

test('check — the CACHED behind answer names the plugin too, not just the versions', async (t) => {
  // Miss this branch and a reader of the result is told `undefined` is out of date for an hour.
  const file = stateFile(t);
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi-dev', version: '0.7.0' }),
    fetchImpl: manifestResponse({ name: 'beezi-dev', version: '0.8.0' }),
    updateCheckFile: file,
    now: () => 4_000_000,
  };
  const fresh = await checkForUpdate(deps);
  assert.equal(fresh.plugin, 'beezi-dev');

  const cached = await checkForUpdate({ ...deps, now: () => 4_000_000 + 60_000 });
  assert.equal(cached.cached, true);
  assert.equal(cached.plugin, 'beezi-dev');
  assert.equal(cached.current, '0.7.0');
  assert.equal(cached.latest, '0.8.0');
});

test('check — upgrading clears the remembered nag without waiting for the next check', async (t) => {
  const file = stateFile(t);
  const fetchImpl = manifestResponse({ name: 'beezi', version: '0.8.0' });
  const now = () => 2_000_000;
  assert.equal((await checkForUpdate({
    manifestUrl: () => 'https://m.test/p.json', readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl, updateCheckFile: file, now,
  })).status, 'behind');

  // Same state file, newer build installed, still inside the quiet window.
  const after = await checkForUpdate({
    manifestUrl: () => 'https://m.test/p.json', readPluginJson: () => ({ name: 'beezi', version: '0.8.0' }),
    fetchImpl, updateCheckFile: file, now: () => 2_000_000 + 60_000,
  });
  assert.equal(after.status, 'skipped');
  assert.equal(updateNotice(after), null);
});

test('check — an offline machine is silent, and does not retry every session', async (t) => {
  const file = stateFile(t);
  let requests = 0;
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; throw new Error('ENOTFOUND'); },
    updateCheckFile: file,
    now: () => 5_000_000,
  };
  const result = await checkForUpdate(deps);
  assert.equal(result.status, 'skipped');
  assert.equal(updateNotice(result), null);
  assert.equal(requests, 1);

  // The failure stamped the clock: without that, an unreachable manifest costs a request inside
  // the hook budget on every session start, forever.
  await checkForUpdate({ ...deps, now: () => 5_000_000 + 60_000 });
  assert.equal(requests, 1);
});

test('check — a non-2xx manifest is treated as no answer, not as version zero', async (t) => {
  const result = await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: manifestResponse({ message: 'Not Found' }, false),
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no-published-version');
});

test('check — every request carries an abort signal, so a hung host cannot stall the hook', async (t) => {
  let seen = null;
  await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async (_u, init) => { seen = init; return { ok: true, json: async () => ({ name: 'beezi', version: '0.7.0' }) }; },
    updateCheckFile: stateFile(t),
  });
  assert.ok(seen && seen.signal, 'no signal means no timeout');
});

test('check — a manifest the plugin cannot version does not erase the last known one', async (t) => {
  const file = stateFile(t);
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    updateCheckFile: file,
  };
  await checkForUpdate({ ...deps, fetchImpl: manifestResponse({ name: 'beezi', version: '0.8.0' }), now: () => 10_000_000 });
  // An hour later the manifest is briefly a marketplace document (a mis-stamped publish).
  const later = await checkForUpdate({
    ...deps,
    fetchImpl: manifestResponse({ plugins: [] }),
    now: () => 10_000_000 + 3_600_001,
  });
  assert.equal(later.status, 'skipped');
  const stored = JSON.parse(fs.readFileSync(file(), 'utf-8'));
  assert.equal(stored.latest, '0.8.0', 'the known version survives a bad answer');
});

// ── the command ────────────────────────────────────────────────────────────────────────────

test('notice — names the one real Codex command, with no marketplace argument', () => {
  const notice = updateNotice({ status: 'behind', current: '0.10.0', latest: '0.11.0', plugin: 'beezi-dev' });
  assert.ok(notice.includes('codex plugin marketplace upgrade`'), 'the bare form, with no name');
  // Measured: `codex plugin marketplace upgrade beezi` errors with "not configured as a Git
  // marketplace" when the name is cache-present but absent from config.toml — the exact state a
  // clone-installed build leaves. Naming a marketplace here would break the command.
  assert.ok(!/marketplace upgrade [a-z]/.test(notice), 'never names a marketplace');
  // Verified against `codex plugin --help`: that verb does not exist, and re-adding is not part
  // of the upgrade — a refreshed snapshot is what Codex picks the newer build up from.
  assert.ok(!notice.includes('codex plugin update'), 'that verb does not exist');
  assert.ok(!notice.includes('codex plugin add'), 'refreshing the marketplace is the whole upgrade');
  assert.ok(notice.includes('new Codex thread'), 'a live session keeps the old build loaded');
  assert.ok(notice.includes('0.11.0') && notice.includes('0.10.0'));
});

test('notice — states the clone caveat, because upgrade touches Git marketplaces only', () => {
  const notice = updateNotice({ status: 'behind', current: '0.10.0', latest: '0.11.0', plugin: 'beezi' });
  assert.ok(notice.includes('local clone'));
  assert.ok(notice.includes('Git'));
});

test('notice — anything but a behind result is silent', () => {
  assert.equal(updateNotice({ status: 'current', current: '0.10.0', latest: '0.10.0' }), null);
  assert.equal(updateNotice({ status: 'skipped', reason: 'no-manifest' }), null);
  assert.equal(updateNotice(null), null);
});
