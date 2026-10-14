import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { childEnv, createRunner } from '../lib/setup-runner.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// The fake closes with child.code once both streams have ended, like a real ChildProcess.
function setup(script, extra) {
  const calls = [];
  const stdout = sink();
  const stderr = sink();
  const spawn = (cmd, args, options) => {
    const child = fakeChild();
    calls.push({ cmd, args, options });
    let open = 2;
    const ended = () => {
      open -= 1;
      if (open === 0) child.emit('close', child.code);
    };
    child.stdout.on('end', ended);
    child.stderr.on('end', ended);
    setImmediate(() => script(child));
    return child;
  };
  const run = createRunner(Object.assign({
    root: '/plugin', cwd: '/tmp/beezi-setup-x', env: { PATH: '/bin', CLAUDE_PID: '9', KEEP: 'y' },
    sessionKeys: ['CLAUDE_PID'], spawn, execPath: '/usr/bin/node', stdout, stderr,
  }, extra));
  return { run, calls, stdout, stderr };
}

test('childEnv drops session keys, keeps the rest and marks the setup run', () => {
  const env = { A: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's' };
  const out = childEnv(env, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
  assert.deepEqual(out, { A: '1', BEEZI_SETUP: '1' });
  assert.deepEqual(env, { A: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's' });
});

test('run spawns node on the plugin script with the clean env, temp cwd and ignored stdin', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('ok\n'); child.stderr.end(); });
  const result = await h.run('workspace.mjs', ['routes', '--account', 'k1']);
  assert.deepEqual(result, { code: 0, stdout: 'ok\n', stderr: '' });
  const call = h.calls[0];
  assert.equal(call.cmd, '/usr/bin/node');
  assert.deepEqual(call.args, [path.join('/plugin', 'scripts', 'workspace.mjs'), 'routes', '--account', 'k1']);
  assert.equal(call.options.cwd, '/tmp/beezi-setup-x');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(call.options.env, { PATH: '/bin', KEEP: 'y', BEEZI_SETUP: '1' });
  assert.equal(h.stdout.text(), '');
});

test('stream echoes whole lines live, hides matching stdout lines, and still captures them', async () => {
  const h = setup((child) => {
    child.code = 0;
    child.stdout.write('Opening your browser');
    child.stdout.write('…\n✓ linked\naccount=ab12');
    child.stderr.write('warn\n');
    child.stdout.end();
    child.stderr.end();
  });
  const result = await h.run('login.mjs', [], { stream: true, hide: /^account=/ });
  assert.equal(result.stdout, 'Opening your browser…\n✓ linked\naccount=ab12');
  assert.equal(h.stdout.text(), 'Opening your browser…\n✓ linked\n');
  assert.equal(h.stderr.text(), 'warn\n');
});

test('stream flushes a final unterminated line that is not hidden', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('Beezi: 3/3 sessions read'); child.stderr.end(); });
  await h.run('backfill.mjs', [], { stream: true });
  assert.equal(h.stdout.text(), 'Beezi: 3/3 sessions read\n');
});

test('a non-zero exit is reported, a signal kill becomes 1, and a spawn error becomes 127', async () => {
  const failed = setup((child) => { child.code = 2; child.stderr.end('✗ boom\n'); child.stdout.end(); });
  assert.deepEqual(await failed.run('x.mjs', []), { code: 2, stdout: '', stderr: '✗ boom\n' });
  const killed = setup((child) => { child.code = null; child.stdout.end(); child.stderr.end(); });
  assert.equal((await killed.run('x.mjs', [])).code, 1);
  const missing = setup((child) => { child.emit('error', new Error('spawn ENOENT')); });
  assert.deepEqual(await missing.run('x.mjs', []), { code: 127, stdout: '', stderr: 'spawn ENOENT' });
});

test('stream paints every echoed stdout and stderr line, but never hidden or captured output', async () => {
  const h = setup((child) => {
    child.code = 0;
    child.stdout.write('✓ linked\naccount=ab12\n');
    child.stderr.write('⚠ slow\n');
    child.stdout.end('tail');
    child.stderr.end();
  }, { paint: (line) => `<${line}>` });
  const result = await h.run('login.mjs', [], { stream: true, hide: /^account=/ });
  assert.equal(h.stdout.text(), '<✓ linked>\n<tail>\n');
  assert.equal(h.stderr.text(), '<⚠ slow>\n');
  assert.equal(result.stdout, '✓ linked\naccount=ab12\ntail');
  assert.equal(result.stderr, '⚠ slow\n');
});

test('a painted run that does not stream echoes nothing', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('✓ quiet\n'); child.stderr.end(); }, { paint: (line) => `<${line}>` });
  assert.deepEqual(await h.run('x.mjs', []), { code: 0, stdout: '✓ quiet\n', stderr: '' });
  assert.equal(h.stdout.text(), '');
});
