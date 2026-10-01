import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyWindows,
  isMaterial,
  rateLimitObservationFromRecord,
  recordRateLimitObservations,
  readPendingRateLimits,
  clearPendingRateLimits,
  readObservedPlan,
  sanitizeLimit,
} from '../lib/rate-limits-codex.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// The debounce series and the observed plan stay MACHINE-level — the reading describes the ChatGPT
// account Codex is signed into, not a Beezi tenant. What is per account is DELIVERY: every linked
// workspace is owed the same row, into its own queue, cleared under its own lock.
const KEY = TEST_KEY;

function useTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rate-limits-test-'));
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    delete process.env.BEEZI_CODEX_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  linkAccount(dir, KEY);
  return dir;
}

// Every shape below is copied from a real rollout on disk (201 files scanned, 2025-12 → 2026-09).
const tokenCount = (rateLimits, timestamp = '2026-09-09T15:54:24.964Z') => ({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    rate_limits: rateLimits,
  },
});

const win = (pct, windowMinutes, resetsAt = 1788987264) => ({
  used_percent: pct,
  window_minutes: windowMinutes,
  resets_at: resetsAt,
});

// ─── window classification: the slot is not the role ──────────────────────────────────────────

test('the standard layout maps primary to 5h and secondary to 7d', () => {
  const cls = classifyWindows({ primary: win(0, 300), secondary: win(33, 10080) });
  assert.equal(cls.fiveHour.pct, 0);
  assert.equal(cls.sevenDay.pct, 33);
});

// 2775 of 10338 local observations carry the WEEKLY window in the `primary` slot with a null
// secondary. Reading the slot as the role writes weekly utilization into the five-hour column.
test('a weekly window in the primary slot is classified as seven-day, not five-hour', () => {
  const cls = classifyWindows({ primary: win(41, 10080), secondary: null });
  assert.equal(cls.fiveHour, null, 'the 5h column must stay empty rather than take a weekly value');
  assert.equal(cls.sevenDay.pct, 41);
});

// 315 local observations, all on a free plan: a 30-day window this wire contract has no column for.
// It is classified into its own slot — never into a column — and travels in limits[] instead.
test('a 30-day window is claimed by neither column', () => {
  const cls = classifyWindows({ primary: win(4, 43200), secondary: null });
  assert.equal(cls.fiveHour, null, 'a 30-day number in the 5h column would be a 10x understatement');
  assert.equal(cls.sevenDay, null);
  assert.equal(cls.monthly.pct, 4);
});

// A span nobody has measured must land nowhere rather than in the nearest column.
test('an unrecognised span is classified into no slot at all', () => {
  const cls = classifyWindows({ primary: win(4, 1440), secondary: null });
  assert.deepEqual([cls.fiveHour, cls.sevenDay, cls.monthly], [null, null, null]);
});

test('the premium bucket, which reports no windows at all, yields no observation', () => {
  const rec = tokenCount({
    limit_id: 'premium', limit_name: null, primary: null, secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, spend_control_reached: null,
    plan_type: 'free', rate_limit_reached_type: null,
  });
  assert.equal(rateLimitObservationFromRecord(rec), null);
});

// ─── record extraction ────────────────────────────────────────────────────────────────────────

test('extracts a full observation from a real token_count record', () => {
  const o = rateLimitObservationFromRecord(tokenCount({
    limit_id: 'codex', limit_name: null,
    primary: win(0, 300, 1788987264), secondary: win(33, 10080, 1789454397),
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null, spend_control_reached: null,
    plan_type: 'plus', rate_limit_reached_type: null,
  }));
  assert.equal(o.observedAt, '2026-09-09T15:54:24.964Z');
  assert.equal(o.fiveHour.pct, 0);
  assert.equal(o.sevenDay.pct, 33);
  assert.equal(o.limitId, 'codex');
});

test('a record that is not a token_count carries no observation', () => {
  assert.equal(rateLimitObservationFromRecord({ type: 'turn_context', payload: { cwd: '/x' } }), null);
  assert.equal(rateLimitObservationFromRecord(tokenCount(undefined)), null);
});

