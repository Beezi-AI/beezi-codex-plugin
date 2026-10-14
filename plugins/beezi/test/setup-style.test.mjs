import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadKeys, colorEnabled, createStyle, paint } from '../lib/setup-style.mjs';

const on = createStyle({ enabled: true });
const off = createStyle({ enabled: false });
const NAMES = ['bold', 'dim', 'cyan', 'boldCyan', 'blue', 'green', 'boldGreen', 'yellow', 'red'];

test('createStyle wraps text in the contract escape codes when enabled', () => {
  assert.equal(on.enabled, true);
  assert.equal(on.bold('a'), '\x1b[1ma\x1b[0m');
  assert.equal(on.dim('a'), '\x1b[2ma\x1b[0m');
  assert.equal(on.cyan('a'), '\x1b[36ma\x1b[0m');
  assert.equal(on.boldCyan('a'), '\x1b[1;36ma\x1b[0m');
  assert.equal(on.blue('a'), '\x1b[1;34ma\x1b[0m');
  assert.equal(on.green('a'), '\x1b[32ma\x1b[0m');
  assert.equal(on.boldGreen('a'), '\x1b[1;32ma\x1b[0m');
  assert.equal(on.yellow('a'), '\x1b[33ma\x1b[0m');
  assert.equal(on.red('a'), '\x1b[31ma\x1b[0m');
});

test('violet maps each mark row onto the light-to-deep 256-colour ramp', () => {
  const ramp = [183, 177, 171, 141, 135, 99, 98, 97, 63, 62, 61, 60, 60, 60];
  ramp.forEach((code, level) => {
    assert.equal(on.violet(level, '▄'), `\x1b[38;5;${code}m▄\x1b[0m`);
  });
});

test('createStyle returns text unchanged when disabled', () => {
  assert.equal(off.enabled, false);
  NAMES.forEach((name) => assert.equal(off[name]('plain'), 'plain', name));
  assert.equal(off.violet(4, 'plain'), 'plain');
});

test('paint colours a line by its leading mark and keeps the leading whitespace', () => {
  assert.equal(paint(on, '✓ Beezi: uploaded 12 sessions.'), '\x1b[32m✓ Beezi: uploaded 12 sessions.\x1b[0m');
  assert.equal(paint(on, '  ⚠ Slow network'), '  \x1b[33m⚠ Slow network\x1b[0m');
  assert.equal(paint(on, '✗ That step stopped unexpectedly.'), '\x1b[31m✗ That step stopped unexpectedly.\x1b[0m');
  assert.equal(paint(on, 'Setup stopped. Run the installer again.'), '\x1b[31mSetup stopped. Run the installer again.\x1b[0m');
  assert.equal(paint(on, '\nSetup stopped. Run the installer again.'), '\n\x1b[31mSetup stopped. Run the installer again.\x1b[0m');
  assert.equal(paint(on, '==> Checking your plan…'), '\x1b[1;34m==>\x1b[0m Checking your plan…');
  assert.equal(paint(on, '  ==> Looking at your past sessions…'), '  \x1b[1;34m==>\x1b[0m Looking at your past sessions…');
});

test('paint leaves other lines unchanged', () => {
  assert.equal(paint(on, 'Beezi: 4/12 sessions read…'), 'Beezi: 4/12 sessions read…');
  assert.equal(paint(on, '==>no space'), '==>no space');
  assert.equal(paint(on, 'Done ✓'), 'Done ✓');
  assert.equal(paint(on, ''), '');
});

test('paint leaves every line unchanged when colour is off', () => {
  ['✓ ok', '  ⚠ warn', '✗ bad', 'Setup stopped.', '\nSetup stopped.', '==> Checking your plan…', 'plain'].forEach((line) => {
    assert.equal(paint(off, line), line);
  });
});

test('colorEnabled needs a TTY stream, no NO_COLOR and a TERM other than dumb', () => {
  const ttyStream = { isTTY: true };
  assert.equal(colorEnabled({ stream: ttyStream, env: {} }), true);
  assert.equal(colorEnabled({ stream: ttyStream, env: { TERM: 'xterm-256color' } }), true);
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: {} }), false);
  assert.equal(colorEnabled({ stream: {}, env: {} }), false);
  assert.equal(colorEnabled({ stream: ttyStream, env: { NO_COLOR: '1' } }), false);
  assert.equal(colorEnabled({ stream: ttyStream, env: { TERM: 'dumb' } }), false);
});

test('canReadKeys needs a raw-capable TTY input, a TTY output and a TERM other than dumb', () => {
  const input = { isTTY: true, setRawMode: () => {} };
  const output = { isTTY: true };
  assert.equal(canReadKeys({ input, output, env: {} }), true);
  assert.equal(canReadKeys({ input: { isTTY: false, setRawMode: () => {} }, output, env: {} }), false);
  assert.equal(canReadKeys({ input: { isTTY: true }, output, env: {} }), false);
  assert.equal(canReadKeys({ input, output: { isTTY: false }, env: {} }), false);
  assert.equal(canReadKeys({ input, output: {}, env: {} }), false);
  assert.equal(canReadKeys({ input, output, env: { TERM: 'dumb' } }), false);
});
