// Imported first, and for its side effect as much as its exports: it redirects every root the
// plugin can resolve into a per-process sandbox and deletes OPENAI_API_KEY from process.env.
// See tools/hermetic-env.mjs for the three leak channels this file used to sit on top of.
import { withCodexAuth } from '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainRateLimitSnapshots } from '../lib/usage-report-codex.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The drain is per account: it reads that account's queue, posts under that account's bearer and
// client id, and clears only what that account's server confirmed.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

const ROW = (pct) => ({
  fetched_at: `2026-09-09T1${pct}:00:00.000Z`,
  five_hour_pct: pct,
  five_hour_resets_at: '2026-09-09T20:54:24.000Z',
  seven_day_pct: 33,
  seven_day_resets_at: '2026-09-15T06:39:57.000Z',
});

function harness(rows, statuses) {
  const calls = [];
  let cleared = null;
  let n = 0;
  return {
    calls,
    cleared: () => cleared,
    deps: {
      // Stubbed so no test ever reads the developer's real ~/.codex/auth.json. Identity is
      // exercised on its own below, against fixtures.
      usageIdentityFields: () => ({}),
      readPendingRateLimits: (key) => { assert.equal(key, KEY, 'the drain reads its own account queue'); return rows; },
      clearPendingRateLimits: (key, posted) => { assert.equal(key, KEY); cleared = posted; },
      fetchImpl: (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        const status = statuses[n];
        n += 1;
        if (status === 'throw') return Promise.reject(new Error('network'));
        return Promise.resolve({ status, json: async () => ({}) });
      },
    },
  };
}

test('posts every pending row and clears them all', async () => {
  const h = harness([ROW(1), ROW(2)], [200, 200]);
  const res = await drainRateLimitSnapshots(KEY, SESSION, h.deps);
  assert.equal(res.posted, 2);
  // The rows themselves, not a count: the queue is re-read inside clearPending and a concurrent
  // append at MAX_PENDING evicts from the front, shifting every index left.
  assert.deepEqual(h.cleared(), [ROW(1), ROW(2)]);
  assert.ok(h.calls[0].url.endsWith('/me/codex/usage'), h.calls[0].url);
});

test('one row per request, sent verbatim when there is no identity to add', async () => {
  const h = harness([ROW(1)], [200]);
  await drainRateLimitSnapshots(KEY, SESSION, h.deps);
  assert.deepEqual(h.calls[0].body, ROW(1));
});

// The API rejects a whole payload on one bad field, and clearing past a failure would drop every
// row queued behind it — the exact silent-loss mode the Claude plugin's drain was built to avoid.
test('a rejection stops the drain and keeps the unsent rows', async () => {
  const h = harness([ROW(1), ROW(2), ROW(3)], [200, 400, 200]);
  const res = await drainRateLimitSnapshots(KEY, SESSION, h.deps);
  assert.equal(res.posted, 1);
  assert.deepEqual(h.cleared(), [ROW(1)], 'only the confirmed row is dropped');
  assert.equal(h.calls.length, 2, 'the drain stops rather than pushing past a rejection');
});

test('a network error on the first row clears nothing', async () => {
  const h = harness([ROW(1), ROW(2)], ['throw', 200]);
  const res = await drainRateLimitSnapshots(KEY, SESSION, h.deps);
  assert.equal(res.posted, 0);
  assert.equal(h.cleared(), null, 'clearPending must not be called at all');
});

