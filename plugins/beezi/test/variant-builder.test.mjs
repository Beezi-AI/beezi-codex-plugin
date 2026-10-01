import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { environment } from '../lib/paths.mjs';

// G-1-7 — scripts/make-variant.sh, the per-environment variant builder.
//
// The shell wrapper is smoke-tested with a DRY_RUN build, as the plan specifies. What is asserted
// here is the part a smoke run cannot show: exactly which keys the rewrite touches, and that the
// env.json it emits is accepted by lib/paths.mjs's resolveEnvironment — the reader that IS the
// schema. Publishing a key that reader rejects would leave the variant refusing to name a root at
// all, and publishing one it ignores would drop silently.
//
// As with the marketplace upsert, THE SHIPPED HEREDOC IS WHAT RUNS: it is sliced out of the .sh
// between its sentinels and executed in-process, because tools/hermetic-env.mjs records a spawned
// child as a hermeticity violation.

const repoRoot = path.dirname(path.dirname(path.dirname(
  path.dirname(url.fileURLToPath(import.meta.url)),
)));
const BUILDER = path.join(repoRoot, 'scripts', 'make-variant.sh');
const require_ = createRequire(import.meta.url);

const PLUGIN_JSON = {
  name: 'beezi',
  version: '0.7.0',
  description: 'Reports Codex session token analytics.',
  author: { name: 'Beezi' },
  skills: './skills/',
  mcpServers: './.mcp.json',
  interface: {
    displayName: 'Beezi',
    shortDescription: 'Ticket drafting and session token analytics for Beezi',
    longDescription: 'Draft and create tickets.',
    developerName: 'Beezi',
    brandColor: '#F5C518',
  },
};

const PACKAGE_JSON = { name: 'beezi', version: '0.7.0', private: true, type: 'module' };

function builderScript() {
  const text = fs.readFileSync(BUILDER, 'utf-8');
  const start = text.indexOf("<<'VARIANT_NODE'\n");
  assert.notEqual(start, -1, 'make-variant.sh no longer has a VARIANT_NODE heredoc');
  const bodyStart = start + "<<'VARIANT_NODE'\n".length;
  const end = text.indexOf('\nVARIANT_NODE\n', bodyStart);
  assert.notEqual(end, -1, 'the VARIANT_NODE heredoc is not terminated');
  return text.slice(bodyStart, end);
}

function build(t, { env = 'staging', apiBase = 'https://beezi-api-staging.azurewebsites.net/api',
  buildId = '4242', updateManifestUrl = 'https://raw.githubusercontent.com/o/n/main/plugins/beezi-staging/.codex-plugin/plugin.json',
  plugin = PLUGIN_JSON } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-variant-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2));

  let out = '';
  const context = vm.createContext({
    require: require_,
    process: {
      argv: ['node', '-', dir, env, apiBase, buildId, updateManifestUrl],
      stdout: { write: (chunk) => { out += chunk; } },
    },
    console: { error: () => {}, log: () => {} },
    Buffer,
    URL,
  });
  vm.runInContext(builderScript(), context, { filename: 'make-variant.sh:VARIANT_NODE' });

  return {
    version: out.trim(),
    plugin: JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf-8')),
    pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')),
    envJson: JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf-8')),
  };
}

test('plugin.json is rewritten key by key, and nothing else moves', (t) => {
  const built = build(t);

  assert.equal(built.plugin.name, 'beezi-staging');
  // An ADO Build.BuildId prerelease suffix, so every internal publish reads as an update with no
  // manual version bump.
  assert.equal(built.plugin.version, '0.7.0-staging.4242');
  assert.equal(built.version, '0.7.0-staging.4242', 'the built version is reported to the shell');
  assert.match(built.plugin.description, / — staging environment build\.$/);

  // Codex-only, and absent from the Claude side entirely: without it a user with both installed
  // sees two identical "Beezi" cards and cannot tell which one is reporting where.
  assert.equal(built.plugin.interface.displayName, 'Beezi (staging)');
  assert.equal(built.plugin.interface.shortDescription,
    'Ticket drafting and session token analytics for Beezi — staging');

  // Untouched: the MCP surface and skills namespace themselves off the plugin NAME
  // (mcp__plugin_beezi-staging_beezi__*, beezi-staging:login), so nothing else needs an edit.
  assert.equal(built.plugin.mcpServers, './.mcp.json');
  assert.equal(built.plugin.skills, './skills/');
  assert.deepEqual(built.plugin.author, { name: 'Beezi' });
  assert.equal(built.plugin.interface.longDescription, 'Draft and create tickets.');
  assert.equal(built.plugin.interface.brandColor, '#F5C518');
});

