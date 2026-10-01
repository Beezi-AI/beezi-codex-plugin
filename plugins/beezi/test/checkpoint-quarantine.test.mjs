import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flushQueue } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One account's queue: every payload, every quarantine and every counter below belongs to it
// alone, and a sibling account's drain can neither see nor delete any of it.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// The drain used to `fs.readdirSync(dir)` with no filter and `readJson(...) == null ? continue`.
// Two consequences, both silent:
//   * a `.tmp` left by a writer that was hard-killed between the temp write and the rename entered
//     the drain, and a truncated one never parsed;
//   * an unparseable file was re-read on EVERY flush — every PostToolUse and every Stop — for
//     fourteen days with no counter, no rename and no message, and then pruneStale deleted it and
//     the session's analytics went with it.
// These lock the filter, the quarantine and the one case that must NOT be quarantined.

// The queue dir is created eagerly, so a test that asserts on the drain's *listing* starts from an
// empty directory rather than from "no directory".
function tmpHome(t) {
  const dir = sandboxHome(t, 'beezi-quarantine-');
  linkAccount(dir, KEY);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  return dir;
}

const write = (name, text) => fs.writeFileSync(path.join(queueDir(KEY), name), text);
const listing = () => fs.readdirSync(queueDir(KEY)).sort();

// Records every payload that reached the wire, so "not posted" is asserted rather than assumed.
function recorder() {
  const posted = [];
  return {
    posted,
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({}) };
    },
  };
}

test('a queued report replays its captured instruction observation unchanged', async (t) => {
  tmpHome(t);
  const captured = {
    segmentId: 's:1-4',
    sessionId: 's',
    project_instructions_status: 'present',
    claude_md_lines: 7,
  };
  write('seg.json', JSON.stringify(captured));
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted, [captured]);
  assert.equal(result.flushed, 1);
});

test('a .tmp left by a hard-killed writer is neither read nor posted', async (t) => {
  tmpHome(t);
  write('seg-1.json', JSON.stringify({ segmentId: 's:1' }));
  // Exactly what writeJsonSecure leaves behind when the process dies between the temp write and
  // the rename: a sibling of the target, in the same directory, holding a truncated payload.
  write(`seg-2.json.${process.pid}.tmp`, '{"segmentId":"s:2","tok');
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted.map((p) => p.segmentId), ['s:1'], 'only the .json is postable');
  assert.equal(result.flushed, 1);
  assert.equal(result.quarantined, 0, 'a .tmp is skipped, not quarantined — it was never a report');
  assert.deepEqual(listing(), [`seg-2.json.${process.pid}.tmp`], 'and it is left for prune');
});

test('an unparseable queue file is quarantined, counted, and never re-read', async (t) => {
  tmpHome(t);
  write('good.json', JSON.stringify({ segmentId: 's:good' }));
  write('bad.json', 'not json at all');
  const first = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl: first.fetchImpl });

  assert.equal(result.quarantined, 1);
  assert.equal(result.flushed, 1, 'the corrupt neighbour does not stop the drain');
  assert.match(String(result.lastError), /quarantined unparseable queue file bad\.json/);
  assert.deepEqual(listing(), ['bad.json.corrupt'], 'the bytes stay where an operator can read them');
  assert.equal(fs.readFileSync(path.join(queueDir(KEY), 'bad.json.corrupt'), 'utf-8'), 'not json at all');

  // The whole point: the next flush must not pick it up again.
  const second = recorder();
  const again = await flushQueue(KEY, SESSION, { fetchImpl: second.fetchImpl });
  assert.deepEqual(second.posted, []);
  assert.equal(again.quarantined, 0, 'a .corrupt is outside the drain, so it is not re-quarantined');
  assert.equal(again.unreadable, 0);
  assert.deepEqual(listing(), ['bad.json.corrupt']);
});

test('a torn write is salvaged and posted when the prefix still names its segment', async (t) => {
  tmpHome(t);
  // A complete payload followed by the tail of a longer previous one — the exact shape a
  // non-atomic writeFileSync leaves when two writers land on one path.
  write('torn.json', '{"segmentId":"s:torn","token_total":15}{"segmentId":"s:old","token_tot');
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted, [{ segmentId: 's:torn', token_total: 15 }]);
  assert.equal(result.salvaged, 1);
  assert.equal(result.flushed, 1);
  assert.equal(result.quarantined, 0);
  assert.deepEqual(listing(), [], 'an accepted report is deleted like any other');
});

test('a salvaged prefix with no segmentId is quarantined rather than posted', async (t) => {
  tmpHome(t);
  // The server's idempotency key is segmentId::model. A prefix that lost it cannot be addressed,
  // so posting it would create a row nothing can ever supersede.
  write('anon.json', '{"token_total":15}{"segmentId":"s:old"');
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted, []);
  assert.equal(result.quarantined, 1);
  assert.equal(result.salvaged, 0);
  assert.deepEqual(listing(), ['anon.json.corrupt']);
});

