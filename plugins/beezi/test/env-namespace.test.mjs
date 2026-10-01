// Per-environment isolation of the data root and the credential-store entry (G-2-2).
//
// EVERY CASE HERE RUNS IN A FRESH CHILD `node` PROCESS, and that is a correctness requirement, not
// a style choice (R6). The environment is consumed at MODULE LOAD: lib/paths.mjs freezes the
// resolved record, and lib/credentials.mjs builds `SERVICE` from it and interpolates that string
// into its PowerShell credential templates while the module evaluates. An in-process matrix that
// mutates `process.env.BEEZI_ENV` between `import()` calls proves nothing — repeated `import()` of
// one URL is served from the ESM cache, and cache-busting only credentials.mjs still gets the
// cached paths.mjs underneath it, so the "staging" case silently re-tests production and passes.
//
// The children also get their OWN home: `tools/hermetic-env.mjs` exports BEEZI_CODEX_HOME into
// this process, and an explicit full root beats the suffixed default — a child inheriting it would
// report the unsuffixed sandbox path and fail every suffix assertion for a reason that has nothing
// to do with the code under test. So the namespace cases DELETE it and redirect HOME/USERPROFILE
// (the child carries no preload, and that redirect is the only thing keeping it off the real
// machine); the shared-root case sets it deliberately, because that is the scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const libUrl = (name) => url.pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const PATHS = libUrl('paths.mjs');
const CREDENTIALS = libUrl('credentials.mjs');
const TOKEN = libUrl('token.mjs');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Run one configuration in a fresh process and return { status, stdout, stderr, json, home }.
 *
 * `overrides` with an `undefined` value deletes the variable, so a case can assert the *absence*
 * of BEEZI_ENV as its own configuration rather than relying on the parent not having one.
 */
function child(t, source, overrides = {}) {
  const home = tmpDir(t, 'beezi-envcase-');
  const env = { ...process.env };
  // A runner that inherits this prints "run() is being called recursively" and exits 0 without
  // running anything — every assertion below would then pass vacuously.
  delete env.NODE_TEST_CONTEXT;
  // Cleared, not overwritten: these are exactly the switches under test, and the parent has them.
  delete env.BEEZI_CODEX_HOME;
  delete env.BEEZI_ENV;
  delete env.BEEZI_API_URL;
  env.HOME = home;
  env.USERPROFILE = home;
  env.CODEX_HOME = path.join(home, '.codex');
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: pluginRoot, encoding: 'utf-8', timeout: 60_000, env,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* a failing case prints nothing */ }
  return {
    status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json, home,
  };
}

// Reports both namespaces at once. Reading them from ONE process is the structural guard S2 calls
// for: the dangerous outcome is suffixing one of the two, and a report that shows only the root or
// only the service name cannot see it.
const REPORT = [
  `import * as paths from ${JSON.stringify(PATHS)};`,
  `import { SERVICE } from ${JSON.stringify(CREDENTIALS)};`,
  "const PROBE = '0123abcd';",
  'process.stdout.write(JSON.stringify({',
  '  env: paths.BEEZI_ENV,',
  '  suffix: paths.environment.envSuffix(),',
  '  service: SERVICE,',
  '  root: paths.beeziCodexHome(),',
  '  codexHome: paths.codexHome(),',
  '  stores: [',
  // The per-account stores take a key; a probe one is supplied rather than skipping them, or the
  // surface this asserts the suffix over would silently shrink to the machine-level files.
  '    paths.queueDir(PROBE), paths.stateDir(), paths.repoMapFile(), paths.credentialsFile(PROBE),',
  '    paths.legacyCredentialsFile(),',
  '    paths.billingConfigFile(), paths.auditLedgerFile(PROBE), paths.usageObservationsFile(),',
  '    paths.trackingStateFile(PROBE), paths.hookLauncherDir(),',
  '  ],',
  '  pid: process.pid,',
  '}));',
].join('\n');

function reportFor(t, overrides) {
  const res = child(t, REPORT, overrides);
  assert.equal(res.status, 0, `the child failed:\n${res.stderr}`);
  assert.ok(res.json, `the child printed no report:\n${res.stdout}\n${res.stderr}`);
  return res;
}

