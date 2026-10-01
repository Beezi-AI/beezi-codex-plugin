// The crash-reporting consent surface (G-9-6).
//
// lib/diagnostics.mjs is the mechanism: it records a structured, redacted record of a plugin
// failure and ships it. This file is the only way a human ever hears about that, answers it, or
// changes the answer. It owns no policy of its own — every decision below is `lib/diagnostics.mjs`'s,
// and this file is deliberately incapable of overriding any of them:
//
//   * DEFAULT IS OFF. Nothing here can report; `recordIssue` refuses before it computes or writes
//     anything unless an explicit, current-version grant is on disk. A machine that never runs this
//     command, or runs it and never answers, records nothing and sends nothing, forever.
//   * ASKED IS NOT GRANTED. `markAsked` stamps that the question was PUT; `grantConsent` stamps an
//     answer. They are separate keys for one reason: a user who read the question and walked away
//     must not be nagged every session, and must also not be counted as having agreed.
//   * NO IS RETROACTIVE. `denyConsent` writes the record and then deletes every event already on
//     disk, so a period of reporting cannot be re-opened by a later flush.
//   * THE ANSWER OUTLIVES THE SWEEP. The record sits at the root of the Beezi home, not under
//     state/, because the 14-day prune walks state/ — an expiring "no" is a machine that silently
//     starts reporting again a fortnight later.
//
// WHY THIS FILE SITS BESIDE ITS SKILL rather than in scripts/ with the other entry points: it is
// the skill's own executable half, and it must work on a machine that is NOT linked. Consent to
// crash reporting is exactly the thing that cannot be made to require signing in first, which also
// rules out the MCP bridge (unlinked, it serves only beezi_login / beezi_status).
//
// Written to the same Node 13.2 floor as lib/ and scripts/, because the shell that runs it is the
// same one that runs them.
import path from 'path';
import url from 'url';
import {
  readConsent,
  hasBeenAsked,
  markAsked,
  grantConsent,
  denyConsent,
} from '../../lib/diagnostics.mjs';

// What a report can carry, stated positively and then negatively. Both halves matter: the negative
// half is not a promise about scrubbing, it is a statement about the record's shape — there is no
// field in `buildRecord` that could hold any of it.
const COLLECTED = [
  'A report is structured fields only: which failure it was (one of a short fixed list), which',
  'plugin file and line it happened in, the error class and error code, an HTTP status when there',
  'was one, the plugin / Node / OS / architecture versions, and how many times it repeated.',
  'It cannot carry your code, your prompts, file contents, any path outside the plugin, repository',
  'or branch names, error messages, stack text, tokens or credentials — there is no field for them.',
];

// ISO timestamps in, a plain day out. The record's own value is echoed rather than reformatted, so
// a malformed one degrades to a phrase instead of printing "Invalid Date" or throwing.
function day(value) {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : 'an unknown date';
}

// Never echo an argument verbatim: it arrives from a model's shell command, and this line is copied
// into transcripts and bug reports. Same treatment paths.mjs gives a rejected environment name.
function describeArgument(value) {
  return String(value).slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '?');
}

// The current setting, in the user's words — and, the first time only, the question itself.
//
// Putting the question here is what makes this file a consent surface rather than a settings
// toggle. A hook cannot prompt (it has no terminal and its output is not a conversation), so the
// only place the question can actually be asked on Codex is a command the user ran on purpose.
// Displaying it stamps `askedAt`, which is what stops it being asked twice.
function statusLines() {
  const record = readConsent();
  const consent = record ? record.consent : null;

  if (consent === 'granted') {
    return [`Beezi crash reporting is ON (turned on ${day(record.decidedAt)}).`, '']
      .concat(COLLECTED)
      .concat([
        '',
        'Turning it off also deletes every report still held on this machine.',
      ]);
  }

  if (consent === 'denied') {
    return [
      `Beezi crash reporting is OFF — you turned it off on ${day(record.decidedAt)}.`,
      'Nothing is being recorded and nothing is being sent.',
    ];
  }

  if (hasBeenAsked()) {
    return [
      `Beezi crash reporting is OFF — the default. You were asked on ${day((record || {}).askedAt)} and have not answered.`,
      'Nothing has been recorded or sent in the meantime, and leaving it unanswered keeps it that way.',
    ];
  }

  // First contact. The question is put, and the fact that it was put is written down.
  const stamped = markAsked();
  return [
    'Beezi crash reporting is OFF — the default. This machine has not been asked before, so here is',
    'the question.',
    '',
    'Beezi can report crashes inside the Beezi plugin itself, so a failure that is otherwise',
    'completely silent — every hook swallows its own errors — can be found and fixed.',
    '',
  ].concat(COLLECTED).concat([
    '',
    'Nothing has been recorded or sent on this machine so far.',
    '',
    stamped
      ? 'If you never answer, it stays OFF and you will not be asked again.'
      : 'If you never answer, it stays OFF. (The answer could not be written down, so you may be asked again.)',
  ]);
}

function turnOn() {
  if (!grantConsent()) {
    return {
      ok: false,
      lines: ['Could not save the choice, so Beezi crash reporting is still OFF. Nothing was recorded or sent.'],
    };
  }
  return {
    ok: true,
    lines: ['Beezi crash reporting is now ON.', '']
      .concat(COLLECTED)
      .concat(['', 'You can turn it off again at any time, which also deletes whatever is still held here.']),
  };
}

function turnOff() {
  // denyConsent writes the record first and discards the pending reports second, so a failed write
  // leaves a machine that is nominally still on with an empty queue — recoverable, and nothing the
  // user wanted is lost. That is worth saying out loud rather than reporting a flat failure.
  if (!denyConsent()) {
    return {
      ok: false,
      lines: [
        'Every report held on this machine has been deleted, but the choice itself could not be saved,',
        'so crash reporting may still be on. Try again, or check that the Beezi home directory is writable.',
      ],
    };
  }
  return {
    ok: true,
    lines: [
      'Beezi crash reporting is now OFF.',
      'Every report still held on this machine has been deleted, and nothing further is recorded or sent.',
      'You will not be asked about this again.',
    ],
  };
}

// `{ ok, lines }` — never throws, never prints. The CLI wrapper below owns stdout and the exit
// status; the test drives this directly, so nothing in the suite has to spawn a process.
export function telemetryCommand(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const first = args.length > 0 && args[0] !== undefined && args[0] !== null ? String(args[0]).trim().toLowerCase() : '';

  if (first === '' || first === 'status') return { ok: true, lines: statusLines() };
  if (first === 'on') return turnOn();
  if (first === 'off') return turnOff();

  return {
    ok: false,
    lines: [
      `\`${describeArgument(first)}\` is not something this command takes, so nothing was changed.`,
      'Run it with no argument to see the current setting, `on` to turn crash reporting on, or `off` to turn it off.',
    ],
  };
}

// Run only when this file IS the entry point. Importing it (the test does) must not execute it.
function isDirectRun() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(entry) === path.resolve(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const result = telemetryCommand(process.argv.slice(2));
  const text = result.lines.join('\n');
  if (result.ok) {
    console.log(text);
  } else {
    console.error(text);
    // Set, not exited: process.exit can truncate stdout, and the message is the whole point.
    process.exitCode = 1;
  }
}
