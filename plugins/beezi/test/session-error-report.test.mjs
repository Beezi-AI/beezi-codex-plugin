import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postSessionError } from '../lib/session-error-report.mjs';
import { recordingFetch } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// A bare token is refused by lib/http.mjs: the client id names the machine row this report belongs
// to, and with several accounts linked one account's id on another's bearer is a misattribution.
const MINE = accountSession(TEST_KEY, 'my-token');
const SESSION = accountSession(TEST_KEY, 'tok');

test('POSTs the payload to /sessions/errors with bearer auth', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', errorDetails: null,
      lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z' },
    MINE,
    { fetchImpl },
  );
  assert.equal(res.reported, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/sessions\/errors$/);
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer my-token');
  assert.equal(fetchImpl.calls[0].opts.headers['X-Beezi-Client'], MINE.clientId,
    'the report names the machine row of the account it was sent as');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].opts.body), {
    sessionId: 's1', error: 'rate_limit', errorDetails: null,
    lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z',
  });
});

test('reports false without a token (no fetch)', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 200 }));
  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, null, { fetchImpl });
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a non-2xx records one diagnostic carrying only the status — never the payload', async () => {
  const issues = [];
  const fetchImpl = async () => ({ status: 422 });
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', lastAssistantMessage: 'you are over your ACME Corp quota' },
    SESSION,
    { fetchImpl, recordIssue: (issue) => { issues.push(issue); return true; } },
  );

  assert.equal(res.reported, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'queue_flush_http_error');
  assert.equal(issues[0].source, 'report');
  assert.equal(issues[0].httpStatus, 422);
  assert.deepEqual(Object.keys(issues[0]).sort(), ['code', 'httpStatus', 'source']);
});

test('a transport failure records the error object, and a 2xx records nothing', async () => {
  const issues = [];
  const boom = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); };
  const failed = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, SESSION, {
    fetchImpl: boom,
    recordIssue: (issue) => { issues.push(issue); return true; },
  });
  assert.equal(failed.reason, 'network');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].error.name, 'TypeError');

  const quiet = [];
  await postSessionError({ sessionId: 's1', error: 'rate_limit' }, SESSION, {
    fetchImpl: async () => ({ status: 201 }),
    recordIssue: (issue) => { quiet.push(issue); return true; },
  });
  assert.deepEqual(quiet, []);
});

test('the real recordIssue writes nothing on a machine that never consented', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-session-error-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, SESSION, {
    fetchImpl: async () => ({ status: 500 }),
  });

  assert.equal(res.reported, false);
  assert.equal(fs.existsSync(path.join(dir, 'diagnostics')), false);
});

test('a 400 on a payload with resetsAt is retried once without it', async () => {
  const fetchImpl = recordingFetch(async (url, opts) => ({ status: JSON.parse(opts.body).resetsAt ? 400 : 200 }));
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', occurredAt: '2026-07-08T10:00:00.000Z', resetsAt: '2026-07-08T11:00:00.000Z' },
    SESSION,
    { fetchImpl, recordIssue: () => true },
  );
  assert.equal(res.reported, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal('resetsAt' in JSON.parse(fetchImpl.calls[1].opts.body), false);
});

test('a 400 on a payload without resetsAt is not retried', async () => {
  const fetchImpl = recordingFetch(async () => ({ status: 400 }));
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', occurredAt: '2026-07-08T10:00:00.000Z' },
    SESSION,
    { fetchImpl, recordIssue: () => true },
  );
  assert.equal(res.reported, false);
  assert.equal(fetchImpl.calls.length, 1);
});