// ── the two namespaces move together, or not at all ───────────────────────────────────────────

test('the default configuration is the unsuffixed production namespace', (t) => {
  const { json, home } = reportFor(t, {});
  assert.equal(json.env, '');
  assert.equal(json.suffix, '');
  assert.equal(json.root, path.join(home, '.beezi-codex'));
  assert.equal(json.service, 'beezi-codex');
});

test('BEEZI_ENV=staging moves the data root AND the credential entry', (t) => {
  const { json, home } = reportFor(t, { BEEZI_ENV: 'staging' });
  assert.equal(json.env, 'staging');
  assert.equal(json.root, path.join(home, '.beezi-codex-staging'));
  assert.equal(json.service, 'beezi-codex-staging');
});

test('BEEZI_ENV=dev moves both the same way', (t) => {
  const { json, home } = reportFor(t, { BEEZI_ENV: 'dev' });
  assert.equal(json.root, path.join(home, '.beezi-codex-dev'));
  assert.equal(json.service, 'beezi-codex-dev');
});

test('BEEZI_ENV=\'\' forces the production namespace (presence, not truthiness)', (t) => {
  const { json, home } = reportFor(t, { BEEZI_ENV: '' });
  assert.equal(json.env, '');
  assert.equal(json.root, path.join(home, '.beezi-codex'));
  assert.equal(json.service, 'beezi-codex');
});

test('every store follows the suffixed root, and none lands in the production one', (t) => {
  // The everyStore() sweep, run in the environment that can actually move: a single accessor left
  // joining onto an unsuffixed root is the failure S2 names — staging credentials over production
  // cursors, and both drains serialized on one refresh lock.
  const { json, home } = reportFor(t, { BEEZI_ENV: 'staging' });
  const prod = path.join(home, '.beezi-codex');
  const shared = path.join(home, '.beezi');
  for (const p of json.stores) {
    assert.ok(p.startsWith(json.root + path.sep), `${p} ignored the environment suffix`);
    assert.ok(!(p === prod || p.startsWith(prod + path.sep)), `${p} is in the production root`);
    assert.ok(!(p === shared || p.startsWith(shared + path.sep)), `${p} is in the Claude root`);
  }
});

test('Codex\'s own root is not namespaced by the variant', (t) => {
  const { json, home } = reportFor(t, { BEEZI_ENV: 'staging', CODEX_HOME: undefined });
  assert.equal(json.codexHome, path.join(home, '.codex'), 'the transcripts moved with the variant');
});

test('each configuration really is a separate process', (t) => {
  // The whole point of this file. If these were one process, the second import would come from the
  // ESM cache and report the first configuration's frozen namespace.
  const a = reportFor(t, { BEEZI_ENV: 'staging' });
  const b = reportFor(t, { BEEZI_ENV: 'dev' });
  assert.notEqual(a.json.pid, b.json.pid);
  assert.notEqual(a.json.service, b.json.service);
  assert.notEqual(a.json.root, b.json.root);
});

// ── an unusable environment name is an error, never production ────────────────────────────────

test('an unknown BEEZI_ENV fails the process instead of resolving to production', (t) => {
  for (const name of ['prod', 'production', 'Staging', 'qa']) {
    const res = child(t, REPORT, { BEEZI_ENV: name });
    assert.notEqual(res.status, 0, `'${name}' produced a working namespace`);
    assert.match(`${res.stdout}${res.stderr}`, /environment/i);
    assert.ok(!res.stdout.includes('beezi-codex'), `'${name}' still named a root or a service`);
  }
});

test('a PowerShell payload in BEEZI_ENV is rejected and never reaches any output', (t) => {
  // R6: validate overrides before embedding them in PowerShell text. SERVICE is interpolated into
  // CRED_WRITE/CRED_READ/CRED_DELETE as literal script text at module load, so the allowlist has
  // to reject this BEFORE lib/credentials.mjs evaluates — which is what the failure proves.
  const payloads = [
    "staging'; Start-Process calc #",
    'staging`n$(whoami)',
    "'+[char]65+'",
    '../../.beezi',
  ];
  for (const name of payloads) {
    const res = child(t, REPORT, { BEEZI_ENV: name });
    assert.notEqual(res.status, 0, `the payload ${JSON.stringify(name)} was accepted`);
    const all = `${res.stdout}${res.stderr}`;
    assert.ok(!all.includes(name), `the payload survived into the process output:\n${all}`);
  }
});

