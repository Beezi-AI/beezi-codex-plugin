import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// G-1-7 — the Codex-shaped marketplace upsert that scripts/sync-to-github.sh runs in variant-merge
// mode. The regression that matters is the LAST one: beezi-dev and beezi-staging build from
// different branches into one internal repo, so a publish that rewrites the whole listing rather
// than one entry silently unpublishes the sibling.
//
// THE SHIPPED HEREDOC IS WHAT RUNS HERE, sliced straight out of the .sh between its sentinels.
// A copy of the script pasted into this file could pass forever while the shipped one was broken.
// It is executed in-process through `vm` rather than spawned: tools/hermetic-env.mjs records every
// child_process call as a hermeticity violation, and a subprocess here would fail the whole file.

const repoRoot = path.dirname(path.dirname(path.dirname(
  path.dirname(url.fileURLToPath(import.meta.url)),
)));
const SYNC_SCRIPT = path.join(repoRoot, 'scripts', 'sync-to-github.sh');
const require_ = createRequire(import.meta.url);

// The generated variant manifest make-variant.sh produces. Only `name` is read by the upsert.
const VARIANT_PLUGIN = {
  name: 'beezi-staging',
  version: '0.7.0-staging.4242',
  description: 'Beezi — staging environment build.',
  interface: { displayName: 'Beezi (staging)' },
};

