import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompt } from '../lib/setup-prompt.mjs';
import { createStyle } from '../lib/setup-style.mjs';

const OPTIONS = [
  { label: 'Ask me (recommended)', description: 'Beezi asks once' },
  { label: 'Send to…' },
  { label: "Don't send", description: 'Nothing is uploaded' },
];
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ERASE_MENU = '\x1b[5A\x1b[0J';
const ERASE_ROW = '\x1b[1A\x1b[0J';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const ESC_WAIT_MS = 600;
const COLOR = createStyle({ enabled: true });

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const count = (text, part) => text.split(part).length - 1;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake terminal: a TTY input with a setRawMode spy and an output collector with a width.
function terminal(opts) {
  const o = opts || {};
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = o.setRawMode || ((on) => { raw.push(on); return input; });
  const written = [];
  const interrupts = [];
  const output = { columns: o.columns || 80, rows: o.rows, write: (s) => { written.push(s); return true; } };
  const prompt = createPrompt({
    input,
    output,
    style: o.style,
    interactive: o.interactive === undefined ? true : o.interactive,
    onInterrupt: () => { interrupts.push({ raw: raw.slice(), text: written.join('') }); },
  });
  const press = async (...keys) => {
    for (const key of keys) {
      await tick();
      input.write(key);
      await tick();
    }
  };
  return {
    input, raw, interrupts, prompt, press,
    type: (line) => press(`${line}\n`),
    text: () => written.join(''),
  };
}

test('choose draws the question, a ❯ on the default and the hint, then collapses to one ✔ line', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Where?', OPTIONS, { defaultIndex: 1 });
  await t.press('\r');
  assert.equal(await answer, 1);
  assert.equal(t.text(), [
    HIDE,
    '? Where?\n',
    '  Ask me (recommended) — Beezi asks once\n',
    '❯ Send to…\n',
    "  Don't send — Nothing is uploaded\n",
    '  ↑/↓ move · Enter select\n',
    ERASE_MENU,
    '✔ Where? Send to…\n',
    SHOW,
  ].join(''));
  assert.deepEqual(t.raw, [true, false]);
  t.prompt.close();
});

test('arrows and k/j move the highlight with wrap-around, and Enter submits it', async () => {
  const t = terminal();
  const up = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press(UP, '\r');
  assert.equal(await up, 2);
  const down = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press(DOWN, 'j', 'k', DOWN, DOWN, '\r');
  assert.equal(await down, 0);
  t.prompt.close();
});

test('a digit moves the highlight without submitting, out-of-range digits are ignored, and \\n also submits', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('3');
  assert.equal(count(t.text(), '✔'), 0);
  await t.press('9', '0', '\r');
  assert.equal(await answer, 2);
  const typed = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('2\r');
  assert.equal(await typed, 1);
  const newline = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('2\n');
  assert.equal(await newline, 1);
  t.prompt.close();
});

test('each change redraws over exactly the rows drawn, and ignored keys draw nothing', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press(DOWN, 'x', ',', ' ', DOWN, '\r');
  assert.equal(await answer, 2);
  const out = t.text();
  assert.equal(count(out, ERASE_MENU), 3);
  assert.equal((out.match(/\x1b\[\d+A/g) || []).length, 3);
  assert.equal(count(out, '? Q?\n'), 3);
});