test('a variant whose baked metadata is unusable cannot even name a credential entry', (t) => {
  // The same failure reached through env.json rather than the override: readEnvJson() reports the
  // error, the frozen record carries it, and SERVICE cannot be built. `import` throws, so nothing
  // downstream gets a production-named store by default.
  const dir = tmpDir(t, 'beezi-badenv-');
  const file = path.join(dir, 'env.json');
  fs.writeFileSync(file, '{"name": "staging"');
  const source = [
    `import { environment } from ${JSON.stringify(PATHS)};`,
    `const read = environment.readEnvJson(${JSON.stringify(file)});`,
    'const resolved = environment.resolveEnvironment({ envJson: read, env: {} });',
    'if (!resolved.error) { process.exitCode = 3; }',
    'process.stdout.write(JSON.stringify({ error: resolved.error, name: resolved.name }));',
  ].join('\n');
  const res = child(t, source, {});
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.name, undefined, 'a malformed variant resolved to a usable namespace');
  assert.match(res.json.error, /not valid JSON/);
});

// ── the PowerShell templates carry the suffixed target name ───────────────────────────────────

test('the Credential Manager scripts name the SUFFIXED target under a variant', (t) => {
  // Guards the template-literal interaction: `$c.TargetName='${SERVICE}'` is baked at module load,
  // so if SERVICE were computed lazily (or the suffix arrived after import) these scripts would
  // still address the production credential while the data root had moved.
  const source = [
    `import { getCredentials, setCredentials, deleteCredentials, SERVICE } from ${JSON.stringify(CREDENTIALS)};`,
    'const scripts = [];',
    'const run = (file, args) => {',
    "  const i = args.indexOf('-Command');",
    '  if (i !== -1) scripts.push(args[i + 1]);',
    "  return { ok: false, stdout: '' };",
    '};',
    "const deps = { platform: 'win32', run };",
    "await getCredentials('a1b2c3d4', deps);",
    "await setCredentials('a1b2c3d4', { access_token: 'a' }, deps);",
    "await deleteCredentials('a1b2c3d4', deps);",
    'process.stdout.write(JSON.stringify({ service: SERVICE, scripts }));',
  ].join('\n');
  const res = child(t, source, { BEEZI_ENV: 'staging' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.service, 'beezi-codex-staging');
  const credMan = res.json.scripts.filter((s) => /Cred(Read|Write|Delete)/.test(s));
  assert.ok(credMan.length >= 3, `expected all three CredMan scripts, got ${credMan.length}`);
  // The target is `<service>:<key>` since the store became keyed; the SUFFIX is what this asserts.
  for (const script of credMan) {
    assert.ok(script.includes("'beezi-codex-staging:a1b2c3d4'"), `a script kept the production target:\n${script}`);
    assert.ok(!/'beezi-codex[:']/.test(script), `a script still addresses production:\n${script}`);
  }
});

// ── BEEZI_CODEX_HOME is an explicit FULL root: a crossed binding must prevent upload ──────────

// The file store moved under accounts/<key>/ when the credential store became keyed, so the shared
// root these two children fight over is that account's file rather than the root-level one.
const SHARED_KEY = 'a1b2c3d4';

const WRITE_CREDS = [
  `import { setCredentials } from ${JSON.stringify(CREDENTIALS)};`,
  `import { credentialsFile, BEEZI_ENV } from ${JSON.stringify(PATHS)};`,
  "const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };",
  `const where = await setCredentials('${SHARED_KEY}', {`,
  "  client_id: 'cid', redirect_uri: 'http://127.0.0.1:1/cb',",
  "  token_endpoint: 'https://issuer.test/token', access_token: 'at', refresh_token: 'rt',",
  '  expires_at: Date.now() + 3600000,',
  '}, deps);',
  `process.stdout.write(JSON.stringify({ where, file: credentialsFile('${SHARED_KEY}'), env: BEEZI_ENV }));`,
].join('\n');

