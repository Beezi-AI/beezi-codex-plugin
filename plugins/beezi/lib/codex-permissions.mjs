// Can this Codex session run Beezi's scripts at all?
//
// Every script but the preflight has to leave the sandbox (lib/codex-sandbox.mjs): it reads the
// system credential store, the data root under the home folder and, mostly, the Beezi server. A
// session can do that two ways — it has no sandbox, or it may ask the user to approve an escalated
// command. A session with neither (approval policy `never` under a sandbox: `codex exec`'s default,
// or a `--ask-for-approval never` launch) cannot, and every skill step would fail one by one. This
// answers that once, up front, with what to restart Codex with.
//
// The answer comes from the session's own rollout: Codex writes a `turn_context` record at every
// turn carrying `approval_policy` and `sandbox_policy` (measured, Codex 0.160, 2026-10-08). The
// shapes seen there: approval `on-request` | `never` | `{ granular: { sandbox_approval, … } }`;
// sandbox `{ type: 'danger-full-access' | 'workspace-write' | 'read-only', … }`. Anything else is
// `unknown`, never a guess — the skill then falls back to the model's own permissions text.
//
// The session is found by CODEX_THREAD_ID (CODEX_SESSION_ID carries the same id), which Codex
// exports to the model's shell commands — measured inside the Windows sandbox, where the sandbox
// account still read the real ~/.codex/sessions and this answered `blocked` for `codex exec`. Read
// only, no credential store, no network, no write: the preflight is the one script that runs inside
// the sandbox, so it must not need what the sandbox blocks.
import fs from 'fs';
import { findRolloutBySessionId } from './transcript-codex.mjs';
import { orDefault } from './compat.mjs';

const TAIL_CHUNK = 256 * 1024;
// The newest turn_context is near the end; a turn whose output dwarfs this is answered `unknown`.
const TAIL_LIMIT = 8 * 1024 * 1024;
const MARKER = Buffer.from('"turn_context"');

function turnContextOf(line) {
  if (line.indexOf(MARKER) < 0) return null;
  let record;
  try { record = JSON.parse(line.toString('utf-8')); } catch { return null; }
  return record && record.type === 'turn_context' && record.payload ? record.payload : null;
}

// The last turn_context in a rollout, read backwards in chunks. Lines are split as bytes, not text,
// so a multi-byte character across a chunk edge is never decoded in halves.
export function lastTurnContext(file, { chunk = TAIL_CHUNK, limit = TAIL_LIMIT } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let read = 0;
    while (end > 0 && read < limit) {
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      read += buf.length;
      end = start;
      const data = Buffer.concat([buf, carry]);
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i -= 1) {
        if (data[i] !== 0x0a) continue;
        const hit = turnContextOf(data.slice(i + 1, lineEnd));
        if (hit) return hit;
        lineEnd = i;
      }
      carry = data.slice(0, lineEnd);
      if (start === 0) return turnContextOf(carry);
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// Only `on-request` was seen in a rollout. `untrusted` and `on-failure` are Codex's other asking
// policies (`--ask-for-approval`); unmeasured, they count as asking because neither refuses without
// a prompt, and an unknown answer would end in the same "carry on" anyway.
const ASKING_POLICIES = ['on-request', 'untrusted', 'on-failure'];

function approvalLabel(approval) {
  if (typeof approval === 'string') return approval;
  if (approval && typeof approval === 'object' && approval.granular) return 'granular';
  return 'unknown';
}

// ok: the session has no sandbox, or can ask the user to approve an escalated command.
// blocked: sandboxed, and escalation requests are refused without asking anyone.
export function assessPermissions(ctx) {
  if (!ctx) return { verdict: 'unknown', reason: 'no-turn-context', approval: 'unknown', sandbox: 'unknown' };
  const policy = ctx.sandbox_policy;
  const sandbox = typeof policy === 'string' ? policy : orDefault((policy || {}).type, 'unknown');
  const approval = ctx.approval_policy;
  const base = { approval: approvalLabel(approval), sandbox };
  if (sandbox === 'danger-full-access') return { verdict: 'ok', reason: 'no-sandbox', ...base };
  if (approval === 'never') return { verdict: 'blocked', reason: 'never-asks', ...base };
  if (approval && typeof approval === 'object' && approval.granular) {
    return approval.granular.sandbox_approval === false
      ? { verdict: 'blocked', reason: 'sandbox-approval-off', ...base }
      : { verdict: 'ok', reason: 'asks', ...base };
  }
  if (ASKING_POLICIES.indexOf(approval) >= 0) return { verdict: 'ok', reason: 'asks', ...base };
  return { verdict: 'unknown', reason: 'unrecognised-policy', ...base };
}

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionPermissions({ env = process.env, findRollout = findRolloutBySessionId, readContext = lastTurnContext } = {}) {
  const id = [env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].filter((v) => typeof v === 'string' && THREAD_ID_RE.test(v))[0];
  if (!id) return { verdict: 'unknown', reason: 'no-thread-id', approval: 'unknown', sandbox: 'unknown' };
  let found = null;
  try { found = findRollout(id); } catch { found = null; }
  if (!found || !found.transcriptPath) return { verdict: 'unknown', reason: 'no-rollout', approval: 'unknown', sandbox: 'unknown' };
  return assessPermissions(readContext(found.transcriptPath));
}

// The flags are Codex's own (`codex --help`, 0.160); `--yolo` is its alias for the bypass flag.
export const RECOMMENDED_LAUNCH = 'codex --sandbox workspace-write --ask-for-approval on-request';
export const FULL_ACCESS_LAUNCH = 'codex --dangerously-bypass-approvals-and-sandbox';

export function renderPreflight(result) {
  const machine = `preflight=${result.verdict} reason=${result.reason} approval=${result.approval} sandbox=${result.sandbox}`;
  if (result.verdict !== 'blocked') return [machine];
  const why = result.reason === 'sandbox-approval-off'
    ? 'with sandbox approvals turned off'
    : `with approval policy "${result.approval}" and a "${result.sandbox}" sandbox`;
  return [
    `✗ Beezi: Codex is running this session ${why}, so it cannot ask you to let Beezi's commands run`
      + ' outside the sandbox. They have to: they read your Beezi sign-in from the system credential'
      + ' store, keep their data in your home folder and reach the Beezi server. Nothing was changed.',
    '  To use Beezi, start Codex so it can ask you first (recommended — you approve each Beezi command):',
    `    ${RECOMMENDED_LAUNCH}`,
    '  or, only on a machine you trust, with no sandbox and no approval prompts at all:',
    `    ${FULL_ACCESS_LAUNCH}   (same as --yolo)`,
    '  To make it the default, set approval_policy = "on-request" and sandbox_mode = "workspace-write"'
      + ' in ~/.codex/config.toml. In the Codex app or the interactive CLI, /permissions changes it for this session.',
    machine,
  ];
}