// G-8-8. The count used to be set only on the deadline path, so a queue STALLED behind a rejection
// — the case where it matters most, because a non-2xx keeps the failed row and its whole tail —
// reported `deferred: 0` and looked identical to an empty queue.
test('rows left behind are counted whatever stopped the drain', async () => {
  const rejected = await drainRateLimitSnapshots(KEY, SESSION, harness([ROW(1), ROW(2), ROW(3)], [200, 400, 200]).deps);
  assert.deepEqual(
    { posted: rejected.posted, deferred: rejected.deferred, reason: rejected.reason },
    { posted: 1, deferred: 2, reason: 'rejected' },
  );
  const offline = await drainRateLimitSnapshots(KEY, SESSION, harness([ROW(1), ROW(2)], ['throw']).deps);
  assert.deepEqual(
    { posted: offline.posted, deferred: offline.deferred, reason: offline.reason },
    { posted: 0, deferred: 2, reason: 'network' },
  );
  const clean = await drainRateLimitSnapshots(KEY, SESSION, harness([ROW(1)], [200]).deps);
  assert.deepEqual(
    { posted: clean.posted, deferred: clean.deferred, reason: clean.reason },
    { posted: 1, deferred: 0, reason: 'drained' },
  );
});

test('no token and no rows are both quiet no-ops', async () => {
  const h = harness([ROW(1)], [200]);
  assert.deepEqual(await drainRateLimitSnapshots(KEY, null, h.deps), { posted: 0, reason: 'no-token' });
  assert.equal(h.calls.length, 0);

  const empty = harness([], []);
  assert.deepEqual(await drainRateLimitSnapshots(KEY, SESSION, empty.deps), { posted: 0, reason: 'empty' });
});

// ─── budget ───────────────────────────────────────────────────────────────────────────────────

// The queue holds up to MAX_PENDING = 40 rows and the drain is serial, so a per-request timeout
// alone bounds nothing: 40 × 3s against a 7.5s hook budget kills the checkpoint before it writes
// state or flushes billable segments. The deadline has to be checked per row.
test('the deadline stops the drain mid-queue and defers the rest', async () => {
  const h = harness([ROW(1), ROW(2), ROW(3), ROW(4)], [200, 200, 200, 200]);
  let clock = 0;
  const res = await drainRateLimitSnapshots(KEY, SESSION, {
    ...h.deps,
    now: () => clock,
    deadline: 1000,
    timeoutMs: 3000,
    fetchImpl: (url, init) => { clock += 600; return h.deps.fetchImpl(url, init); },
  });
  assert.equal(res.posted, 2, 'two rows fit inside the budget');
  assert.equal(res.deferred, 2, 'the rest stay queued for the next turn end');
  assert.equal(h.calls.length, 2, 'no request is even started past the deadline');
  assert.deepEqual(h.cleared(), [ROW(1), ROW(2)], 'only the posted rows are dropped');
});

// Deferring is free — the rows are on disk and the next checkpoint retries them — so nothing is
// lost, and the next drain picks up exactly where this one stopped.
test('a drain with no deadline still empties the whole queue', async () => {
  const h = harness([ROW(1), ROW(2), ROW(3)], [200, 200, 200]);
  const res = await drainRateLimitSnapshots(KEY, SESSION, h.deps);
  assert.equal(res.posted, 3);
  assert.equal(res.deferred, 0);
});