// The server's toStrictDate drops an unparseable timestamp silently while still answering 200
// "stored", and the drain would then clear a row that was never written.
test('an unusable timestamp drops the observation rather than shipping a bad dedup key', () => {
  assert.equal(rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300) }, 'not a date')), null);
  assert.equal(rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300) }, '')), null);
  // Milliseconds where seconds were expected lands in year +58639 and fails @IsISO8601().
  assert.equal(
    rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300) }, '1788987264000')),
    null,
  );
});

// A non-finite or negative percent reaches @IsInt()/@Min(0) untouched by the server's rounding and
// 400s the payload — which breaks the drain WITHOUT clearing, stalling every row behind it.
test('a percentage that cannot be sent is not sent', () => {
  const nan = rateLimitObservationFromRecord(tokenCount({ primary: { ...win(0, 300), used_percent: NaN } }));
  assert.equal(nan.fiveHour.pct, null, 'NaN must not reach the wire');
  const negative = rateLimitObservationFromRecord(tokenCount({ primary: { ...win(0, 300), used_percent: -1 } }));
  assert.equal(negative.fiveHour.pct, null, 'a negative percent must not reach the wire');
});

// ─── debounce ─────────────────────────────────────────────────────────────────────────────────

test('isMaterial fires on a window rollover, a 5-point move, and crossing 100', () => {
  assert.equal(isMaterial({ pct: 10, resetsAt: 1 }, null), true, 'first reading always counts');
  assert.equal(isMaterial({ pct: 10, resetsAt: 2 }, { pct: 10, resetsAt: 1 }), true, 'rollover');
  assert.equal(isMaterial({ pct: 16, resetsAt: 1 }, { pct: 10, resetsAt: 1 }), true, '6-point move');
  assert.equal(isMaterial({ pct: 13, resetsAt: 1 }, { pct: 10, resetsAt: 1 }), false, '3-point move');
  assert.equal(isMaterial({ pct: 100, resetsAt: 1 }, { pct: 98, resetsAt: 1 }), true, 'hit the ceiling');
});

test('isMaterial treats 99 as exhausted: crossing it either way is material', () => {
  assert.equal(isMaterial({ pct: 99, resetsAt: 1 }, { pct: 97, resetsAt: 1 }), true, '97 -> 99 is exhaustion');
  assert.equal(isMaterial({ pct: 97, resetsAt: 1 }, { pct: 99, resetsAt: 1 }), true, '99 -> 97 is recovery');
  assert.equal(isMaterial({ pct: 100, resetsAt: 1 }, { pct: 99, resetsAt: 1 }), false, 'already exhausted');
  assert.equal(isMaterial({ pct: 98.9, resetsAt: 1 }, { pct: 97, resetsAt: 1 }), false, 'below the line');
});

const obs = (pct, at, limitId = 'codex') => ({
  observedAt: at,
  fiveHour: { pct, resetsAt: 1788987264, windowMinutes: 300 },
  sevenDay: null,
  limitId,
});

test('an immaterial move inside the floor window is not queued', (t) => {
  useTmpHome(t);
  assert.equal(recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]).recorded, 1);
  assert.equal(recordRateLimitObservations([obs(12, '2026-09-09T10:05:00.000Z')], [KEY]).recorded, 0);
  assert.equal(readPendingRateLimits(KEY).length, 1);
});

test('an unchanged reading is queued again once the 15-minute floor passes', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]);
  assert.equal(recordRateLimitObservations([obs(10, '2026-09-09T10:15:00.000Z')], [KEY]).recorded, 1);
  assert.equal(readPendingRateLimits(KEY).length, 2);
});

// Five local rollouts carry both a `codex` and a `premium` bucket. One shared baseline would let
// one series' reading suppress the other's.
test('each limit_id debounces against its own baseline', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z', 'codex')], [KEY]);
  const other = recordRateLimitObservations([obs(10, '2026-09-09T10:01:00.000Z', 'premium')], [KEY]);
  assert.equal(other.recorded, 1, 'a different limit_id is a different series, not a repeat');
});

