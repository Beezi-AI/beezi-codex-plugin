import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FUN_LINES, finaleLines } from '../lib/setup-finale.mjs';
import { NO_TERMINAL, SESSION_KEYS, STOPPED, setupMain } from '../lib/setup-main.mjs';
import { createStyle, paint } from '../lib/setup-style.mjs';

const COLOR = createStyle({ enabled: true });
const PLAIN = createStyle({ enabled: false });
const ESC = /\x1b\[/;
const block = (lines) => lines.map((line) => `${line}\n`).join('');

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

function harness(over) {
  const seen = { closed: 0, removed: [], runner: null, prompt: null, ctx: null, exit: null, interrupt: null, exitHandlers: [] };
  const stdout = sink();
  const stderr = sink();
  const terminal = { isTTY: true };
  const deps = {
    stdout,
    stderr,
    env: { PATH: '/bin', CODEX_THREAD_ID: 'thread-1' },
    random: () => 0,
    openTerminal: () => terminal,
    makeTempDir: () => '/tmp/beezi-setup-x1',
    removeDir: (dir) => { seen.removed.push(dir); },
    createPrompt: (io) => { seen.prompt = io; return { close: () => { seen.closed += 1; } }; },
    createRunner: (options) => { seen.runner = options; return 'run-fn'; },
    runSetup: (ctx) => { seen.ctx = ctx; return Promise.resolve(0); },
    onInterrupt: (handler) => { seen.interrupt = handler; },
    onExit: (handler) => { seen.exitHandlers.push(handler); },
    exit: (code) => { seen.exit = code; },
    ...over,
  };
  return { deps, seen, stdout, stderr, terminal };
}

// A colour terminal: TTY stdout of the given width, and a terminal that can read raw keys.
function colourTerminal(h, columns) {
  h.stdout.isTTY = true;
  h.stdout.columns = columns;
  h.terminal.setRawMode = () => {};
  return h;
}

test('SESSION_KEYS are the two variables Codex exports with the session id', () => {
  assert.deepEqual(SESSION_KEYS, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
});

test('without a terminal it says how to sign in instead and exits 1 before touching anything', async () => {
  const h = harness({ openTerminal: () => null });
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.equal(h.stderr.text(), `${NO_TERMINAL}\n`);
  assert.equal(NO_TERMINAL, '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.');
  assert.equal(h.seen.runner, null);
  assert.equal(h.seen.interrupt, null);
  assert.deepEqual(h.seen.exitHandlers, []);
  assert.deepEqual(h.seen.removed, []);
});

test('on a colour terminal the no-terminal ✗ line is painted red', async () => {
  const h = colourTerminal(harness({ openTerminal: () => null }), 100);
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.equal(h.stderr.text(), `${paint(COLOR, NO_TERMINAL)}\n`);
  assert.match(h.stderr.text(), ESC);
});

test('on process exit a TTY stdout gets the cursor shown again, and piped stdout registers nothing', async () => {
  const tty = colourTerminal(harness({}), 100);
  assert.equal(await setupMain('/plugin', tty.deps), 0);
  assert.equal(tty.seen.exitHandlers.length, 1);
  tty.stdout.chunks.length = 0;
  tty.seen.exitHandlers[0]();
  assert.equal(tty.stdout.text(), '\x1b[?25h');
  const piped = harness({});
  assert.equal(await setupMain('/plugin', piped.deps), 0);
  assert.deepEqual(piped.seen.exitHandlers, []);
});

test('it runs the wizard from a fresh temp cwd with the session keys stripped, then cleans up', async () => {
  const h = harness({});
  assert.equal(await setupMain('/plugin', h.deps), 0);
  const { paint: runnerPaint, ...runner } = h.seen.runner;
  assert.deepEqual(runner, { root: '/plugin', cwd: '/tmp/beezi-setup-x1', env: h.deps.env, sessionKeys: SESSION_KEYS });
  assert.equal(runnerPaint('✓ done'), '✓ done');
  assert.equal(h.seen.prompt.input, h.terminal);
  assert.equal(h.seen.prompt.output, h.stdout);
  assert.equal(h.seen.ctx.run, 'run-fn');
  assert.equal(typeof h.seen.ctx.ask.close, 'function');
  h.stdout.chunks.length = 0;
  h.seen.ctx.print('✓ done');
  assert.equal(h.stdout.text(), '✓ done\n');
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test("the wizard's exit code passes through with no finale, and a crash still closes the prompt and removes the temp dir", async () => {
  const signInFailed = harness({ runSetup: () => Promise.resolve(1) });
  assert.equal(await setupMain('/plugin', signInFailed.deps), 1);
  assert.deepEqual(signInFailed.seen.removed, ['/tmp/beezi-setup-x1']);
  assert.equal(signInFailed.stdout.text(), '');
  const crashed = harness({ runSetup: () => Promise.reject(new Error('boom')) });
  await assert.rejects(setupMain('/plugin', crashed.deps), /boom/);
  assert.equal(crashed.seen.closed, 1);
  assert.deepEqual(crashed.seen.removed, ['/tmp/beezi-setup-x1']);
  assert.equal(crashed.stdout.text(), '');
});

test('Ctrl+C closes the prompt, removes the temp dir, says how to finish and exits 130', () => {
  const h = harness({ runSetup: () => new Promise(() => {}) });
  setupMain('/plugin', h.deps);
  h.seen.interrupt();
  assert.equal(h.stdout.text(), `\n${STOPPED}\n`);
  assert.equal(STOPPED, 'Setup stopped. Run the installer again, or ask "Sign me in to Beezi" in a new Codex thread, to finish.');
  assert.equal(h.seen.exit, 130);
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('Ctrl+C inside a menu takes the same stop path, with the stop line in red', () => {
  const h = colourTerminal(harness({ runSetup: () => new Promise(() => {}) }), 100);
  setupMain('/plugin', h.deps);
  assert.equal(typeof h.seen.prompt.onInterrupt, 'function');
  assert.equal(h.seen.prompt.onInterrupt, h.seen.interrupt);
  h.seen.prompt.onInterrupt();
  assert.equal(h.stdout.text(), `\n${paint(COLOR, STOPPED)}\n`);
  assert.match(h.stdout.text(), ESC);
  assert.equal(h.seen.exit, 130);
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('colour follows stdout and NO_COLOR, and arrow-key menus need raw key reading on a TTY', async () => {
  const cases = [
    { name: 'colour terminal', env: {}, color: true, interactive: true },
    { name: 'NO_COLOR', env: { NO_COLOR: '1' }, color: false, interactive: true },
    { name: 'TERM=dumb', env: { TERM: 'dumb' }, color: false, interactive: false },
    { name: 'no raw mode', env: {}, raw: false, color: true, interactive: false },
    { name: 'piped stdout', env: {}, tty: false, color: false, interactive: false },
  ];
  for (const c of cases) {
    const h = colourTerminal(harness({ env: { PATH: '/bin', ...c.env } }), 100);
    if (c.raw === false) delete h.terminal.setRawMode;
    if (c.tty === false) h.stdout.isTTY = false;
    assert.equal(await setupMain('/plugin', h.deps), 0, c.name);
    assert.equal(h.seen.prompt.style.enabled, c.color, c.name);
    assert.equal(h.seen.prompt.interactive, c.interactive, c.name);
    assert.equal(h.seen.runner.paint('✓ ok'), c.color ? paint(COLOR, '✓ ok') : '✓ ok', c.name);
  }
});

test('every printed line is painted by its leading mark, and stays plain under NO_COLOR', async () => {
  const lines = ['✓ Beezi: uploaded 2 sessions.', '⚠ Beezi: 1 hook entry is broken.', '✗ Something went wrong.', '==> Checking your plan…', 'No plan was saved.'];
  const printAll = (ctx) => {
    lines.forEach((line) => ctx.print(line));
    return Promise.resolve(1);
  };
  const colour = colourTerminal(harness({ runSetup: printAll }), 100);
  assert.equal(await setupMain('/plugin', colour.deps), 1);
  assert.equal(colour.stdout.text(), block(lines.map((line) => paint(COLOR, line))));
  assert.notEqual(colour.stdout.text(), block(lines));
  const plain = colourTerminal(harness({ env: { PATH: '/bin', NO_COLOR: '1' }, runSetup: printAll }), 100);
  assert.equal(await setupMain('/plugin', plain.deps), 1);
  assert.equal(plain.stdout.text(), block(lines));
  assert.doesNotMatch(plain.stdout.text(), ESC);
});

test('a finished setup ends with the Codex finale at the terminal width, its fun line picked by random', async () => {
  const wide = colourTerminal(harness({ random: () => 0 }), 100);
  assert.equal(await setupMain('/plugin', wide.deps), 0);
  assert.equal(wide.stdout.text(), block(finaleLines({ agent: 'Codex', style: COLOR, columns: 100, random: () => 0 })));
  assert.ok(wide.stdout.text().includes(FUN_LINES[0]));
  const narrow = colourTerminal(harness({ random: () => 0.99 }), 60);
  assert.equal(await setupMain('/plugin', narrow.deps), 0);
  assert.equal(narrow.stdout.text(), block(finaleLines({ agent: 'Codex', style: COLOR, columns: 60, random: () => 0.99 })));
  const unsized = harness({ env: { PATH: '/bin', NO_COLOR: '1' } });
  assert.equal(await setupMain('/plugin', unsized.deps), 0);
  assert.equal(unsized.stdout.text(), block(finaleLines({ agent: 'Codex', style: PLAIN, columns: 80, random: () => 0 })));
  assert.doesNotMatch(unsized.stdout.text(), ESC);
});

test('by default the cwd is a new, empty beezi-setup- folder in the OS temp dir, deleted afterwards', async () => {
  let cwd = null;
  const h = harness({
    makeTempDir: undefined,
    removeDir: undefined,
    createRunner: (options) => { cwd = options.cwd; return 'run-fn'; },
    runSetup: () => {
      assert.equal(path.dirname(cwd), os.tmpdir());
      assert.match(path.basename(cwd), /^beezi-setup-/);
      assert.deepEqual(fs.readdirSync(cwd), []);
      return Promise.resolve(0);
    },
  });
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.equal(fs.existsSync(cwd), false);
});