test('a hung request is cut to what the deadline has left, not the full per-request cap', async () => {
  const h = harness([ROW(1)], []);
  let requested = false;
  const startedAt = Date.now();
  const res = await drainRateLimitSnapshots(KEY, SESSION, {
    ...h.deps,
    deadline: Date.now() + 50,
    timeoutMs: 3000,
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      requested = true;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(requested, 'the request was started — otherwise the abort path is never exercised');
  assert.equal(res.posted, 0);
  assert.equal(h.cleared(), null, 'an aborted row stays queued');
  assert.ok(elapsed < 1500, `the drain waited ${elapsed}ms — the 3s cap was not shrunk to the budget`);
});

// ─── identity enrichment ──────────────────────────────────────────────────────────────────────

import { usageIdentityFields } from '../lib/usage-report-codex.mjs';

const account = (over = {}) => ({
  authMode: 'chatgpt', plan: 'plus', subscriptionType: 'plus', expiresAt: null,
  accountId: 'eb76c91d-0000-4000-8000-000000000000', email: 'dev@example.com', ...over,
});
const subscriptionBilling = { source: 'subscription', subscriptionType: 'plus', plan: 'plus', rateLimitTier: null };

for (const live of [null, account()]) {
  test(`billing identity reaches quota uploads with ${live ? 'conflicting' : 'missing'} auth identity`, async () => {
    const h = harness([ROW(1)], [200]);
    const result = await drainRateLimitSnapshots(KEY, SESSION, {
      ...h.deps,
      usageIdentityFields,
      readChatgptAuth: () => live,
      readBillingConfig: () => ({
        ...subscriptionBilling, authType: 'chatgpt',
        accountId: ' billing-account ', email: ' billing@example.com ',
      }),
      readObservedPlan: () => null,
      env: {},
    });
    assert.equal(result.posted, 1);
    assert.equal(h.calls[0].body.account_uuid, 'billing-account');
    assert.equal(h.calls[0].body.account_email, 'billing@example.com');
    assert.equal(h.calls[0].body.subscription_plan, 'plus');
    assert.equal(h.calls[0].body.five_hour_pct, 1);
  });
}

// L1 + L3. usageIdentityFields calls resolveBilling(billing, env) with no deps
// (usage-report-codex.mjs:49), so step 4 of the ladder opens the real ~/.codex/auth.json, and its
// `deps.env == null ? process.env` default (:45) lets a host OPENAI_API_KEY win at step 1. The
// asserted plan only appears under a `subscription` resolution, so both have to be pinned.
test('carries the Codex account id and email, plus the resolved plan', (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => subscriptionBilling,
    env: {},
  });
  assert.equal(f.account_uuid, 'eb76c91d-0000-4000-8000-000000000000');
  assert.equal(f.account_email, 'dev@example.com');
  assert.equal(f.subscription_plan, 'plus');
});

// resolveBilling also returns billing_source and third_party_provider. Neither is in
// UsageSnapshotRequestDto, and forbidNonWhitelisted 400s the whole payload on an unknown key —
// which breaks the drain WITHOUT clearing, stalling every row behind it.
test('never lets a non-whitelisted billing key onto the wire', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => subscriptionBilling,
  });
  const allowed = [
    'account_uuid', 'account_email', 'subscription_type', 'rate_limit_tier', 'subscription_plan',
  ];
  for (const key of Object.keys(f)) {
    assert.ok(allowed.indexOf(key) !== -1, `${key} is not accepted by the usage DTO`);
  }
  assert.equal(f.billing_source, undefined);
  assert.equal(f.third_party_provider, undefined);
});

test('an unknown field is omitted, never nulled — the server reads a null as a claim', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ accountId: null, email: null }),
    readBillingConfig: () => null,
  });
  assert.equal('account_uuid' in f, false);
  assert.equal('account_email' in f, false);
});

test('an oversized value is dropped rather than sent to 400 the row', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ accountId: 'x'.repeat(65), email: 'e'.repeat(330) }),
    readBillingConfig: () => null,
  });
  assert.equal('account_uuid' in f, false, 'account_uuid is @MaxLength(64)');
  assert.equal('account_email' in f, false, 'account_email is @MaxLength(320)');
});

test('an unreadable auth.json degrades to no identity rather than throwing', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => { throw new Error('unreadable'); },
    readBillingConfig: () => { throw new Error('unreadable'); },
  });
  assert.deepEqual(f, {});
});

test('the drain preserves captured identity and enriches unidentified rows', async () => {
  const h = harness([{ ...ROW(1), account_uuid: 'captured-account' }, ROW(2)], [200, 200]);
  await drainRateLimitSnapshots(KEY, SESSION, {
    ...h.deps,
    usageIdentityFields: () => ({ account_uuid: 'acct-1', account_email: 'current@example.com', five_hour_pct: 999 }),
  });
  assert.equal(h.calls[0].body.account_uuid, 'captured-account');
  assert.equal(h.calls[0].body.account_email, undefined, 'do not mix accounts');
  assert.equal(h.calls[1].body.account_uuid, 'acct-1');
  assert.equal(h.calls[1].body.account_email, 'current@example.com');
  assert.equal(h.calls[0].body.five_hour_pct, 1, 'the observation must not be overwritten');
});

