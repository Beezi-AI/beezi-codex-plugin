import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase, ENDPOINTS } from '../lib/config.mjs';
import {
  flushBackfillChunks,
  completeBackfill,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from '../lib/audit-flush.mjs';
import { accountSession, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { loadCoverageCheckpoints, currentBinding } from '../lib/session-coverage.mjs';

// The chunk flush uploads ONE account's history: `key` is what the 401 renewal renews, and
// `session` is the bearer and the client id the server binds the machine row from.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// ─── helpers ────────────────────────────────────────────────────────────────

// One report, padded to roughly `bytes` so chunk-boundary behaviour can be driven precisely.
function report(sessionId, segmentId, bytes = 200) {
  return {
    segmentId,
    sessionId,
    remote: 'git@github.com:acme/app.git',
    branch: 'main',
    from_line: 0,
    to_line: 5,
    session_name: 'x'.repeat(Math.max(0, bytes - 200)),
    models: { 'claude-sonnet-4-5': { token_input: 1, token_output: 1, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 2,
    token_input: 1,
    token_output: 1,
    token_cache: 0,
    duration_sec: 1,
  };
}

function group(sessionId, count, bytes = 200) {
  return {
    sessionId,
    reports: Array.from({ length: count }, (_unused, i) => report(sessionId, `${sessionId}:${i}`, bytes)),
  };
}

// Records every call, replies with the queued status/body. Bodies are served through text() —
// the transport reads every body exactly once as text (readResponseBody).
function fakePost(replies) {
  const calls = [];
  let i = 0;
  // `session`, not a bare token — lib/http.mjs refuses a string, so a stub that took one would
  // be modelling a call the real postJson could never make.
  const impl = async (url, session, body, deps) => {
    calls.push({ url, session, token: session && session.token, body, deps });
    const reply = typeof replies === 'function' ? replies(body, calls.length) : replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      status: reply.status,
      text: async () => {
        if (reply.throws) throw new Error('unreadable');
        if (reply.raw != null) return reply.raw;
        return JSON.stringify(reply.body ?? {});
      },
    };
  };
  return { impl, calls };
}

const okBody = (over = {}) => ({ stored: 1, skipped: 0, completed: false, errors: [], ...over });

// ─── planChunks ─────────────────────────────────────────────────────────────

test('1. packs several sessions into one chunk when they fit', () => {
  const chunks = planChunks([group('s1', 2), group('s2', 2)]);

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].sessionIds, ['s1', 's2']);
  assert.equal(chunks[0].reports.length, 4);
});

// Sessions stay whole so the ledger can attribute a chunk verdict to whole sessions.
test('2. never splits a session that fits, even at a chunk boundary', () => {
  const chunks = planChunks([group('s1', 40), group('s2', 40)]);

  assert.ok(chunks.length > 1, 'the two sessions do not fit in one chunk');
  for (const chunk of chunks) {
    const ids = new Set(chunk.reports.map((r) => r.sessionId));
    assert.equal(ids.size, 1, 'a chunk boundary fell inside a session');
  }
});

test('3. every planned chunk stays under both caps', () => {
  const chunks = planChunks([group('s1', 40, 1000), group('s2', 40, 1000), group('s3', 40, 1000)]);

  for (const chunk of chunks) {
    assert.ok(chunk.reports.length <= MAX_CHUNK_ITEMS, `chunk of ${chunk.reports.length} items exceeds the item cap`);
    const bytes = Buffer.byteLength(JSON.stringify({ sessions: chunk.reports }), 'utf-8');
    assert.ok(bytes <= MAX_BODY_BYTES, `chunk of ${bytes} bytes exceeds the byte budget`);
  }
});

// The ruling: 50 array items per request, regardless of how far under the byte budget they sit.
test('4. cuts a chunk at exactly MAX_CHUNK_ITEMS even when far under the byte budget', () => {
  const chunks = planChunks([group('s1', 30), group('s2', 30)]);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.reports.length <= MAX_CHUNK_ITEMS));
});

// A session with more segments than one chunk holds now legally splits; continuations carry
// partialOf so the caller accepts the session only when every part landed.
test('5. an over-cap session splits with partialOf on every part', () => {
  const chunks = planChunks([group('big', MAX_CHUNK_ITEMS * 2 + 5)]);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.partialOf === 'big'));
  assert.deepEqual([...new Set(chunks.flatMap((c) => c.sessionIds))], ['big']);
});

