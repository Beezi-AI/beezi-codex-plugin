// The hermeticity preload MUST be the first import in this file.
//
// `BEEZI_ENV` is consumed at MODULE LOAD (paths.mjs freezes the resolved environment, and
// credentials.mjs interpolates the suffixed SERVICE into its PowerShell templates from it), so a
// `withEnv` call inside a test body is far too late. On a developer machine that exports
// BEEZI_ENV, every assertion below would silently exercise a suffixed namespace and pass for the
// wrong reason — the same class of defect as the tests that only passed because their author was
// signed in. `SCRUBBED_ENV_KEYS` in tools/hermetic-env.mjs already deletes BEEZI_ENV; importing
// it here buys that under a bare `node --test` too, not only under `npm test`.
import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beeziCodexHome,
  queueDir,
  stateDir,
  repoMapFile,
  credentialsFile,
  legacyCredentialsFile,
  billingConfigFile,
  hookLauncherDir,
  codexHome,
  codexSessionsDir,
  KNOWN_ENVIRONMENTS,
  environment,
  BEEZI_ENV,
  ENV_API_BASE,
} from '../lib/paths.mjs';

// The reader is grouped under one export because lib/paths.mjs's FUNCTION exports are, by
// test/hermetic.test.mjs's L2 contract, path accessors that must resolve inside the sandbox.
const { readEnvJson, resolveEnvironment, environmentError, envSuffix } = environment;

