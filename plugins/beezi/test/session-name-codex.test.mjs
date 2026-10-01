import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sessionNameFromIndex,
  sessionNameFrom,
  resolveSessionName,
  isSafeSessionName,
  codexHomeFromTranscript,
} from '../lib/session-name-codex.mjs';

function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codexhome-'));
  process.env.CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
}

function writeRollout(records) {
  const file = path.join(tmpdir(), 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function writeRaw(content) {
  const file = path.join(tmpdir(), 'rollout.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

// A response_item user message — the shape Codex uses for both injected context and the real prompt.
const responseUser = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const eventUser = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });

const SID = 'abc-123';

// The two injected shapes that actually leaked into reported names on real machines.
const ENV_CONTEXT = '<environment_context>\n  <cwd>C:\\Users\\SomeUser\\Documents\\proj</cwd>\n  <shell>powershell</shell>\n</environment_context>';
const ASSISTANT_PRIMING = 'You are a helpful assistant. You will be presented with a user prompt, and your task is to summarize it.';

test('sessionNameFromIndex reads the thread_name for a session id', () => {
  withCodexHome((home) => {
    fs.writeFileSync(path.join(home, 'session_index.jsonl'),
      [JSON.stringify({ id: 'other', thread_name: 'Nope' }),
       JSON.stringify({ id: SID, thread_name: 'Fix the parser' })].join('\n') + '\n');
    assert.equal(sessionNameFromIndex(SID), 'Fix the parser');
    assert.equal(sessionNameFromIndex('missing'), null);
  });
});

test('sessionNameFrom returns the first real user_message from the rollout', () => {
  const file = writeRollout([
    responseUser('# AGENTS.md instructions ...'),
    eventUser('Refactor the checkout flow'),
  ]);
  assert.equal(sessionNameFrom(file), 'Refactor the checkout flow');
});

test('resolveSessionName prefers the index over the transcript', () => {
  withCodexHome((home) => {
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: SID, thread_name: 'Indexed title' }) + '\n');
    const file = writeRollout([eventUser('transcript title')]);
    assert.equal(resolveSessionName(SID, file), 'Indexed title');
  });
});

// --- the preamble denylist -------------------------------------------------------------------

test('the injected environment_context never becomes the name', () => {
  const file = writeRollout([responseUser(ENV_CONTEXT), eventUser('Add a retry to the uploader')]);
  const name = sessionNameFrom(file);
  assert.equal(name, 'Add a retry to the uploader');
  // The bug this guards: a home path used to leave the machine inside session_name.
  assert.ok(!name.includes('C:\\Users\\'));
  assert.ok(!name.includes('/Users/'));
});

test('the summarizer priming message never becomes the name', () => {
  const file = writeRollout([responseUser(ASSISTANT_PRIMING), eventUser('Wire up the webhook')]);
  assert.equal(sessionNameFrom(file), 'Wire up the webhook');
});

test('recommended_plugins is skipped — a shape the old allowlist did not name', () => {
  const file = writeRollout([responseUser('<recommended_plugins>\n  <plugin>beezi</plugin>\n</recommended_plugins>'), eventUser('Bump the API client')]);
  assert.equal(sessionNameFrom(file), 'Bump the API client');
});

test('an AGENTS.md/Skills preamble alone yields null rather than a name', () => {
  const file = writeRollout([responseUser('# AGENTS.md instructions for c:\\repo\n<INSTRUCTIONS>\n## Skills\n')]);
  assert.equal(sessionNameFrom(file), null);
});

test('a preamble-only transcript never leaks even when it is the only user text', () => {
  const file = writeRollout([responseUser(ENV_CONTEXT), responseUser(ASSISTANT_PRIMING)]);
  assert.equal(sessionNameFrom(file), null);
});

test('turn_aborted is skipped — it is a Codex notice, not a prompt', () => {
  const file = writeRollout([
    responseUser('<turn_aborted>\n  <reason>interrupted</reason>\n</turn_aborted>'),
    eventUser('Carry on with the parser'),
  ]);
  assert.equal(sessionNameFrom(file), 'Carry on with the parser');
});

test("Codex's own title-generation turn never becomes the name", () => {
  const file = writeRollout([
    eventUser('Generate a concise UI title (20-40 characters) for this task. Return only the title.'),
  ]);
  assert.equal(sessionNameFrom(file), null);
});

// --- the IDE context wrapper -----------------------------------------------------------------