test('the question, options and hint are cut to one row with …', async () => {
  const t = terminal({ columns: 24 });
  const options = [
    { label: 'Acme', description: 'Owner of the workspace' },
    { label: 'A workspace with a very long name', description: 'Member' },
  ];
  const one = t.prompt.choose('Where should analytics for this repo go?', options, { defaultIndex: 0 });
  await t.press('\r');
  assert.equal(await one, 0);
  const many = t.prompt.chooseMany('Which workspaces should get analytics?', options);
  await t.press('\r');
  assert.deepEqual(await many, []);
  const yes = t.prompt.confirm('Show Beezi in the status line?', true);
  await t.press('y', '\r');
  assert.equal(await yes, true);
  assert.deepEqual(plain(t.text()).split('\n'), [
    '? Where should analyti…',
    '❯ Acme — Owner of the …',
    '  A workspace with a v…',
    '  ↑/↓ move · Enter sel…',
    '✔ Where should analytics for this repo go? Acme',
    '? Which workspaces sho…',
    '❯ ◯ Acme — Owner of th…',
    '  ◯ A workspace with a…',
    '  ↑/↓ move · Space sel…',
    '✔ Which workspaces should get analytics? skipped',
    '? Show Beezi i… [Y/n]',
    '? Show Beezi i… [Y/n] y',
    '✔ Show Beezi in the status line? Yes',
    '',
  ]);
  assert.equal(count(t.text(), '\x1b[4A\x1b[0J'), 2);
  assert.equal(count(t.text(), ERASE_ROW), 2);
});