const READ_CREDS = [
  `import { getCredentials } from ${JSON.stringify(CREDENTIALS)};`,
  `import { getAccessToken } from ${JSON.stringify(TOKEN)};`,
  `import { credentialsFile, BEEZI_ENV } from ${JSON.stringify(PATHS)};`,
  "const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };",
  `const creds = await getCredentials('${SHARED_KEY}', deps);`,
  `const token = await getAccessToken('${SHARED_KEY}', { ...deps, getCredentials: () => getCredentials('${SHARED_KEY}', deps) });`,
  'process.stdout.write(JSON.stringify({',
  `  env: BEEZI_ENV, file: credentialsFile('${SHARED_KEY}'), creds, token,`,
  '}));',
].join('\n');

test('two environments sharing one BEEZI_CODEX_HOME cannot lift each other\'s token', (t) => {
  // R1: "callers running two environments must provide distinct roots, and a mismatched binding
  // must prevent upload". SERVICE already keeps the native keyrings apart, but an explicit full
  // root shares the FILE store — so the environment is stamped onto the stored blob and a
  // disagreement reads as absent. No token means every reporting path has nothing to flush with.
  const shared = tmpDir(t, 'beezi-sharedroot-');

  const wrote = child(t, WRITE_CREDS, { BEEZI_ENV: 'staging', BEEZI_CODEX_HOME: shared });
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(wrote.json.env, 'staging');
  assert.equal(wrote.json.file, path.join(shared, 'accounts', SHARED_KEY, 'credentials.json'));
  assert.ok(fs.existsSync(wrote.json.file), 'the staging install wrote into the shared root');

  const staging = child(t, READ_CREDS, { BEEZI_ENV: 'staging', BEEZI_CODEX_HOME: shared });
  assert.equal(staging.status, 0, staging.stderr);
  assert.equal(staging.json.token, 'at', 'staging cannot read back its own credentials');

  const production = child(t, READ_CREDS, { BEEZI_CODEX_HOME: shared });
  assert.equal(production.status, 0, production.stderr);
  assert.equal(production.json.env, '', 'the second process is the production namespace');
  assert.equal(production.json.file, staging.json.file, 'both really do share one root');
  assert.equal(production.json.creds, null, 'production adopted staging credentials');
  assert.equal(production.json.token, null, 'UPLOAD NOT PREVENTED: a bearer token was issued');
});

test('an explicit API override does not let production reach a staging binding', (t) => {
  // BEEZI_API_URL is a supported override and stays one — but it must not silently cross a stored
  // environment binding (R1). Pointing production at the staging API does not make the staging
  // credentials in a shared root usable.
  const shared = tmpDir(t, 'beezi-crossapi-');
  const wrote = child(t, WRITE_CREDS, { BEEZI_ENV: 'staging', BEEZI_CODEX_HOME: shared });
  assert.equal(wrote.status, 0, wrote.stderr);

  const crossed = child(t, READ_CREDS, {
    BEEZI_CODEX_HOME: shared,
    BEEZI_API_URL: 'https://beezi-api-staging.azurewebsites.net/api',
  });
  assert.equal(crossed.status, 0, crossed.stderr);
  assert.equal(crossed.json.token, null, 'an API override crossed the stored environment binding');
});

test('distinct roots are what actually work, and they stay isolated', (t) => {
  const prodRoot = tmpDir(t, 'beezi-prodroot-');
  const stagingRoot = tmpDir(t, 'beezi-stagingroot-');
  assert.equal(child(t, WRITE_CREDS, { BEEZI_CODEX_HOME: prodRoot }).status, 0);
  assert.equal(
    child(t, WRITE_CREDS, { BEEZI_ENV: 'staging', BEEZI_CODEX_HOME: stagingRoot }).status, 0,
  );
  const prod = child(t, READ_CREDS, { BEEZI_CODEX_HOME: prodRoot });
  const staging = child(t, READ_CREDS, { BEEZI_ENV: 'staging', BEEZI_CODEX_HOME: stagingRoot });
  assert.equal(prod.json.token, 'at');
  assert.equal(staging.json.token, 'at');
  assert.notEqual(prod.json.file, staging.json.file);
});