test('6. a single over-budget report is still sent alone rather than looping', () => {
  const chunks = planChunks([{ sessionId: 's1', reports: [report('s1', 's1:0', MAX_BODY_BYTES * 2)] }]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reports.length, 1);
});

test('7. empty groups are dropped', () => {
  assert.deepEqual(planChunks([{ sessionId: 's1', reports: [] }]), []);
});

// ─── in-run transport retry ────────────────────────────────────────

const noSleep = { sleep: async () => {} };

test('31. a thrown post retries once and succeeds without marking anything failed', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return { status: 200, text: async () => JSON.stringify(okBody()) };
  };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: impl, ...noSleep });

  assert.equal(calls, 2);
  assert.equal(result.retryableFailures, 0);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('32. a 5xx retries once and succeeds', async () => {
  const post = fakePost([{ status: 503, raw: 'busy' }, { status: 200, body: okBody() }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, ...noSleep });

  assert.equal(post.calls.length, 2);
  assert.equal(result.retryableFailures, 0);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('33. the retry is bounded: two throws mark FAILED with the transport reason', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new TypeError('fetch failed'); };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: impl, ...noSleep });

  assert.equal(calls, 2);
  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.lastError, 'network');
});

test('34. a timeout is recorded as timeout, not network', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const impl = async () => { throw abort; };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: impl, ...noSleep });

  assert.equal(result.lastError, 'timeout');
  assert.equal(result.bySession.get('s1').reason, 'timeout');
});

// ─── in-band timelines ─────────────────────────────────────────────

const timelineFor = (sessionId) => ({ sessionId, periods: [{ state: 'working' }], subagents: [], plan_events: [] });