// The dominant real shape: 106 of 182 local rollouts. The IDE prepends a context dump and marks the
// human's text with a heading. Reporting the whole message names the session after the user's open
// tab list; refusing it names nothing. Unwrap.
const IDE_WRAPPED = [
  '# Context from my IDE setup:',
  '',
  '## Active file: portal/api/src/infra/formatter.ts',
  '',
  '## Open tabs:',
  '- formatter.ts: portal/api/src/infra/formatter.ts',
  '- handler.ts: portal/api/src/app/handler.ts',
  '',
  '## My request for Codex:',
  'branch search does not work',
].join('\n');

test('an IDE-wrapped message resolves to the human request, not the context dump', () => {
  const file = writeRollout([eventUser(IDE_WRAPPED)]);
  const name = sessionNameFrom(file);
  assert.equal(name, 'branch search does not work');
  assert.ok(!name.includes('Open tabs'), 'the IDE dump does not ride along');
  assert.ok(!name.includes('Active file'));
});

test('an IDE wrapper with no request section yields null rather than the dump', () => {
  const file = writeRollout([eventUser('# Context from my IDE setup:\n\n## Active file: a.ts\n\n## Open tabs:\n- a.ts: a.ts')]);
  assert.equal(sessionNameFrom(file), null);
});

test('an IDE-wrapped response_item is unwrapped too, and can still lose to a later event_msg', () => {
  const file = writeRollout([responseUser(IDE_WRAPPED), eventUser('the real follow-up prompt')]);
  assert.equal(sessionNameFrom(file), 'the real follow-up prompt');
});

// --- the latch -------------------------------------------------------------------------------

test('a rejected response_item candidate does not latch out a later real prompt', () => {
  // Both are response_items: with the old `!firstResponseUser` latch the env block won and the real
  // prompt below it was discarded. No event_msg here, so nothing else can rescue it.
  const file = writeRollout([responseUser(ENV_CONTEXT), responseUser('Explain the retry backoff')]);
  assert.equal(sessionNameFrom(file), 'Explain the retry backoff');
});

test('an event_msg user_message still beats an earlier acceptable response_item', () => {
  const file = writeRollout([responseUser('some pasted context line'), eventUser('The actual prompt')]);
  assert.equal(sessionNameFrom(file), 'The actual prompt');
});

// --- the scan window -------------------------------------------------------------------------

test('a preamble far larger than the old 64KB head still resolves', () => {
  // ~1.3MB of preamble across several records, mirroring a real rollout whose first user_message
  // sat at byte 1,240,509. The old fixed 64KB head returned null for these.
  const records = [];
  for (let i = 0; i < 7; i++) records.push(responseUser(`<environment_context>${'x'.repeat(190 * 1024)}`));
  records.push(eventUser('Ship the migration'));
  const file = writeRollout(records);
  assert.ok(fs.statSync(file).size > 1_300_000, 'fixture must exceed 1.3MB');
  assert.equal(sessionNameFrom(file), 'Ship the migration');
});

test('a complete final record with no trailing newline is still parsed', () => {
  const file = writeRaw([JSON.stringify(responseUser(ENV_CONTEXT)), JSON.stringify(eventUser('No trailing newline'))].join('\n'));
  assert.equal(sessionNameFrom(file), 'No trailing newline');
});

test('a record cut off by the scan ceiling is dropped, not half-parsed', () => {
  // One record larger than the 2MB ceiling: the read stops mid-record and the fragment must not
  // become a name (and must not throw).
  const file = writeRaw(JSON.stringify(responseUser('x'.repeat(3 * 1024 * 1024))) + '\n');
  assert.equal(sessionNameFrom(file), null);
});

test('a multi-byte character straddling a chunk boundary is not mangled', () => {
  const CHUNK = 256 * 1024;
  const NAME = '日本語のプロンプト'; // 3 bytes per char
  const nameRec = JSON.stringify(eventUser(NAME));
  const nameOffsetInRec = nameRec.indexOf(NAME); // everything before it is ASCII
  // Land the chunk boundary one byte into the first multi-byte character.
  const targetPrefixBytes = CHUNK - nameOffsetInRec - 1;
  const mk = (pad) => JSON.stringify(responseUser(`<environment_context>${'x'.repeat(pad)}`));
  const pad = targetPrefixBytes - 1 - mk(0).length; // -1 for the '\n'
  assert.ok(pad > 0, 'fixture must be able to reach the boundary');
  const filler = mk(pad);
  assert.equal(Buffer.byteLength(`${filler}\n`), targetPrefixBytes);
  const file = writeRaw(`${filler}\n${nameRec}\n`);
  const name = sessionNameFrom(file);
  assert.equal(name, NAME);
  assert.ok(!name.includes('\uFFFD'), 'no replacement characters');
});

