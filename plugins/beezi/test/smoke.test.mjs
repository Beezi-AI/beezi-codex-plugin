import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every module under lib/ must load. This is the cheapest guard against the failure that a
// per-module suite cannot catch: an import removed or renamed in one module while another still
// depends on it, or a cycle introduced between two modules that each pass their own tests. A
// broken module shows up here as a named failure rather than as a silently smaller test count.
const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, '..', 'lib');
const scriptsDir = path.join(here, '..', 'scripts');

const modules = fs.readdirSync(libDir).filter((f) => f.endsWith('.mjs')).sort();

test('lib/ has modules to check', () => {
  assert.ok(modules.length > 20, `expected the full engine, found ${modules.length} modules`);
});

for (const name of modules) {
  test(`lib/${name} loads`, async () => {
    const mod = await import(pathToFileURL(path.join(libDir, name)).href);
    assert.ok(mod, `${name} imported to nothing`);
  });
}

test('every script entry point resolves its imports', async () => {
  // Scripts are executables — importing one runs it — so parse rather than execute: read each
  // file's own import specifiers and check the targets exist. Catches a renamed lib module that
  // only a script still references (scripts have no unit tests of their own).
  const scripts = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'));
  assert.ok(scripts.length > 0, 'no scripts found');
  const missing = [];
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(scriptsDir, script), 'utf-8');
    for (const m of source.matchAll(/^import\s[\s\S]*?from\s+['"](\.\.?\/[^'"]+)['"]/gm)) {
      const target = path.resolve(scriptsDir, m[1]);
      if (!fs.existsSync(target)) missing.push(`${script} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'scripts import modules that do not exist');
});
