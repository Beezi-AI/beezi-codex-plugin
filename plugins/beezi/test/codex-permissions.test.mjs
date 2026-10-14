import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessPermissions, lastTurnContext, sessionPermissions, renderPreflight,
  RECOMMENDED_LAUNCH, FULL_ACCESS_LAUNCH,
} from '../lib/codex-permissions.mjs';
import { tmpHome } from '../tools/suite-fixtures.mjs';

// The preflight decides, before any other script runs, whether this Codex session can let Beezi's
// scripts out of the sandbox. The turn_context shapes below are the ones measured in real rollouts
// (Codex 0.160, 2026-10-08); a shape it has not seen must come back `unknown`, never a verdict.

const WORKSPACE_WRITE = { type: 'workspace-write', network_access: false };
const GRANULAR_OFF = { granular: { sandbox_approval: false, rules: false, request_permissions: true } };
const THREAD = '01a11bec-0fe9-7c42-afe9-909d7dd36331';

test('a session that can ask, or has no sandbox, may run the scripts', () => {
  assert.equal(assessPermissions({ approval_policy: 'on-request', sandbox_policy: WORKSPACE_WRITE }).verdict, 'ok');
  assert.equal(assessPermissions({ approval_policy: 'on-request', sandbox_policy: { type: 'read-only' } }).verdict, 'ok');
  assert.equal(assessPermissions({ approval_policy: 'untrusted', sandbox_policy: WORKSPACE_WRITE }).verdict, 'ok');
  // Yolo: `never` asks nobody, but there is no sandbox to leave.
  const yolo = assessPermissions({ approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } });
  assert.deepEqual(yolo, { verdict: 'ok', reason: 'no-sandbox', approval: 'never', sandbox: 'danger-full-access' });
  assert.equal(assessPermissions({
    approval_policy: { granular: { sandbox_approval: true } }, sandbox_policy: WORKSPACE_WRITE,
  }).verdict, 'ok');
});

test('a sandboxed session that never asks is blocked', () => {
  assert.deepEqual(assessPermissions({ approval_policy: 'never', sandbox_policy: WORKSPACE_WRITE }),
    { verdict: 'blocked', reason: 'never-asks', approval: 'never', sandbox: 'workspace-write' });
  assert.equal(assessPermissions({ approval_policy: 'never', sandbox_policy: { type: 'read-only' } }).verdict, 'blocked');
  assert.deepEqual(assessPermissions({ approval_policy: GRANULAR_OFF, sandbox_policy: WORKSPACE_WRITE }),
    { verdict: 'blocked', reason: 'sandbox-approval-off', approval: 'granular', sandbox: 'workspace-write' });
});

test('a shape the preflight has not seen is unknown, not a verdict', () => {
  assert.equal(assessPermissions(null).verdict, 'unknown');
  assert.equal(assessPermissions({ approval_policy: 'something-new', sandbox_policy: WORKSPACE_WRITE }).verdict, 'unknown');
  assert.equal(assessPermissions({ sandbox_policy: WORKSPACE_WRITE }).verdict, 'unknown');
});

function record(type, payload) {
  return JSON.stringify({ timestamp: '2026-10-08T17:30:17Z', type, payload });
}

test('lastTurnContext reads the newest turn_context, across chunk edges and multi-byte text', (t) => {
  const dir = tmpHome(t, { prefix: 'codex-permissions-' });
  const file = path.join(dir, 'rollout.jsonl');
  const filler = record('response_item', { type: 'message', text: 'ü€😀'.repeat(400) });
  fs.writeFileSync(file, [
    record('session_meta', { id: THREAD }),
    record('turn_context', { approval_policy: 'never', sandbox_policy: WORKSPACE_WRITE }),
    filler,
    record('turn_context', { approval_policy: 'on-request', sandbox_policy: WORKSPACE_WRITE }),
    filler, filler,
    '',
  ].join('\n'));
  for (const chunk of [7, 64, 1000, 1 << 20]) {
    const ctx = lastTurnContext(file, { chunk });
    assert.equal(ctx && ctx.approval_policy, 'on-request', `chunk ${chunk}`);
  }
  // The only turn_context on the very first line, no trailing newline.
  const first = path.join(dir, 'first.jsonl');
  fs.writeFileSync(first, `${record('turn_context', { approval_policy: 'never', sandbox_policy: WORKSPACE_WRITE })}\n${filler}`);
  assert.equal(lastTurnContext(first, { chunk: 50 }).approval_policy, 'never');
});

