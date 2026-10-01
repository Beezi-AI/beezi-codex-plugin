import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// The non-production-URL guard in scripts/sync-to-github.sh, and the one carve-out that lets the
// `beezi-local` variant through it.
//
// beezi-local is published to the INTERNAL marketplace by the dev step of
// azure-pipelines-github-sync.yml, so a developer working on the Beezi API can install a plugin
// pointed at their own machine without building one. Its env.json therefore carries
// http://localhost:5001/api by design - the exact shape the guard exists to refuse.
//
// What is pinned here is that the exception stayed NARROW. The easy version of this change is
// `ALLOW_NON_PROD=true` on the pipeline step, which would also switch off the ngrok and 0.0.0.0
// checks - the cases the guard was actually written for, where a tunnel URL lands in the commit
// log of a repo whose history we do not control. The shell text is the assertion target because
// tools/hermetic-env.mjs records a spawned child as a hermeticity violation, so the script cannot
// be run here; the pattern itself IS executed, against the grep output shapes it will see.

const repoRoot = path.dirname(path.dirname(path.dirname(
  path.dirname(url.fileURLToPath(import.meta.url)),
)));
const SYNC_SCRIPT = path.join(repoRoot, 'scripts', 'sync-to-github.sh');
const PIPELINE = path.join(repoRoot, 'azure-pipelines-github-sync.yml');

const syncText = () => fs.readFileSync(SYNC_SCRIPT, 'utf-8');
const pipelineText = () => fs.readFileSync(PIPELINE, 'utf-8');

// The ERE the shell hands to `grep -vE`, lifted out of the script and translated to the one
// construct JavaScript spells differently. Lifting it rather than restating it is the point: a
// copy pasted into this file could pass forever while the shipped pattern was broken.
function carveOutPattern() {
  const match = syncText().match(/'(\/env\\\.json:[^']+)'/);
  assert.ok(match, 'sync-to-github.sh no longer carries an /env.json carve-out pattern');
  // POSIX [[:space:]] is the one construct JavaScript spells differently; String.raw keeps
  // the backslash out of the hands of the string escape rules.
  return new RegExp(match[1].replace('[[:space:]]', String.raw`\s`));
}

const LINE = (file, body) => `dist/variant-local/plugins/beezi-local/${file}:3:  ${body}`;

test('the guard still refuses every non-production URL shape it was written for', () => {
  const text = syncText();
  assert.match(
    text,
    /grep -RInE 'ngrok\|localhost\|127\\\.0\\\.0\\\.1\|0\\\.0\\\.0\\\.0'/,
    'the variant-mode guard must still scan for all four shapes',
  );
  assert.match(text, /--include='\*\.mcp\.json' --include='\.mcp\.json' --include='env\.json'/);
  assert.match(text, /refusing to publish - non-production connector URL found/);
});

test('the carve-out is gated on the beezi-local variant alone', () => {
  assert.match(
    syncText(),
    /if \[ "\$variant_name" = "beezi-local" \] && \[ -n "\$non_prod" \]; then/,
    'a carve-out that is not gated on the variant name would also exempt dev and staging',
  );
});

test('the carve-out exempts the loopback apiBase line and nothing else', () => {
  const allowed = carveOutPattern();

  // The two forms make-variant.sh can emit: with a trailing comma when updateManifestUrl follows
  // it (the published local), and without when it does not (a hand-built local).
  assert.ok(allowed.test(LINE('env.json', '"apiBase": "http://localhost:5001/api",')));
  assert.ok(allowed.test(LINE('env.json', '"apiBase": "http://127.0.0.1:5001/api"')));

  // Anchored, and the hosts are named explicitly. An unanchored pattern would also pass this,
  // whose host is evil.test - the same trap make-variant.sh anchors its plaintext exception against.
  assert.ok(!allowed.test(LINE('env.json', '"apiBase": "http://localhost:1@evil.test/api",')));
  // The cases the guard actually exists for stay refused.
  assert.ok(!allowed.test(LINE('env.json', '"apiBase": "https://beezi.ngrok.io/api",')));
  assert.ok(!allowed.test(LINE('env.json', '"apiBase": "http://0.0.0.0:5001/api",')));
  // A loopback URL in a connector manifest is not this variant's purpose, so it is not exempt.
  assert.ok(!allowed.test(LINE('.mcp.json', '"url": "http://localhost:5001/api"')));
  // Only apiBase. Any other env.json key pointing at a local box is still a finding.
  assert.ok(!allowed.test(LINE('env.json', '"updateManifestUrl": "http://localhost:5001/api",')));
});

test('the dev step publishes beezi-local without reaching for ALLOW_NON_PROD or FORCE', () => {
  const text = pipelineText();
  // Assignment-shaped, not word-shaped: the step's own comments name both variables to explain
  // why neither is set, and a tripwire that fired on the explanation would be useless.
  assert.ok(
    !/(?:^|\s)(?:export\s+)?ALLOW_NON_PROD\s*=/m.test(text),
    'a blanket override would also disable the ngrok and 0.0.0.0 checks for that publish',
  );
  // Two pushes to one branch in one job. Each sync-to-github.sh run re-fetches the tip, so the
  // beezi-local push fast-forwards over the beezi-dev push made seconds earlier. FORCE would turn
  // a stale tip from a loud push rejection into a silent overwrite of that publish.
  assert.ok(
    !/(?:^|\s)(?:export\s+)?FORCE\s*=/m.test(text),
    'a forced push would let the second publish clobber the first',
  );
  // Empty api-base on purpose: make-variant.sh falls through to LOCAL_API_BASE, so the loopback
  // address is not restated here where it could drift from the one the builder documents.
  assert.match(
    text,
    /OUT=dist\/variant-local bash scripts\/make-variant\.sh local "" "\$\(Build\.BuildId\)" '\$\(GITHUB_REPO_INTERNAL\)'/,
  );
  // A separate OUT is load-bearing: make-variant.sh opens with `rm -rf "$OUT"`, and
  // sync-to-github.sh names the variant with `ls "$VARIANT_DIR/plugins"`, which needs one entry.
  assert.match(text, /VARIANT_DIR=dist\/variant-local bash scripts\/sync-to-github\.sh/);
  assert.match(text, /VARIANT_DIR=dist\/variant bash scripts\/sync-to-github\.sh/);
  assert.match(
    text,
    /displayName: Publish beezi-dev and beezi-local variants to internal GitHub\n\s+condition: eq\(variables\['Build\.SourceBranchName'\], 'dev'\)/,
  );
});
