// Stdio entry for the Beezi MCP server: Codex runs this instead of
// connecting to the portal directly, so the stored sign-in credentials
// authenticate MCP too — no separate OAuth prompt. Logic in lib/mcp-bridge.mjs.
import readline from 'readline';
import { createBridge } from '../lib/mcp-bridge.mjs';
import { exitClean } from '../lib/shutdown.mjs';
import { checkEnvironment } from '../lib/env-guard.mjs';
import { isTelemetryGranted } from '../lib/diagnostics.mjs';
import { claimFlushWindow, flushDiagnostics } from '../lib/telemetry-flush.mjs';
import { sharedLock, withLock } from '../lib/single-instance-lock.mjs';
import { orDefault } from '../lib/compat.mjs';

// stdout on a pipe is asynchronous, so a forced exit drops whatever is still buffered — including
// the response we waited for the in-flight work below to produce. Keeping only the newest write's
// flush promise is enough: stream writes complete in order, so awaiting the last implies the rest.
let flushed = Promise.resolve();
const write = (line) => {
  flushed = new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
};

const bridge = createBridge({ write });
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Handling is async — a tool call can be a whole browser sign-in — so exiting the moment stdin
// ends would drop whatever is still in flight and swallow its response. Track the outstanding
// work and leave only once it has settled.
const inFlight = new Set();
let stdinClosed = false;
let leaving = false;
let watcher = null;
let diagnosticsTimer = null;
let diagnosticsInterval = null;
let diagnosticsStarted = false;

async function flushPendingDiagnostics() {
  if (leaving || stdinClosed) return;
  const guard = checkEnvironment();
  if (guard.status !== 'ok' && guard.status !== 'migrated') return;
  if (!isTelemetryGranted()) return;
  // The lock covers only the synchronous claim, never the POSTs: lock order is checked across this
  // whole process, so a ranked lock held over network I/O would refuse the watcher's election and
  // the token refresh. The claim itself keeps other windows from sending until it expires.
  const claim = withLock(sharedLock('diagnostics-flush'), { leaseMs: 30_000 }, () => claimFlushWindow());
  if (!claim.ok || !claim.value) return;
  await flushDiagnostics({ claimedUntil: claim.value });
}

function startDiagnosticsDelivery() {
  if (diagnosticsStarted || leaving || stdinClosed) return;
  diagnosticsStarted = true;
  const run = () => {
    const work = flushPendingDiagnostics().catch(() => {}).finally(() => {
      inFlight.delete(work);
      void maybeExit();
    });
    inFlight.add(work);
  };
  diagnosticsTimer = setTimeout(run, 1000);
  diagnosticsTimer.unref();
  diagnosticsInterval = setInterval(run, 15 * 60 * 1000);
  diagnosticsInterval.unref();
}

async function maybeExit() {
  if (leaving || !stdinClosed || inFlight.size > 0) return;
  leaving = true;
  clearTimeout(diagnosticsTimer);
  clearInterval(diagnosticsInterval);
  // BEFORE the flush and the exit, so no tick fires into a process that is tearing down and the
  // election lock is released rather than left for the next watcher's stale-takeover path. The
  // tick timer is CLEARED here, never unref'd (G-10-2): an unref'd timer in a process whose only
  // other handle is stdin is precisely the bug test/mcp-bridge-timers.test.mjs locks out.
  if (watcher) {
    try { watcher.stop(); } catch { /* best-effort */ }
    watcher = null;
  }
  await flushed;
  // exitClean, not process.exit: undici's keep-alive handles trip a libuv assertion on Windows
  // when the process is torn down while they are still open.
  await exitClean(0);
}

// ── The rollout watcher (G-1-1, Branch A) — ON unless explicitly opted out ────────────────────
//
// The variable name and the accepted values below are `WATCHER_ENV_VAR` and `isWatcherEnabled`
// from lib/rollout-watcher.mjs, which is the authority on both. They are repeated here for ONE
// reason: this check runs before the dynamic import, so an opted-out machine never loads the
// watcher's module graph — checkpoint, session-audit, coverage and the lock primitive — at all.
// Importing the module to ask it would defeat the gate.
//
// It is an explicit false-value list, not a truthiness test, for the same reason
// isWatcherEnabled uses one:
// `BEEZI_CODEX_WATCHER=0` and `=false` are what a user types to turn something OFF, and both are
// truthy strings. Anything else about the decision belongs in startWatcher(), and
// test/watcher-optin.test.mjs asserts the two copies cannot drift.
//
// `.mcp.json` forwards BEEZI_CODEX_WATCHER. The watcher now defaults ON because it is the only
// timely delivery path when a terminal Codex API error does not fire Stop. Explicit false values
// keep the original zero-load opt-out available.
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// The plan's release order puts delivery automation after the production cutover and its guarded
// migration (repo-root docs/plans/2026-09-10-codex-gap-closure-plan.md, "Release order"), so
// shipping this delivery path is the requirement, not a precaution.
const watcherFlag = process.env.BEEZI_CODEX_WATCHER;
const watcherEnabled = typeof watcherFlag !== 'string'
  || ['0', 'false', 'no', 'off', 'disabled'].indexOf(watcherFlag.trim().toLowerCase()) === -1;

if (watcherEnabled) {
  // Dynamic, and its failure is swallowed: analytics must never be the reason ticket drafting
  // stops working, and this file's stdout belongs to JSON-RPC — a stray write corrupts the stream.
  // Each tick rechecks migration before pruning or capturing, including after a refusal.
  import('../lib/rollout-watcher.mjs')
    .then((mod) => {
      if (!mod) return;
      // stdin may already have closed while the module was loading; starting a tick loop into a
      // process that is on its way out would leave the election lock held by a corpse.
      if (leaving || stdinClosed) return;
      watcher = mod.startWatcher();
    })
    .catch((error) => process.stderr.write(`[beezi-mcp] watcher: ${orDefault((error || {}).message, error)}\n`));
}

rl.on('line', (line) => {
  let initialization = false;
  try {
    const msg = JSON.parse(line);
    initialization = msg != null && msg.method === 'initialize';
  } catch { /* bridge handles malformed input */ }
  // A throw anywhere in handling must not escape as an unhandled rejection — Node makes those
  // fatal, and staying up for the whole session is this server's entire job.
  const work = bridge
    .handleLine(line)
    .then(() => { if (initialization) startDiagnosticsDelivery(); })
    .catch((error) => process.stderr.write(`[beezi-mcp] ${orDefault((error || {}).message, error)}\n`))
    .finally(() => {
      inFlight.delete(work);
      void maybeExit();
    });
  inFlight.add(work);
});

rl.on('close', () => {
  stdinClosed = true;
  void maybeExit();
});