test('lastTurnContext gives up rather than guessing', (t) => {
  const dir = tmpHome(t, { prefix: 'codex-permissions-' });
  assert.equal(lastTurnContext(path.join(dir, 'missing.jsonl')), null);
  const none = path.join(dir, 'none.jsonl');
  fs.writeFileSync(none, `${record('session_meta', { id: THREAD })}\n{not json "turn_context"\n`);
  assert.equal(lastTurnContext(none), null);
  // Past the read limit the answer is unknown, not the stale turn_context further back.
  const deep = path.join(dir, 'deep.jsonl');
  fs.writeFileSync(deep, `${record('turn_context', { approval_policy: 'never', sandbox_policy: WORKSPACE_WRITE })}\n${'x'.repeat(5000)}\n`);
  assert.equal(lastTurnContext(deep, { chunk: 1000, limit: 2000 }), null);
});

test('sessionPermissions finds this session by the thread id Codex exports', () => {
  const asked = [];
  const result = sessionPermissions({
    env: { CODEX_THREAD_ID: THREAD },
    findRollout: (id) => { asked.push(id); return { sessionId: id, transcriptPath: '/r.jsonl' }; },
    readContext: (p) => (p === '/r.jsonl' ? { approval_policy: 'never', sandbox_policy: WORKSPACE_WRITE } : null),
  });
  assert.deepEqual(asked, [THREAD]);
  assert.equal(result.verdict, 'blocked');
});

test('sessionPermissions is unknown without a session it can read', () => {
  const never = () => { throw new Error('must not be called'); };
  assert.equal(sessionPermissions({ env: {}, findRollout: never }).reason, 'no-thread-id');
  assert.equal(sessionPermissions({ env: { CODEX_THREAD_ID: '../../etc' }, findRollout: never }).reason, 'no-thread-id');
  assert.equal(sessionPermissions({ env: { CODEX_THREAD_ID: THREAD }, findRollout: () => null }).reason, 'no-rollout');
  assert.equal(sessionPermissions({
    env: { CODEX_THREAD_ID: THREAD }, findRollout: () => { throw new Error('EACCES'); },
  }).reason, 'no-rollout');
  assert.equal(sessionPermissions({
    env: { CODEX_SESSION_ID: THREAD },
    findRollout: (id) => ({ sessionId: id, transcriptPath: '/r.jsonl' }),
    readContext: () => null,
  }).reason, 'no-turn-context');
});

test('a blocked preflight tells the user how to restart Codex; any other says nothing to them', () => {
  const blocked = renderPreflight({ verdict: 'blocked', reason: 'never-asks', approval: 'never', sandbox: 'workspace-write' });
  assert.match(blocked[0], /^✗ Beezi: Codex is running this session with approval policy "never" and a "workspace-write" sandbox/);
  const text = blocked.join('\n');
  assert.ok(text.includes(RECOMMENDED_LAUNCH));
  assert.ok(text.includes(FULL_ACCESS_LAUNCH));
  assert.equal(RECOMMENDED_LAUNCH, 'codex --sandbox workspace-write --ask-for-approval on-request');
  assert.match(text, /approval_policy = "on-request" and sandbox_mode = "workspace-write"/);
  assert.equal(blocked[blocked.length - 1], 'preflight=blocked reason=never-asks approval=never sandbox=workspace-write');
  assert.match(renderPreflight({ verdict: 'blocked', reason: 'sandbox-approval-off', approval: 'granular', sandbox: 'workspace-write' })[0],
    /with sandbox approvals turned off/);

  assert.deepEqual(renderPreflight({ verdict: 'ok', reason: 'asks', approval: 'on-request', sandbox: 'workspace-write' }),
    ['preflight=ok reason=asks approval=on-request sandbox=workspace-write']);
  assert.deepEqual(renderPreflight({ verdict: 'unknown', reason: 'no-thread-id', approval: 'unknown', sandbox: 'unknown' }),
    ['preflight=unknown reason=no-thread-id approval=unknown sandbox=unknown']);
});

test('the preflight script needs nothing the sandbox blocks', () => {
  // It is the one script the skills run inside the sandbox, so it must not reach the env guard,
  // the credential store, the network or Beezi's data root. Its own imports are pinned here; what
  // transcript-codex.mjs loads only lists rollout files on this path.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = fs.readFileSync(path.join(here, '..', 'scripts', 'preflight.mjs'), 'utf-8');
  const lib = fs.readFileSync(path.join(here, '..', 'lib', 'codex-permissions.mjs'), 'utf-8');
  for (const [name, src] of [['scripts/preflight.mjs', script], ['lib/codex-permissions.mjs', lib]]) {
    const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(['fs', '../lib/codex-permissions.mjs', './transcript-codex.mjs', './compat.mjs'].includes(spec),
        `${name} imports ${spec}`);
    }
    assert.doesNotMatch(src, /\bcliMayProceed\s*\(/, `${name} calls the env guard`);
    assert.doesNotMatch(src, /\bfs\.(write|append|mkdir|rename|unlink|rm)/, `${name} writes`);
  }
});
