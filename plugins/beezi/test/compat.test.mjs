import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  orDefault,
  base64urlEncode,
  base64urlDecode,
  removeFileSync,
  removeDirSync,
} from '../lib/compat.mjs';

// G-8-7. lib/compat.mjs is 47 lines imported by ~35 modules, and until now the only thing that
// looked at it was test/compat-syntax.test.mjs — a LEXICAL ban-gate that never calls a function
// in it. Everything here is a behaviour pin, not a smoke test: each assertion below was checked
// against a mutated lib/compat.mjs and observed to fail.
//
// Nothing in this file touches a path outside os.tmpdir(), and the two remove helpers are driven
// through stubs on the `fs` module object rather than through the developer's disk wherever the
// assertion is about which fs call was made.

// ── orDefault (lib/compat.mjs:10-12) ────────────────────────────────────────────────────────────

// The whole point of the helper is that it is `??`, not `||`. There are ~35 call sites; a reader
// who misreads it as `||` writes a bug that only shows up on a zero cursor, an empty session name
// or a `false` flag — all of which are legitimate values the caller meant to keep.
test('orDefault falls back for null and undefined only', () => {
  const fallback = 'FALLBACK';

  assert.strictEqual(orDefault(null, fallback), fallback);
  assert.strictEqual(orDefault(undefined, fallback), fallback);

  // No argument at all is the `undefined` case, reached by every optional `deps.x`.
  assert.strictEqual(orDefault(undefined, null), null);

  // Every other falsy value is a value and must survive. Object.is, not ===, so that NaN and -0
  // are actually compared rather than silently passing.
  assert.ok(Object.is(orDefault(0, fallback), 0), 'a zero cursor / token count / cost survives');
  assert.ok(Object.is(orDefault('', fallback), ''), 'an empty session name or branch survives');
  assert.ok(Object.is(orDefault(false, fallback), false), 'a disabled flag survives');
  assert.ok(Object.is(orDefault(NaN, fallback), NaN), 'NaN survives');
  assert.ok(Object.is(orDefault(-0, fallback), -0), '-0 survives as -0, not as the fallback');

  // Truthy values are returned by identity, not by copy.
  const obj = { a: 1 };
  assert.strictEqual(orDefault(obj, fallback), obj);
});

// The documented difference from `??` (lib/compat.mjs:8-9): the fallback is an argument, so it is
// evaluated before the call regardless of which branch wins. `??` short-circuits; this cannot.
// This is a documentation test — it pins what the header comment promises. It is not
// mutation-provable from inside compat.mjs, because the eagerness is JavaScript's argument
// evaluation and no edit to the function body can restore short-circuiting.
test('orDefault evaluates its fallback eagerly, unlike `??`', () => {
  let calls = 0;
  const expensive = () => { calls += 1; return 'fallback'; };

  assert.strictEqual(orDefault('kept', expensive()), 'kept');
  assert.strictEqual(calls, 1, 'the fallback ran even though the value was used');

  assert.strictEqual(orDefault(null, expensive()), 'fallback');
  assert.strictEqual(calls, 2);
});

// ── base64url (lib/compat.mjs:16-28) ────────────────────────────────────────────────────────────

// The padding branch is chosen by input byte length mod 3, and PKCE (RFC 7636) requires the
// unpadded form — lib/oauth.mjs:32-33 encodes 32 bytes (one pad) and lib/login.mjs:161 encodes
// 16 bytes (two pads), so both strip branches are on the live path.
test('base64urlEncode strips padding for every input length mod 3', () => {
  assert.strictEqual(base64urlEncode(Buffer.from('abc')), 'YWJj', '3n: standard base64 has no pad');
  assert.strictEqual(base64urlEncode(Buffer.from('a')), 'YQ', '3n+1: two "=" stripped from YQ==');
  assert.strictEqual(base64urlEncode(Buffer.from('ab')), 'YWI', '3n+2: one "=" stripped from YWI=');
  assert.strictEqual(base64urlEncode(Buffer.from('abcd')), 'YWJjZA', '3n+1 again, longer');

  for (const input of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    const encoded = base64urlEncode(Buffer.from(input));
    assert.strictEqual(encoded.indexOf('='), -1, `no padding in ${encoded}`);
    assert.strictEqual(encoded.indexOf('+'), -1, `no "+" in ${encoded}`);
    assert.strictEqual(encoded.indexOf('/'), -1, `no "/" in ${encoded}`);
  }

  assert.strictEqual(base64urlEncode(Buffer.alloc(0)), '', 'an empty buffer encodes to an empty string');
});

