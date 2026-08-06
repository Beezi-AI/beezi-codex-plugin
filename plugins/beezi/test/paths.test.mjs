import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  beeziCodexHome,
  queueDir,
  stateDir,
  repoMapFile,
  credentialsFile,
  billingConfigFile,
  hookLauncherDir,
} from '../lib/paths.mjs';

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

const everyStore = () => [
  beeziCodexHome(),
  queueDir(),
  stateDir(),
  repoMapFile(),
  credentialsFile(),
  billingConfigFile(),
  hookLauncherDir(),
];

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
