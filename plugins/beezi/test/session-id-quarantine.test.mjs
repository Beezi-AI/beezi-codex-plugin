import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quarantinePoisonedSessionState } from '../lib/transcript-codex.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// The queue moved under accounts/<key>/ with the keyed layout, and the sweep walks every linked
// account's. The quarantine tree itself stays machine-level: a poisoned report is a plugin defect,
// not a tenant's business, and an operator repairing one wants them in one place.
const KEY = TEST_KEY;
const QUEUE = `accounts/${KEY}/queue`;

// G-3-1 cleanup. A machine that ran an older build can hold state and queue entries written by a
// session the plugin could not name: `state/null.json`, `state/null.agents/`, `queue/null_1-18.json`.
// They are MOVED somewhere inspectable, never deleted — a queued report is unreported analytics
// with real tokens and cost in it, and only its session id is wrong.

function withBeeziHome(fn) {
  const prev = process.env.BEEZI_CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-quarantine-'));
  process.env.BEEZI_CODEX_HOME = dir;
  linkAccount(dir, KEY);
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
  }
}

const SID = '019b9e64-70b0-7b02-856d-172ee1af767c';

function write(root, rel, body) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

const exists = (...parts) => fs.existsSync(path.join(...parts));

test('moves the poisoned state file, its agent sidecars and its queued reports', () => {
  withBeeziHome((root) => {
    write(root, 'state/null.json', { cursor: 18, cwd: 'C:/work/app', transcriptPath: 'C:/r.jsonl' });
    write(root, 'state/null.agents/agent-1.json', { cursor: 4 });
    write(root, `${QUEUE}/null_1-18.json`, { segmentId: 'null:1-18', sessionId: null, tokens: 42 });
    write(root, `${QUEUE}/null_agent-1_1-4.json`, { segmentId: 'null:agent-1:1-4', sessionId: null });
    write(root, `${QUEUE}/undefined_1-2.json`, { segmentId: 'undefined:1-2' });
    // Untouched neighbours: a real session's state, sidecar dir and queued report.
    write(root, `state/${SID}.json`, { cursor: 5 });
    write(root, `state/${SID}.agents/agent-9.json`, { cursor: 1 });
    write(root, `${QUEUE}/${SID}_1-5.json`, { segmentId: `${SID}:1-5` });

    const result = quarantinePoisonedSessionState({ now: () => Date.parse('2026-09-10T12:00:00Z') });

    assert.equal(result.moved.length, 5);
    assert.deepEqual(result.failed, []);
    assert.equal(exists(root, 'state', 'null.json'), false);
    assert.equal(exists(root, 'state', 'null.agents'), false);
    assert.equal(exists(root, 'accounts', KEY, 'queue', 'null_1-18.json'), false);
    assert.equal(exists(root, 'accounts', KEY, 'queue', 'undefined_1-2.json'), false);

    // Nothing else was touched.
    assert.equal(exists(root, 'state', `${SID}.json`), true);
    assert.equal(exists(root, 'state', `${SID}.agents`, 'agent-9.json'), true);
    assert.equal(exists(root, 'accounts', KEY, 'queue', `${SID}_1-5.json`), true);
  });
});

test('nothing is deleted — the payloads survive intact under quarantine/', () => {
  withBeeziHome((root) => {
    const payload = { segmentId: 'null:1-18', sessionId: null, input_tokens: 42 };
    write(root, `${QUEUE}/null_1-18.json`, payload);
    write(root, 'state/null.agents/agent-1.json', { cursor: 4 });

    const result = quarantinePoisonedSessionState();

    const moved = result.moved.find((m) => m.to.endsWith('null_1-18.json'));
    assert.ok(moved, 'the queued report was relocated, not dropped');
    assert.deepEqual(JSON.parse(fs.readFileSync(moved.to, 'utf-8')), payload);
    // The sidecar directory moves whole, with its contents.
    const agents = result.moved.find((m) => m.to.endsWith('null.agents'));
    assert.equal(fs.readFileSync(path.join(agents.to, 'agent-1.json'), 'utf-8'), '{"cursor":4}');
    assert.ok(result.dir.startsWith(path.join(root, 'quarantine')));
  });
});

test('a clean machine is a no-op and creates no quarantine directory', () => {
  withBeeziHome((root) => {
    write(root, `state/${SID}.json`, { cursor: 5 });
    write(root, `${QUEUE}/${SID}_1-5.json`, { segmentId: `${SID}:1-5` });

    const result = quarantinePoisonedSessionState();

    assert.deepEqual(result.moved, []);
    assert.equal(result.dir, null);
    assert.equal(exists(root, 'quarantine'), false);
  });
});

test('a missing data root is not an error', () => {
  withBeeziHome((root) => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(quarantinePoisonedSessionState().moved, []);
  });
});

// The marker: repeat runs are visibly no-ops, and every sweep is recorded in one place.
test('the manifest records each sweep and re-running finds nothing left to move', () => {
  withBeeziHome((root) => {
    write(root, 'state/null.json', { cursor: 1 });
    quarantinePoisonedSessionState({ now: () => Date.parse('2026-09-10T12:00:00Z') });

    const second = quarantinePoisonedSessionState({ now: () => Date.parse('2026-09-10T13:00:00Z') });
    assert.deepEqual(second.moved, []);
    assert.equal(second.dir, null);

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'quarantine', 'manifest.json'), 'utf-8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.sweeps.length, 1, 'a no-op sweep adds no entry');
    assert.equal(manifest.sweeps[0].at, '2026-09-10T12:00:00.000Z');
    assert.equal(manifest.sweeps[0].moved.length, 1);
    assert.match(manifest.sweeps[0].moved[0].from, /null\.json$/);
    assert.ok(fs.existsSync(path.join(root, 'quarantine', 'README.txt')));
  });
});

// A second poisoning after a sweep must not overwrite what the first sweep preserved.
test('a later sweep gets its own directory rather than clobbering the earlier one', () => {
  withBeeziHome((root) => {
    write(root, `${QUEUE}/null_1-18.json`, { segmentId: 'null:1-18', first: true });
    const a = quarantinePoisonedSessionState({ now: () => Date.parse('2026-09-10T12:00:00Z') });

    write(root, `${QUEUE}/null_1-18.json`, { segmentId: 'null:1-18', second: true });
    const b = quarantinePoisonedSessionState({ now: () => Date.parse('2026-09-11T12:00:00Z') });

    assert.notEqual(a.dir, b.dir);
    assert.equal(JSON.parse(fs.readFileSync(a.moved[0].to, 'utf-8')).first, true);
    assert.equal(JSON.parse(fs.readFileSync(b.moved[0].to, 'utf-8')).second, true);
  });
});

// The move is restricted to the ids JavaScript manufactures for a missing value. An unfamiliar id
// shape is skipped by the resolver (free) but never relocated (not free).
test('an unusual but non-stringified id is left alone', () => {
  withBeeziHome((root) => {
    write(root, 'state/session_with_underscores.json', { cursor: 1 });
    write(root, `${QUEUE}/nullify_1-2.json`, { segmentId: 'nullify:1-2' });
    write(root, 'state/null.json.4242.tmp', '{"half":');

    const result = quarantinePoisonedSessionState();

    assert.deepEqual(result.moved, []);
    assert.equal(exists(root, 'state', 'session_with_underscores.json'), true);
    assert.equal(exists(root, 'accounts', KEY, 'queue', 'nullify_1-2.json'), true);
    assert.equal(exists(root, 'state', 'null.json.4242.tmp'), true, 'a live writer’s temp is not raced');
  });
});
