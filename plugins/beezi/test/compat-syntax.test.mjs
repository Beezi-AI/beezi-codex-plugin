import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// The plugin's runtime floor is Node 13.2 — the first version that runs .mjs unflagged. Everything
// under lib/ and scripts/ must parse and run there; this test is the regression lock. It is a
// lexical scan, not a parser: comments and string/template contents are stripped first, then each
// banned construct is grepped for. test/ itself is exempt and stays on modern Node.
//
// Two properties this file has to hold, in this order:
//   1. Every check must actually fire on the construct it names. A typo in a matcher, or an
//      exemption list widened by accident, would make the gate pass silently on a clean repo and
//      keep passing forever. The fixture pairs under test/fixtures/compat/ prove each one.
//   2. The stripper must not lose its place. A desynced lexer does not report a false failure — it
//      goes quiet, and every ban downstream of the desync stops existing. See the stripper's own
//      comment for the desync that was found and fixed here.

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const fixtureDir = path.join(pluginRoot, 'test', 'fixtures', 'compat');

function runtimeFiles() {
  const out = [];
  for (const dir of ['lib', 'scripts']) {
    for (const name of fs.readdirSync(path.join(pluginRoot, dir))) {
      if (name.endsWith('.mjs')) out.push(path.join(dir, name));
    }
  }
  return out;
}

// Keywords after which a `/` can only begin a regex literal, never a division: none of them can
// end an expression, so what follows must be the start of a new one.
const REGEX_AFTER_KEYWORD = [
  'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'delete', 'void', 'yield', 'await',
  'throw', 'do', 'else',
];

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    || ch === '_' || ch === '$';
}

// The identifier immediately before the current position, or '' when that identifier is a property
// name. The `.` guard matters because `of` and `in` are not reserved words: `obj.of / 2` is a
// division, and only the guard keeps it from being read as the start of a regex.
function tailWord(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  if (start > 0 && text[start - 1] === '.') return '';
  return text.slice(start, end);
}

// Blank out comments, string literals and template contents so bans only fire on real code.
// Template interpolations survive (their contents are code); the rest of the template dies.
// Naive lexer, good enough for this codebase's style.
//
// THE DESYNC THIS FIXES (G-10-4 Hole 1). `lastSig` is the last significant code character and
// decides whether a `/` opens a regex literal or is a division. It used to be matched against a
// punctuation-only allowlist, so a regex in expression position after a *keyword* — the `n` of
// `return` — failed the test and was read as division. Its body was then scanned as code, and a
// body containing an odd number of quotes flipped the lexer into string mode. String mode ran to
// the next matching quote, which in practice meant the end of the file: every ban downstream of
// that line silently stopped being checked. Concrete input, verified against the old lexer:
//
//     function f(x){ return /don't/.test(x); }
//     const bad = a ?? b;                      // <- invisible: the `??` was never scanned
//
// Two changes hold the line:
//   (a) When `lastSig` is an identifier character, the trailing word decides. If it is one of
//       REGEX_AFTER_KEYWORD the `/` opens a regex; otherwise it is a division, so `total / count`,
//       `arr[0] / n` and `(a + b) / s` all keep working. Measured over lib/ + scripts/ at the time
//       of the fix: exactly two files re-lex (lib/hook-input.mjs:4, lib/operations-codex.mjs:62,
//       both `return /…/.test(…)`), and the set of reported violations is unchanged.
//   (b) Containment, independent of (a): a single- or double-quoted string and a regex literal now
//       both end at a raw newline. Neither may contain a line terminator, so this costs nothing on
//       valid code — but it caps the blast radius of any residual mis-lex at one line instead of
//       the rest of the file. That is what turns a silent hole into, at worst, a local one.
function stripNonCode(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let mode = 'code';
  const templateStack = [];
  let lastSig = '';
  let inClass = false;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; out += '  '; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; out += '  '; continue; }
      if (ch === '/') {
        const afterKeyword = isWordChar(lastSig)
          && REGEX_AFTER_KEYWORD.indexOf(tailWord(out)) !== -1;
        if (lastSig === '' || '(,=:[!&|?{};<>+-*%~^'.indexOf(lastSig) !== -1 || afterKeyword) {
          mode = 'regex'; inClass = false; i += 1; out += ' '; continue;
        }
      }
      if (ch === "'") { mode = 'single'; i += 1; out += ' '; continue; }
      if (ch === '"') { mode = 'double'; i += 1; out += ' '; continue; }
      if (ch === '`') { mode = 'template'; i += 1; out += ' '; continue; }
      if (ch === '}' && templateStack.length) { templateStack.pop(); mode = 'template'; i += 1; out += ' '; continue; }
      if (!/\s/.test(ch)) lastSig = ch;
      out += ch; i += 1; continue;
    }
    if (mode === 'regex') {
      // A regex literal cannot span a line. Bailing here bounds a mis-detected `/` to one line.
      if (ch === '\n') { mode = 'code'; lastSig = ';'; out += '\n'; i += 1; continue; }
      if (ch === '\\') { i += 2; out += '  '; continue; }
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) { mode = 'code'; lastSig = ')'; i += 1; out += ' '; continue; }
      out += ' '; i += 1; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += '\n'; } else out += ' ';
      i += 1; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; out += '  '; continue; }
      out += ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"';
      // Same containment: a quoted string cannot hold a raw newline, so an unterminated one is a
      // mis-lex and must not be allowed to swallow the rest of the file.
      if (ch === '\n') { mode = 'code'; lastSig = ';'; out += '\n'; i += 1; continue; }
      if (ch === '\\') { i += 2; out += '  '; continue; }
      // A closed string is a value, so a `/` after it is a division, not a regex.
      if (ch === quote) { mode = 'code'; lastSig = ')'; i += 1; out += ' '; continue; }
      out += ' '; i += 1; continue;
    }
    // template
    if (ch === '\\') { i += 2; out += '  '; continue; }
    if (ch === '`') { mode = 'code'; lastSig = ')'; i += 1; out += ' '; continue; }
    if (ch === '$' && next === '{') { templateStack.push(true); mode = 'code'; i += 2; out += '  '; continue; }
    out += ch === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