test('an unrecognised plan is omitted rather than reported as the literal "unknown"', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ plan: 'unknown', subscriptionType: null }),
    readBillingConfig: () => ({ source: 'subscription', plan: 'unknown', subscriptionType: null, rateLimitTier: null }),
  });
  assert.equal('subscription_plan' in f, false);
  assert.equal('subscription_type' in f, false);
});

// billing.json goes stale: a login that could not resolve the tier writes plan 'unknown' and never
// revisits it. Observed on a real machine — the record said 'unknown' while auth.json said 'plus'.
test('a stale unknown plan on disk falls back to the live id_token', (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 — the fallback only runs under a subscription resolution
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ plan: 'plus', subscriptionType: 'plus' }),
    readBillingConfig: () => ({ source: 'subscription', plan: 'unknown', subscriptionType: null, rateLimitTier: null }),
    env: {},
  });
  assert.equal(f.subscription_plan, 'plus');
  assert.equal(f.subscription_type, 'plus');
});

test('a different live account cannot supply the billing account plan', () => {
  const fields = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => ({
      source: 'subscription', authType: 'chatgpt', plan: 'unknown', accountId: 'billing-account',
    }),
    readObservedPlan: () => null,
    env: {},
  });
  assert.equal(fields.account_uuid, 'billing-account');
  assert.equal(fields.subscription_plan, undefined);
});

test('a real plan on disk still wins over the live read', (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' }); // L1 — as above
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ plan: 'plus', subscriptionType: 'plus' }),
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro_20x', subscriptionType: 'pro_20x', rateLimitTier: null }),
    env: {},
  });
  assert.equal(f.subscription_plan, 'pro_20x');
});

// Under API-key billing the subscription plan is not a fact about how the work was paid for, so
// the live read must not smuggle one in behind the resolver's refusal to state it.
test('an api-key machine reports no plan even when auth.json still holds one', () => {
  // An exported key is what the process will actually bill against, so the resolver reports
  // api-key regardless of a leftover ChatGPT sign-in on disk.
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ plan: 'plus', subscriptionType: 'plus' }),
    readBillingConfig: () => ({ source: 'subscription', plan: 'unknown', subscriptionType: null, rateLimitTier: null }),
    env: { OPENAI_API_KEY: 'sk-live-not-a-real-key' },
  });
  assert.equal('subscription_plan' in f, false, 'the live plan must not smuggle past the resolver');
  assert.equal('subscription_type' in f, false);
});

// ─── the plan ladder: rung 2 is the plan the SERVER stamped on the rate-limit reading ─────────

const observed = (plan) => () => (plan == null ? null : { plan, observedAt: '2026-09-09T10:00:00.000Z' });

// Rung 2 sits ABOVE billing.json's captured plan because it needs no JWT parse, no signature we do
// not check, and no token freshness — it is a value the server already wrote into a log on disk.
test('the observed plan_type outranks the plan captured from the id_token', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => ({ source: 'subscription', plan: 'free', subscriptionType: 'free', rateLimitTier: null }),
    readObservedPlan: observed('plus'),
    env: {},
  });
  assert.equal(f.subscription_plan, 'plus');
  // The PAIR moves together: on Codex the subscription type IS the tier, so leaving billing.json's
  // 'free' beside the rollout's 'plus' would put two different tiers in one row.
  assert.equal(f.subscription_type, 'plus');
});

// The one way this rung ships broken. A tier the user typed by hand is unverifiable but final;
// billing-config.mjs:25-27 and session-start.mjs:221 both go out of their way to protect it.
test('a self-reported plan still beats the observed plan_type', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => ({
      source: 'subscription', plan: 'team', subscriptionType: 'team', rateLimitTier: null,
      selfReported: true,
    }),
    readObservedPlan: observed('plus'),
    env: {},
  });
  assert.equal(f.subscription_plan, 'team');
  assert.equal(f.subscription_type, 'team');
});

