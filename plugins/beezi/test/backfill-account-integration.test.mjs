import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../lib/session-audit.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'account-current';
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.`;
}

function response(status, body, { malformed = false } = {}) {
  const raw = malformed ? '<not-json>' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw),
    text: async () => raw,
  };
}

function writeRollout(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  // mtime must land between ACTIVE_SESSION_WINDOW_MS (30 min) and MAX_SESSION_AGE_MS (30 days):
  // newer reads as a session still being written, older as out of scope. A T0-pinned mtime fell
  // out of the 30-day window once the wall clock passed 2026-08-31.
  const mtime = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(file, mtime, mtime);
}

function isolatedHistory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-account-backfill-'));
  const codexHome = path.join(root, 'codex');
  const beeziHome = path.join(root, 'beezi');
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(beeziHome, { recursive: true });

  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    BEEZI_CODEX_HOME: process.env.BEEZI_CODEX_HOME,
    BEEZI_API_URL: process.env.BEEZI_API_URL,
  };
  process.env.CODEX_HOME = codexHome;
  process.env.BEEZI_CODEX_HOME = beeziHome;
  process.env.BEEZI_API_URL = 'https://beezi.test/api';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: ACCOUNT,
      id_token: jwt({
        exp: 1_893_456_000,
        'https://api.openai.com/auth': {
          chatgpt_account_id: ACCOUNT,
          chatgpt_plan_type: 'plus',
        },
      }),
    },
  }));

  const day = path.join(codexHome, 'sessions', '2026', '08', '01');
  writeRollout(path.join(day, `rollout-2026-08-01T00-00-00-${PARENT}.jsonl`), [
    { timestamp: at(0), type: 'session_meta', payload: { id: PARENT, session_id: PARENT, thread_source: 'user', cwd: work } },
    { timestamp: at(1_000), type: 'turn_context', payload: { cwd: work, model: 'gpt-5.4-mini' } },
    { timestamp: at(5_000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120,
    } } } },
  ]);
  writeRollout(path.join(day, `rollout-2026-08-01T00-00-01-${CHILD}.jsonl`), [
    { timestamp: at(10), type: 'session_meta', payload: {
      id: CHILD, session_id: PARENT, parent_thread_id: PARENT, thread_source: 'subagent',
      agent_nickname: 'Ada', cwd: work, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
    } },
    { timestamp: at(15), type: 'session_meta', payload: { id: PARENT, session_id: PARENT, thread_source: 'user', cwd: work } },
    { timestamp: at(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120,
    } } } },
    { timestamp: at(4_000), type: 'turn_context', payload: { cwd: work, model: 'gpt-5.4-mini' } },
    { timestamp: at(8_000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 160, cached_input_tokens: 10, output_tokens: 30, total_tokens: 190,
    } } } },
  ]);
}

const SESSION = accountSession(TEST_KEY, 'beezi-token');

const deps = (fetchImpl) => ({
  // Not optional. runAudit drives the real checkpoint, whose repoRootOf shells out to `git` for
  // every cwd it sees — unstubbed that reads the DEVELOPER'S OWN repository, which is what the
  // hermetic backstop now records. resolveRepoRoot swallows a throwing gitImpl and falls through to
  // its filesystem walk, so the synthetic roots below still resolve exactly as they did.
  gitImpl: () => { throw new Error('not a git repository'); },
  linkedSessions: async () => [SESSION],
  getDefaultKey: async () => TEST_KEY,
  whoamiImpl: async () => ({ valid: true, trackingMode: 'audit', backfillCompleted: false }),
  recordWhoamiImpl: () => {},
  resolveTranscriptByCwdImpl: () => null,
  computeSessionTimelineImpl: () => null,
  fetchImpl,
});

test('real backfill pipeline registers the account before parent and child reports', async (t) => {
  isolatedHistory(t);
  const wire = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    wire.push({ url, headers: init.headers, body });
    if (url.endsWith('/me/cli-agent/account')) {
      return response(200, { status: 'stored', accountLinked: true, keysLinked: 0 });
    }
    if (url.endsWith('/sessions/backfill')) {
      return response(200, {
        stored: body.sessions.length, skipped: 0, errors: [], timelines: 0,
      });
    }
    if (url.endsWith('/sessions/backfill/complete')) return response(200, {});
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runAudit(deps(fetchImpl));
  assert.equal(result.finalized, true);
  assert.deepEqual(wire.map(({ url }) => new URL(url).pathname), [
    '/api/me/cli-agent/account', '/api/sessions/backfill', '/api/sessions/backfill/complete',
  ]);
  assert.deepEqual(wire[0].body, { accountUuid: ACCOUNT, subscriptionType: 'plus' });
  assert.equal(wire[0].headers['X-Beezi-Agent'], 'codex');

  const reports = wire[1].body.sessions;
  assert.ok(reports.some((item) => item.is_subagent === true), 'real sweep emitted a child report');
  assert.ok(reports.some((item) => item.is_subagent !== true), 'real parser emitted a parent report');
  for (const item of reports) assert.equal(item.account_uuid, wire[0].body.accountUuid);
});

for (const [name, failure] of [
  ['network failure', () => { throw new Error('offline'); }],
  ['HTTP 503', () => response(503, { message: 'later' })],
  ['malformed 2xx', () => response(200, null, { malformed: true })],
]) {
  test(`account registration ${name} sends no history and does not finalize`, async (t) => {
    isolatedHistory(t);
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (!url.endsWith('/me/cli-agent/account')) throw new Error('history request escaped the gate');
      return failure();
    };
    const result = await runAudit(deps(fetchImpl));
    assert.equal(result.reason, 'account-registration-failed');
    assert.equal(result.finalized, false);
    assert.equal(result.plannedReports, 0, 'transcripts were not parsed');
    assert.equal(urls.length, 1);
  });
}