// Every check the gate applies to a runtime file, in the order they are reported.
//   name    — the text that lands in the failure list, and the key the fixtures are matched on.
//   scope   — 'code' runs against the comment/string-stripped source; 'raw' against the file text.
//   match   — a RegExp (tested against the subject) or a predicate over the subject.
//   allowed — posix paths exempt from this check. Deliberately tiny; see the snapshot test below.
//
// The two 'raw' checks are raw on purpose: what they ban *is* a string literal, so stripping would
// blank the very text they look for. The price is that they also fire when a comment or string
// spells the banned form out. That is deliberate over-strictness — a loud false positive beats an
// invisible false negative — and it is why their negative fixtures use construct-level near-misses
// instead of quoting the ban.
const CHECKS = [
  {
    name: 'node:-prefixed import specifier (absent on Node 13.x)',
    scope: 'raw',
    match: /(from\s*|import\s*\(?\s*)['"]node:/,
  },
  {
    name: "'base64url' encoding literal (Node 15.7+) — use compat base64url helpers",
    scope: 'raw',
    match: /['"]base64url['"]/,
    allowed: ['lib/compat.mjs'],
  },
  { name: 'optional chaining `?.`', scope: 'code', match: /\?\.[a-zA-Z_$([]/ },
  { name: 'nullish coalescing `??` (and `??=`)', scope: 'code', match: /\?\?/ },
  { name: 'logical assignment `||=` / `&&=`', scope: 'code', match: /(\|\||&&)=/ },
  { name: 'String.prototype.replaceAll', scope: 'code', match: /\.replaceAll\s*\(/ },
  { name: 'Object.hasOwn (Node 16.9+)', scope: 'code', match: /Object\.hasOwn\b/ },
  {
    name: 'fs.rmSync (Node 14.14+) — use compat removeFileSync/removeDirSync',
    scope: 'code',
    match: /\brmSync\b/,
    allowed: ['lib/compat.mjs'],
  },
  {
    name: 'bare `new AbortController()` (global is Node 15+) — use makeAbortController',
    scope: 'code',
    match: /new\s+AbortController\b/,
    allowed: ['lib/fetch-compat.mjs'],
  },
  {
    name: 'direct globalThis.fetch (Node 18+) — use fetchCompat',
    scope: 'code',
    match: /globalThis\.fetch\b/,
    allowed: ['lib/fetch-compat.mjs'],
  },
  { name: 'structuredClone (Node 17+)', scope: 'code', match: /\bstructuredClone\b/ },
  { name: 'Array/String .at() (Node 16.6+)', scope: 'code', match: /\.at\s*\(/ },
  { name: 'findLast/findLastIndex (Node 18+)', scope: 'code', match: /\.findLast(Index)?\s*\(/ },
  { name: 'AbortSignal statics (Node 16+)', scope: 'code', match: /AbortSignal\./ },
  { name: 'crypto.randomUUID (Node 14.17+)', scope: 'code', match: /randomUUID/ },
  // Top-level await: an `await` at brace depth zero. The stripper keeps code structure, so
  // tracking depth over the stripped source is reliable.
  {
    name: 'top-level await (Node 14.8+)',
    scope: 'code',
    match: (code) => {
      let depth = 0;
      for (const line of code.split('\n')) {
        for (const ch of line) {
          if (ch === '{' || ch === '(') depth += 1;
          if (ch === '}' || ch === ')') depth -= 1;
        }
        if (depth === 0 && /(^|[^.\w])await\s/.test(line)) return true;
      }
      return false;
    },
  },
];

// The one place a file is judged. Both the real-tree scan and every fixture test go through it, so
// a fixture proves the whole gate — exemptions, scopes and failure text included — not just a
// matcher in isolation.
function scanSource(posixFile, raw) {
  const failures = [];
  const code = stripNonCode(raw);
  for (const check of CHECKS) {
    if (check.allowed && check.allowed.indexOf(posixFile) !== -1) continue;
    const subject = check.scope === 'raw' ? raw : code;
    const hit = typeof check.match === 'function' ? check.match(subject) : check.match.test(subject);
    if (hit) failures.push(`${posixFile}: ${check.name}`);
  }
  return failures;
}

// [check name, fixture slug]. Every entry needs <slug>.bad.mjs.txt (must be flagged for that check)
// and <slug>.ok.mjs.txt (must be reported clean). The completeness test below makes it impossible
// to add a 17th check without adding its pair.
const FIXTURES = [
  ['node:-prefixed import specifier (absent on Node 13.x)', 'node-prefix-import'],
  ["'base64url' encoding literal (Node 15.7+) — use compat base64url helpers", 'base64url-literal'],
  ['optional chaining `?.`', 'optional-chaining'],
  ['nullish coalescing `??` (and `??=`)', 'nullish-coalescing'],
  ['logical assignment `||=` / `&&=`', 'logical-assignment'],
  ['String.prototype.replaceAll', 'replace-all'],
  ['Object.hasOwn (Node 16.9+)', 'object-hasown'],
  ['fs.rmSync (Node 14.14+) — use compat removeFileSync/removeDirSync', 'rm-sync'],
  ['bare `new AbortController()` (global is Node 15+) — use makeAbortController', 'abort-controller'],
  ['direct globalThis.fetch (Node 18+) — use fetchCompat', 'globalthis-fetch'],
  ['structuredClone (Node 17+)', 'structured-clone'],
  ['Array/String .at() (Node 16.6+)', 'array-at'],
  ['findLast/findLastIndex (Node 18+)', 'find-last'],
  ['AbortSignal statics (Node 16+)', 'abort-signal-statics'],
  ['crypto.randomUUID (Node 14.17+)', 'random-uuid'],
  ['top-level await (Node 14.8+)', 'top-level-await'],
];

function fixtureSource(name) {
  return fs.readFileSync(path.join(fixtureDir, name), 'utf-8');
}

test('runtime files stay valid on Node 13.2', () => {
  const failures = [];
  for (const file of runtimeFiles()) {
    const raw = fs.readFileSync(path.join(pluginRoot, file), 'utf-8');
    for (const failure of scanSource(file.split(path.sep).join('/'), raw)) failures.push(failure);
  }
  assert.deepEqual(failures, [], `Node 13.2-incompatible constructs found:\n${failures.join('\n')}`);
});

// --- the gate's own coverage -------------------------------------------------------------------

test('every check has a positive and a negative fixture', () => {
  const checkNames = CHECKS.map((c) => c.name).slice().sort();
  const fixtureNames = FIXTURES.map((f) => f[0]).slice().sort();
  assert.deepEqual(fixtureNames, checkNames, 'add a fixture pair for every check in CHECKS');
  const missing = [];
  for (const [, slug] of FIXTURES) {
    for (const suffix of ['.bad.mjs.txt', '.ok.mjs.txt']) {
      if (!fs.existsSync(path.join(fixtureDir, slug + suffix))) missing.push(slug + suffix);
    }
  }
  assert.deepEqual(missing, [], 'missing fixture files');
});

for (const [name, slug] of FIXTURES) {
  test(`positive — ${slug}.bad.mjs.txt is flagged: ${name}`, () => {
    const file = `${slug}.bad.mjs.txt`;
    const failures = scanSource(`test/fixtures/compat/${file}`, fixtureSource(file));
    assert.ok(
      failures.some((f) => f.indexOf(name) !== -1),
      `${file} must trip "${name}". Reported: ${JSON.stringify(failures)}`,
    );
  });

  test(`negative — ${slug}.ok.mjs.txt is clean`, () => {
    const file = `${slug}.ok.mjs.txt`;
    const failures = scanSource(`test/fixtures/compat/${file}`, fixtureSource(file));
    assert.deepEqual(failures, [], `${file} must not trip any check`);
  });
}

test('positive — the desync fixture is flagged through the regex that used to hide it', () => {
  const file = 'desync-regex-after-return.bad.mjs.txt';
  const failures = scanSource(`test/fixtures/compat/${file}`, fixtureSource(file));
  assert.ok(
    failures.some((f) => f.indexOf('nullish coalescing') !== -1),
    `the \`??\` after \`return /don't/\` must still be scanned. Reported: ${JSON.stringify(failures)}`,
  );
});

test('negative — regex bodies after a keyword are not scanned as code', () => {
  const file = 'desync-regex-after-return.ok.mjs.txt';
  const failures = scanSource(`test/fixtures/compat/${file}`, fixtureSource(file));
  assert.deepEqual(failures, [], `${file} must not trip any check`);
});

test('the exemption list has not been widened', () => {
  // Four exemptions, all pointing at the compat shims that are allowed to touch the raw API.
  const exemptions = CHECKS.filter((c) => c.allowed).map((c) => [c.name, c.allowed]);
  assert.deepEqual(exemptions, [
    ["'base64url' encoding literal (Node 15.7+) — use compat base64url helpers", ['lib/compat.mjs']],
    ['fs.rmSync (Node 14.14+) — use compat removeFileSync/removeDirSync', ['lib/compat.mjs']],
    ['bare `new AbortController()` (global is Node 15+) — use makeAbortController', ['lib/fetch-compat.mjs']],
    ['direct globalThis.fetch (Node 18+) — use fetchCompat', ['lib/fetch-compat.mjs']],
  ]);
});

test('an exemption suppresses the check only for the file it names', () => {
  const raw = fixtureSource('rm-sync.bad.mjs.txt');
  assert.ok(scanSource('lib/fs-store.mjs', raw).some((f) => f.indexOf('fs.rmSync') !== -1));
  assert.deepEqual(scanSource('lib/compat.mjs', raw), []);
});

test('fixtures cannot be picked up by the test runner', () => {
  // Node globs **/test/**/*.?(c|m)js when given no paths, so *any* .mjs under test/ — however
  // deeply nested — is loaded and run as a test file. Verified on v24.11.1: a throwaway
  // test/fixtures/compat/plain.mjs was executed and reported as a passing test file; the same
  // content as plain.mjs.txt was not discovered at all.
  const runnable = fs.readdirSync(fixtureDir).filter((n) => /\.(c|m)?js$/.test(n));
  assert.deepEqual(runnable, [], 'fixtures must not use an extension the test runner globs');
});

// --- stripper self-tests -----------------------------------------------------------------------

test('the stripper does not hide real code', () => {
  const code = stripNonCode('const a = b ?? "x ?? y"; // ?? in comment\nconst c = `t${d ?? e}`;');
  assert.ok(/b \?\?/.test(code), 'code-level ?? survives');
  assert.ok(/d \?\? e/.test(code), 'interpolation contents survive');
  assert.ok(!/x \?\?/.test(code), 'string contents are stripped');
});

test('a regex literal containing quotes does not desync the stripper', () => {
  // The exact shape that hid lib/repo-timeline.mjs's `?.` from the first version of this scan.
  const source = 'const RE = /("[^"]+"|\'[^\']+\')/g;\nconst v = line?.message;\n';
  const code = stripNonCode(source);
  assert.ok(/line\?\.message/.test(code), 'code after the regex literal is still scanned');
});

test('division after a parenthesised value is not misread as a regex', () => {
  const code = stripNonCode('const r = (a + b) / seconds; const bad = x ?? y;');
  assert.ok(/x \?\? y/.test(code), 'scanning continues past the division');
});

// G-10-4 Hole 1, fix (a). Each of these was MISSED by the punctuation-only rule: the regex was
// read as a division, so its body landed in the scanned code and its apostrophe opened string mode,
// blanking everything after it. Both assertions are needed and both stay on ONE line: the newline
// containment of fix (b) would otherwise repair the damage before the next line and hide the
// regression. `randomUUID` is the tell — it is banned, so if the body is scanned as code it shows.
const REGEX_AFTER_KEYWORD_CASES = [
  ['return', "function f(x){ return /don't randomUUID/.test(x); } const bad = a ?? b;"],
  ['typeof', "const t = typeof /won't randomUUID/; const bad = a ?? b;"],
  ['case', "switch (k) { case /it's randomUUID/.source: break; } const bad = a ?? b;"],
  ['delete', "delete /won't randomUUID/.lastIndex; const bad = a ?? b;"],
  ['void', "void /isn't randomUUID/.source; const bad = a ?? b;"],
  ['yield', "function* g(){ yield /shan't randomUUID/.source; } const bad = a ?? b;"],
  ['throw', "function h(){ throw /oughtn't randomUUID/.source; } const bad = a ?? b;"],
  ['in', "const y = 'a' in /don't randomUUID/; const bad = a ?? b;"],
  ['of', "for (const m of /can't randomUUID/.exec(s) || []) { void m; } const bad = a ?? b;"],
  ['instanceof', "const b = x instanceof /aren't randomUUID/.constructor; const bad = a ?? b;"],
  ['await', "async function f(x){ return await /don't randomUUID/.test(x); } const bad = a ?? b;"],
  ['do', "do /don't randomUUID/.test(x); while (0); const bad = a ?? b;"],
  ['else', "if (a) b(); else /don't randomUUID/.test(x); const bad = a ?? b;"],
];

// One case per entry in REGEX_AFTER_KEYWORD: a rule with no regression test is a rule that can be
// deleted silently, which is the whole failure mode this file exists to close.
test('every keyword in REGEX_AFTER_KEYWORD has a case', () => {
  const covered = REGEX_AFTER_KEYWORD_CASES.map((c) => c[0]).slice().sort();
  assert.deepEqual(covered, REGEX_AFTER_KEYWORD.slice().sort());
});

for (const [keyword, snippet] of REGEX_AFTER_KEYWORD_CASES) {
  test(`a regex after \`${keyword}\` is lexed as a regex, not a division`, () => {
    const code = stripNonCode(`${snippet}\n`);
    assert.ok(!/randomUUID/.test(code), 'the regex body is blanked, not scanned as code');
    assert.ok(/a \?\? b/.test(code), 'code after the regex on the same line is still scanned');
  });
}

// The other direction: the keyword rule must not turn real division into a regex, which would
// start hiding code — the exact failure this gate exists to prevent. Same-line again, because a
// `/` misread as a regex opener blanks everything up to the next `/` or the end of the line.
const DIVISION_CASES = [
  ['an identifier', 'const r = total / count; const bad = a ?? b;'],
  ['a number', 'const r = 10 / count; const bad = a ?? b;'],
  ['a closing bracket', 'const r = arr[0] / count; const bad = a ?? b;'],
  ['a closing paren', 'const r = (a + b) / count; const bad = a ?? b;'],
  ['a closing brace of a call', 'const r = f({ a: 1 }) / count; const bad = a ?? b;'],
  ['an identifier merely ending in a keyword', 'const r = noreturn / count; const bad = a ?? b;'],
  ['a property named `.of`', 'const r = obj.of / count; const bad = a ?? b;'],
  ['a property named `.in`', 'const r = obj.in / count; const bad = a ?? b;'],
  // These two are the reason a closed string or template sets lastSig to a value marker. Without
  // it lastSig is still the `=`, the `/` opens a regex, and the rest of the line is blanked. The
  // `.length` variants would mask that, so both forms are here.
  ['a quoted string', "const r = 'ab' / count; const bad = a ?? b;"],
  ['a template literal', 'const r = `ab` / count; const bad = a ?? b;'],
  ['a quoted string property', "const r = 'ab'.length / count; const bad = a ?? b;"],
  ['a template literal property', 'const r = `ab`.length / count; const bad = a ?? b;'],
];

for (const [after, snippet] of DIVISION_CASES) {
  test(`division after ${after} is not misread as a regex`, () => {
    const code = stripNonCode(`${snippet}\n`);
    assert.ok(/a \?\? b/.test(code), 'scanning continues past the division');
  });
}

// G-10-4 Hole 1, fix (b) — containment. No valid JS reaches either state: a quoted string and a
// regex literal may not contain a raw line terminator. But if a future lexer slip opens one of
// these modes by mistake, the damage has to stop at the newline instead of blanking every
// remaining line. A silent gate is the one failure mode with no signal at all.
test('an unterminated string cannot swallow the rest of the file', () => {
  const code = stripNonCode("const broken = 'oops\nconst bad = a ?? b;\n");
  assert.ok(/a \?\? b/.test(code), 'the next line is still scanned');
});

test('an unterminated regex cannot swallow the rest of the file', () => {
  const code = stripNonCode('const broken = /oops\nconst bad = a ?? b;\n');
  assert.ok(/a \?\? b/.test(code), 'the next line is still scanned');
});
