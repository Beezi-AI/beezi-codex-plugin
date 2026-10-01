import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { BEEZI_HOOKS } from '../lib/hooks-install.mjs';
import { touchHeartbeat } from '../lib/timing.mjs';
import { stateDir } from '../lib/paths.mjs';
import { resolveCodexTranscript, quarantinePoisonedSessionState } from '../lib/transcript-codex.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The heartbeat's wiring into the two hook scripts (G-3-2).
//
// SOURCE ASSERTIONS, AND WHY. Nothing in this suite can execute a hook script: they read a payload
// from fd 0, and the hermeticity gate records every child_process call as a violation, so spawning
// one fails the file it runs in (tools/hermetic-env.mjs — `withoutGuard` exists for exactly one
// sanctioned caller and this is not it). smoke.test.mjs makes the same trade for the same reason:
// it PARSES each script's imports rather than running it. These checks are therefore deliberately
// structural. They cannot prove the scripts behave; lib/timing.mjs's own tests do that. What they
// prove is that the three decisions that are only expressible in the script — which path claims,
// which path only touches, and which path ships a turn end's payload — have not silently changed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const scriptsDir = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'scripts',
);
const read = (name) => fs.readFileSync(path.join(scriptsDir, name), 'utf-8');

test('NO NEW HOOK EVENT: the heartbeat rides the five entries already registered', () => {
  // The whole argument for this row being cheap. A sixth entry is another line the user has to read
  // and trust in /hooks, and Codex's trust gate makes that the expensive part of anything here.
  assert.deepEqual(
    BEEZI_HOOKS.map((h) => h.event),
    ['SessionStart', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'],
  );
  assert.equal(BEEZI_HOOKS.filter((h) => h.script === 'checkpoint.mjs').length, 1,
    'one PostToolUse handler, not a second one beside it');
});

test('the PostToolUse handler refuses subagent payloads BEFORE it can claim a heartbeat', () => {
  const src = read('checkpoint.mjs');
  // The STATEMENT, not the prose about it — indexOf('input.agent_id') would happily match the
  // comment that explains the guard and keep passing after the guard itself was deleted.
  const guard = src.indexOf('if (input.agent_id) process.exit(0);');
  const claim = src.indexOf('shouldHeartbeat(input)');
  assert.ok(guard > -1, 'the agent_id guard is what bounds an unmeasured fan-out');
  assert.ok(claim > -1, 'the handler consults the heartbeat gate');
  assert.ok(guard < claim, 'a fan-out must cost a process exit, never a claim');
});

test('the git boundary short-circuits the claim, and stamps the marker instead', () => {
  const src = read('checkpoint.mjs');
  // The marker means "time since the last CHECKPOINT of this session", not "since the last
  // heartbeat" — otherwise a session committing every few minutes still pays a redundant one.
  assert.match(src, /boundary\s*\?\s*false\s*:\s*shouldHeartbeat\(/);
  assert.match(src, /if \(result.outcome === 'committed'\) touchHeartbeat\(input\.session_id\)/);
});

test('only the heartbeat path ships a turn end: emitTimeline is the flag, never a literal true', () => {
  const src = read('checkpoint.mjs');
  // emitTimeline drives the subagent sweep, the timeline POST and the rate-limit drain. The
  // heartbeat needs all three because it stands in for a Stop that may never come; the git-boundary
  // path must keep the behaviour it shipped with, so hard-coding `true` here is a regression in
  // the boundary path even though the heartbeat would still work.
  // Scoped to the call itself, not to the whole file: a future comment quoting `emitTimeline: true`
  // must not redden this.
  const call = src.split('\n').find((l) => l.includes('runCheckpoint(input,'));
  assert.ok(call, 'the handler still calls runCheckpoint');
  assert.match(call, /emitTimeline:\s*heartbeat/);
  assert.doesNotMatch(call, /emitTimeline:\s*true/);
  // And the budget is not optional on either path: Codex kills an overrunning hook and reports the
  // kill as a hook failure.
  assert.match(src, /budgetMs:\s*HOOK_BUDGET_MS/);
});

test('the turn end resets the heartbeat window', () => {
  const src = read('stop.mjs');
  assert.match(src, /touchHeartbeat\(input\.session_id\)/,
    'without this the marker tracks heartbeats rather than checkpoints, and the next turn fires early');
  // Before runCheckpoint, so a Stop that is itself killed leaves the next turn free to heartbeat.
  assert.ok(src.indexOf('touchHeartbeat(') > src.indexOf('runCheckpoint('));
});

test('the gate is imported from lib/timing.mjs, not from the 28-module engine', () => {
  const src = read('checkpoint.mjs');
  // The cost argument for the whole row: the gate runs on every tool call, so it must not be able
  // to drag lib/checkpoint.mjs in. That import stays dynamic and past the guard.
  assert.match(src, /^import \{[^}]*shouldHeartbeat[^}]*\} from '\.\.\/lib\/timing\.mjs';$/m);
  assert.doesNotMatch(src, /^import .*from '\.\.\/lib\/checkpoint\.mjs';$/m);
  assert.match(src, /await import\('\.\.\/lib\/checkpoint\.mjs'\)/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The marker is a NEW FILENAME SHAPE inside state/, a directory three other modules enumerate.
// `<id>.agents` (lib/subagent-state.mjs) is the precedent — every reader there already matches an
// extension explicitly rather than assuming everything is `<id>.json` — but "already true" is not
// a guarantee, and getting this wrong resurrects G-3-1 in the very directory G-3-1 was about: a
// reader that derives a session id from a filename would mint `s1` out of `s1.heartbeat` and bill
// a phantom session, or throw on a zero-byte file it tried to JSON.parse.
// ─────────────────────────────────────────────────────────────────────────────────────────────

afterEach(() => forgetHeldLocks());

const tmpHome = (t) => sandboxHome(t, 'beezi-hb-state-');

test('the marker is invisible to every reader that enumerates state/', (t) => {
  tmpHome(t);
  // Two markers: an ordinary session, and the reserved id the quarantine sweep hunts for.
  assert.equal(touchHeartbeat('019b9e64-70b0-7b02-856d-172ee1af767c'), true);
  assert.equal(touchHeartbeat('null'), true);
  const markers = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.heartbeat'));
  assert.equal(markers.length, 2, 'the fixture actually put markers in state/');
  for (const m of markers) {
    assert.equal(fs.statSync(path.join(stateDir(), m)).size, 0, 'a marker is mtime and nothing else');
  }

  // findRolloutBySessionState filters `.json` and then readJson's the match. A marker reaching it
  // would either mint a session id from the filename or throw on empty content.
  assert.equal(resolveCodexTranscript({ session_id: null, cwd: '/nowhere' }), null);

  // The poisoned-state sweep matches `<id>.json` and `<id>.agents` only, so `null.heartbeat` is
  // neither quarantined nor mistaken for a session named "null".
  const swept = quarantinePoisonedSessionState();
  assert.deepEqual(swept.moved, [], JSON.stringify(swept));
  assert.deepEqual(swept.failed, []);
  assert.equal(fs.readdirSync(stateDir()).filter((f) => f.endsWith('.heartbeat')).length, 2);
});

test('a stale marker is swept by the 14-day prune like anything else in state/', (t) => {
  tmpHome(t);
  touchHeartbeat('s1');
  const marker = path.join(stateDir(), 's1.heartbeat');
  assert.equal(fs.existsSync(marker), true);

  // A dead session must not leave a marker behind forever — pruneStale is generic over the
  // directory, which is why the marker needs no cleanup of its own.
  pruneStale(Date.now() + 15 * 24 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(marker), false);
});
