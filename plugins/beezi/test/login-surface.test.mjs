import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The login surface's cross-file contract, in the shape test/sync-surface.test.mjs uses.
//
// skills/login/SKILL.md branches on step 1's OUTPUT TEXT and on nothing else: it reads the key off
// `account=<key>`, identifies the same-tenant refusal by its sentence, identifies each of the two
// sign-ins-still-with-the-human-in-the-browser by ITS sentence, and treats everything else as a
// failed sign-in.
// None of those sentences live in the skill — lib/login.mjs, scripts/login.mjs and
// lib/mcp-bridge.mjs produce them — so rewording one on either side silently re-labels a real
// outcome as a different one. A genuine refusal becomes a generic failure; a sign-in that is merely
// slow becomes one too, and the user is told to retry something that is still running.
//
// Two-sided on purpose: the source must still PRINT the fragment AND the skill must still carry the
// phrase it branches on. Either assertion alone passes happily while the contract is broken.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');
const skill = read('skills', 'login', 'SKILL.md');

test('login skill — every step-1 outcome is printed by the surface and branched on by the skill', () => {
  // [what prints it, the distinctive fragment it must still print, the phrase the skill branches on]
  const outcomes = [
    [['lib', 'login.mjs'], 'is already linked as', /is already linked as/],
    [['scripts', 'login.mjs'], 'account=${result.key}', /`account=<key>`/],
    [['lib', 'mcp-bridge.mjs'], 'account=${result.key}', /`account=<key>`/],
    [['lib', 'mcp-bridge.mjs'], 'The sign-in is still running here', /The sign-in is still running here/],
    [['lib', 'mcp-bridge.mjs'], 'A Beezi sign-in is already in progress', /A Beezi sign-in is already in progress/],
    [['lib', 'mcp-bridge.mjs'], 'Beezi sign-in failed:', /Beezi sign-in failed/],
    [['scripts', 'login.mjs'], '✗ ${friendlyMessage(error)}', /✗/],
  ];
  for (const [file, fragment, inSkill] of outcomes) {
    assert.ok(
      read(...file).includes(fragment),
      `${file.join('/')} should still print "${fragment}" — the login skill branches on it`,
    );
    assert.match(skill, inSkill, `skills/login/SKILL.md should still branch on "${fragment}"`);
  }
});

// The discriminator is only safe while exactly one place spells the sentence. Two wordings and the
// skill matches one of them, sending every refusal printed by the other down the failure branch —
// where it is relayed as "the sign-in failed", which is the opposite misfire.
test('login — the same-tenant refusal sentence has exactly one definition', () => {
  assert.match(read('lib', 'login.mjs'), /export function refusedSameTenantMessage/);
  assert.match(read('scripts', 'login.mjs'), /refusedSameTenantMessage\(result\)/);
  assert.match(read('lib', 'mcp-bridge.mjs'), /refusedSameTenantMessage\(result\)/);

  for (const dir of ['lib', 'scripts']) {
    for (const name of fs.readdirSync(path.join(pluginRoot, dir))) {
      if (!name.endsWith('.mjs')) continue;
      if (dir === 'lib' && name === 'login.mjs') continue;
      assert.ok(
        !read(dir, name).includes('is already linked as'),
        `${dir}/${name} spells the refusal out itself instead of calling refusedSameTenantMessage`,
      );
    }
  }
});

// The failure branch is defined as "no account= line and none of the other sentences", so a path
// that printed a key alongside one of them would be read as a success that also failed.
test('login — the MCP tool prints its key only on a completed sign-in', () => {
  const bridge = read('lib', 'mcp-bridge.mjs');
  const pending = bridge.indexOf('The sign-in is still running here');
  const failed = bridge.indexOf('Beezi sign-in failed:');
  const key = bridge.indexOf('account=${result.key}');
  assert.ok(pending > -1 && failed > -1 && key > -1);
  assert.ok(key > pending && key > failed, 'the key is composed after both keyless exits have returned');
  assert.match(bridge, /const key = result\.key \? `\\naccount=\$\{result\.key\}` : '';/);
});