test('package and plugin versions stay synchronised, and the package name does not move', (t) => {
  const built = build(t);
  assert.equal(built.pkg.version, built.plugin.version);
  // Nothing reads package.json's `name`: there are no dependencies, nothing is published to a
  // registry, and lib/diagnostics.mjs reads `version` alone. The identity Codex and users see is
  // plugin.json's `name`, so the four variants deliberately share one package identity.
  assert.equal(built.pkg.name, 'beezi');
  assert.equal(built.pkg.type, 'module', 'every other package.json key is left alone');
});

test('env.json is written WHOLESALE, from exactly the schema lib/paths.mjs validates', (t) => {
  const built = build(t);
  assert.deepEqual(Object.keys(built.envJson), ['name', 'apiBase', 'updateManifestUrl']);

  // The reader is the schema. A key it rejects would make the variant refuse to name a root at
  // all (R1: a malformed variant env.json must never fall through to production).
  const resolved = environment.resolveEnvironment({
    envJson: { present: true, value: built.envJson },
    env: {},
  });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.name, 'staging');
  assert.equal(resolved.suffix, '-staging');
  assert.equal(resolved.apiBase, 'https://beezi-api-staging.azurewebsites.net/api');
  assert.equal(resolved.updateManifestUrl,
    'https://raw.githubusercontent.com/o/n/main/plugins/beezi-staging/.codex-plugin/plugin.json');
});

test('a dev build produces the dev namespace, not a second staging one', (t) => {
  const built = build(t, { env: 'dev', apiBase: 'https://beezi-api-dev.azurewebsites.net/api', buildId: '7' });
  assert.equal(built.plugin.name, 'beezi-dev');
  assert.equal(built.plugin.version, '0.7.0-dev.7');
  assert.equal(built.plugin.interface.displayName, 'Beezi (dev)');
  assert.equal(built.envJson.name, 'dev');
  assert.equal(environment.resolveEnvironment({
    envJson: { present: true, value: built.envJson }, env: {},
  }).suffix, '-dev');
});

test('a HAND-BUILT local gets its own namespace and NO updateManifestUrl key', (t) => {
  // A local built by hand stays on the machine that built it, so there is no published copy to
  // compare itself against. The key is OMITTED rather than written empty: an empty string would
  // fail resolveEnvironment's absolute-URL check, and the variant would then refuse to name a root
  // at all. Absent is the only form the reader treats as "no update check". The dev pipeline step
  // also publishes a `local` variant, and that one DOES carry the key - the test below.
  const built = build(t, {
    env: 'local',
    apiBase: 'http://localhost:5001/api',
    buildId: '3',
    updateManifestUrl: '',
  });
  assert.equal(built.plugin.name, 'beezi-local');
  assert.equal(built.plugin.version, '0.7.0-local.3');
  assert.equal(built.plugin.interface.displayName, 'Beezi (local)');
  assert.deepEqual(Object.keys(built.envJson), ['name', 'apiBase']);

  const resolved = environment.resolveEnvironment({
    envJson: { present: true, value: built.envJson }, env: {},
  });
  assert.equal(resolved.error, undefined);
  // Its own root and its own keyring entry, so a local build cannot read or overwrite what the
  // dev variant stored - the two are as separate as dev and staging are.
  assert.equal(resolved.suffix, '-local');
  assert.equal(resolved.apiBase, 'http://localhost:5001/api');
  assert.equal(resolved.updateManifestUrl, null, "lib/update-check.mjs skips on 'no-manifest'");
});

