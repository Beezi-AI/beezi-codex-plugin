import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSENT_VERSION,
  DIAGNOSTIC_CODES,
  readConsent,
  hasBeenAsked,
  isTelemetryGranted,
  recordIssue,
  diagnosticsDir,
  diagnosticsConsentFile,
} from '../lib/diagnostics.mjs';
import { telemetryCommand } from '../skills/telemetry/telemetry.mjs';

// G-9-6. lib/diagnostics.mjs owns the switch; this is the only thing a human can reach it through.
// The properties asserted here are the ones a user is entitled to rely on, so each is checked
// against the real module and the real files — nothing about consent is worth proving against a
// stub. Driven in-process rather than by spawning the CLI, because the suite's hermeticity gate
// records every child process as a leak.

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-consent-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function events() {
  try {
    return fs.readdirSync(diagnosticsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

const say = (result) => result.lines.join('\n');
const crash = () => recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED });

test('the first run puts the question — and being asked is not consent', (t) => {
  withHome(t);

  const result = telemetryCommand([]);

  assert.equal(result.ok, true);
  assert.match(say(result), /has not been asked before/);
  assert.match(say(result), /OFF — the default/);
  assert.match(say(result), /Nothing has been recorded or sent on this machine so far/);
  assert.match(say(result), /If you never answer, it stays OFF and you will not be asked again/);

  // The two halves that must never collapse into one: the question was PUT, and it was not
  // answered. `hasBeenAsked` is what stops the re-nag; `consent` is what would authorize a report.
  assert.equal(hasBeenAsked(), true, 'the question is recorded as asked');
  assert.equal(readConsent().consent, undefined, 'and no answer is invented on the user’s behalf');
  assert.equal(isTelemetryGranted(), false, 'so the default stands');

  assert.equal(crash(), false, 'nothing is recorded');
  assert.deepEqual(events(), [], 'and nothing is on disk to be sent later');
});

test('a user who never answers is not asked twice', (t) => {
  withHome(t);
  telemetryCommand([]);

  const again = say(telemetryCommand([]));

  assert.doesNotMatch(again, /has not been asked before/, 'the question is put once, not every run');
  assert.match(again, /You were asked on \d{4}-\d{2}-\d{2} and have not answered/);
  assert.match(again, /Nothing has been recorded or sent in the meantime/);
  assert.equal(isTelemetryGranted(), false, 'unanswered stays off, however many times it is read');
  assert.equal(crash(), false);
  assert.deepEqual(events(), []);
});

test('a declined machine is neither re-nagged nor reported on', (t) => {
  withHome(t);

  const off = telemetryCommand(['off']);
  assert.equal(off.ok, true);
  assert.match(say(off), /is now OFF/);
  assert.match(say(off), /You will not be asked about this again/);

  // Declined is a real answer, so the question is never put again — this is the whole reason
  // `hasBeenAsked` exists as a key separate from `consent`.
  const later = say(telemetryCommand([]));
  assert.doesNotMatch(later, /has not been asked before/);
  assert.match(later, /you turned it off on \d{4}-\d{2}-\d{2}/);
  assert.match(later, /Nothing is being recorded and nothing is being sent/);

  assert.equal(readConsent().consent, 'denied');
  assert.equal(isTelemetryGranted(), false);
  assert.equal(crash(), false, 'a declined machine records nothing');
  assert.deepEqual(events(), [], 'and holds nothing that a later flush could ship');
});

test('a declined machine can change its mind later', (t) => {
  withHome(t);
  telemetryCommand([]);
  const askedAt = readConsent().askedAt;
  telemetryCommand(['off']);
  assert.equal(isTelemetryGranted(), false);

  const on = telemetryCommand(['on']);

  assert.equal(on.ok, true);
  assert.equal(isTelemetryGranted(), true, 'a no is an answer, not a latch');
  assert.equal(crash(), true);
  assert.match(say(telemetryCommand([])), /is ON \(turned on \d{4}-\d{2}-\d{2}\)/);
  // Neither answer rewrites the moment the question was PUT — a machine asked on day 1 that
  // answers on day 30 keeps both timestamps.
  assert.equal(readConsent().askedAt, askedAt);
});

test('turning it on reports only what happens afterwards', (t) => {
  withHome(t);

  // Pre-consent failures are not queued for later — the gate is inside recordIssue, before
  // anything is computed or written, so a later "on" cannot become retroactive consent.
  assert.equal(crash(), false);
  assert.deepEqual(events(), []);

  const on = telemetryCommand(['on']);
  assert.equal(on.ok, true);
  assert.match(say(on), /is now ON/);
  assert.equal(isTelemetryGranted(), true);

  assert.equal(crash(), true);
  assert.equal(events().length, 1, 'exactly the failure that happened after the grant');
});

test('turning it off deletes what was already recorded', (t) => {
  withHome(t);
  telemetryCommand(['on']);
  crash();
  assert.equal(events().length, 1);

  const off = telemetryCommand(['off']);

  assert.equal(off.ok, true);
  assert.match(say(off), /has been deleted/);
  assert.deepEqual(events(), [], 'a period of reporting cannot be re-opened by a later flush');
  assert.equal(isTelemetryGranted(), false);
  assert.equal(crash(), false);
});

test('the answer is stored where the 14-day sweep cannot reach it', (t) => {
  const home = withHome(t);
  telemetryCommand(['off']);

  const file = diagnosticsConsentFile();
  assert.equal(fs.existsSync(file), true);
  assert.equal(path.dirname(file), path.resolve(home), 'root of the Beezi home, never under state/');
  // Stated as the failure it prevents: prune walks state/, so a consent record living there would
  // expire, and a machine that declined would silently start reporting again a fortnight later.
  assert.equal(file.indexOf(`${path.sep}state${path.sep}`), -1);
});

test('a record from another consent version re-asks instead of inheriting the answer', (t) => {
  const home = withHome(t);
  fs.writeFileSync(
    path.join(home, path.basename(diagnosticsConsentFile())),
    JSON.stringify({ version: CONSENT_VERSION + 1, consent: 'granted', decidedAt: '2020-01-01T00:00:00.000Z' }),
  );

  const result = telemetryCommand([]);

  assert.equal(isTelemetryGranted(), false, 'a grant against a different question is not this one');
  assert.match(say(result), /has not been asked before/, 'so the question is put again');
  assert.equal(crash(), false);
});

test('an argument that is not on or off changes nothing, and is not echoed back raw', (t) => {
  withHome(t);
  telemetryCommand(['on']);

  const result = telemetryCommand(['on; rm -rf /']);

  assert.equal(result.ok, false, 'a non-zero exit, so the model cannot read it as a setting');
  assert.doesNotMatch(say(result), /rm -rf/, 'the argument is shaped before it is quoted back');
  assert.match(say(result), /is not something this command takes/);
  assert.equal(isTelemetryGranted(), true, 'and the stored answer is untouched');
});

test('status is a read: it never changes an answer that exists', (t) => {
  withHome(t);
  telemetryCommand(['on']);
  const before = readConsent();

  telemetryCommand([]);
  telemetryCommand(['status']);

  assert.deepEqual(readConsent(), before);
  assert.equal(isTelemetryGranted(), true);
});