// The five columns plus the two passthrough keys UsageSnapshotRequestDto declares (`limits`,
// `raw`). It is a SET, not a count: forbidNonWhitelisted 400s the whole payload on an unknown key,
// and a 400 breaks the drain WITHOUT clearing, stalling every row queued behind it. The two
// negatives below are the guard §2/§4 actually want and they survive the widening — `plan_type` has
// no column, so it rides inside `raw` and reaches the wire as `subscription_plan` instead.
test('a queued row carries exactly the seven keys the API whitelists, and never plan_type', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([{
    observedAt: '2026-09-09T15:54:24.964Z',
    fiveHour: { pct: 0, resetsAt: 1788987264, windowMinutes: 300 },
    sevenDay: { pct: 33, resetsAt: 1789454397, windowMinutes: 10080 },
    limitId: 'codex',
    planType: 'plus',
    raw: { limit_id: 'codex', plan_type: 'plus' },
  }], [KEY]);
  const [row] = readPendingRateLimits(KEY);
  assert.deepEqual(Object.keys(row).sort(), [
    'fetched_at', 'five_hour_pct', 'five_hour_resets_at', 'limits', 'raw',
    'seven_day_pct', 'seven_day_resets_at',
  ]);
  assert.equal('plan_type' in row, false, 'no column for it — it belongs in raw');
  assert.equal('planType' in row, false, 'the observation field must not leak onto the row');
  assert.equal('window_minutes' in row, false);
  // The five columns are byte-for-byte what they were before limits/raw were added.
  assert.equal(row.fetched_at, '2026-09-09T15:54:24.964Z');
  assert.equal(row.five_hour_pct, 0);
  assert.equal(row.five_hour_resets_at, '2026-09-09T20:54:24.000Z');
  assert.equal(row.seven_day_pct, 33);
  assert.equal(row.seven_day_resets_at, '2026-09-15T06:39:57.000Z');
});

// ─── G-4-9: the sub-fields the five columns cannot express ────────────────────────────────────

// The nested DTO is deep-whitelisted — the global pipe traverses @ValidateNested() — so ONE unknown
// key inside limits[] 400s the whole snapshot. The sanitizer is a whitelist independent of its
// input: hand it a raw window object and the classifier key still cannot get out.
const LIMIT_DTO_KEYS = ['group', 'is_active', 'kind', 'percent', 'resets_at', 'scope', 'severity'];

test('a limit entry is sanitized to exactly the seven keys the nested DTO declares', () => {
  const entry = sanitizeLimit({
    kind: 'monthly', used_percent: 4, window_minutes: 43200, resets_at: 'x', anything_else: 1,
  });
  assert.deepEqual(Object.keys(entry).sort(), LIMIT_DTO_KEYS);
  assert.equal(entry.window_minutes, undefined, 'the classifier has no column and must not travel');
  // JSON is what actually reaches the wire, and it drops the undefined ones.
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), { kind: 'monthly', resets_at: 'x' });
});

// THE LIVE DATA LOSS THIS CLOSES: 315 of 10338 local observations, all free-plan, carried a 30-day
// window and were dropped ENTIRELY — not just the window, the whole reading — because the contract
// had no column for the span.
test('a 30-day window survives in limits[] instead of dropping the whole reading', (t) => {
  useTmpHome(t);
  const o = rateLimitObservationFromRecord(tokenCount({
    limit_id: 'codex', limit_name: null,
    primary: win(4, 43200, 1788987264), secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null, spend_control_reached: false,
    plan_type: 'free', rate_limit_reached_type: null,
  }));
  assert.ok(o, 'the reading used to be discarded for want of a client-side write');
  assert.equal(o.monthly.pct, 4);

  recordRateLimitObservations([o], [KEY]);
  const [row] = readPendingRateLimits(KEY);
  assert.equal(row.five_hour_pct, null, 'a 30-day number must never be written into the 5h column');
  assert.equal(row.seven_day_pct, null);
  assert.equal(row.limits.length, 1);
  assert.equal(row.limits[0].kind, 'monthly');
  assert.equal(row.limits[0].percent, 4);
  assert.equal(row.limits[0].resets_at, '2026-09-09T20:54:24.000Z');
  for (const key of Object.keys(row.limits[0])) {
    assert.ok(LIMIT_DTO_KEYS.indexOf(key) !== -1, `${key} is not accepted by UsageSnapshotLimitDto`);
  }
});

