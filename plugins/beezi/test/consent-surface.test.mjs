import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSENT_VERSION,
  consentPrompt,
  correlationPrompt,
  hasCorrelationBeenAsked,
  isCorrelationGranted,
  DIAGNOSTIC_CODES,
  readConsent,
  hasBeenAsked,
  isTelemetryGranted,
  recordIssue,
  diagnosticsDir,
  diagnosticsConsentFile,
} from '../lib/diagnostics.mjs';
import { telemetryCommand } from '../scripts/telemetry.mjs';

// lib/diagnostics.mjs owns the one-time prompts; the settings CLI reads and changes the switch.
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

test('status is read-only and the hook prompt asks without granting consent', (t) => {
  withHome(t);
  const result = telemetryCommand([]);
  assert.equal(result.ok, true);
  assert.match(say(result), /diagnostics are OFF/);
  assert.equal(hasBeenAsked(), false, 'reading settings does not consume the hook prompt');
  assert.equal(readConsent(), null);
  const prompt = consentPrompt();
  assert.match(prompt, /Never your code, prompts, or file paths/);
  assert.match(prompt, /settings skill/);
  assert.match(prompt, /random installation ID/);
  assert.equal(hasBeenAsked(), true);
  assert.equal(hasCorrelationBeenAsked(), true, 'the initial ask covers correlation too');
  assert.equal(correlationPrompt(), null, 'the initial offer must not be repeated');
  assert.equal(readConsent().consent, undefined);
  assert.equal(isTelemetryGranted(), false);
  assert.equal(isCorrelationGranted(), false);
  assert.equal(crash(), false);
  assert.deepEqual(events(), []);
});

test('a user who never answers is not asked twice', (t) => {
  withHome(t);
  assert.equal(typeof consentPrompt(), 'string');
  const before = readConsent();
  const again = say(telemetryCommand([]));
  assert.match(again, /diagnostics are OFF/);
  assert.equal(consentPrompt(), null);
  assert.equal(correlationPrompt(), null);
  assert.deepEqual(readConsent(), before, 'a settings read does not rewrite prompt timestamps');
  assert.equal(isTelemetryGranted(), false);
  assert.equal(crash(), false);
  assert.deepEqual(events(), []);
});

test('a declined machine is neither re-nagged nor reported on', (t) => {
  withHome(t);

  const off = telemetryCommand(['off']);
  assert.equal(off.ok, true);
  assert.match(say(off), /diagnostics are OFF/);
  assert.equal(consentPrompt(), null);
  assert.equal(correlationPrompt(), null);

  // Declined is a real answer, so the question is never put again — this is the whole reason
  // `hasBeenAsked` exists as a key separate from `consent`.
  const later = say(telemetryCommand([]));
  assert.match(later, /diagnostics are OFF/);
  assert.equal(isCorrelationGranted(), false);

  assert.equal(readConsent().consent, 'denied');
  assert.equal(isTelemetryGranted(), false);
  assert.equal(crash(), false, 'a declined machine records nothing');
  assert.deepEqual(events(), [], 'and holds nothing that a later flush could ship');
});

test('a declined machine can change its mind later', (t) => {
  withHome(t);
  consentPrompt();
  const askedAt = readConsent().askedAt;
  telemetryCommand(['off']);
  assert.equal(isTelemetryGranted(), false);

  const on = telemetryCommand(['on']);

  assert.equal(on.ok, true);
  assert.equal(isTelemetryGranted(), true, 'a no is an answer, not a latch');
  assert.equal(crash(), true);
  assert.match(say(telemetryCommand([])), /diagnostics are ON/);
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
  assert.match(say(on), /diagnostics are ON/);
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
  assert.match(say(off), /were deleted/);
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
  assert.match(say(result), /diagnostics are OFF/);
  assert.equal(hasBeenAsked(), false, 'reading status leaves the new question for its hook owner');
  assert.equal(typeof consentPrompt(), 'string');
  assert.equal(hasBeenAsked(), true);
  assert.equal(crash(), false);
});

test('an invalid crash-report mode changes nothing, and is not echoed back raw', (t) => {
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
