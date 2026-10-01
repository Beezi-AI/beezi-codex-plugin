import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readJsonSalvaged, writeJsonSecure, safeFileName } from '../lib/fs-store.mjs';

// The store had no direct test at all: the rename retry, the errno filter and the temp cleanup were
// unreachable from a test because `fs` is a module-level import in lib/fs-store.mjs. The retry
// cases below drive an INJECTED fs, so they touch no real filesystem and behave identically on
// every platform — the point of the loop is Windows contention, which cannot be provoked on CI.
// The plain cases use a real temp dir. No case may branch on the developer's machine.

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fs-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });

// A minimal fs the retry loop can be driven against. `renameFails` is consumed one entry per
// attempt; anything left over means the loop stopped early, which is what several cases assert.
function fakeFs({ renameErrors = [], writeError = null } = {}) {
  const calls = { mkdir: 0, write: 0, chmod: 0, rename: 0, unlink: [] };
  return {
    calls,
    impl: {
      mkdirSync: () => { calls.mkdir += 1; },
      writeFileSync: () => { calls.write += 1; if (writeError) throw writeError; },
      chmodSync: () => { calls.chmod += 1; },
      unlinkSync: (p) => { calls.unlink.push(p); },
      renameSync: () => {
        const error = renameErrors[calls.rename];
        calls.rename += 1;
        if (error) throw error;
      },
    },
  };
}

const FAKE = '/beezi-not-a-real-root/state.json';
const FAKE_TMP = `${FAKE}.${process.pid}.tmp`;

test('1. a rename that clears after two EPERMs succeeds without throwing', () => {
  const { impl, calls } = fakeFs({ renameErrors: [errno('EPERM'), errno('EPERM')] });
  const slept = [];
  writeJsonSecure(FAKE, { a: 1 }, {}, { fs: impl, sleepImpl: (ms) => slept.push(ms) });
  assert.equal(calls.rename, 3, 'third attempt is the one that lands');
  assert.deepEqual(slept, [5, 10], 'backs off before attempts 2 and 3, never before the first');
  assert.deepEqual(calls.unlink, [], 'a temp that was renamed into place must not be unlinked');
});

test('2. a rename contended all four attempts throws "held open" and cleans the temp', () => {
  const { impl, calls } = fakeFs({
    renameErrors: [errno('EBUSY'), errno('EBUSY'), errno('EBUSY'), errno('EBUSY')],
  });
  assert.throws(
    () => writeJsonSecure(FAKE, { a: 1 }, {}, { fs: impl, sleepImpl: () => {} }),
    /could not atomically replace .* held open by another process/,
  );
  assert.equal(calls.rename, 4, 'exactly RENAME_ATTEMPTS tries, no more');
  assert.deepEqual(calls.unlink, [FAKE_TMP], 'the temp is cleaned through the INJECTED fs');
});

test('3. a non-contention errno throws immediately instead of spinning the retry', () => {
  // The bare `catch { /* contended; retry */ }` this replaces treated ENOSPC as contention: four
  // attempts, ~30ms of a hook budget, and then a message blaming another process for a full disk.
  const { impl, calls } = fakeFs({ renameErrors: [errno('ENOSPC')] });
  const slept = [];
  assert.throws(
    () => writeJsonSecure(FAKE, { a: 1 }, {}, { fs: impl, sleepImpl: (ms) => slept.push(ms) }),
    (error) => error.code === 'ENOSPC',
    'the original error propagates, not the "held open" one',
  );
  assert.equal(calls.rename, 1, 'no retry for an errno that can never clear');
  assert.deepEqual(slept, [], 'and no backoff either');
  assert.deepEqual(calls.unlink, [FAKE_TMP]);
});

test('4. a failed temp write unlinks the temp and propagates its own error', () => {
  const { impl, calls } = fakeFs({ writeError: errno('ENOSPC') });
  assert.throws(
    () => writeJsonSecure(FAKE, { a: 1 }, {}, { fs: impl, sleepImpl: () => {} }),
    (error) => error.code === 'ENOSPC' && !/held open/.test(error.message),
  );
  assert.equal(calls.rename, 0, 'never reaches the rename');
  assert.deepEqual(calls.unlink, [FAKE_TMP], 'no half-written temp is left for the drain to find');
});