// A float percent is handed over unrounded, exactly as the five_hour/seven_day columns already do:
// UsageSnapshotLimitDto.percent carries @Transform(roundPct) ahead of its @IsInt()
// (usage-snapshot.request.dto.ts:30-33), the same pair the columns have at :105-119. Rounding here
// instead would make the nested entry behave differently from the columns beside it, and readPct
// (which only rejects non-finite and negative) is the single gate for both.
test('a float percent travels the way the columns already travel it', (t) => {
  useTmpHome(t);
  const o = rateLimitObservationFromRecord(tokenCount({
    primary: { used_percent: 56.00000000000001, window_minutes: 43200, resets_at: 1788987264 },
    secondary: win(4.5, 300),
  }));
  recordRateLimitObservations([o], [KEY]);
  const [row] = readPendingRateLimits(KEY);
  assert.equal(row.five_hour_pct, 4.5, 'the column sends the float and the server rounds on ingest');
  assert.equal(row.limits[0].percent, 56.00000000000001, 'and so does the nested entry');
});

// limits[] carries only what has no column of its own. Promoting the 5h/7d windows there as well
// would hand the backend a duplicate view of numbers it already has in the columns.
test('a reading with only 5h/7d windows sends no limits entry at all', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]);
  assert.equal(readPendingRateLimits(KEY)[0].limits, null);
});

test('raw round-trips the untranslated block and nothing else', (t) => {
  useTmpHome(t);
  const block = {
    limit_id: 'codex',
    limit_name: 'Codex',
    primary: win(4, 43200, 1788987264),
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: false,
    plan_type: 'free',
    rate_limit_reached_type: null,
  };
  const o = rateLimitObservationFromRecord(tokenCount(block));
  recordRateLimitObservations([o], [KEY]);
  const [row] = readPendingRateLimits(KEY);
  assert.deepEqual(Object.keys(row.raw).sort(), [
    'credits', 'limit_id', 'plan_type', 'primary', 'rate_limit_reached_type',
    'secondary', 'spend_control_reached',
  ]);
  // The four sub-fields that were dropped outright before this landed.
  assert.equal(row.raw.credits.has_credits, false);
  assert.equal(row.raw.credits.balance, '0');
  assert.equal(row.raw.plan_type, 'free');
  assert.equal(row.raw.spend_control_reached, false);
  // window_minutes IS allowed inside raw — it is a jsonb passthrough, not a whitelisted array.
  assert.equal(row.raw.primary.window_minutes, 43200);
  // Not on §4's list, so deliberately absent rather than swept in by a spread.
  assert.equal('limit_name' in row.raw, false);
  assert.equal('individual_limit' in row.raw, false);
});

test('a block carrying none of the named keys yields raw null rather than an empty object', (t) => {
  useTmpHome(t);
  const o = rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300) }));
  assert.ok(o.raw && o.raw.primary, 'primary is one of the named keys');
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]); // hand-built, no raw
  assert.equal(readPendingRateLimits(KEY)[0].raw, null);
});

// ─── G-2-3: plan_type is a plan source, and it lives on the observation, never on the row ──────

test('the observation carries the server-stamped plan_type verbatim', () => {
  const known = rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300), plan_type: 'plus' }));
  assert.equal(known.planType, 'plus');
  // 6926 of 10352 local observations — older Codex builds stamp no plan at all.
  const older = rateLimitObservationFromRecord(tokenCount({ primary: win(5, 300), plan_type: null }));
  assert.equal(older.planType, null);
});

const planned = (at, planType, pct = 10) => ({ ...obs(pct, at), planType });

test('the observed plan is normalized through the one tier table', (t) => {
  useTmpHome(t);
  // Codex still calls the $200 tier `pro`; the API prices it as pro_20x.
  recordRateLimitObservations([planned('2026-09-09T10:00:00.000Z', 'pro')], [KEY]);
  assert.equal(readObservedPlan().plan, 'pro_20x');
});

