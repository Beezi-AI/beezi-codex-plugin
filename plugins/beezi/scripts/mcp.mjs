// Stdio entry for the Beezi MCP server: Codex runs this instead of
// connecting to the portal directly, so the stored sign-in credentials
// authenticate MCP too — no separate OAuth prompt. Logic in lib/mcp-bridge.mjs.
import readline from 'node:readline';
import { createBridge } from '../lib/mcp-bridge.mjs';
import { exitClean } from '../lib/shutdown.mjs';

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

async function maybeExit() {
  if (leaving || !stdinClosed || inFlight.size > 0) return;
  leaving = true;
  await flushed;
  // exitClean, not process.exit: undici's keep-alive handles trip a libuv assertion on Windows
  // when the process is torn down while they are still open.
  await exitClean(0);
}

rl.on('line', (line) => {
  // A throw anywhere in handling must not escape as an unhandled rejection — Node makes those
  // fatal, and staying up for the whole session is this server's entire job.
  const work = bridge
    .handleLine(line)
    .catch((error) => process.stderr.write(`[beezi-mcp] ${error?.message ?? error}\n`))
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