// Bytes chosen so that standard base64 actually produces the two characters being substituted;
// asserting on ASCII text alone would never exercise either replace.
test('base64urlEncode substitutes - for + and _ for /', () => {
  const plus = Buffer.from([0xfb, 0xef, 0xbe]);
  assert.strictEqual(plus.toString('base64'), '++++', 'the fixture really produces "+"');
  assert.strictEqual(base64urlEncode(plus), '----');

  const slash = Buffer.from([0xff, 0xff, 0xff]);
  assert.strictEqual(slash.toString('base64'), '////', 'the fixture really produces "/"');
  assert.strictEqual(base64urlEncode(slash), '____');

  // Both in one buffer, so a helper that only fixed the first substitution is caught.
  const both = Buffer.concat([plus, slash]);
  assert.strictEqual(base64urlEncode(both), '----____');
});

test('base64urlDecode maps - and _ back to + and /', () => {
  assert.strictEqual(base64urlDecode('----').toString('hex'), 'fbefbe');
  assert.strictEqual(base64urlDecode('____').toString('hex'), 'ffffff');
  assert.strictEqual(base64urlDecode('----____').toString('hex'), 'fbefbeffffff');
});

// A finding, recorded so nobody re-derives it: on the runtime this suite runs on, the two
// `.replace` calls in base64urlDecode (compat.mjs:27) are BELT-AND-BRACES, not load-bearing.
// Node's own base64 decoder already accepts the URL-safe alphabet — and a mixed one — so removing
// either substitution changes no observable output, and no black-box test above can distinguish
// the two implementations. Measured on v24.11.1: deleting BOTH from compat.mjs leaves every test
// in this file green. That is a statement about the CI runtime only; it was not measured on the
// Node 13.2 floor, which is one more reason not to act on it.
//
// This is the opposite of the ENCODE side, where the substitutions and the padding strip are all
// load-bearing and every one of them is caught by a mutation. Keep the decode replaces: they cost
// nothing and they are the only thing that would keep this helper correct against a stricter
// decoder. But do not mistake a green suite for proof that they run.
test('the decode substitutions are redundant on this runtime — Node takes the URL-safe alphabet', () => {
  assert.strictEqual(Buffer.from('----', 'base64').toString('hex'), 'fbefbe', 'no "-"->"+" needed');
  assert.strictEqual(Buffer.from('____', 'base64').toString('hex'), 'ffffff', 'no "_"->"/" needed');
  assert.strictEqual(Buffer.from('-+_/', 'base64').toString('hex'), 'fbefff', 'even mixed alphabets');
});

test('base64urlDecode round-trips unpadded input for every length mod 3', () => {
  for (const input of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
    const encoded = base64urlEncode(Buffer.from(input));
    assert.strictEqual(base64urlDecode(encoded).toString('utf-8'), input, `round trip of ${input}`);
  }

  // Random bytes, the PKCE shape: 32 bytes (3n+2) and 16 bytes (3n+1).
  for (const len of [16, 32]) {
    const buf = Buffer.alloc(len, 0xa7);
    assert.deepEqual(base64urlDecode(base64urlEncode(buf)), buf, `round trip of ${len} bytes`);
  }
});

// The decoder is deliberately padding-tolerant (lib/compat.mjs:24-25) — it accepts what its own
// encoder never emits, which is what makes it safe to hand a segment from any producer.
test('base64urlDecode accepts padding its own encoder strips', () => {
  assert.strictEqual(base64urlDecode('YQ==').toString('utf-8'), 'a');
  assert.strictEqual(base64urlDecode('YQ').toString('utf-8'), 'a');
  assert.strictEqual(base64urlDecode('YWI=').toString('utf-8'), 'ab');
  assert.strictEqual(base64urlDecode('YWI').toString('utf-8'), 'ab');
});