test('5. the backoff schedule is 0, 5, 10, 15 ms', () => {
  const { impl } = fakeFs({
    renameErrors: [errno('EACCES'), errno('EACCES'), errno('EACCES'), errno('EACCES')],
  });
  const slept = [];
  assert.throws(() => writeJsonSecure(FAKE, { a: 1 }, {}, { fs: impl, sleepImpl: (ms) => slept.push(ms) }));
  assert.deepEqual(slept, [5, 10, 15], 'the first attempt is immediate; the rest step by 5ms');
});

test('6. a round trip writes 0600 and reads back what it wrote', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'nested', 'state.json');
  writeJsonSecure(file, { cursor: 7, name: 'a"b' });
  assert.deepEqual(readJson(file), { cursor: 7, name: 'a"b' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'payloads carry prompt text and tokens');
  }
});

test('7. an overwrite leaves no .tmp behind for the queue drain to trip over', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonSecure(file, { cursor: 1 });
  writeJsonSecure(file, { cursor: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.deepEqual(readJson(file), { cursor: 2 });
});

test('8. readJson returns the fallback for trailing junk and for a missing file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'torn.json');
  fs.writeFileSync(file, '{"a":1}{"b":2');
  assert.deepEqual(readJson(file, { fell: 'back' }), { fell: 'back' });
  assert.equal(readJson(path.join(dir, 'nope.json')), null);
});

test('9. readJsonSalvaged recovers a torn write and says which answer it gave', (t) => {
  const dir = tmpDir(t);
  // The wreckage AND the good prefix both carry a `}` and a `"` inside a string value, so the
  // brace scanner is actually exercised rather than a naive indexOf('}').
  const torn = path.join(dir, 'torn.json');
  fs.writeFileSync(torn, '{"a":1,"msg":"} not the end \\" either"}{"b":2,"tail":"wreck');
  const salvaged = readJsonSalvaged(torn);
  assert.deepEqual(salvaged.value, { a: 1, msg: '} not the end " either' });
  assert.equal(salvaged.salvaged, true);
  assert.equal(salvaged.unreadable, false);

  const clean = path.join(dir, 'clean.json');
  writeJsonSecure(clean, { a: 1 });
  assert.deepEqual(readJsonSalvaged(clean), { value: { a: 1 }, salvaged: false, unreadable: false });

  const junk = path.join(dir, 'junk.json');
  fs.writeFileSync(junk, 'not json at all');
  assert.deepEqual(readJsonSalvaged(junk), { value: null, salvaged: false, unreadable: false });

  const truncated = path.join(dir, 'truncated.json');
  fs.writeFileSync(truncated, '{"a":1,"b":');
  assert.deepEqual(readJsonSalvaged(truncated), { value: null, salvaged: false, unreadable: false });
});

test('9b. a file that cannot be READ is reported unreadable, never as a parse failure', (t) => {
  const dir = tmpDir(t);
  // The distinction the queue drain quarantines on: a missing or locked file is not corrupt, and
  // renaming it to `.corrupt` would destroy a payload that was merely unavailable this instant.
  assert.deepEqual(
    readJsonSalvaged(path.join(dir, 'gone.json')),
    { value: null, salvaged: false, unreadable: true },
  );
  const asDir = path.join(dir, 'a-directory.json');
  fs.mkdirSync(asDir);
  assert.equal(readJsonSalvaged(asDir).unreadable, true, 'EISDIR is a read failure, not corruption');
});

test('10. safeFileName cannot produce a separator, a traversal or a drive letter', () => {
  assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFileName('C:\\x'), 'C__x');
  assert.equal(safeFileName('a/b'), 'a_b');
  assert.equal(safeFileName('a\\b'), 'a_b');
  assert.equal(safeFileName('x'.repeat(300)).length, 120, 'bounded for name-limited filesystems');
  assert.equal(safeFileName('x'.repeat(300), { max: 8 }), 'xxxxxxxx');
  assert.equal(safeFileName(''), 'unknown');
  assert.equal(safeFileName(null), 'unknown');
  assert.equal(safeFileName(undefined, { fallback: 'anon' }), 'anon');
  // A mangled-but-stable name still identifies its owner.
  assert.equal(safeFileName('agent-1.rollout'), 'agent-1.rollout');
});

test('11. the deps parameter is additive — the three-argument call site is untouched', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sub', 'state.json');
  writeJsonSecure(file, { ok: true }, { dirMode: 0o700 });
  assert.deepEqual(readJson(file), { ok: true });
});