test('wide characters count as two columns, so a CJK label is cut to fit and the redraw erases the drawn rows', async () => {
  const t = terminal({ columns: 13 });
  const answer = t.prompt.choose('Q?', [{ label: '工作区名称很长' }, { label: 'B' }], { defaultIndex: 0 });
  await t.press(DOWN, '\r');
  assert.equal(await answer, 1);
  assert.deepEqual(plain(t.text()).split('\n'), [
    '? Q?',
    '❯ 工作区名…',
    '  B',
    '  ↑/↓ move …',
    '? Q?',
    '  工作区名…',
    '❯ B',
    '  ↑/↓ move …',
    '✔ Q? B',
    '',
  ]);
  assert.equal(count(t.text(), '\x1b[4A\x1b[0J'), 2);
  assert.equal((t.text().match(/\x1b\[\d+A/g) || []).length, 2);
});

test('consecutive digits compose one option number live, and any other key starts a new number', async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i + 1}` }));
  const t = terminal();
  const one = t.prompt.choose('Q?', twelve, { defaultIndex: 0 });
  await t.press('1', '2');
  assert.match(t.text(), /❯ Option 12\n/);
  await t.press('\r');
  assert.equal(await one, 11);
  assert.match(t.text(), /✔ Q\? Option 12\n/);
  const many = t.prompt.chooseMany('Which?', twelve);
  await t.press('10,12\r');
  assert.deepEqual(await many, [9, 11]);
  const mixed = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press(DOWN, ' ', '3', '\r');
  assert.deepEqual(await mixed, [1, 2]);
  const moved = t.prompt.choose('Q?', twelve, { defaultIndex: 0 });
  await t.press('1', '2', DOWN, '\r');
  assert.equal(await moved, 0);
  const single = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('2\r');
  assert.equal(await single, 1);
  const pair = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('1,3\r');
  assert.deepEqual(await pair, [0, 2]);
  t.prompt.close();
});

test('a menu as tall as the terminal uses the typed prompt for that question only', async () => {
  const short = terminal({ rows: 5 });
  const typed = short.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await short.type('3');
  assert.equal(await typed, 2);
  assert.match(short.text(), /Choose 1-3 \[1\]: /);
  const many = short.prompt.chooseMany('Which?', OPTIONS);
  await short.type('1,3');
  assert.deepEqual(await many, [0, 2]);
  assert.deepEqual(short.raw, []);
  const yes = short.prompt.confirm('Upload?', true);
  await short.press('\r');
  assert.equal(await yes, true);
  assert.deepEqual(short.raw, [true, false]);
  short.prompt.close();
  const tall = terminal({ rows: 6 });
  const keyed = tall.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await tall.press('\r');
  assert.equal(await keyed, 0);
  assert.deepEqual(tall.raw, [true, false]);
  tall.prompt.close();
});

test('chooseMany with no options returns [] without drawing or touching raw mode', async () => {
  const keyed = terminal();
  assert.deepEqual(await keyed.prompt.chooseMany('Which?', []), []);
  assert.deepEqual(keyed.raw, []);
  assert.equal(keyed.text(), '');
  keyed.prompt.close();
  const typed = terminal({ interactive: false });
  assert.deepEqual(await typed.prompt.chooseMany('Which?', []), []);
  assert.equal(typed.text(), '');
  typed.prompt.close();
});

test('an exception inside a key question restores raw mode and the cursor, rejects, and later questions still work', async () => {
  const t = terminal();
  let reads = 0;
  const flaky = { get label() { reads += 1; if (reads > 1) throw new Error('bad label'); return 'A'; } };
  const onKey = t.prompt.choose('Q?', [flaky], { defaultIndex: 0 });
  const onKeyFailed = assert.rejects(onKey, /bad label/);
  await t.press('\r');
  await onKeyFailed;
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  const broken = { get label() { throw new Error('no label'); } };
  await assert.rejects(t.prompt.choose('Q?', [broken], { defaultIndex: 0 }), /no label/);
  assert.deepEqual(t.raw, [true, false, true, false]);
  assert.ok(t.text().endsWith(SHOW));
  const typed = t.prompt.text('Email or account id:');
  await t.type('dev');
  assert.equal(await typed, 'dev');
  t.prompt.close();
});

test('Esc skips a choice that has no default, and Enter still submits option 1', async () => {
  const t = terminal();
  const skipped = t.prompt.choose('Q?', OPTIONS);
  await t.press(ESC);
  assert.equal(await skipped, null);
  assert.match(t.text(), /  ↑\/↓ move · Enter select · Esc skip\n/);
  assert.match(t.text(), /✔ Q\? skipped\n/);
  const first = t.prompt.choose('Q?', OPTIONS);
  await t.press('\r');
  assert.equal(await first, 0);
  t.prompt.close();
});

test('Esc is ignored when the choice has a default', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 2 });
  await t.press(ESC);
  await sleep(ESC_WAIT_MS);
  assert.equal(count(t.text(), '✔'), 0);
  await t.press('\r');
  assert.equal(await answer, 2);
  t.prompt.close();
});

test('keys typed in a menu never reach a later text answer', async () => {
  const t = terminal();
  const skipped = t.prompt.choose('Q?', OPTIONS);
  await t.press('2', ESC);
  assert.equal(await skipped, null);
  const typed = t.prompt.text('Email or account id:');
  await t.type('  dev@example.com ');
  assert.equal(await typed, 'dev@example.com');
  assert.deepEqual(t.raw, [true, false]);
  t.prompt.close();
});

test('chooseMany toggles with Space and digits, ignores commas, and returns sorted picks', async () => {
  const t = terminal();
  const spaced = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press(' ', DOWN, DOWN, ' ', '\r');
  assert.deepEqual(await spaced, [0, 2]);
  assert.match(t.text(), /❯ ◉ Ask me \(recommended\) — Beezi asks once\n/);
  assert.match(t.text(), /✔ Which\? Ask me \(recommended\), Don't send\n/);
  const typed = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('1,3\r');
  assert.deepEqual(await typed, [0, 2]);
  const untick = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('3', '1', '3', '\r');
  assert.deepEqual(await untick, [0]);
  assert.match(t.text(), /  ↑\/↓ move · Space select · Enter confirm \(nothing selected = skip\)\n/);
  t.prompt.close();
});

test('chooseMany with nothing ticked, or dismissed with Esc, returns [] and shows skipped', async () => {
  const t = terminal();
  const none = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('\r');
  assert.deepEqual(await none, []);
  const dismissed = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press(' ', ESC);
  assert.deepEqual(await dismissed, []);
  assert.equal(count(t.text(), '✔ Which? skipped\n'), 2);
  t.prompt.close();
});

test('confirm keeps the literal [Y/n], sets the answer with y/n, and submits on Enter', async () => {
  const t = terminal();
  const enter = t.prompt.confirm('Upload?', true);
  await t.press('\r');
  assert.equal(await enter, true);
  const no = t.prompt.confirm('Switch?', false);
  await t.press('x', 'y', 'n', '\r');
  assert.equal(await no, false);
  const yes = t.prompt.confirm('Switch?', false);
  await t.press('Y', '\r');
  assert.equal(await yes, true);
  const out = t.text();
  assert.match(out, /\? Upload\? \[Y\/n\]\n/);
  assert.match(out, /\? Switch\? \[y\/N\] n\n/);
  assert.match(out, /✔ Upload\? Yes\n/);
  assert.match(out, /✔ Switch\? No\n/);
  assert.match(out, /✔ Switch\? Yes\n/);
  assert.equal(count(out, ERASE_ROW), 6);
  t.prompt.close();
});

test('Ctrl+C restores raw mode and the cursor, then calls onInterrupt', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('\x03');
  assert.equal(await answer, null);
  assert.equal(t.interrupts.length, 1);
  assert.deepEqual(t.interrupts[0].raw, [true, false]);
  assert.ok(t.interrupts[0].text.endsWith(SHOW));
  assert.equal(count(t.text(), '✔'), 0);
  t.prompt.close();
});

test('raw mode is on only while a question is open, and lines typed between questions are dropped', async () => {
  const t = terminal();
  const first = t.prompt.confirm('One?', true);
  await t.press('\r');
  assert.equal(await first, true);
  assert.deepEqual(t.raw, [true, false]);
  await t.type('stray');
  const second = t.prompt.choose('Two?', OPTIONS, { defaultIndex: 0 });
  assert.deepEqual(t.raw, [true, false, true]);
  await t.press('\r');
  assert.equal(await second, 0);
  assert.deepEqual(t.raw, [true, false, true, false]);
  const typed = t.prompt.text('Email or account id:');
  await t.type('dev');
  assert.equal(await typed, 'dev');
  assert.deepEqual(t.raw, [true, false, true, false]);
  assert.equal(count(t.text(), HIDE), 2);
  assert.equal(count(t.text(), SHOW), 2);
  t.prompt.close();
});

test('EOF during a key question restores the terminal and dismisses it and every later one', async () => {
  const t = terminal();
  const pending = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  setImmediate(() => t.input.end());
  assert.equal(await pending, null);
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  const before = t.text();
  assert.equal(await t.prompt.chooseMany('Later?', OPTIONS), null);
  assert.equal(await t.prompt.confirm('Later?', true), null);
  assert.equal(await t.prompt.text('Later?'), null);
  assert.equal(t.text(), before);
  assert.deepEqual(t.raw, [true, false]);
});

test('close dismisses an open question, can be repeated, and stops reading the terminal', async () => {
  const t = terminal();
  const pending = t.prompt.confirm('Q?', true);
  t.prompt.close();
  assert.equal(await pending, null);
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  t.prompt.close();
  assert.equal(t.input.isPaused(), true);
  assert.equal(await t.prompt.choose('Later?', OPTIONS), null);
  const fresh = terminal();
  fresh.prompt.close();
  assert.equal(fresh.input.isPaused(), true);
  assert.equal(fresh.input.listenerCount('data'), 0);
});

test('a setRawMode that throws falls back to typed prompts for this and every later question', async () => {
  const calls = [];
  const t = terminal({ setRawMode: (on) => { calls.push(on); throw new Error('EIO'); } });
  const first = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.type('2');
  assert.equal(await first, 1);
  const second = t.prompt.confirm('Upload?', true);
  await t.type('n');
  assert.equal(await second, false);
  assert.deepEqual(calls, [true]);
  assert.match(t.text(), /Choose 1-3 \[1\]: /);
  assert.match(t.text(), /Upload\? \[Y\/n\] /);
  assert.equal(count(t.text(), HIDE), 0);
  t.prompt.close();
});

test('non-interactive mode never touches raw mode, even on a TTY', async () => {
  const t = terminal({ interactive: false });
  const answer = t.prompt.choose('Q?', OPTIONS);
  await t.type('3');
  assert.equal(await answer, 2);
  assert.deepEqual(t.raw, []);
  assert.match(t.text(), /Choose 1-3, or press Enter to skip: $/);
  t.prompt.close();
});

test('with colour on, the menu and the ✔ line use the contract styles', async () => {
  const t = terminal({ style: COLOR });
  const answer = t.prompt.choose('Q?', OPTIONS, { defaultIndex: 0 });
  await t.press('\r');
  assert.equal(await answer, 0);
  const many = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('\r');
  assert.deepEqual(await many, []);
  const yes = t.prompt.confirm('Upload?', true);
  await t.press('\r');
  assert.equal(await yes, true);
  const out = t.text();
  assert.ok(out.includes('\x1b[1;36m?\x1b[0m \x1b[1mQ?\x1b[0m\n'));
  assert.ok(out.includes('\x1b[36m❯\x1b[0m \x1b[36mAsk me (recommended)\x1b[0m\x1b[2m — Beezi asks once\x1b[0m\n'));
  assert.ok(out.includes('\n  Send to…\n'));
  assert.ok(out.includes('\x1b[2m  ↑/↓ move · Enter select\x1b[0m\n'));
  assert.ok(out.includes('\x1b[32m✔\x1b[0m \x1b[1mQ?\x1b[0m \x1b[36mAsk me (recommended)\x1b[0m\n'));
  assert.ok(out.includes('\x1b[36m❯\x1b[0m \x1b[2m◯\x1b[0m \x1b[36mAsk me (recommended)\x1b[0m'));
  assert.ok(out.includes('\x1b[32m✔\x1b[0m \x1b[1mWhich?\x1b[0m \x1b[2mskipped\x1b[0m\n'));
  assert.ok(out.includes('\x1b[1;36m?\x1b[0m \x1b[1mUpload?\x1b[0m \x1b[1;36m[Y/n]\x1b[0m\n'));
  assert.ok(out.includes('\x1b[32m✔\x1b[0m \x1b[1mUpload?\x1b[0m \x1b[36mYes\x1b[0m\n'));
  t.prompt.close();
});

// Runs one typed session (choose and confirm with a re-ask, chooseMany with a re-ask, text) and returns its output.
async function typedSession(style) {
  const input = new PassThrough();
  const written = [];
  const prompt = createPrompt({ input, output: { write: (s) => { written.push(s); } }, style });
  const type = async (line) => {
    await tick();
    input.write(`${line}\n`);
    await tick();
  };
  const choice = prompt.choose('Where?', OPTIONS, { defaultIndex: 0 });
  await type('9');
  await type('2');
  assert.equal(await choice, 1);
  const many = prompt.chooseMany('Which?', OPTIONS);
  await type('x');
  await type('1,3');
  assert.deepEqual(await many, [0, 2]);
  const yes = prompt.confirm('Upload?', false);
  await type('maybe');
  await type('y');
  assert.equal(await yes, true);
  const email = prompt.text('Email or account id:');
  await type('dev@example.com');
  assert.equal(await email, 'dev@example.com');
  prompt.close();
  return written.join('');
}

test('typed prompts with colour on differ from today\'s bytes only by escape codes', async () => {
  const styled = await typedSession(COLOR);
  const unstyled = await typedSession(undefined);
  assert.notEqual(styled, unstyled);
  assert.equal(plain(styled), unstyled);
  assert.ok(styled.includes('\n\x1b[1mWhere?\x1b[0m\n'));
  assert.ok(styled.includes('  1) Ask me (recommended)\x1b[2m (default)\x1b[0m\x1b[2m — Beezi asks once\x1b[0m\n'));
  assert.ok(styled.includes('\x1b[1;36mChoose 1-3 [1]:\x1b[0m '));
  assert.ok(styled.includes('\x1b[33mEnter one number from 1 to 3.\x1b[0m\n'));
  assert.ok(styled.includes('\x1b[1;36mChoose one or more (for example 1,3), or press Enter to skip:\x1b[0m '));
  assert.ok(styled.includes('\x1b[33mEnter numbers from 1 to 3, separated by commas.\x1b[0m\n'));
  assert.ok(styled.includes('\n\x1b[1mUpload?\x1b[0m \x1b[1;36m[y/N]\x1b[0m '));
  assert.ok(styled.includes('\x1b[33mAnswer y or n.\x1b[0m\n'));
  assert.ok(styled.includes('\n\x1b[1mEmail or account id:\x1b[0m '));
});