// This repo's own .agents/plugins/marketplace.json — the shape the upsert lifts policy/category off.
const SOURCE_MARKETPLACE = {
  name: 'beezi',
  interface: { displayName: 'Beezi' },
  plugins: [
    {
      name: 'beezi',
      source: { source: 'local', path: './plugins/beezi' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ],
};

function upsertScript() {
  const text = fs.readFileSync(SYNC_SCRIPT, 'utf-8');
  const start = text.indexOf("<<'UPSERT_NODE'\n");
  assert.notEqual(start, -1, 'sync-to-github.sh no longer has an UPSERT_NODE heredoc');
  const bodyStart = start + "<<'UPSERT_NODE'\n".length;
  const end = text.indexOf('\nUPSERT_NODE\n', bodyStart);
  assert.notEqual(end, -1, 'the UPSERT_NODE heredoc is not terminated');
  return text.slice(bodyStart, end);
}

class Exit extends Error {}

// Run the shipped heredoc with `argv` as its arguments, returning what it wrote and how it exited.
function runUpsert(args) {
  let out = '';
  const errors = [];
  let code = 0;
  const fakeProcess = {
    argv: ['node', '-', ...args],
    stdout: { write: (chunk) => { out += chunk; } },
    exit: (status) => { code = status; throw new Exit(String(status)); },
  };
  const context = vm.createContext({
    require: require_,
    process: fakeProcess,
    console: { error: (message) => errors.push(String(message)), log: () => {} },
    Buffer,
    URL,
  });
  try {
    vm.runInContext(upsertScript(), context, { filename: 'sync-to-github.sh:UPSERT_NODE' });
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
  }
  return { out, errors, code };
}

function bench(t, { published, source = SOURCE_MARKETPLACE, plugin = VARIANT_PLUGIN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-upsert-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const existingFile = path.join(dir, 'existing.json');
  // An empty internal repo has no published marketplace at all: the shell leaves the file absent.
  if (published !== undefined) fs.writeFileSync(existingFile, JSON.stringify(published, null, 2));
  const sourceFile = path.join(dir, 'source.json');
  fs.writeFileSync(sourceFile, JSON.stringify(source, null, 2));
  const pluginFile = path.join(dir, 'plugin.json');
  fs.writeFileSync(pluginFile, JSON.stringify(plugin, null, 2));
  return [existingFile, sourceFile, pluginFile, 'beezi-internal', 'Beezi (internal)', 'beezi'];
}

test('an empty internal repo bootstraps a Codex-shaped marketplace', (t) => {
  const res = runUpsert(bench(t));
  assert.equal(res.code, 0, res.errors.join('\n'));
  const doc = JSON.parse(res.out);

  // Codex's top level is { name, interface: { displayName } } — Claude's owner/description shape
  // would be rejected here, which is why the upsert could not be ported verbatim.
  assert.equal(doc.name, 'beezi-internal', 'must differ from the public "beezi" marketplace name');
  assert.deepEqual(doc.interface, { displayName: 'Beezi (internal)' });
  assert.ok(!('owner' in doc) && !('description' in doc), 'those are the Claude-side keys');
  assert.deepEqual(doc.plugins, [{
    name: 'beezi-staging',
    source: { source: 'local', path: './plugins/beezi-staging' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }]);
  assert.ok(res.out.endsWith('}\n'), 'stable serialisation — an unstable one pushes a no-op build');
});

test('policy and category are copied from the source entry, never hardcoded', (t) => {
  const source = {
    name: 'beezi',
    interface: { displayName: 'Beezi' },
    plugins: [{
      name: 'beezi',
      source: { source: 'local', path: './plugins/beezi', extraKey: 'kept' },
      policy: { installation: 'REQUIRED', authentication: 'NEVER' },
      category: 'Engineering',
    }],
  };
  const doc = JSON.parse(runUpsert(bench(t, { source })).out);
  const entry = doc.plugins[0];
  assert.deepEqual(entry.policy, { installation: 'REQUIRED', authentication: 'NEVER' });
  assert.equal(entry.category, 'Engineering');
  // Only `path` is ours; anything else the source's `source` object carries survives the copy.
  assert.deepEqual(entry.source, { source: 'local', path: './plugins/beezi-staging', extraKey: 'kept' });
});

test('the entry carries no `version` — R1 forbids the unvalidated schema extension', (t) => {
  const doc = JSON.parse(runUpsert(bench(t)).out);
  assert.ok(!('version' in doc.plugins[0]),
    'the plugin has a version, but Codex’s marketplace schema has no field for it; '
    + 'the update check reads env.json.updateManifestUrl instead (G-8-4)');
});

test('an existing entry for the same variant is replaced in place, not appended', (t) => {
  const published = {
    name: 'beezi-internal',
    interface: { displayName: 'Beezi (internal)' },
    plugins: [{
      name: 'beezi-staging',
      source: { source: 'local', path: './plugins/beezi-staging' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
      publishedBy: 'build-41',
    }],
  };
  const doc = JSON.parse(runUpsert(bench(t, { published })).out);
  assert.equal(doc.plugins.length, 1, 'replaced, not appended');
  assert.equal(doc.plugins[0].publishedBy, 'build-41',
    'keys a previous publish put on the entry survive the merge');
});

test("a sibling variant's entry survives — the regression that matters", (t) => {
  // beezi-dev was published from the `development` branch. Publishing beezi-staging from
  // `staging` must not unpublish it: a snapshot from either branch would, which is the whole
  // reason variant mode is a merge.
  const dev = {
    name: 'beezi-dev',
    source: { source: 'local', path: './plugins/beezi-dev' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  const published = {
    name: 'beezi-internal',
    interface: { displayName: 'Beezi (internal)' },
    plugins: [dev],
    someKeyWeDidNotWrite: true,
  };

  const doc = JSON.parse(runUpsert(bench(t, { published })).out);

  assert.deepEqual(doc.plugins.map((p) => p.name), ['beezi-dev', 'beezi-staging']);
  assert.deepEqual(doc.plugins[0], dev, 'byte for byte, in its original position');
  assert.equal(doc.someKeyWeDidNotWrite, true, 'unknown top-level keys are preserved too');

  // And back the other way: re-publishing beezi-dev leaves beezi-staging alone.
  const back = JSON.parse(runUpsert(bench(t, {
    published: doc,
    plugin: { name: 'beezi-dev', version: '0.7.0-dev.99' },
  })).out);
  assert.deepEqual(back.plugins.map((p) => p.name), ['beezi-dev', 'beezi-staging']);
  assert.equal(back.plugins[1].source.path, './plugins/beezi-staging');
});

test('beezi-local joins dev and staging rather than displacing either', (t) => {
  // The dev pipeline step publishes beezi-dev and then beezi-local in ONE job, back to back
  // against the same branch. The second run re-fetches the tip the first just pushed, so the
  // listing it upserts into already holds beezi-dev - and a staging publish from another branch
  // may have left its own entry there too. Three entries is therefore the real steady state, not
  // the pair the fixtures above assume.
  const dev = {
    name: 'beezi-dev',
    source: { source: 'local', path: './plugins/beezi-dev' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  const staging = Object.assign({}, dev, {
    name: 'beezi-staging',
    source: { source: 'local', path: './plugins/beezi-staging' },
  });
  const published = {
    name: 'beezi-internal',
    interface: { displayName: 'Beezi (internal)' },
    plugins: [dev, staging],
  };

  const doc = JSON.parse(runUpsert(bench(t, {
    published,
    plugin: { name: 'beezi-local', version: '0.7.0-local.4242' },
  })).out);

  assert.deepEqual(doc.plugins.map((p) => p.name), ['beezi-dev', 'beezi-staging', 'beezi-local']);
  assert.deepEqual(doc.plugins[0], dev, 'the entry published seconds earlier is untouched');
  assert.deepEqual(doc.plugins[1], staging);
  assert.equal(doc.plugins[2].source.path, './plugins/beezi-local');
});

test('a source marketplace with no beezi entry aborts rather than guessing', (t) => {
  const source = { name: 'beezi', interface: { displayName: 'Beezi' }, plugins: [] };
  const res = runUpsert(bench(t, { source }));
  assert.equal(res.code, 1);
  assert.match(res.errors.join('\n'), /no "beezi" entry/);
  assert.equal(res.out, '', 'nothing is written on the failure path');
});

test('a published marketplace whose shape we do not recognise is refused, not overwritten', (t) => {
  const res = runUpsert(bench(t, { published: { name: 'beezi-internal', plugins: 'not an array' } }));
  assert.equal(res.code, 1);
  assert.match(res.errors.join('\n'), /no "plugins" array - refusing to overwrite/);
  assert.equal(res.out, '');
});

test('an unparseable published marketplace bootstraps, because a missing file reads the same way', (t) => {
  const args = bench(t);
  fs.writeFileSync(args[0], '{ not json');
  const doc = JSON.parse(runUpsert(args).out);
  assert.equal(doc.name, 'beezi-internal');
  assert.deepEqual(doc.plugins.map((p) => p.name), ['beezi-staging']);
});

test('the shell passes the upsert exactly the arguments it reads', () => {
  // The two halves of this module live in different languages in one file; nothing else checks
  // that the shell's call site and the script's destructuring still line up.
  const text = fs.readFileSync(SYNC_SCRIPT, 'utf-8');
  assert.match(text, /"\$existing_marketplace" "\$source_marketplace" \\\n\s+"\$staging\/plugins\/\$variant_name\/\.codex-plugin\/plugin\.json" \\\n\s+"\$INTERNAL_MARKETPLACE_NAME" "\$INTERNAL_MARKETPLACE_DISPLAY_NAME" "\$SOURCE_PLUGIN_NAME"/);
  assert.match(upsertScript(), /existingFile, sourceFile, variantPluginJson, marketplaceName, marketplaceDisplayName, sourcePluginName,/);
  // Codex marketplaces live under .agents/plugins/; Claude's under .claude-plugin/. Getting this
  // wrong publishes a manifest no Codex install would ever find.
  assert.match(text, /MARKETPLACE_PATH="\.agents\/plugins\/marketplace\.json"/);
  // The only surviving mention of Claude's path is the comment that warns about this exact
  // confusion; nothing in the upsert or the tree surgery may reach for it.
  assert.ok(!upsertScript().includes('.claude-plugin'), 'no Claude-side path survived the port');
  for (const line of text.split('\n')) {
    if (line.includes('.claude-plugin')) {
      assert.match(line.trim(), /^#/, `.claude-plugin appears in executable shell: ${line.trim()}`);
    }
  }
});

test('the PUBLIC snapshot is stamped with its own updateManifestUrl (G-8-4)', () => {
  // make-variant.sh only accepts dev and staging, and the checkout ships no env.json, so the
  // public build is the one build nobody stamps. Without this the stale-version check would be
  // inert for exactly the users there are most of.
  const text = fs.readFileSync(SYNC_SCRIPT, 'utf-8');
  assert.match(text, /git --work-tree="\$stamp" add -f -- "plugins\/\$SOURCE_PLUGIN_NAME\/env\.json"/);
  // The URL names the published plugin manifest, which is where a version actually lives.
  assert.match(text, /plugins\/%s\/\.codex-plugin\/plugin\.json/);
  // ONE key only: a `name` would re-namespace the data root onto a suffixed one, and an
  // `apiBase` would pin customers to a host lib/config.mjs's release default already owns.
  const stampBlock = text.slice(text.indexOf('stamp="$(mktemp -d)"'), text.indexOf('git write-tree', text.indexOf('stamp="$(mktemp -d)"')));
  assert.ok(!stampBlock.includes('"name"'), 'the public stamp must not name an environment');
  assert.ok(!stampBlock.includes('"apiBase"'), 'the public stamp must not bake an API base');
});