// --- the index and the codex home ------------------------------------------------------------

test('a missing index falls through to the transcript', () => {
  withCodexHome(() => {
    const file = writeRollout([eventUser('From the transcript')]);
    assert.equal(resolveSessionName(SID, file), 'From the transcript');
  });
});

test('both sources failing yields null, not a throw', () => {
  withCodexHome(() => {
    assert.equal(resolveSessionName(SID, path.join(tmpdir(), 'nope.jsonl')), null);
  });
});

test('codexHomeFromTranscript recovers the home from a rollout path', () => {
  const home = path.join(path.sep === '\\' ? 'C:\\tmp' : '/tmp', 'codexhome');
  const rollout = path.join(home, 'sessions', '2026', '08', '07', 'rollout-2026-08-07T10-00-00-abc.jsonl');
  assert.equal(codexHomeFromTranscript(rollout), path.resolve(home));
  // Anything not shaped sessions/YYYY/MM/DD/<file> is refused rather than guessed at.
  assert.equal(codexHomeFromTranscript(path.join(home, 'sessions', 'rollout.jsonl')), null);
  assert.equal(codexHomeFromTranscript(path.join(home, 'rollout.jsonl')), null);
  assert.equal(codexHomeFromTranscript(null), null);
});

test('the index is found via the transcript path when CODEX_HOME points elsewhere', () => {
  // The macOS failure: codexHome() resolves somewhere Codex does not actually write, while the
  // transcript path in hand is correct.
  const realHome = tmpdir();
  const dayDir = path.join(realHome, 'sessions', '2026', '08', '07');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-2026-08-07T10-00-00-abc.jsonl');
  fs.writeFileSync(rollout, JSON.stringify(eventUser('transcript fallback')) + '\n');
  fs.writeFileSync(path.join(realHome, 'session_index.jsonl'), JSON.stringify({ id: SID, thread_name: 'Recovered title' }) + '\n');

  withCodexHome(() => {
    assert.equal(resolveSessionName(SID, rollout), 'Recovered title');
  });
});

// --- the safety guard ------------------------------------------------------------------------

test('isSafeSessionName refuses anything still shaped like injected context', () => {
  assert.equal(isSafeSessionName('<environment_context> ...'), false);
  assert.equal(isSafeSessionName('<xml>pasted by the user</xml>'), false);
  assert.equal(isSafeSessionName('# Fix login bug'), false, 'a heading reads as a document');
  assert.equal(isSafeSessionName('… …'), false, 'a fully redacted name is no name');
  assert.equal(isSafeSessionName(''), false);
  assert.equal(isSafeSessionName(null), false);
});

test('isSafeSessionName accepts ordinary prompts', () => {
  assert.equal(isSafeSessionName('Refactor the checkout flow'), true);
  assert.equal(isSafeSessionName('fix src/lib/parser.ts line 40'), true, 'relative paths are ordinary content');
  assert.equal(isSafeSessionName('日本語のプロンプト'), true);
});

// --- path redaction ---------------------------------------------------------------------------
// An absolute path is removed from the name rather than costing the whole name. Rejecting outright
// lost real prompts — a build error whose stack trace mentions the home directory, or "update this
// file <path>" — while redaction keeps the useful half and still lets nothing identifying leave.

const nameOf = (text) => sessionNameFrom(writeRollout([eventUser(text)]));

test('an absolute path inside a real prompt is redacted, not fatal', () => {
  const name = nameOf('[ERROR] Unable to build website at tryToBuildLocale (C:\\Users\\Someone\\proj\\build.js)');
  assert.ok(name, 'the prompt still yields a name');
  assert.ok(!name.includes('C:\\Users\\'), `no windows home path: ${name}`);
  assert.match(name, /Unable to build website/, 'the useful half survives');
});

test('POSIX home paths are redacted the same way', () => {
  for (const p of ['/Users/someone/app/main.ts', '/home/someone/app/main.ts']) {
    const name = nameOf(`why does ${p} crash`);
    assert.ok(!name.includes('someone'), `redacted: ${name}`);
    assert.match(name, /why does .* crash/);
  }
});

test('a run of redacted paths collapses to one marker', () => {
  // A prompt listing a dozen files otherwise becomes a wall of ellipses before the actual sentence.
  const name = nameOf('C:\\a\\b.ts C:\\c\\d.ts C:\\e\\f.ts C:\\g\\h.ts review migration for conflicts');
  assert.match(name, /^… review migration for conflicts$/);
});

test('a prompt that is nothing but a path yields no name at all', () => {
  assert.equal(nameOf('C:\\Users\\Someone\\Downloads\\thing.docx'), null);
});