// 'unknown' as a plan reads as a fact on the wire, and it also leaves billing.json permanently
// stale — the failure `go` used to cause. A tier we cannot price is simply not recorded.
test('a plan_type the tier table does not know is not written', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([planned('2026-09-09T10:00:00.000Z', 'mystery')], [KEY]);
  assert.equal(readObservedPlan(), null);
});

// The majority case, and the one a naive implementation gets wrong: two thirds of observations
// carry no plan, and treating that as "no plan" would report nothing for most sessions.
test('a plan_type: null observation leaves the stored plan standing rather than clearing it', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([planned('2026-09-09T10:00:00.000Z', 'plus')], [KEY]);
  assert.equal(readObservedPlan().plan, 'plus');
  recordRateLimitObservations([planned('2026-09-09T11:00:00.000Z', null, 40)], [KEY]);
  assert.equal(readObservedPlan().plan, 'plus', 'a silent build must not erase a known plan');
});

// The free→plus transition this machine actually made, dated by the rollout's own timestamps —
// the event the refresh flow exists to catch, which happened without anyone running refresh.
test('a plan change is captured even when the reading itself is debounced away', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([planned('2026-09-09T10:00:00.000Z', 'free')], [KEY]);
  const res = recordRateLimitObservations([planned('2026-09-09T10:05:00.000Z', 'plus', 11)], [KEY]);
  assert.equal(res.recorded, 0, 'a 1-point move inside the floor is not worth a row');
  assert.equal(readObservedPlan().plan, 'plus', 'but the plan change is worth remembering');
});

test('an older observation never drags the observed plan backwards', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([planned('2026-09-09T11:00:00.000Z', 'plus')], [KEY]);
  recordRateLimitObservations([planned('2026-09-09T09:00:00.000Z', 'free', 60)], [KEY]);
  assert.equal(readObservedPlan().plan, 'plus');
});

test('the observed plan survives a drain', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([planned('2026-09-09T10:00:00.000Z', 'plus')], [KEY]);
  clearPendingRateLimits(KEY, readPendingRateLimits(KEY));
  assert.equal(readPendingRateLimits(KEY).length, 0);
  assert.equal(readObservedPlan().plan, 'plus', 'the plan outlives the queue it was observed with');
});

test('the monthly window debounces against its own baseline', (t) => {
  useTmpHome(t);
  const monthly = (pct, at) => ({
    observedAt: at, fiveHour: null, sevenDay: null,
    monthly: { pct, resetsAt: 1788987264, windowMinutes: 43200 },
    limitId: 'codex',
  });
  assert.equal(recordRateLimitObservations([monthly(4, '2026-09-09T10:00:00.000Z')], [KEY]).recorded, 1);
  assert.equal(recordRateLimitObservations([monthly(5, '2026-09-09T10:05:00.000Z')], [KEY]).recorded, 0);
  assert.equal(recordRateLimitObservations([monthly(20, '2026-09-09T10:06:00.000Z')], [KEY]).recorded, 1);
});

test('clearing drops only the confirmed prefix', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([
    obs(10, '2026-09-09T10:00:00.000Z'),
    obs(20, '2026-09-09T10:30:00.000Z'),
    obs(30, '2026-09-09T11:00:00.000Z'),
  ], [KEY]);
  assert.equal(readPendingRateLimits(KEY).length, 3);
  clearPendingRateLimits(KEY, readPendingRateLimits(KEY).slice(0, 2));
  const rest = readPendingRateLimits(KEY);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].five_hour_pct, 30);
});

test('the debounce baseline survives a drain', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]);
  clearPendingRateLimits(KEY, readPendingRateLimits(KEY));
  const after = recordRateLimitObservations([obs(11, '2026-09-09T10:05:00.000Z')], [KEY]);
  assert.equal(after.recorded, 0, 'draining must not reopen the floor window');
});