// Swap an env var for one test and put it back, whether or not it was set.
function withEnv(t, name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

// Write an env.json fixture into a temp dir and hand back its path. Deliberately NOT
// plugins/beezi/env.json: a stray file there re-namespaces the whole suite, and a crashed test
// would leave one behind. readEnvJson() takes the path for exactly this reason.
function envJsonFixture(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-envjson-'));
  const file = path.join(dir, 'env.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

// The per-account stores need a key, so the sweep supplies one — skipping them would quietly
// shrink the surface these two regression locks cover, and an account directory that escaped the
// data root would be exactly as damaging as a root-level file that did.
const PROBE_KEY = '0123abcd';

const everyStore = () => [
  beeziCodexHome(),
  queueDir(PROBE_KEY),
  stateDir(),
  repoMapFile(),
  credentialsFile(PROBE_KEY),
  legacyCredentialsFile(),
  billingConfigFile(),
  hookLauncherDir(),
];

// ── the unsuffixed default is unchanged ───────────────────────────────────────────────────────
// These four are the "production is untouched" regression lock. paths.mjs is imported by nearly
// everything, so a behaviour change here with no environment set is a bug, not a feature.

test('the data root is this agent\'s own, not the shared ~/.beezi', (t) => {
  withEnv(t, 'BEEZI_CODEX_HOME', undefined);
  assert.equal(beeziCodexHome(), path.join(os.homedir(), '.beezi-codex'));
});

test('no store lands inside the Claude Code plugin\'s ~/.beezi', (t) => {
  // The two plugins write the same filenames — queue/, state/, billing.json, repo-map.json,
  // credentials.json. Sharing a root means one agent's queued segments flushed under the other's
  // identity, and whichever captured a plan last winning billing.json for both.
  withEnv(t, 'BEEZI_CODEX_HOME', undefined);
  const shared = path.join(os.homedir(), '.beezi');
  for (const p of everyStore()) {
    assert.ok(
      !(p === shared || p.startsWith(shared + path.sep)),
      `${p} is inside the Claude Code plugin's data root`,
    );
  }
});

test('BEEZI_HOME does not relocate this plugin', (t) => {
  // Honouring it would restore the collision on exactly the machines that set it: one variable
  // pointing both agents at one directory.
  withEnv(t, 'BEEZI_CODEX_HOME', undefined);
  withEnv(t, 'BEEZI_HOME', path.join(os.tmpdir(), 'shared-beezi'));
  assert.equal(beeziCodexHome(), path.join(os.homedir(), '.beezi-codex'));
});

test('BEEZI_CODEX_HOME relocates every store together', (t) => {
  const dir = path.join(os.tmpdir(), 'beezi-codex-home-test');
  withEnv(t, 'BEEZI_CODEX_HOME', dir);
  assert.equal(beeziCodexHome(), dir);
  for (const p of everyStore()) {
    assert.ok(p === dir || p.startsWith(dir + path.sep), `${p} ignored BEEZI_CODEX_HOME`);
  }
});

test('the shipped build resolves the production namespace and no baked API', () => {
  // No env.json in the source tree — the variant builder writes one into its own copy. If one
  // ever appears here, every store and the keyring entry move under the whole suite.
  assert.equal(environmentError(), null, 'the shipped tree has unusable environment metadata');
  assert.equal(BEEZI_ENV, '');
  assert.equal(envSuffix(), '');
  assert.equal(ENV_API_BASE, null);
});

// ── the reader: env.json on disk ──────────────────────────────────────────────────────────────

test('an absent env.json is the production build, not an error', () => {
  const missing = readEnvJson(path.join(os.tmpdir(), 'beezi-no-such-env-json', 'env.json'));
  assert.deepEqual(missing, { present: false, value: {} });
  assert.deepEqual(resolveEnvironment({ envJson: missing, env: {} }), {
    name: '', suffix: '', apiBase: null, updateManifestUrl: null,
  });
});

test('a present-but-unparseable env.json is an error, NOT production', (t) => {
  // R1: a malformed variant env.json must never be silently treated as prod. "Returns {} on any
  // failure" would do exactly that — a staging build with a truncated file would write into the
  // production root holding a staging token.
  const file = envJsonFixture(t, '{"name": "staging"');
  const read = readEnvJson(file);
  assert.equal(read.present, true);
  assert.match(read.error, /not valid JSON/);
  assert.ok(resolveEnvironment({ envJson: read, env: {} }).error, 'malformed metadata resolved');
});

test('an env.json that is not a JSON object is an error', (t) => {
  for (const body of ['[1,2]', '"staging"', 'null', '42']) {
    const read = readEnvJson(envJsonFixture(t, body));
    assert.ok(read.error, `${body} was accepted as variant metadata`);
  }
});

test('a well-formed variant record resolves name and API together', (t) => {
  const file = envJsonFixture(t, {
    name: 'staging',
    apiBase: 'https://beezi-api-staging.azurewebsites.net/api',
    updateManifestUrl: 'https://raw.githubusercontent.com/o/n/main/.claude-plugin/marketplace.json',
  });
  assert.deepEqual(resolveEnvironment({ envJson: readEnvJson(file), env: {} }), {
    name: 'staging',
    suffix: '-staging',
    apiBase: 'https://beezi-api-staging.azurewebsites.net/api',
    updateManifestUrl: 'https://raw.githubusercontent.com/o/n/main/.claude-plugin/marketplace.json',
  });
});

// ── the resolver: names ───────────────────────────────────────────────────────────────────────

test('the allowlist is exactly the four names that may be interpolated', () => {
  // 'local' is a developer-machine build that talks to an API on loopback. It is a full member of
  // this list, not a special case: it gets its own root, its own keyring entry and its own hook
  // owner, so a local build cannot read or overwrite the dev variant's state.
  assert.deepEqual([...KNOWN_ENVIRONMENTS], ['', 'dev', 'staging', 'local']);
});

test('a local variant resolves its own namespace and a loopback apiBase', () => {
  const envJson = { present: true, value: { name: 'local', apiBase: 'http://localhost:5001/api' } };
  const r = resolveEnvironment({ envJson, env: {} });
  assert.equal(r.error, undefined);
  assert.equal(r.name, 'local');
  assert.equal(r.suffix, '-local');
  assert.equal(r.apiBase, 'http://localhost:5001/api');
  // Never published, so it ships without one - and an absent key is not an error.
  assert.equal(r.updateManifestUrl, null);
});

test('BEEZI_ENV wins over the baked name, and is a PRESENCE check', () => {
  const envJson = { present: true, value: { name: 'staging', apiBase: 'https://s.test/api' } };
  assert.equal(resolveEnvironment({ envJson, env: { BEEZI_ENV: 'dev' } }).suffix, '-dev');
  // `||` here instead of a presence check would make BEEZI_ENV='' fall through to the baked
  // name, so a developer could not force the production namespace on a staging build.
  assert.equal(resolveEnvironment({ envJson, env: { BEEZI_ENV: '' } }).name, '');
  assert.equal(resolveEnvironment({ envJson, env: {} }).name, 'staging');
});

test('an unknown environment name is an error, and prod is never the fallback', () => {
  for (const name of ['prod', 'production', 'STAGING', 'staging ', 'test', 'LOCAL', 'localhost', '../beezi-codex']) {
    const r = resolveEnvironment({ envJson: { present: false, value: {} }, env: { BEEZI_ENV: name } });
    assert.ok(r.error, `'${name}' resolved instead of erroring`);
    assert.equal(r.name, undefined, `'${name}' produced a usable namespace`);
  }
});

test('a shell/PowerShell payload is rejected and never echoed back verbatim', () => {
  // R6: validate overrides before embedding them in PowerShell text. The rejection message is
  // itself an output channel, so the payload must not survive into it either.
  const payloads = [
    "staging'; whoami #",
    'staging`n$(whoami)',
    "'+[char]65+'",
    'staging\\..\\..\\Windows',
  ];
  for (const name of payloads) {
    const r = resolveEnvironment({ envJson: { present: false, value: {} }, env: { BEEZI_ENV: name } });
    assert.ok(r.error, `'${name}' was accepted as an environment name`);
    assert.ok(!r.error.includes(name), `the rejection echoed the payload: ${r.error}`);
    // The message template itself uses only letters and single quotes, so any of these can only
    // have arrived from the rejected value.
    assert.ok(!/[`$;#\\()"]/.test(r.error), `the rejection leaked a metacharacter: ${r.error}`);
  }
});

test('a non-string environment name never becomes a path fragment', () => {
  for (const name of [7, true, {}, ['staging']]) {
    const envJson = { present: true, value: { name } };
    assert.ok(resolveEnvironment({ envJson, env: {} }).error, `${String(name)} was accepted`);
  }
});

test('a malformed BAKED name is an error even when an override replaces it', () => {
  // Otherwise `BEEZI_ENV=''` on a build whose metadata we could not understand resolves to
  // production — the fall-through R1 bans, reached the long way round.
  const envJson = { present: true, value: { name: 'prod', apiBase: 'https://p.test/api' } };
  assert.ok(resolveEnvironment({ envJson, env: { BEEZI_ENV: '' } }).error);
  assert.ok(resolveEnvironment({ envJson, env: { BEEZI_ENV: 'staging' } }).error);
});

// ── the resolver: API metadata, resolved with the namespace ───────────────────────────────────

test('a named variant missing its apiBase is an error', () => {
  // "Missing required metadata in a named variant is an error that prevents upload" (R1).
  const envJson = { present: true, value: { name: 'staging' } };
  const r = resolveEnvironment({ envJson, env: {} });
  assert.ok(r.error);
  assert.match(r.error, /no apiBase/);
});

test('BEEZI_ENV on a build with NO env.json still moves the namespace', () => {
  // G-2-2 ships standalone, before any variant exists: the API then follows the release default,
  // which lib/config.mjs owns.
  const r = resolveEnvironment({ envJson: { present: false, value: {} }, env: { BEEZI_ENV: 'staging' } });
  assert.equal(r.suffix, '-staging');
  assert.equal(r.apiBase, null);
});

test('a malformed baked apiBase is an error, not a silent drop to the default', () => {
  for (const apiBase of ['not-a-url', 'ftp://x/api', '/api', 'javascript:alert(1)', 7]) {
    const envJson = { present: true, value: { name: 'staging', apiBase } };
    assert.ok(resolveEnvironment({ envJson, env: {} }).error, `${String(apiBase)} was accepted`);
  }
});

test('a malformed updateManifestUrl is an error (schema published for G-8-4)', () => {
  const envJson = {
    present: true,
    value: { name: 'staging', apiBase: 'https://s.test/api', updateManifestUrl: 'nope' },
  };
  assert.ok(resolveEnvironment({ envJson, env: {} }).error);
});

test('an explicit API override cannot move the namespace', () => {
  // R1: resolve API and namespace together, and never let an API override cross a binding. The
  // structural half is that BEEZI_API_URL is not an input to the namespace at all — it is the
  // first rung of lib/config.mjs's precedence, and nothing else.
  const envJson = { present: true, value: { name: 'staging', apiBase: 'https://s.test/api' } };
  const withOverride = resolveEnvironment({
    envJson, env: { BEEZI_API_URL: 'https://beezi-api.example.com/api' },
  });
  assert.equal(withOverride.name, 'staging');
  assert.equal(withOverride.suffix, '-staging');
  assert.equal(withOverride.apiBase, 'https://s.test/api', 'the baked record is what was resolved');
});

// ── the suffix lands in exactly one place ─────────────────────────────────────────────────────

test('a suffixed root is still outside the Claude Code plugin\'s ~/.beezi', () => {
  const shared = path.join(os.homedir(), '.beezi');
  for (const name of KNOWN_ENVIRONMENTS) {
    const suffix = name === '' ? '' : `-${name}`;
    const root = path.join(os.homedir(), `.beezi-codex${suffix}`);
    assert.ok(
      !(root === shared || root.startsWith(shared + path.sep)),
      `${root} is inside the Claude Code plugin's data root`,
    );
  }
});

test('Codex\'s own roots are never namespaced', (t) => {
  // ~/.codex belongs to Codex, not to this plugin: both variants read the same transcripts, and
  // suffixing it would point a staging install at a sessions directory that does not exist.
  withEnv(t, 'CODEX_HOME', undefined);
  assert.equal(codexHome(), path.join(os.homedir(), '.codex'));
  assert.equal(codexSessionsDir(), path.join(os.homedir(), '.codex', 'sessions'));
});
