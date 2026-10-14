import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUN_LINES, MARK, WORDMARK, finaleLines } from '../lib/setup-finale.mjs';
import { createStyle } from '../lib/setup-style.mjs';

// The preview's assets and finale(), verbatim except that columns is a parameter.
const DEMO_MARK = [
  '           ▄▄',
  '       ▄▄████',
  '    ▄▄███████',
  '▄▄██████████▀      ▄▄███▄',
  '█████████▀▀     ▄█████████',
  '█████▀▀     ▄▄█████████▀▀',
  '▀▀▀      ▄▄█████████▀▀',
  '      ▄██████████▀      ▄▄',
  '  ▄▄█████████▀▀      ▄████',
  '▄█████████▀▀     ▄▄███████',
  '▀██████▀     ▄▄██████████▀',
  '   ▀▀        █████████▀',
  '             █████▀▀',
  '             █▀▀',
];
const DEMO_WORDMARK = [
  '██████╗ ███████╗███████╗███████╗██╗',
  '██╔══██╗██╔════╝██╔════╝╚══███╔╝██║',
  '██████╔╝█████╗  █████╗    ███╔╝ ██║',
  '██╔══██╗██╔══╝  ██╔══╝   ███╔╝  ██║',
  '██████╔╝███████╗███████╗███████╗██║',
  '╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝',
];
const DEMO_FUN = [
  'The hive is counting your tokens now. You just write the code.',
  'Bee-lieve in yourself. And in your cache hit rate.',
  'A bee visits about 2 million flowers for a pound of honey. Your agent will read fewer files. Probably.',
  'Go ship something. We will keep the receipts.',
  'Buzzing quietly in the background. You will not even notice us.',
  'Pro tip: the cheapest token is the one you never send.',
  'Fresh hive, zero stings. Happy building.',
];

const RESET = '\x1b[0m';
const VIOLETS = [183, 177, 171, 141, 135, 99, 98, 97, 63, 62, 61, 60, 60, 60];
const violet = (row, text) => `\x1b[38;5;${VIOLETS[row]}m${text}${RESET}`;
const bold = (text) => `\x1b[1m${text}${RESET}`;
const dim = (text) => `\x1b[2m${text}${RESET}`;
const green = (text) => `\x1b[1;32m${text}${RESET}`;

function banner(agent, color) {
  const paint = color ? violet : (row, text) => text;
  const strong = color ? bold : (text) => text;
  const soft = color ? dim : (text) => text;
  const markWidth = 27;
  const lines = DEMO_MARK.map((row, i) => {
    const left = paint(i, row.padEnd(markWidth));
    const w = i - 3;
    if (w >= 0 && w < DEMO_WORDMARK.length) return `  ${left}  ${strong(DEMO_WORDMARK[w])}`;
    if (i === 10) return `  ${left}  ${soft('×')} ${strong(agent)}`;
    return `  ${left}`;
  });
  return lines.join('\n');
}

function finale(agent, color, fun, columns) {
  const ok = color ? green : (text) => text;
  const soft = color ? dim : (text) => text;
  const head = columns >= 72
    ? banner(agent, color)
    : `  ${color ? violet(3, '▰') : '▰'} beezi × ${agent}`;
  return [
    '',
    head,
    '',
    `  ${ok('✔ Everything is set up. Happy hacking! =)')}`,
    `  Open ${agent} and keep working — restart it first if it was already open.`,
    `  ${soft(`🐝 ${fun}`)}`,
    '',
  ].join('\n');
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (agent, color, columns, random) => finaleLines({ agent, style: createStyle({ enabled: color }), columns, random });

test('the mark, wordmark and fun lines are exactly the preview ones', () => {
  assert.deepEqual(MARK, DEMO_MARK);
  assert.deepEqual(WORDMARK, DEMO_WORDMARK);
  assert.deepEqual(FUN_LINES, DEMO_FUN);
});

test('wide colour output matches the preview byte for byte for both agents', () => {
  ['Claude Code', 'Codex'].forEach((agent) => {
    assert.deepEqual(lines(agent, true, 80, () => 0), finale(agent, true, DEMO_FUN[0], 80).split('\n'), agent);
    assert.deepEqual(lines(agent, true, 72, () => 0.99), finale(agent, true, DEMO_FUN[6], 72).split('\n'), agent);
  });
});

test('wide output puts the wordmark beside mark rows 3-8 and "× <agent>" beside row 10', () => {
  const out = lines('Claude Code', true, 100, () => 0);
  assert.equal(out.length, 20);
  assert.equal(out[0], '');
  assert.equal(out[4], '  \x1b[38;5;141m▄▄██████████▀      ▄▄███▄  \x1b[0m  \x1b[1m██████╗ ███████╗███████╗███████╗██╗\x1b[0m');
  assert.equal(out[11], '  \x1b[38;5;61m▀██████▀     ▄▄██████████▀ \x1b[0m  \x1b[2m×\x1b[0m \x1b[1mClaude Code\x1b[0m');
  assert.equal(out[15], '');
  assert.equal(out[16], '  \x1b[1;32m✔ Everything is set up. Happy hacking! =)\x1b[0m');
  assert.equal(out[17], '  Open Claude Code and keep working — restart it first if it was already open.');
  assert.equal(out[18], `  \x1b[2m🐝 ${DEMO_FUN[0]}\x1b[0m`);
  assert.equal(out[19], '');
});

test('under 72 columns the art becomes one ▰ line', () => {
  assert.deepEqual(lines('Codex', true, 71, () => 0.5), finale('Codex', true, DEMO_FUN[3], 71).split('\n'));
  assert.equal(lines('Codex', true, 71, () => 0.5)[1], '  \x1b[38;5;141m▰\x1b[0m beezi × Codex');
  assert.deepEqual(lines('Codex', false, 40, () => 0.5), [
    '',
    '  ▰ beezi × Codex',
    '',
    '  ✔ Everything is set up. Happy hacking! =)',
    '  Open Codex and keep working — restart it first if it was already open.',
    `  🐝 ${DEMO_FUN[3]}`,
    '',
  ]);
});

test('with colour off the same art prints in plain characters', () => {
  const out = lines('Claude Code', false, 80, () => 0);
  assert.deepEqual(out, finale('Claude Code', false, DEMO_FUN[0], 80).split('\n'));
  assert.ok(out.every((line) => line.indexOf('\x1b') === -1));
  assert.deepEqual(out, lines('Claude Code', true, 80, () => 0).map(plain));
  assert.equal(out[1], `  ${MARK[0]}${' '.repeat(14)}`);
});

test('the fun line is picked with the injected random', () => {
  DEMO_FUN.forEach((fun, i) => {
    const out = lines('Codex', false, 80, () => (i + 0.5) / DEMO_FUN.length);
    assert.equal(out[out.length - 2], `  🐝 ${fun}`);
  });
});

test('every art row fits 72 columns', () => {
  ['Claude Code', 'Codex'].forEach((agent) => {
    [true, false].forEach((color) => {
      const art = lines(agent, color, 72, () => 0).slice(1, 1 + MARK.length);
      assert.equal(art.length, 14);
      art.forEach((row) => assert.ok(Array.from(plain(row)).length <= 72, row));
    });
  });
  assert.ok(MARK.every((row) => Array.from(row).length <= 27));
});
