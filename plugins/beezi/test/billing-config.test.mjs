import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readBillingConfig,
  writeBillingConfig,
  isStale,
  subscriptionReportFields,
  resolveSource,
  resolveBilling,
  syncBillingSource,
  hasFreshApiKeyEvidence,
  hasFreshSubscriptionEvidence,
  recordApiKeyEvidence,
  recordSubscriptionEvidence,
} from '../lib/billing-config.mjs';
import { BillingSource } from '../lib/billing.mjs';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-billing-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME; else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('write then read round-trips the config', () => {
  withTempHome(() => {
    const cfg = { version: 1, source: 'subscription', plan: 'max_5x' };
    writeBillingConfig(cfg);
    assert.deepEqual(readBillingConfig(), cfg);
  });
});

test('readBillingConfig returns null when absent', () => {
  withTempHome(() => assert.equal(readBillingConfig(), null));
});

const DAY = 24 * 60 * 60 * 1000;

test('isStale — false for non-subscription source', () => {
  assert.equal(isStale({ source: 'anthropic_api_key' }), false);
});

test('isStale — true when plan missing or unknown', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', capturedAt: new Date(now).toISOString() }, now), true);
});

test('isStale — true when credentials expired', () => {
  const now = 1_000_000_000_000;
  const cfg = { source: 'subscription', plan: 'pro', credentialsExpiresAt: now - 1, capturedAt: new Date(now).toISOString() };
  assert.equal(isStale(cfg, now), true);
});

test('isStale — true when older than the window, false when fresh', () => {
  const now = 1_000_000_000_000;
  const fresh = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 1 * DAY).toISOString() };
  const old = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 8 * DAY).toISOString() };
  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
});

test('subscriptionReportFields — populated for subscription, empty otherwise', () => {
  const cfg = { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', plan: 'max_5x' };
  assert.deepEqual(subscriptionReportFields('subscription', cfg), {
    subscription_type: 'pro',
    rate_limit_tier: 'default_claude_max_5x',
    subscription_plan: 'max_5x',
  });
  assert.deepEqual(subscriptionReportFields('anthropic_api_key', cfg), {});
  assert.deepEqual(subscriptionReportFields('subscription', null), {});
});

test('isStale — self-reported plan never goes stale by age or credential expiry', () => {
  const now = 1_000_000_000_000;
  const old = {
    source: 'subscription',
    plan: 'max_20x',
    selfReported: true,
    credentialsExpiresAt: now - 1,
    capturedAt: new Date(now - 400 * DAY).toISOString(),
  };
  assert.equal(isStale(old, now), false);
});

test('isStale — self-reported config with missing or unknown plan is still stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
});

// ─── the billing-source ladder ────────────────────────────────────────────────────────────────
// One resolution shared by the session-start hook and every checkpoint, so the two can never
// disagree about what this machine bills.

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const stamp = (msAgo) => new Date(NOW - msAgo).toISOString();
const signals = (authMode, hasStoredApiKey = false) => ({
  readCodexAuthSignals: () => ({ authMode, hasStoredApiKey }),
  now: NOW,
});
const blind = signals(null); // a machine exposing nothing on disk

test('rung 1 — an exported key wins over everything on disk', () => {
  const cfg = { subscriptionEvidenceAt: stamp(0), selfReported: true, source: BillingSource.SUBSCRIPTION };
  assert.equal(
    resolveSource(cfg, { OPENAI_API_KEY: 'sk-x' }, signals('chatgpt')),
    BillingSource.OPENAI_API_KEY,
  );
});

test('rung 2/3 — a recent error outranks a stale auth.json', () => {
  // An old ChatGPT login lingers on disk; a quota error cannot fire unless a key is paying.
  assert.equal(
    resolveSource({ apiKeyEvidenceAt: stamp(HOUR) }, {}, signals('chatgpt')),
    BillingSource.OPENAI_API_KEY,
  );
  assert.equal(
    resolveSource({ subscriptionEvidenceAt: stamp(HOUR) }, {}, signals('apikey')),
    BillingSource.SUBSCRIPTION,
  );
});

test('evidence older than a day stops counting', () => {
  assert.equal(
    resolveSource({ apiKeyEvidenceAt: stamp(25 * HOUR) }, {}, signals('chatgpt')),
    BillingSource.SUBSCRIPTION,
  );
});

test('a stamp from the future is not evidence', () => {
  // Guards a clock that jumped backwards.
  assert.equal(hasFreshApiKeyEvidence({ apiKeyEvidenceAt: stamp(-HOUR) }, NOW), false);
  assert.equal(hasFreshSubscriptionEvidence({ subscriptionEvidenceAt: stamp(-HOUR) }, NOW), false);
});