test('relative paths are left untouched', () => {
  assert.equal(nameOf('fix src/lib/parser.ts line 40'), 'fix src/lib/parser.ts line 40');
});

// --- the session index ------------------------------------------------------------------------
// Codex writes ~/.codex/session_index.jsonl twice per session: the raw first prompt truncated to
// ~36 characters lands immediately, then the AI-generated thread name replaces it seconds later.
// Both records carry the same id, so the resolver has to choose — and it has to gate what it picks,
// because that first record is verbatim prompt text.

function writeIndex(home, records) {
  fs.writeFileSync(path.join(home, 'session_index.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('the AI title wins over the placeholder even when it is written first', () => {
  withCodexHome((home) => {
    writeIndex(home, [
      { id: SID, thread_name: 'Design Dockerized notes app', updated_at: '2026-09-07T10:25:45.4273257Z' },
      { id: SID, thread_name: 'our task to design local app (i thin', updated_at: '2026-09-07T10:25:41.3106017Z' },
    ]);
    assert.equal(sessionNameFromIndex(SID), 'Design Dockerized notes app');
  });
});

test('an absolute path in an index name is redacted', () => {
  withCodexHome((home) => {
    writeIndex(home, [{ id: SID, thread_name: 'why does C:\\Users\\Someone\\app\\main.ts crash' }]);
    const name = sessionNameFromIndex(SID);
    assert.ok(name, 'the name survives redaction');
    assert.ok(!name.includes('C:\\Users\\'), `no windows home path: ${name}`);
    assert.match(name, /why does .* crash/);
  });
});

test('an index name that is nothing but an absolute path is refused', () => {
  withCodexHome((home) => {
    writeIndex(home, [{ id: SID, thread_name: 'C:\\Users\\Someone\\Downloads\\thing.docx' }]);
    assert.equal(sessionNameFromIndex(SID), null);
  });
});

test('an index name shaped like injected context is refused', () => {
  withCodexHome((home) => {
    writeIndex(home, [{ id: SID, thread_name: ENV_CONTEXT }]);
    assert.equal(sessionNameFromIndex(SID), null);
  });
});

test('a newest record that fails the safety gate falls back to an older usable one', () => {
  withCodexHome((home) => {
    writeIndex(home, [
      { id: SID, thread_name: 'Fix the parser', updated_at: '2026-09-07T10:00:00Z' },
      { id: SID, thread_name: 'C:\\Users\\Someone\\Downloads\\thing.docx', updated_at: '2026-09-07T10:00:05Z' },
    ]);
    assert.equal(sessionNameFromIndex(SID), 'Fix the parser');
  });
});

test('the truncated first-prompt placeholder does not become the name', () => {
  const realHome = tmpdir();
  const dayDir = path.join(realHome, 'sessions', '2026', '09', '07');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-2026-09-07T10-25-41-abc.jsonl');
  fs.writeFileSync(rollout,
    JSON.stringify(eventUser('our task to design local app (i think web app with api and postgres)')) + '\n');
  // The AI title has not landed yet: only Codex's own 36-character cut of the prompt is indexed.
  writeIndex(realHome, [{ id: SID, thread_name: 'our task to design local app (i thin' }]);

  withCodexHome(() => {
    assert.equal(resolveSessionName(SID, rollout),
      'our task to design local app (i think web app with api and postgres)');
  });
});

test('a placeholder is still used when the rollout yields nothing', () => {
  withCodexHome((home) => {
    writeIndex(home, [{ id: SID, thread_name: 'our task to design local app (i thin' }]);
    assert.equal(resolveSessionName(SID, path.join(tmpdir(), 'missing.jsonl')),
      'our task to design local app (i thin');
  });
});

test('an AI title that is not a truncation of the prompt is kept', () => {
  withCodexHome((home) => {
    writeIndex(home, [{ id: SID, thread_name: 'Deploy apps to Vercel' }]);
    const rollout = writeRollout([eventUser('we need to deploy our apps on vercel, u can use mcp')]);
    assert.equal(resolveSessionName(SID, rollout), 'Deploy apps to Vercel');
  });
});

test('an AI title differing from a short prompt only in case is kept', () => {
  withCodexHome((home) => {
    writeIndex(home, [
      { id: SID, thread_name: 'ping', updated_at: '2026-09-09T15:54:21Z' },
      { id: SID, thread_name: 'Ping', updated_at: '2026-09-09T15:54:25Z' },
    ]);
    assert.equal(resolveSessionName(SID, writeRollout([eventUser('ping')])), 'Ping');
  });
});
