// A DEFAULT import, not a named one: tools/hermetic-env.mjs patches the child_process object, and
// a named binding is snapshotted at instantiation and bypasses that guard entirely.
import childProcess from 'child_process';
import { orDefault } from './compat.mjs';

// A branch is tracked only when it carries a `.../task-<id>` segment. The capture group
// yields the `task-<id>` token (see taskFromBranch).
export const TASK_BRANCH_RE = /\/(task-[a-zA-Z0-9_-]+)/;

export function git(args, cwd) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    // Swallow git's stderr. Probing a directory that isn't a repo is routine here (the
    // origin lookup runs on every cwd a session touches), and Codex surfaces hook stderr —
    // so an unsilenced probe prints "fatal: not a git repository" at the user mid-turn.
    stdio: ['ignore', 'pipe', 'ignore'],
    // Bound the spawn so a hung git can't burn the whole 10s hook budget.
    timeout: 5000,
    killSignal: 'SIGKILL',
    // Pin the C locale so parsed output (e.g. reflog "checkout: moving from…") stays
    // English regardless of the user's git language settings.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

// A local-path origin carries the OS username; only the folder name may travel, with the same
// `local:` prefix checkpoint.mjs's localRemote() uses so it never canonicalises onto a real server.
// scp-style ssh (`host:path`, `user@host:path`) is NOT local: its colon follows a host of 2+ chars.
// No `new URL()`: `remote` is the server-side repo key, and URL normalisation would fork it.
const LOCAL_ORIGIN_RE = /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;

export function sanitizeRemote(url) {
  if (typeof url !== 'string') return url;
  if (LOCAL_ORIGIN_RE.test(url)) {
    const name = url.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return name ? `local:${name}` : 'local:';
  }
  return url.replace(/\/\/[^@/]+@/, '//').replace(/[?#].*$/, '');
}

// Resolve a repo's origin remote with embedded credentials stripped, or null on any
// failure (not a repo, no origin, git error). Never throws.
export function resolveOriginRemote(gitImpl, dir) {
  try { return sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], dir)); }
  catch { return null; }
}

export function currentBranch(cwd, gitImpl = git) {
  return gitImpl(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// The `task-<id>` token for a task branch, or null when the branch doesn't fit.
export function taskFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(orDefault(branch, ''));
  return match ? match[1] : null;
}