test('27. a group timeline rides its chunk; chunks without any omit the field entirely', async () => {
  const post = fakePost([{ status: 200, body: okBody({ timelines: 1 }) }, { status: 200, body: okBody() }]);
  const withTimeline = { ...group('s1', 1), timeline: timelineFor('s1') };

  const first = await flushBackfillChunks([withTimeline], KEY, SESSION, { postJsonImpl: post.impl });
  await flushBackfillChunks([group('s2', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.deepEqual(post.calls[0].body.timelines, [timelineFor('s1')]);
  assert.equal(first.timelines, 1);
  assert.equal('timelines' in post.calls[1].body, false, 'no-timeline chunks must stay byte-identical to the old wire shape');
});

test('28. a split session carries its timeline in the first part only', () => {
  const chunks = planChunks([{ ...group('big', MAX_CHUNK_ITEMS * 2 + 5), timeline: timelineFor('big') }]);

  assert.ok(chunks.length >= 3);
  assert.deepEqual(chunks[0].timelines, [timelineFor('big')]);
  assert.ok(chunks.slice(1).every((c) => c.timelines.length === 0));
});

test('29. bisection redistributes timelines to the sub-chunk holding their session', async () => {
  const post = fakePost((body, n) => {
    if (n === 1) return { status: 400, body: { statusCode: 400, message: ['bad payload'] } };
    return { status: 200, body: okBody({ timelines: (body.timelines ?? []).length }) };
  });
  const groups = [
    { ...group('s1', 1), timeline: timelineFor('s1') },
    { ...group('s2', 1), timeline: timelineFor('s2') },
  ];

  const result = await flushBackfillChunks(groups, KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 3);
  assert.deepEqual(post.calls[1].body.timelines, [timelineFor('s1')]);
  assert.deepEqual(post.calls[2].body.timelines, [timelineFor('s2')]);
  assert.equal(result.timelines, 2);
});

test('30. an old server that 400s the timelines field gets the chunk again without them', async () => {
  const post = fakePost((body, n) => {
    if (n === 1) {
      return { status: 400, body: { statusCode: 400, message: ['property timelines should not exist'] } };
    }
    return { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(
    [{ ...group('s1', 1), timeline: timelineFor('s1') }],
    KEY,
    SESSION,
    { postJsonImpl: post.impl },
  );

  assert.equal(post.calls.length, 2);
  assert.equal('timelines' in post.calls[1].body, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.permanentRejections, 0);
});

// ─── flushBackfillChunks ─────────────────────────────────────────────────────

test('8. POSTs { sessions } to the backfill route with the raised timeout', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.ok(post.calls[0].url.endsWith('/sessions/backfill'));
  assert.ok(Array.isArray(post.calls[0].body.sessions));
  assert.equal(post.calls[0].body.skipExisting, undefined);
  assert.equal(post.calls[0].deps.timeoutMs, 60_000);
});

// The response has no per-session success list — a session is accepted unless errors[] names it.
test('9. verdicts derive from errors[]: none → ACCEPTED, all → REJECTED, some → PARTIAL', async () => {
  const post = fakePost([
    {
      status: 200,
      body: okBody({
        stored: 2,
        skipped: 3,
        errors: [
          { sessionId: 's2', segmentId: 's2:0', reason: 'Repository is not connected to Beezi.' },
          { sessionId: 's3', segmentId: 's3:0', reason: 'boom' },
          { sessionId: 's3', segmentId: 's3:1', reason: 'boom' },
        ],
      }),
    },
  ]);

  const result = await flushBackfillChunks(
    [group('s1', 1), group('s2', 2), group('s3', 2)],
    KEY,
    SESSION,
    { postJsonImpl: post.impl },
  );

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.PARTIAL);
  assert.equal(result.bySession.get('s2').reason, 'Repository is not connected to Beezi.');
  assert.equal(result.bySession.get('s3').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.itemErrors, 3);
  assert.equal(result.stored, 2);
  assert.equal(result.skipped, 3);
});

// The server's benign zero-token skip produces skipped > 0 with an empty errors[] — still accepted.
test('10. skipped-with-no-errors is still ACCEPTED', async () => {
  const post = fakePost([{ status: 200, body: okBody({ stored: 0, skipped: 1 }) }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('11. a 401 renews the token exactly once and retries the chunk', async () => {
  const post = fakePost([
    { status: 401, body: {} },
    { status: 200, body: okBody() },
    { status: 200, body: okBody() },
  ]);
  let renewals = 0;
  const getAccessToken = async (_key, _deps, opts) => {
    if (opts?.forceRefresh) renewals += 1;
    return 'fresh-tok';
  };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'stale-tok'), { postJsonImpl: post.impl, getAccessToken });

  assert.equal(renewals, 1);
  assert.equal(post.calls.length, 2);
  assert.equal(post.calls[1].token, 'fresh-tok');
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('12. a still-401 after renewal is FAILED (retryable), never rejected', async () => {
  const post = fakePost([{ status: 401, body: {} }, { status: 401, body: {} }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, {
    postJsonImpl: post.impl,
    getAccessToken: async () => 'other-tok',
  });

  assert.equal(result.permanentRejections, 0);
  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

// One malformed field 400s the whole chunk; bisection isolates the poison session so the
// innocent ones still land — with a bounded number of extra requests.
test('13. a 400 bisects at session boundaries and isolates the poison session', async () => {
  const poisoned = new Set(['s3']);
  const post = fakePost((body) => {
    const ids = new Set(body.sessions.map((r) => r.sessionId));
    const bad = [...ids].some((id) => poisoned.has(id));
    return bad && ids.size >= 1
      ? ids.size === 1
        ? { status: 400, body: { statusCode: 400, message: ['sessions.0.agent_name must be shorter'], error: 'Bad Request' } }
        : { status: 400, body: { statusCode: 400, message: ['sessions.2.agent_name must be shorter'], error: 'Bad Request' } }
      : { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(
    [group('s1', 1), group('s2', 1), group('s3', 1), group('s4', 1)],
    KEY,
    SESSION,
    { postJsonImpl: post.impl },
  );

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s3').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.bySession.get('s4').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.permanentRejections, 1);
  // 4 sessions: worst case 2N-1 = 7 requests on the 400 path.
  assert.ok(post.calls.length <= 7, `bisection used ${post.calls.length} requests`);
});

test('14. a single-session 400 floor surfaces the first validation message', async () => {
  const post = fakePost([
    { status: 400, body: { statusCode: 400, message: ['sessions.0.branch must be shorter than or equal to 255 characters'], error: 'Bad Request' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
  assert.match(result.lastError, /branch must be shorter/);
});

test('15. 403 BACKFILL_ALREADY_COMPLETED halts and sends nothing further', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_ALREADY_COMPLETED', message: 'sealed' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 40), group('s2', 40)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.ALREADY_COMPLETED);
  assert.equal(post.calls.length, 1);
});

test('16. 403 BACKFILL_NOT_ALLOWED halts with nothing marked judged', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_NOT_ALLOWED', message: 'audit ended' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.NOT_ALLOWED);
  assert.equal(result.bySession.size, 0);
});

// Seat revocation / deactivation answer 403 WITHOUT a code — that is re-link territory, never
// "the pull is done" or "tracking is off".
test('17. a code-less 403 is FAILED + a distinct halt, not a seal or a tracking signal', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, message: 'Your seat was revoked', error: 'Forbidden' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.FORBIDDEN);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.retryableFailures, 1);
});

test('18. 404 from an old server halts as unsupported and marks nothing judged', async () => {
  const post = fakePost([{ status: 404, raw: '<html>Cannot POST /api/sessions/backfill</html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.UNSUPPORTED_SERVER);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

// Express answers over-limit bodies itself with HTML — the transport must not choke on it.
test('19. a 413 with an HTML body is REJECTED without throwing', async () => {
  const post = fakePost([{ status: 413, raw: '<html><body>Payload Too Large</body></html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.permanentRejections, 1);
});

test('20. a 503 marks the chunk FAILED so a re-run retries it', async () => {
  const post = fakePost([{ status: 503, body: {} }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

test('21. a thrown request is FAILED, not rejected', async () => {
  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, {
    postJsonImpl: async () => { throw new Error('socket hang up'); },
  });

  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.lastError, 'network');
});

// A 2xx we cannot attribute must never be ledgered — and never sealed on top of.
test('22. a 2xx with an unreadable body is UNATTRIBUTED and counted', async () => {
  const post = fakePost([{ status: 200, raw: '<html>gateway page</html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.UNATTRIBUTED);
  assert.equal(result.unattributed, 1);
  assert.equal(result.lastError, 'unreadable-response');
});

// A split session is accepted only when every one of its sub-chunks was.
test('23. a split session downgrades when any sub-chunk fails', async () => {
  const post = fakePost((body, n) =>
    n === 1 ? { status: 200, body: okBody() } : { status: 503, body: {} },
  );

  const result = await flushBackfillChunks([group('big', MAX_CHUNK_ITEMS + 5)], KEY, SESSION, {
    postJsonImpl: post.impl,
  });

  assert.equal(result.bySession.get('big').status, BackfillSessionStatus.FAILED);
});

test('24. reports progress after each chunk', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);
  const seen = [];

  await flushBackfillChunks([group('s1', 40), group('s2', 40)], KEY, SESSION, {
    postJsonImpl: post.impl,
    onChunk: (p) => seen.push(p.sent),
  });

  assert.ok(seen.length > 1);
  assert.deepEqual(seen, seen.map((_unused, i) => i + 1));
});

test('25. no groups means no request at all', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  const result = await flushBackfillChunks([], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 0);
  assert.equal(result.chunks, 0);
});

// ─── completeBackfill ───────────────────────────────────────────────────────

test('26. completeBackfill POSTs the seal route and reports the coded refusals', async () => {
  const ok = fakePost([{ status: 200, body: { stored: 0, skipped: 0, completed: true, errors: [] } }]);
  const sealed = await completeBackfill(SESSION, { postJsonImpl: ok.impl });
  assert.ok(ok.calls[0].url.endsWith('/sessions/backfill/complete'));
  assert.equal(sealed.completed, true);

  const refused = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_NOT_ALLOWED', message: 'audit ended' } },
  ]);
  const denial = await completeBackfill(SESSION, { postJsonImpl: refused.impl });
  assert.equal(denial.completed, false);
  assert.equal(denial.code, 'BACKFILL_NOT_ALLOWED');
});

// ─── G-8-6: the endpoint is a parameter, not a literal ───────────────────────

test('27. defaults to ENDPOINTS.sessionsBackfill — no route is spelled out in the module', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(post.calls[0].url.endsWith(ENDPOINTS.sessionsBackfill), true);
});

test('28. options.endpoint reuses the whole chunk/bisect/renewal machinery on another route', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl }, { endpoint: '/sessions/sync' });

  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].url.endsWith('/sessions/sync'), true);
  // Still absolute against the configured API base, never a bare path.
  assert.equal(post.calls[0].url.startsWith(apiBase()), true);
});

// ─── G-8-2: HTTP failures are recorded, without the response text ────────────

test('29. a permanent rejection records one diagnostic carrying only the status', async () => {
  const post = fakePost([{ status: 400, body: { message: `bad field in ${process.cwd()}` } }]);
  const issues = [];

  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, {
    postJsonImpl: post.impl,
    recordIssue: (issue) => { issues.push(issue); return true; },
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'queue_flush_http_error');
  assert.equal(issues[0].source, 'backfill');
  assert.equal(issues[0].httpStatus, 400);
  assert.deepEqual(Object.keys(issues[0]).sort(), ['code', 'httpStatus', 'source']);
});

test('30. a terminal 5xx records the status too, and a clean run records nothing', async () => {
  const failing = fakePost([{ status: 503, body: {} }]);
  const failures = [];
  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, {
    postJsonImpl: failing.impl,
    sleep: async () => {},
    recordIssue: (issue) => { failures.push(issue); return true; },
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].httpStatus, 503);

  const ok = fakePost([{ status: 200, body: okBody() }]);
  const quiet = [];
  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, {
    postJsonImpl: ok.impl,
    recordIssue: (issue) => { quiet.push(issue); return true; },
  });
  assert.deepEqual(quiet, []);
});

test('31. the real recordIssue is a silent no-op on a machine that never consented', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-audit-flush-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = fakePost([{ status: 400, body: { message: 'nope' } }]);
  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl });

  assert.equal(result.permanentRejections, 1);
  assert.equal(fs.existsSync(path.join(dir, 'diagnostics')), false);
});

// ─── deps.renewSession: the run's shared renewal ────────────────────────────

test('35. with deps.renewSession every 401 renews through it, with no per-call guard', async () => {
  const post = fakePost((_body, n) => (n === 1 || n === 3 ? { status: 401, body: {} } : { status: 200, body: okBody() }));
  const asked = [];
  let tokenReads = 0;

  const result = await flushBackfillChunks(
    [group('s1', MAX_CHUNK_ITEMS), group('s2', MAX_CHUNK_ITEMS)],
    KEY,
    accountSession(KEY, 'stale-tok'),
    {
      postJsonImpl: post.impl,
      renewSession: async (stale) => {
        asked.push(stale.token);
        return { ...stale, token: stale.token === 'stale-tok' ? 't2' : 't3' };
      },
      getAccessToken: async () => { tokenReads += 1; return 'never'; },
    },
  );

  assert.deepEqual(asked, ['stale-tok', 't2']);
  assert.deepEqual(post.calls.map((c) => c.token), ['stale-tok', 't2', 't2', 't3']);
  assert.equal(tokenReads, 0, 'the run-level renewal replaces the per-call token read');
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
});

for (const [label, answer] of [['null', () => null], ['the same token', (stale) => ({ ...stale })]]) {
  test(`36. renewSession answering ${label} retries nothing and leaves the chunk FAILED`, async () => {
    const post = fakePost([{ status: 401, body: {} }]);
    let asked = 0;

    const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'tok-a'), {
      postJsonImpl: post.impl,
      renewSession: async (stale) => { asked += 1; return answer(stale); },
      getAccessToken: async () => { throw new Error('the per-call token read must not run'); },
    });

    assert.equal(asked, 1);
    assert.equal(post.calls.length, 1);
    assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
    assert.equal(result.lastError, 'HTTP 401');
    assert.equal(result.permanentRejections, 0);
  });
}

test('37. under renewSession a chunk still retries after a renewal at most once', async () => {
  const post = fakePost([
    { status: 401, body: {} },
    { status: 503, body: {} },
    { status: 401, body: {} },
  ]);
  let renewals = 0;

  const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'tok-a'), {
    postJsonImpl: post.impl,
    renewSession: async (stale) => { renewals += 1; return { ...stale, token: `tok-${renewals + 1}` }; },
    getAccessToken: async () => { throw new Error('the per-call token read must not run'); },
    ...noSleep,
  });

  assert.equal(renewals, 1);
  assert.deepEqual(post.calls.map((c) => c.token), ['tok-a', 'tok-2', 'tok-2']);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.lastError, 'HTTP 401');
});

test('38. a workspace clone records attempt evidence before every chunk, the renewed retry included', async (t) => {
  const home = sandboxHome(t, 'beezi-lanes-cov-');
  linkAccount(home, KEY);
  const TENANT = 'ten-1';
  const session = { ...accountSession(KEY, 'tok-a'), tenantId: TENANT };
  const binding = currentBinding(session.clientId);
  const attemptedAtPost = [];
  const post = fakePost((_body, n) => {
    attemptedAtPost.push(Object.keys(loadCoverageCheckpoints(KEY, binding, {}, TENANT).sessions).sort());
    return n === 1 ? { status: 401, body: {} } : { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(
    [group('s1', MAX_CHUNK_ITEMS), group('s2', MAX_CHUNK_ITEMS)],
    KEY,
    session,
    {
      postJsonImpl: post.impl,
      renewSession: async (stale) => ({ ...stale, token: 'tok-b' }),
      getAccessToken: async () => { throw new Error('the per-call token read must not run'); },
    },
  );

  assert.deepEqual(post.calls.map((c) => [c.token, c.session.tenantId]), [['tok-a', TENANT], ['tok-b', TENANT], ['tok-b', TENANT]]);
  assert.deepEqual(attemptedAtPost, [['s1'], ['s1'], ['s1', 's2']]);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
});

// ─── gzip request bodies ────────────────────────────────────────────────────

const gzipFlags = (calls) => calls.map((call) => call.deps.gzip === true);
// Staging's answer when gzip bytes reach the JSON parser (a proxy that drops Content-Encoding), and an HTML 400.
const jsonBadRequest = { status: 400, body: { message: 'Unexpected token \u001f in JSON at position 0', error: 'Bad Request', statusCode: 400 } };
const htmlBadRequest = { status: 400, raw: '<html><body><h1>400 Bad Request</h1></body></html>' };
// Keeps terminal 4xx/5xx paths off the real diagnostics recorder.
const noIssues = { recordIssue: () => true };

test('gzip 1. with compression enabled every chunk posts with gzip: true', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 40), group('s2', 40)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, true]);
  assert.equal(compression.enabled, true);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 2. without deps.compression the post gets exactly today\'s deps', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, ...noIssues });

  assert.deepEqual(Object.keys(post.calls[0].deps).sort(), ['fetchImpl', 'timeoutMs']);
});

test('gzip 3. a 415 resends the chunk plain once; its 2xx turns gzip off for the run and gives the verdict', async () => {
  const post = fakePost((body, n) => {
    if (n === 1) return { status: 415, raw: '<html>415 Unsupported Media Type</html>' };
    return { status: 200, body: okBody({ errors: [{ sessionId: 's1', segmentId: 's1:0', reason: 'Repository is not connected to Beezi.' }] }) };
  });
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 40), group('s2', 40)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });
  await flushBackfillChunks([group('s3', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false, false, false]);
  assert.deepEqual(post.calls[1].body, post.calls[0].body);
  assert.equal(compression.enabled, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.PARTIAL);
  assert.equal(result.bySession.get('s1').reason, 'Repository is not connected to Beezi.');
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.permanentRejections, 0);
  assert.equal(result.retryableFailures, 0);
});