// A row appended by a concurrent writer while the drain is in flight. The queue is capped with
// slice(-MAX_PENDING), so an append to a full queue evicts from the FRONT and shifts every index
// left — an index-based clear would then take exactly as many never-posted rows as were evicted.
test('clearing survives an eviction that shifts the queue under it', (t) => {
  useTmpHome(t);
  const posted = [];
  for (let i = 0; i < 40; i++) {
    const at = new Date(Date.UTC(2026, 8, 9, 0, 0, 0) + i * 3600_000).toISOString();
    recordRateLimitObservations([obs(i, at)], [KEY]);
  }
  posted.push(...readPendingRateLimits(KEY));
  assert.equal(posted.length, 40, 'the queue starts full at MAX_PENDING');

  // Another process records five more while the 40 above are being posted.
  for (let i = 0; i < 5; i++) {
    const at = new Date(Date.UTC(2026, 8, 11, 0, 0, 0) + i * 3600_000).toISOString();
    recordRateLimitObservations([obs(50 + i, at)], [KEY]);
  }
  clearPendingRateLimits(KEY, posted);

  const rest = readPendingRateLimits(KEY);
  assert.equal(rest.length, 5, 'only the five unposted rows are left');
  for (const row of rest) {
    assert.ok(row.five_hour_pct >= 50, `${row.fetched_at} was never posted and must survive`);
  }
});

// The floor is measured against a RECORD's timestamp, not wall-clock now, so an out-of-order
// observation (two Codex sessions, or a subagent hook beside the parent checkpoint) could drag the
// baseline backwards and reopen the 15-minute window early.
test('an out-of-order observation never moves the debounce baseline backwards', (t) => {
  useTmpHome(t);
  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]);
  // Older than what is already recorded, and material against it (a 15-point move), so it is
  // queued — but it must not become the baseline.
  assert.equal(recordRateLimitObservations([obs(25, '2026-09-09T09:50:00.000Z')], [KEY]).recorded, 1);
  // Immaterial against the 10:00 reading and inside 15 minutes of it. Had the older row moved the
  // baseline, this would read as a 14-point move against pct 25 with the floor already reopened.
  const after = recordRateLimitObservations([obs(11, '2026-09-09T10:05:00.000Z')], [KEY]);
  assert.equal(after.recorded, 0, 'the baseline is the newest reading, not the last one written');
});

// ─── the fan-out: one reading, one debounce decision, one queue per account ───────────────────

// The split this module went through in 0.13. The series must stay machine-level or the 5-point
// gate and the 15-minute floor would be re-opened once per linked workspace; the QUEUE must be per
// account or one tenant's successful drain would clear rows the other has not sent.
test('one material reading lands in every account queue, and each clears independently', (t) => {
  const home = useTmpHome(t);
  const OTHER = '99887766';
  linkAccount(home, OTHER);

  const recorded = recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY, OTHER]);
  assert.equal(recorded.recorded, 1, 'one reading, decided once');
  assert.deepEqual(recorded.skippedKeys, [], 'both queues took it');
  assert.equal(readPendingRateLimits(KEY).length, 1);
  assert.equal(readPendingRateLimits(OTHER).length, 1);

  clearPendingRateLimits(KEY, readPendingRateLimits(KEY));

  assert.equal(readPendingRateLimits(KEY).length, 0, 'the account that posted is clear');
  assert.equal(readPendingRateLimits(OTHER).length, 1, 'the other account still owes its row');
});

// The debounce is a property of the READING, not of a tenant: adding a second linked account must
// not make the same rollout line material all over again.
test('a second account does not re-open the debounce for a reading already seen', (t) => {
  const home = useTmpHome(t);
  const OTHER = '99887766';
  linkAccount(home, OTHER);

  recordRateLimitObservations([obs(10, '2026-09-09T10:00:00.000Z')], [KEY]);
  const again = recordRateLimitObservations([obs(12, '2026-09-09T10:05:00.000Z')], [KEY, OTHER]);

  assert.equal(again.recorded, 0, 'immaterial and inside the floor, for every account');
  assert.equal(readPendingRateLimits(OTHER).length, 0, 'nothing was invented for the new account');
});
