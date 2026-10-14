import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompt, openTerminal, parseNumbers, renderOptions } from '../lib/setup-prompt.mjs';

const OPTIONS = [
  { label: 'Ask me (recommended)', description: 'Beezi asks once' },
  { label: 'Send to…' },
  { label: "Don't send", description: 'Nothing is uploaded' },
];

function harness() {
  const input = new PassThrough();
  const written = [];
  const prompt = createPrompt({ input, output: { write: (s) => { written.push(s); } } });
  const type = (line) => new Promise((resolve) => {
    setImmediate(() => {
      input.write(`${line}\n`);
      setImmediate(resolve);
    });
  });
  return { input, written, prompt, type, text: () => written.join('') };
}

test('parseNumbers reads comma lists, drops duplicates and rejects out-of-range parts', () => {
  assert.deepEqual(parseNumbers('1, 3', 3), [0, 2]);
  assert.deepEqual(parseNumbers('2,2', 3), [1]);
  assert.deepEqual(parseNumbers('', 3), []);
  assert.equal(parseNumbers('4', 3), null);
  assert.equal(parseNumbers('0', 3), null);
  assert.equal(parseNumbers('1,x', 3), null);
  assert.equal(parseNumbers('1.5', 3), null);
});

test('renderOptions numbers options, marks the default and appends descriptions', () => {
  assert.deepEqual(renderOptions(OPTIONS, 0), [
    '  1) Ask me (recommended) (default) — Beezi asks once',
    '  2) Send to…',
    "  3) Don't send — Nothing is uploaded",
  ]);
  assert.equal(renderOptions(OPTIONS, -1)[0], '  1) Ask me (recommended) — Beezi asks once');
});

test('choose returns the picked index and shows the question with numbered options', async () => {
  const h = harness();
  const answer = h.prompt.choose('Where should analytics go?', OPTIONS);
  await h.type('2');
  assert.equal(await answer, 1);
  assert.match(h.text(), /Where should analytics go\?\n {2}1\) Ask me/);
  assert.match(h.text(), /Choose 1-3, or press Enter to skip: $/);
  h.prompt.close();
});

test('choose takes the default on Enter and re-asks after an invalid answer', async () => {
  const h = harness();
  const first = h.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await h.type('');
  assert.equal(await first, 0);
  const second = h.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await h.type('9');
  await h.type('1,2');
  await h.type('3');
  assert.equal(await second, 2);
  assert.equal(h.text().split('Enter one number from 1 to 3.').length - 1, 2);
  assert.match(h.text(), /Choose 1-3 \[1\]: /);
  h.prompt.close();
});

test('choose without a default skips on Enter and re-asks after an invalid answer', async () => {
  const h = harness();
  const skipped = h.prompt.choose('Q?', OPTIONS);
  await h.type('');
  assert.equal(await skipped, null);
  assert.match(h.text(), /Choose 1-3, or press Enter to skip: $/);
  const retry = h.prompt.choose('Q?', OPTIONS);
  await h.type('9');
  await h.type('1');
  assert.equal(await retry, 0);
  assert.match(h.text(), /Enter one number from 1 to 3\./);
  h.prompt.close();
});

test('chooseMany returns every picked index, [] on Enter, and re-asks on bad input', async () => {
  const h = harness();
  const many = h.prompt.chooseMany('Which workspaces?', OPTIONS);
  await h.type('3, 1');
  assert.deepEqual(await many, [2, 0]);
  const none = h.prompt.chooseMany('Which workspaces?', OPTIONS);
  await h.type('');
  assert.deepEqual(await none, []);
  const retry = h.prompt.chooseMany('Which workspaces?', OPTIONS);
  await h.type('7');
  await h.type('2');
  assert.deepEqual(await retry, [1]);
  assert.match(h.text(), /Enter numbers from 1 to 3, separated by commas\./);
  h.prompt.close();
});

test('confirm honours the default and accepts y/yes/n/no in any case', async () => {
  const h = harness();
  const enterYes = h.prompt.confirm('Upload?', true);
  await h.type('');
  assert.equal(await enterYes, true);
  const enterNo = h.prompt.confirm('Switch?', false);
  await h.type('');
  assert.equal(await enterNo, false);
  const typed = h.prompt.confirm('Switch?', false);
  await h.type('maybe');
  await h.type('YES');
  assert.equal(await typed, true);
  assert.match(h.text(), /Upload\? \[Y\/n\] /);
  assert.match(h.text(), /Switch\? \[y\/N\] /);
  assert.match(h.text(), /Answer y or n\./);
  h.prompt.close();
});

test('text returns the trimmed answer and null for an empty one', async () => {
  const h = harness();
  const typed = h.prompt.text('Email or account id:');
  await h.type('  dev@example.com ');
  assert.equal(await typed, 'dev@example.com');
  const empty = h.prompt.text('Email or account id:');
  await h.type('');
  assert.equal(await empty, null);
  h.prompt.close();
});

test('EOF dismisses the pending question and every later one', async () => {
  const h = harness();
  const pending = h.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  setImmediate(() => h.input.end());
  assert.equal(await pending, null);
  assert.equal(await h.prompt.chooseMany('Q?', OPTIONS), null);
  assert.equal(await h.prompt.confirm('Q?', true), null);
  assert.equal(await h.prompt.text('Q?'), null);
});

test('after EOF no later question writes its menu or query', async () => {
  const h = harness();
  const pending = h.prompt.confirm('Q?', true);
  setImmediate(() => h.input.end());
  assert.equal(await pending, null);
  const before = h.text();
  assert.equal(await h.prompt.choose('Later?', OPTIONS, { defaultIndex: 0 }), null);
  assert.equal(await h.prompt.choose('Later?', OPTIONS), null);
  assert.equal(await h.prompt.chooseMany('Later?', OPTIONS), null);
  assert.equal(await h.prompt.confirm('Later?', false), null);
  assert.equal(await h.prompt.text('Later?'), null);
  assert.equal(h.text(), before);
});

test('lines typed while no question is pending are dropped', async () => {
  const h = harness();
  h.input.write('2\n');
  await new Promise((resolve) => setImmediate(resolve));
  const answer = h.prompt.choose('Q?', OPTIONS);
  await h.type('3');
  assert.equal(await answer, 2);
  h.prompt.close();
});

test('openTerminal prefers a TTY stdin, falls back to /dev/tty off Windows, else null', () => {
  const ttyStdin = { isTTY: true };
  const piped = { isTTY: false };
  const devTty = { fromDevTty: true };
  assert.equal(openTerminal({ stdin: ttyStdin, platform: 'darwin', openTty: () => devTty }), ttyStdin);
  assert.equal(openTerminal({ stdin: piped, platform: 'linux', openTty: () => devTty }), devTty);
  assert.equal(openTerminal({ stdin: piped, platform: 'win32', openTty: () => devTty }), null);
  assert.equal(openTerminal({ stdin: piped, platform: 'linux', openTty: () => { throw new Error('ENXIO'); } }), null);
});
