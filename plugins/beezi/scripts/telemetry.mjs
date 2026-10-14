// The crash-report switch the settings skill runs:
//
//   node scripts/telemetry.mjs [status|correlate|on|anonymous|off]
//
// Every decision — what each mode grants, what it deletes — is lib/diagnostics.mjs's setCrashMode;
// this file only words the result. It must work on a machine that is NOT linked: consent to crash
// reporting is exactly the thing that cannot be made to require signing in first.
import path from 'path';
import url from 'url';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { CRASH_MODES, crashMode, isCrashMode, setCrashMode } from '../lib/diagnostics.mjs';

const CORRELATION_ON = 'An installation ID is attached. When binding is needed, it uses the default '
  + 'usable Beezi account, otherwise the first usable account. Changing the default does not rebind an existing ID.';
const CORRELATION_OFF = 'Reports are anonymous — no installation ID is attached.';
const CHANGE = 'Use the settings skill to change this (Correlate, On, Anonymous or Off).';

// Never echo an argument verbatim: it arrives from a model's shell command, and this line is copied
// into transcripts and bug reports.
function describeArgument(value) {
  return String(value).slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '?');
}

function statusLine() {
  const mode = crashMode();
  if (mode === CRASH_MODES.OFF) return `Beezi diagnostics are OFF. ${CHANGE}`;
  return `Beezi diagnostics are ON. ${mode === CRASH_MODES.CORRELATE ? CORRELATION_ON : CORRELATION_OFF} ${CHANGE}`;
}

function changedLine(mode, wasOn) {
  if (mode === CRASH_MODES.CORRELATE) {
    return `Beezi diagnostics are ON with account correlation. ${CORRELATION_ON} Choose Anonymous in `
      + 'the settings skill to turn correlation off again.';
  }
  if (mode === CRASH_MODES.OFF) {
    return 'Beezi diagnostics are OFF. Pending reports and the installation ID were deleted.';
  }
  if (mode === CRASH_MODES.ANONYMOUS && wasOn) {
    return `Beezi diagnostics stay ON, without account correlation. ${CORRELATION_OFF} Pending `
      + 'correlated reports were deleted.';
  }
  if (mode === CRASH_MODES.ANONYMOUS) {
    return `Beezi diagnostics are ON, without account correlation. ${CORRELATION_OFF}`;
  }
  return 'Beezi diagnostics are ON. Crash reports about the plugin will be sent — never your code '
    + `or prompts. ${CORRELATION_OFF} Recommended: choose Correlate in the settings skill — it `
    + 'attaches one so support can find your report.';
}

// What On/Anonymous actually deleted before the save failed, or null when nothing went.
function purgedSentence(purged) {
  const n = purged.removed > 0 ? purged.removed : 0;
  const reports = `${n} pending ${n === 1 ? 'report' : 'reports'} carrying the installation ID`;
  if (n > 0 && purged.idRemoved) return `${reports}, and the ID itself, were deleted`;
  if (n > 0) return `${reports} ${n === 1 ? 'was' : 'were'} deleted`;
  return purged.idRemoved ? 'The installation ID was deleted' : null;
}

// Off deletes before it can fail to save, so its failure says so. On and Anonymous name only what
// their purge actually deleted; with nothing deleted, as from Off or On, they changed nothing.
function failureLine(mode, before, purged) {
  if (mode === CRASH_MODES.OFF) {
    return 'Every report held on this machine has been deleted, but the choice itself could not be '
      + 'saved, so crash reporting may still be on. Try again, or check that the Beezi home directory '
      + 'is writable.';
  }
  const deleted = purgedSentence(purged);
  if (deleted !== null) {
    const rest = before === CRASH_MODES.CORRELATE ? 'account correlation may still be on' : 'the setting is otherwise unchanged';
    return `${deleted}, but the choice itself could not be saved, so ${rest}. Try again, or check `
      + 'that the Beezi home directory is writable.';
  }
  return 'Could not save the choice, so crash reporting is unchanged. Try again, or check that the '
    + 'Beezi home directory is writable.';
}

// `{ ok, lines }` — never throws, never prints. The CLI wrapper below owns stdout and the exit
// status, so nothing that drives this has to spawn a process.
export function telemetryCommand(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const first = args.length > 0 && args[0] != null ? String(args[0]).trim().toLowerCase() : '';

  if (first === '' || first === 'status') return { ok: true, lines: [statusLine()] };
  if (!isCrashMode(first)) {
    return {
      ok: false,
      lines: [
        `\`${describeArgument(first)}\` is not something this command takes, so nothing was changed.`,
        'Run it with no argument to see the current setting, or with correlate, on, anonymous or off to change it.',
      ],
    };
  }

  const before = crashMode();
  const purged = { removed: 0, idRemoved: false };
  if (!setCrashMode(first, Date.now, purged)) return { ok: false, lines: [failureLine(first, before, purged)] };
  return { ok: true, lines: [changedLine(first, before !== CRASH_MODES.OFF)] };
}

// Run only when this file IS the entry point. Importing it must not execute it.
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
  if (!cliMayProceed()) {
    process.exitCode = 1;
  } else {
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
}