test('gzip 4. a 400 with any body on a compressed chunk resends it plain; a plain 2xx turns gzip off, with no bisection', async () => {
  for (const refusal of [jsonBadRequest, htmlBadRequest]) {
    const post = fakePost((body, n) => (n === 1 ? refusal : { status: 200, body: okBody() }));
    const compression = { enabled: true };

    const result = await flushBackfillChunks([group('s1', 1), group('s2', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

    assert.deepEqual(gzipFlags(post.calls), [true, false]);
    assert.deepEqual(post.calls[1].body, post.calls[0].body, 'the same whole chunk, not a bisected half');
    assert.equal(compression.enabled, false);
    assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
    assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
    assert.equal(result.permanentRejections, 0);
  }
});

test('gzip 5. a genuine validation 400 comes back on the plain resend too: bisection runs plain and gzip stays on', async () => {
  const poisoned = new Set(['s3']);
  const post = fakePost((body) => {
    const ids = new Set(body.sessions.map((r) => r.sessionId));
    return [...ids].some((id) => poisoned.has(id))
      ? { status: 400, body: { statusCode: 400, message: ['sessions.0.agent_name must be shorter'], error: 'Bad Request' } }
      : { status: 200, body: okBody() };
  });
  const compression = { enabled: true };

  const result = await flushBackfillChunks(
    [group('s1', 1), group('s2', 1), group('s3', 1), group('s4', 1)],
    KEY,
    SESSION,
    { postJsonImpl: post.impl, compression, ...noIssues },
  );

  assert.deepEqual(gzipFlags(post.calls), [true, false, false, false, false, false]);
  assert.deepEqual(post.calls[1].body, post.calls[0].body, 'the plain resend is the same whole chunk');
  assert.equal(compression.enabled, true, 'a plain 400 says nothing against gzip');
  assert.equal(result.bySession.get('s3').status, BackfillSessionStatus.REJECTED);
  for (const id of ['s1', 's2', 's4']) assert.equal(result.bySession.get(id).status, BackfillSessionStatus.ACCEPTED, id);
  assert.equal(result.permanentRejections, 1);
});

test('gzip 6. the timelines 400 branch still works: the plain resend draws the 400 and drops the timelines', async () => {
  const post = fakePost((body) => (body.timelines != null
    ? { status: 400, body: { statusCode: 400, message: ['property timelines should not exist'] } }
    : { status: 200, body: okBody() }));
  const compression = { enabled: true };

  const result = await flushBackfillChunks(
    [{ ...group('s1', 1), timeline: timelineFor('s1') }],
    KEY,
    SESSION,
    { postJsonImpl: post.impl, compression, ...noIssues },
  );

  assert.deepEqual(gzipFlags(post.calls), [true, false, false]);
  assert.equal('timelines' in post.calls[1].body, true);
  assert.equal('timelines' in post.calls[2].body, false);
  assert.equal(compression.enabled, true);
  assert.equal(result.timelinesDropped, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 7. a 401 on a compressed chunk renews the token and retries compressed', async () => {
  const post = fakePost([{ status: 401, body: {} }, { status: 200, body: okBody() }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'stale-tok'), {
    postJsonImpl: post.impl,
    getAccessToken: async () => 'fresh-tok',
    compression,
    ...noIssues,
  });

  assert.deepEqual(gzipFlags(post.calls), [true, true]);
  assert.equal(post.calls[1].token, 'fresh-tok');
  assert.equal(compression.enabled, true);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 8. with the run-level renewSession a 401 retry also goes out compressed', async () => {
  const post = fakePost([{ status: 401, body: {} }, { status: 200, body: okBody() }]);
  const compression = { enabled: true };
  const renewSession = async (stale) => ({ ...stale, token: 'fresh-tok' });

  const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'stale-tok'), {
    postJsonImpl: post.impl,
    renewSession,
    compression,
    ...noIssues,
  });

  assert.deepEqual(gzipFlags(post.calls), [true, true]);
  assert.equal(post.calls[1].token, 'fresh-tok');
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 9. a 415 after a 401 renewal resends plain with the renewed token', async () => {
  const post = fakePost([{ status: 401, body: {} }, { status: 415, raw: '' }, { status: 200, body: okBody() }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, accountSession(KEY, 'stale-tok'), {
    postJsonImpl: post.impl,
    getAccessToken: async () => 'fresh-tok',
    compression,
    ...noIssues,
  });

  assert.deepEqual(gzipFlags(post.calls), [true, true, false]);
  assert.deepEqual(post.calls.map((c) => c.token), ['stale-tok', 'fresh-tok', 'fresh-tok']);
  assert.equal(compression.enabled, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 10. the plain resend keeps its own 5xx retry, and its eventual 2xx turns gzip off', async () => {
  const post = fakePost([{ status: 415, raw: '' }, { status: 503, body: {} }, { status: 200, body: okBody() }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noSleep, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false, false]);
  assert.equal(compression.enabled, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.retryableFailures, 0);
});

test('gzip 11. a 5xx on a compressed chunk is retried plain, and that plain 2xx turns gzip off', async () => {
  const post = fakePost([{ status: 500, body: {} }, { status: 200, body: okBody() }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noSleep, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false]);
  assert.equal(compression.enabled, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.retryableFailures, 0);
});

test('gzip 12. a 5xx that the plain retry also gets leaves the chunk FAILED and gzip on', async () => {
  const post = fakePost([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noSleep, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false]);
  assert.equal(compression.enabled, true);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.retryableFailures, 1);
});

test('gzip 13. a compressed post that throws is retried plain, and that plain 2xx turns gzip off', async () => {
  const flags = [];
  const postJsonImpl = async (url, session, body, deps) => {
    flags.push(deps.gzip === true);
    if (flags.length === 1) throw new TypeError('fetch failed');
    return { status: 200, text: async () => JSON.stringify(okBody()) };
  };
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl, compression, ...noSleep, ...noIssues });

  assert.deepEqual(flags, [true, false]);
  assert.equal(compression.enabled, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.retryableFailures, 0);
});

test('gzip 14. compression already off: a 400 bisects exactly as today', async () => {
  const post = fakePost((body, n) => (n === 1 ? htmlBadRequest : { status: 200, body: okBody() }));
  const compression = { enabled: false };

  const result = await flushBackfillChunks([group('s1', 1), group('s2', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [false, false, false]);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 15. two lanes: a compressed request still in flight when the other lane turns gzip off falls back too', async () => {
  const compression = { enabled: true };
  const calls = [];
  let releaseBoth;
  const bothSent = new Promise((resolve) => { releaseBoth = resolve; });
  let compressedSent = 0;
  const postJsonImpl = async (url, session, body, deps) => {
    calls.push({ sessionId: body.sessions[0].sessionId, gzip: deps.gzip === true });
    if (deps.gzip === true) {
      compressedSent += 1;
      if (compressedSent === 2) releaseBoth();
      await bothSent;
      return { status: 415, text: async () => '<html>415 Unsupported Media Type</html>' };
    }
    return { status: 200, text: async () => JSON.stringify(okBody()) };
  };

  const [a, b] = await Promise.all([
    flushBackfillChunks([group('a1', 1)], KEY, SESSION, { postJsonImpl, compression, ...noIssues }),
    flushBackfillChunks([group('b1', 1)], KEY, SESSION, { postJsonImpl, compression, ...noIssues }),
  ]);

  assert.equal(compression.enabled, false);
  assert.deepEqual(calls.filter((c) => c.gzip).map((c) => c.sessionId).sort(), ['a1', 'b1']);
  assert.deepEqual(calls.filter((c) => !c.gzip).map((c) => c.sessionId).sort(), ['a1', 'b1']);
  assert.equal(a.bySession.get('a1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(b.bySession.get('b1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(a.permanentRejections + b.permanentRejections, 0);
});

test('gzip 16. a code-less 403 on a compressed chunk resends it plain; the plain 2xx turns gzip off', async () => {
  const post = fakePost((body, n) => (n === 1
    ? { status: 403, raw: '<html><body>Blocked by policy</body></html>' }
    : { status: 200, body: okBody() }));
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false]);
  assert.deepEqual(post.calls[1].body, post.calls[0].body);
  assert.equal(compression.enabled, false);
  assert.equal(result.halt, null);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('gzip 17. a 404 on a compressed chunk resends it plain; a plain 404 still halts as unsupported', async () => {
  const post = fakePost([{ status: 404, raw: '<html>Cannot POST /api/sessions/backfill</html>' }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1), group('s2', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true, false]);
  assert.equal(compression.enabled, true);
  assert.equal(result.halt, BackfillHalt.UNSUPPORTED_SERVER);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

test('gzip 18. a coded 403 on a compressed chunk is not resent and halts as today', async () => {
  const post = fakePost([{ status: 403, body: { statusCode: 403, code: 'BACKFILL_ALREADY_COMPLETED', message: 'sealed' } }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 40), group('s2', 40)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true]);
  assert.equal(compression.enabled, true);
  assert.equal(result.halt, BackfillHalt.ALREADY_COMPLETED);
});

test('gzip 19. a 429 on a compressed chunk is not resent plain', async () => {
  const post = fakePost([{ status: 429, body: { statusCode: 429, message: 'Too Many Requests' } }]);
  const compression = { enabled: true };

  const result = await flushBackfillChunks([group('s1', 1)], KEY, SESSION, { postJsonImpl: post.impl, compression, ...noIssues });

  assert.deepEqual(gzipFlags(post.calls), [true]);
  assert.equal(compression.enabled, true);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
});