// PINNED, NOT ENDORSED. base64 length mod 4 === 1 is not a decodable shape, and Buffer.from does
// not say so — it drops the dangling character. A caller handing it a truncated JWT segment
// (lib/chatgpt-auth.mjs:19 is the live one) gets short bytes and a JSON.parse failure rather
// than a decode error, and nothing else in the repo documents that.
test('base64urlDecode silently discards a dangling character (length mod 4 === 1)', () => {
  const truncated = 'YWJjZ'; // 'YWJjZA' ('abcd') with its last character lopped off.
  assert.strictEqual(truncated.length % 4, 1);

  const decoded = base64urlDecode(truncated);
  assert.strictEqual(decoded.length, 3, 'the dangling character contributes nothing');
  assert.strictEqual(decoded.toString('utf-8'), 'abc', 'the 4th byte is gone, without an error');
});

// PINNED, NOT ENDORSED. Characters outside the alphabet are skipped, not rejected and not treated
// as terminators, so garbage in the middle of a segment still yields a plausible-looking buffer.
test('base64urlDecode silently skips characters outside the alphabet', () => {
  assert.strictEqual(base64urlDecode('YW$%Jj').toString('utf-8'), 'abc', 'the junk is skipped, not fatal');
  assert.strictEqual(base64urlDecode('!!!!').length, 0, 'an all-junk segment decodes to zero bytes');
  assert.strictEqual(base64urlDecode('').length, 0);
});

// String(str) at lib/compat.mjs:27 is what keeps a non-string from throwing on .replace. Note the
// consequence, pinned rather than endorsed: the coerced text is itself decoded, so null does not
// come back empty — "null" is four alphabet characters and yields three bytes of nonsense. A
// caller must check its input; this helper will not fail for it.
test('base64urlDecode coerces a non-string argument instead of throwing', () => {
  assert.doesNotThrow(() => base64urlDecode(null));
  assert.doesNotThrow(() => base64urlDecode(undefined));
  assert.doesNotThrow(() => base64urlDecode(12345));

  assert.strictEqual(base64urlDecode(null).toString('hex'), '9ee965', 'String(null) is decoded as data');
  assert.strictEqual(base64urlDecode(undefined).length, 6);
  assert.strictEqual(base64urlDecode(12345).toString('hex'), 'd76df8');
});

// The production use: lib/chatgpt-auth.mjs:19 decodes a JWT payload segment. A payload of 3n+1
// bytes puts the two-pad branch on that live path, which is the branch a naive implementation
// (one that only handles the single-pad case) gets wrong.
test('a JWT payload segment of 3n+1 bytes round-trips through both helpers', () => {
  const payload = '{"sub":"u1","plan":"pro"}';
  assert.strictEqual(Buffer.byteLength(payload) % 3, 1, 'the fixture really is the two-pad case');

  const segment = base64urlEncode(Buffer.from(payload, 'utf-8'));
  assert.strictEqual(segment.indexOf('='), -1, 'a JWT segment carries no padding');

  const parsed = JSON.parse(base64urlDecode(segment).toString('utf-8'));
  assert.deepEqual(parsed, { sub: 'u1', plan: 'pro' });
});

// ── removeFileSync / removeDirSync (lib/compat.mjs:32-47) ───────────────────────────────────────

const ABSENT = Symbol('absent');

// `fs` is a module-level import in compat.mjs (:1) and a core module's default export is the very
// object mutated here, so a stub lands. Adding a `deps` parameter to a two-line helper used by 35
// files would be worse, and the plan says so (G-8-7 case 10). Restored via t.after, which runs on
// failure too — the hermetic gate's own exit handler calls fs.rmSync, so a leaked stub would take
// the sandbox cleanup with it.
function stubFs(t, overrides) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = Object.prototype.hasOwnProperty.call(fs, key) ? fs[key] : ABSENT;
  }
  t.after(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === ABSENT) delete fs[key];
      else fs[key] = saved[key];
    }
  });
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === ABSENT) delete fs[key];
    else fs[key] = overrides[key];
  }
  return saved;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-compat-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return dir;
}

test('removeFileSync deletes the file it is given', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'gone.json');
  fs.writeFileSync(file, '{}');

  removeFileSync(file);

  assert.strictEqual(fs.existsSync(file), false, 'the file is actually gone afterwards');
});