test('rung 4 — auth_mode decides, and outranks a merely-present key', () => {
  assert.equal(resolveSource(null, {}, signals('apikey')), BillingSource.OPENAI_API_KEY);
  assert.equal(resolveSource(null, {}, signals('chatgpt')), BillingSource.SUBSCRIPTION);
  // A leftover key with a ChatGPT sign-in bills the subscription: auth_mode is the field Codex
  // itself uses to pick a credential.
  assert.equal(resolveSource(null, {}, signals('chatgpt', true)), BillingSource.SUBSCRIPTION);
  // With no auth_mode at all (older build), key presence is the remaining signal.
  assert.equal(resolveSource(null, {}, signals(null, true)), BillingSource.OPENAI_API_KEY);
});

test('rung 5 — a self-report is used only when nothing observable exists', () => {
  const declared = { selfReported: true, source: BillingSource.OPENAI_API_KEY };
  assert.equal(resolveSource(declared, {}, blind), BillingSource.OPENAI_API_KEY);
  // ...and is overruled the moment the machine shows a real signal.
  assert.equal(resolveSource(declared, {}, signals('chatgpt')), BillingSource.SUBSCRIPTION);
});

test('a recorded source that was NOT self-reported is never an input', () => {
  // billing.json's `source` records the last resolution; treating it as evidence would let a
  // switch made outside our sight keep asserting itself forever.
  const cfg = { source: BillingSource.SUBSCRIPTION, selfReported: false };
  assert.equal(resolveSource(cfg, {}, blind), BillingSource.UNKNOWN);
});

test('rung 6 — a machine with no signal at all reports unknown', () => {
  assert.equal(resolveSource(null, {}, blind), BillingSource.UNKNOWN);
});

test('an unreadable auth.json degrades to unknown instead of throwing', () => {
  const throwing = { readCodexAuthSignals: () => { throw new Error('EACCES'); }, now: NOW };
  assert.equal(resolveSource(null, {}, throwing), BillingSource.UNKNOWN);
});

test('resolveBilling carries the plan fields only for a subscription', () => {
  const cfg = { subscriptionType: 'plus', rateLimitTier: null, plan: 'plus' };
  assert.deepEqual(resolveBilling(cfg, {}, signals('chatgpt')), {
    billing_source: 'subscription',
    subscription_type: 'plus',
    rate_limit_tier: null,
    subscription_plan: 'plus',
  });
  assert.deepEqual(resolveBilling(cfg, { OPENAI_API_KEY: 'sk-x' }, signals('chatgpt')), {
    billing_source: 'openai_api_key',
  });
  assert.deepEqual(resolveBilling(cfg, {}, blind), { billing_source: 'unknown' });
});

test('recording evidence is idempotent inside the window', () => {
  const at = new Date(NOW);
  const first = recordApiKeyEvidence(null, at);
  assert.equal(first.version, 1);
  assert.equal(first.apiKeyEvidenceAt, at.toISOString());
  assert.equal(recordApiKeyEvidence(first, at), null, 'a fresh stamp is not rewritten');
  // ...but a lapsed one is renewed.
  const later = new Date(NOW + 25 * HOUR);
  assert.ok(recordApiKeyEvidence(first, later));
});

test('recording evidence preserves the plan detail already captured', () => {
  const cfg = { version: 1, source: 'subscription', plan: 'plus', capturedAt: stamp(HOUR) };
  const next = recordSubscriptionEvidence(cfg, new Date(NOW));
  assert.equal(next.plan, 'plus');
  assert.equal(next.capturedAt, cfg.capturedAt);
  assert.equal(next.subscriptionEvidenceAt, new Date(NOW).toISOString());
});

test('syncBillingSource realigns the recorded source without disturbing the plan', () => {
  const cfg = { version: 1, source: 'subscription', plan: 'plus', capturedAt: stamp(HOUR) };
  const synced = syncBillingSource(cfg, BillingSource.OPENAI_API_KEY);
  assert.equal(synced.source, 'openai_api_key');
  assert.equal(synced.plan, 'plus');
  // capturedAt tracks when the PLAN was captured; bumping it here would hide a plan going stale.
  assert.equal(synced.capturedAt, cfg.capturedAt);
});

test('syncBillingSource is a no-op when the source already agrees', () => {
  const cfg = { version: 1, source: 'subscription', plan: 'plus' };
  assert.equal(syncBillingSource(cfg, BillingSource.SUBSCRIPTION), null);
});

test('syncBillingSource seeds a config on a machine that never captured a plan', () => {
  assert.deepEqual(syncBillingSource(null, BillingSource.UNKNOWN), { version: 1, source: 'unknown' });
});
