import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getJson, postJson } from '../lib/http.mjs';

const manifestPath = fileURLToPath(new URL('../.codex-plugin/plugin.json', import.meta.url));
let moduleId = 0;

async function withManifest(t, contents) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...args) {
    if (file === manifestPath) {
      reads++;
      if (contents === undefined) throw new Error('manifest unavailable');
      return contents;
    }
    return original.call(this, file, ...args);
  };
  t.after(() => { fs.readFileSync = original; });
  const { machineHeaders } = await import(`../lib/machine-identity.mjs?version-test=${moduleId++}`);
  return { machineHeaders, reads: () => reads };
}

test('version header uses the installed build version and caches it across accounts', async (t) => {
  const { machineHeaders, reads } = await withManifest(t, '{"version":"0.14.2-staging.5358"}');
  for (const clientId of ['client-a', 'client-b']) {
    const headers = machineHeaders(clientId);
    assert.equal(headers['X-Beezi-Plugin-Version'], '0.14.2-staging.5358');
    assert.equal(headers['X-Beezi-Client'], clientId);
  }
  assert.equal(reads(), 1);
});

test('version header is limited to 255 characters', async (t) => {
  const { machineHeaders } = await withManifest(t, JSON.stringify({ version: 'v'.repeat(300) }));
  assert.equal(machineHeaders()['X-Beezi-Plugin-Version'], 'v'.repeat(255));
});

for (const contents of [undefined, '{', 'null', '{}', '{"version":42}', '{"version":""}']) {
  test(`unavailable version is omitted and cached: ${contents}`, async (t) => {
    const { machineHeaders, reads } = await withManifest(t, contents);
    for (let i = 0; i < 2; i++) {
      assert.equal(Object.hasOwn(machineHeaders(), 'X-Beezi-Plugin-Version'), false);
    }
    assert.equal(reads(), 1);
  });
}

test('API GET and POST send the installed plugin version', async () => {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
  const seen = [];
  const deps = { fetchImpl: async (_url, options) => { seen.push(options.headers); return { ok: true }; } };
  const session = { token: 'token', clientId: 'client' };
  await getJson('https://api.test/thing', session, deps);
  await postJson('https://api.test/thing', session, {}, deps);
  assert.equal(seen.length, 2);
  for (const headers of seen) assert.equal(headers['X-Beezi-Plugin-Version'], expected);
});