// A no-throw assertion alone is passed by an EMPTY function body, so the call log is asserted too:
// the helper must have reached unlinkSync with the path it was handed. G-8-3's releaseLock and
// lib/fs-store.mjs:58 both depend on the deletion really being attempted.
test('removeFileSync calls unlinkSync with the path and swallows ENOENT', (t) => {
  const calls = [];
  stubFs(t, {
    unlinkSync(p) {
      calls.push(p);
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    },
  });

  assert.doesNotThrow(() => removeFileSync('/nonexistent/beezi/missing.json'));
  assert.deepEqual(calls, ['/nonexistent/beezi/missing.json'], 'the deletion was attempted');
});

// The catch at :35 is bare, so it swallows every error class and not only ENOENT. That is the
// contract its callers rely on; asserting it means a later narrowing to `if (e.code !== "ENOENT")
// throw e` cannot land unnoticed.
test('removeFileSync swallows every error class, not only ENOENT', (t) => {
  const seen = [];
  stubFs(t, {
    unlinkSync(p) {
      seen.push(p);
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    },
  });

  assert.doesNotThrow(() => removeFileSync('/locked/file'));
  assert.deepEqual(seen, ['/locked/file']);
});

test('removeFileSync on a directory does not throw and leaves it standing', (t) => {
  const dir = tempDir(t);
  const inner = path.join(dir, 'nested');
  fs.mkdirSync(inner);

  assert.doesNotThrow(() => removeFileSync(inner));

  assert.strictEqual(fs.existsSync(inner), true, 'unlink on a directory is a no-op, not a wipe');
});

test('removeDirSync removes a nested tree', (t) => {
  const dir = tempDir(t);
  const nested = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'leaf.txt'), 'x');
  const target = path.join(dir, 'a');

  removeDirSync(target);

  assert.strictEqual(fs.existsSync(target), false, 'the whole tree is gone');
  assert.strictEqual(fs.existsSync(dir), true, 'and nothing above it was touched');
});

test('removeDirSync on a missing path does not throw', (t) => {
  const dir = tempDir(t);
  assert.doesNotThrow(() => removeDirSync(path.join(dir, 'never-existed')));
});

// The modern branch (:40-41). `force: true` is what makes a missing path a no-op on Node >= 14.14,
// and `recursive: true` is what makes a non-empty lock dir removable — losing either turns
// releaseLock into a permanent stale lock.
test('removeDirSync uses rmSync with recursive+force when it exists', (t) => {
  const calls = [];
  stubFs(t, { rmSync: (p, opts) => { calls.push([p, opts]); } });

  removeDirSync('/tmp/beezi-lock');

  assert.deepEqual(calls, [['/tmp/beezi-lock', { recursive: true, force: true }]]);
});

// The Node < 14.14 branch (:42-45). This is the branch the whole module exists for and CI has
// never once executed it: on every modern runtime fs.rmSync is present and :41 wins.
test('removeDirSync falls back to rmdirSync({recursive:true}) when fs.rmSync is absent', (t) => {
  const rmdirCalls = [];
  stubFs(t, {
    rmSync: ABSENT,
    rmdirSync: (p, opts) => { rmdirCalls.push([p, opts]); },
  });
  assert.strictEqual(typeof fs.rmSync, 'undefined', 'the Node 13.2 shape is really in place');

  removeDirSync('/tmp/beezi-old-node');

  assert.deepEqual(rmdirCalls, [['/tmp/beezi-old-node', { recursive: true }]]);
});

test('removeDirSync swallows a throwing rmdirSync on the Node 13.2 path', (t) => {
  const rmdirCalls = [];
  stubFs(t, {
    rmSync: ABSENT,
    rmdirSync: (p) => {
      rmdirCalls.push(p);
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    },
  });

  assert.doesNotThrow(() => removeDirSync('/tmp/beezi-missing'));
  assert.deepEqual(rmdirCalls, ['/tmp/beezi-missing'], 'the removal was attempted');
});

test('removeDirSync swallows a throwing rmSync on the modern path', (t) => {
  const calls = [];
  stubFs(t, {
    rmSync: (p) => {
      calls.push(p);
      throw new Error('EBUSY: resource busy or locked');
    },
  });

  assert.doesNotThrow(() => removeDirSync('/tmp/beezi-busy'));
  assert.deepEqual(calls, ['/tmp/beezi-busy']);
});