// The regression lock for the two rungs below: ~2/3 of observations name no plan, so a null must
// fall straight through and change nothing at all.
test('no observed plan leaves the existing two-rung fallback exactly as it was', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account({ plan: 'plus', subscriptionType: 'plus' }),
    readBillingConfig: () => ({ source: 'subscription', plan: 'unknown', subscriptionType: null, rateLimitTier: null }),
    readObservedPlan: observed(null),
    env: {},
  });
  assert.equal(f.subscription_plan, 'plus', 'the stale unknown still falls back to the id_token');
});

// The plan is only a fact about a SUBSCRIPTION. On a key-billed machine there is no tier to state,
// and rung 2 must not go around the resolver's refusal to state one.
test('the observed plan_type is not stamped onto an api-key machine', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => null,
    readObservedPlan: observed('plus'),
    env: { OPENAI_API_KEY: 'sk-live-not-a-real-key' },
  });
  assert.equal('subscription_plan' in f, false);
  assert.equal('subscription_type' in f, false);
});

// ─── the billing deps seam ────────────────────────────────────────────────────────────────────

// usageIdentityFields is handed the DRAIN's deps wholesale, and there `now` is a clock FUNCTION
// while resolveSource's `now` is an epoch NUMBER. Spread through, every `now - ms` freshness
// comparison goes NaN and a fresh API-key stamp is silently discarded — so the machine would report
// a subscription plan for work a key was paying for.
test('a clock function in deps never reaches the billing ladder as its epoch', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => ({
      source: 'subscription', plan: 'plus', subscriptionType: 'plus', rateLimitTier: null,
      apiKeyEvidenceAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
    readObservedPlan: observed('plus'),
    now: () => 0, // the drain's deadline clock, not an epoch
    env: {},
  });
  assert.equal('subscription_plan' in f, false, 'an hour-old api-key stamp is still fresh evidence');
  assert.equal('subscription_type' in f, false);
});

// The same call with a real epoch: the ladder does see it, so the field is threaded rather than
// simply thrown away.
test('an epoch now IS threaded, and an expired stamp stops vouching', () => {
  const f = usageIdentityFields({
    readChatgptAuth: () => account(),
    readBillingConfig: () => ({
      source: 'subscription', plan: 'plus', subscriptionType: 'plus', rateLimitTier: null,
      apiKeyEvidenceAt: '2026-09-01T00:00:00.000Z',
    }),
    now: Date.parse('2026-09-09T00:00:00.000Z'), // eight days on — the 24h evidence window lapsed
    env: {},
  });
  assert.equal(f.subscription_plan, 'plus');
});

// G-10-1 L1. Step 4 of the ladder used to open the REAL ~/.codex/auth.json even when every other
// resolver was injected; it is now answered from the account this function already read.
test('step 4 of the ladder is answered from the account already read, not a second file read', () => {
  const billing = { source: 'subscription', plan: 'plus', subscriptionType: 'plus', rateLimitTier: null };
  // No auth.json anywhere (the sandbox CODEX_HOME is empty) and no injected signals reader — the
  // resolution can only have come from the account object this function already had in hand.
  const chatgpt = usageIdentityFields({
    readChatgptAuth: () => account({ authMode: 'chatgpt' }),
    readBillingConfig: () => billing,
    env: {},
  });
  assert.equal(chatgpt.subscription_plan, 'plus');
  // auth_mode is null under a ChatGPT sign-in, so hasStoredApiKey is the only thing that can tell a
  // machine holding a key apart — and it is carried on the account for exactly that reason.
  const keyed = usageIdentityFields({
    readChatgptAuth: () => account({ authMode: null, hasStoredApiKey: true }),
    readBillingConfig: () => billing,
    env: {},
  });
  assert.equal('subscription_plan' in keyed, false, 'a stored key means no subscription to state');
});