test('a PUBLISHED local keeps its updateManifestUrl, like every other published variant', (t) => {
  // The dev pipeline step builds `local` with a real Build.BuildId and the internal repo, and
  // publishes it beside beezi-dev, so developers working on the Beezi API can install a
  // loopback-pointed plugin without building one. Once it is published it must self-update like
  // any other variant: the key has to survive into env.json and out of resolveEnvironment.
  const built = build(t, {
    env: 'local',
    apiBase: 'http://localhost:5001/api',
    buildId: '4242',
    updateManifestUrl: 'https://raw.githubusercontent.com/acme/internal/main/plugins/beezi-local/.codex-plugin/plugin.json',
  });
  assert.equal(built.plugin.version, '0.7.0-local.4242');
  assert.deepEqual(Object.keys(built.envJson), ['name', 'apiBase', 'updateManifestUrl']);

  const resolved = environment.resolveEnvironment({
    envJson: { present: true, value: built.envJson }, env: {},
  });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.suffix, '-local');
  assert.equal(
    resolved.updateManifestUrl,
    'https://raw.githubusercontent.com/acme/internal/main/plugins/beezi-local/.codex-plugin/plugin.json',
  );
});

test('a manifest with no interface block is left alone rather than crashing the build', (t) => {
  const plugin = { name: 'beezi', version: '0.7.0', description: 'x' };
  const built = build(t, { plugin });
  assert.equal(built.plugin.name, 'beezi-staging');
  assert.ok(!('interface' in built.plugin));
});

test('the shell validates its arguments before anything is copied', () => {
  const text = fs.readFileSync(BUILDER, 'utf-8');
  // Only the environments lib/paths.mjs will accept in a path or a PowerShell credential template.
  assert.match(text, /\n\s*dev\|staging\|local\) : ;;/);
  assert.deepEqual(
    environment.KNOWN_ENVIRONMENTS.filter((n) => n !== ''),
    ['dev', 'staging', 'local'],
  );
  assert.match(text, /https:\/\/\*\/api\) : ;;/, 'the api-base must be https and end in /api');
  // The plaintext exception is anchored, and it names the loopback hosts explicitly. A glob
  // (http://localhost:*/api) would also accept http://localhost:1@evil.test/api, whose host is
  // evil.test - so this assertion is what keeps the exception from widening back into one.
  assert.match(
    text,
    /\^http:\/\/\(localhost\|127\\.0\\.0\\.1\)\(:\[0-9\]\+\)\?\/api\$/,
    'the local loopback exception must stay an anchored regex',
  );
  assert.match(text, /update-repo '\$UPDATE_REPO' must be exactly owner\/name/);

  // This shell IS the record of the address a local build talks to - the dev pipeline step that
  // publishes `local` passes an EMPTY api-base precisely so the URL is not repeated in the YAML.
  // Asserted literally: a developer who has to retype the URL will sooner or later retype it
  // wrong, and nothing downstream would notice.
  assert.match(text, /^LOCAL_API_BASE="http:\/\/localhost:5001\/api"$/m);
  // `:-`, not `-`: an EMPTY api-base must fall through to LOCAL_API_BASE too, or the pipeline
  // could not pass a build-id and an update-repo positionally without also naming the URL.
  assert.match(text, /API_BASE="\$\{2:-\$LOCAL_API_BASE\}"/, 'local defaults its api-base');
  assert.match(text, /BUILD_ID="\$\{3:-0\}"/, 'a hand-built local defaults its build-id');
  // Every PUBLISHED env must still state both - a silent default there would ship a variant
  // pointed somewhere nobody chose.
  assert.match(text, /API_BASE="\$\{2:\?api-base is required\}"/);
  assert.match(text, /BUILD_ID="\$\{3:\?build-id is required\}"/);

  // Built in shell, not in the heredoc, so the one place the URL shape lives is greppable. It
  // names the published PLUGIN manifest rather than the marketplace one: marketplace.json has no
  // version field, and R1 forbids adding one to a schema Codex has not been validated against,
  // while .codex-plugin/plugin.json carries a version already. lib/update-check.mjs is the reader.
  assert.match(
    text,
    /UPDATE_MANIFEST_URL="https:\/\/raw\.githubusercontent\.com\/\$UPDATE_REPO\/main\/plugins\/beezi-\$ENV_NAME\/\.codex-plugin\/plugin\.json"/,
  );
  // The one guard kept from Claude's publish.json machinery.
  assert.match(text, /\[ -d "\$SOURCE_PLUGIN" \]/);
  // Output location is overridable so a smoke build need not leave an untracked dist/ behind.
  assert.match(text, /OUT="\$\{OUT:-dist\/variant\}"/);
});