test('a file that cannot be read is left alone, not quarantined', async (t) => {
  tmpHome(t);
  // Quarantining on a READ failure is the dangerous half of this change: a transient EACCES from
  // an AV scanner — which is exactly what the rename retry in fs-store exists for — would
  // permanently remove a good payload from the drain. A directory gives a deterministic,
  // cross-platform read failure (EISDIR) with no chmod games.
  fs.mkdirSync(path.join(queueDir(KEY), 'locked.json'));
  write('good.json', JSON.stringify({ segmentId: 's:good' }));
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted.map((p) => p.segmentId), ['s:good']);
  assert.equal(result.unreadable, 1);
  assert.equal(result.quarantined, 0, 'unreadable is not corrupt');
  assert.deepEqual(listing(), ['locked.json'], 'still there, unrenamed, for the next pass');
});

test('deferred counts postable reports, not dirents', async (t) => {
  tmpHome(t);
  for (let i = 0; i < 3; i += 1) write(`seg-${i}.json`, JSON.stringify({ segmentId: `s:${i}` }));
  // Named to sort AFTER the reports, so an unfiltered readdir would inflate the remainder rather
  // than being skipped for free ahead of it.
  for (let i = 0; i < 4; i += 1) write(`zz-junk-${i}.tmp`, 'x');
  let nowMs = 1_000_000;
  const fetchImpl = async () => { nowMs += 3000; return { status: 200, json: async () => ({}) }; };

  const result = await flushQueue(KEY, SESSION, { fetchImpl, now: () => nowMs, deadline: nowMs + 4000 });

  assert.equal(result.flushed, 2);
  assert.equal(result.deferred, 1, 'one report is left, not one report plus four .tmp files');
});

// A queued report written under a session id the plugin could not name. The drain treats a 4xx as
// permanent and UNLINKS the file, so posting one destroys unreported analytics: it holds real
// tokens, real cost and a real segment window, and only its session id is wrong. G-3-1 / REVIEW R6.

test('a report queued under an unnamed session is neither posted nor deleted', async (t) => {
  tmpHome(t);
  const poisoned = { segmentId: 'null:1-18', sessionId: null, token_total: 42 };
  write('null_1-18.json', JSON.stringify(poisoned));
  write('good.json', JSON.stringify({ segmentId: 's:good', sessionId: 's1' }));
  // A 400 is what a null sessionId actually draws, and `res.status < 500` is the branch that
  // unlinks. Reaching the wire at all is therefore the failure — so the seam 400s everything and
  // the assertion is that the poisoned payload is not among what was sent.
  const posted = [];
  const fetchImpl = async (_url, init) => {
    posted.push(JSON.parse(init.body));
    return { status: 400, json: async () => ({ message: 'sessionId must be a string' }) };
  };

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted.map((p) => p.segmentId), ['s:good'], 'the unnamed one never reached the wire');
  assert.equal(result.unnamed, 1);
  assert.equal(result.rejected, 1, 'the neighbour was judged normally — the skip does not stop the drain');
  assert.equal(listing().includes('good.json'), false, 'and a genuinely rejected report is still deleted');
  assert.deepEqual(listing(), ['null_1-18.json'], 'left on disk for the quarantine sweep to relocate');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(queueDir(KEY), 'null_1-18.json'), 'utf-8')),
    poisoned,
    'byte-identical: nothing about it was rewritten either',
  );
});

test('the string "undefined" is judged by name, not by shape', async (t) => {
  tmpHome(t);
  // `${undefined}` interpolates to a string that passes every character check and reads as a
  // perfectly valid id all the way to the server.
  write('undefined_1-2.json', JSON.stringify({ segmentId: 'undefined:1-2', sessionId: 'undefined' }));
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted, []);
  assert.equal(result.unnamed, 1);
  assert.match(String(result.lastError), /unusable session id undefined_1-2\.json/, 'the skip is not invisible');
  assert.deepEqual(listing(), ['undefined_1-2.json']);
});

test('a payload that carries no sessionId at all is still posted', async (t) => {
  tmpHome(t);
  // Only a PRESENT id is judged. An absent one is not evidence of this bug, and re-deciding a
  // payload we know nothing about would silently stall reports this check was never about.
  write('seg.json', JSON.stringify({ segmentId: 's:1' }));
  const { posted, fetchImpl } = recorder();

  const result = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.deepEqual(posted.map((p) => p.segmentId), ['s:1']);
  assert.equal(result.unnamed, 0);
  assert.equal(result.flushed, 1);
});
