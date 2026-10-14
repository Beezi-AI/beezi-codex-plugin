import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeDirSync } from './compat.mjs';
import { finaleLines } from './setup-finale.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { canReadKeys, colorEnabled, createStyle, paint } from './setup-style.mjs';
import { runSetup } from './setup-wizard.mjs';

// Session-id variables Codex exports to shell commands; the runner drops them from every child's env.
export const SESSION_KEYS = Object.freeze(['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.';
export const STOPPED = 'Setup stopped. Run the installer again, or ask "Sign me in to Beezi" in a new Codex thread, to finish.';
const INTERRUPTED = 130;
const AGENT = 'Codex';
const SHOW_CURSOR = '\x1b[?25h';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-'));
}

function onSigint(handler) {
  process.once('SIGINT', handler);
}

function onProcessExit(handler) {
  process.on('exit', handler);
}

// Runs the wizard on the terminal from a fresh temp cwd and resolves its exit code; Ctrl+C exits 130.
export function setupMain(root, deps) {
  const d = deps || {};
  const stdout = d.stdout || process.stdout;
  const stderr = d.stderr || process.stderr;
  const env = d.env || process.env;
  const style = createStyle({ enabled: colorEnabled({ stream: stdout, env }) });
  const input = (d.openTerminal || openTerminal)();
  if (input === null) {
    stderr.write(`${paint(style, NO_TERMINAL)}\n`);
    return Promise.resolve(1);
  }
  // Shows the cursor again on process exit.
  if (stdout.isTTY) (d.onExit || onProcessExit)(() => { stdout.write(SHOW_CURSOR); });
  const print = (line) => { stdout.write(`${paint(style, line)}\n`); };
  const removeDir = d.removeDir || removeDirSync;
  const exit = d.exit || ((code) => process.exit(code));
  const cwd = (d.makeTempDir || makeTempDir)();
  let prompt = null;
  const cleanup = () => {
    prompt.close();
    removeDir(cwd);
  };
  // Shared by SIGINT and Ctrl+C inside an arrow-key menu.
  const stop = () => {
    cleanup();
    print('');
    print(STOPPED);
    exit(INTERRUPTED);
  };
  prompt = (d.createPrompt || createPrompt)({
    input, output: stdout, style, interactive: canReadKeys({ input, output: stdout, env }), onInterrupt: stop,
  });
  (d.onInterrupt || onSigint)(stop);
  const run = (d.createRunner || createRunner)({
    root, cwd, env, sessionKeys: SESSION_KEYS, paint: (line) => paint(style, line),
  });
  return (d.runSetup || runSetup)({ run, ask: prompt, print })
    .finally(cleanup)
    .then((code) => {
      if (code === 0) {
        finaleLines({ agent: AGENT, style, columns: stdout.columns || 80, random: d.random || Math.random })
          .forEach((line) => { stdout.write(`${line}\n`); });
      }
      return code;
    });
}
