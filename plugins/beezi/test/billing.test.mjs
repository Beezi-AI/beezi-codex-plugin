import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingSource,
  detectBillingSource,
  normalizePlan,
  isApiKeyBillingEvidence,
  isSubscriptionBillingEvidence,
} from '../lib/billing.mjs';

// detectBillingSource reads the ENVIRONMENT only. The disk signals (auth.json) and recorded error
// evidence are weighed in resolveSource — see billing-config.test.mjs — so that the precedence
// between them lives in exactly one place.

test('an explicit OPENAI_API_KEY env means api-key billing', () => {
  assert.equal(detectBillingSource({ OPENAI_API_KEY: 'sk-x' }), BillingSource.OPENAI_API_KEY);
});

test('no environment signal yields unknown, never a guessed subscription', () => {
  // The headline regression guard. Defaulting to SUBSCRIPTION stamped a possibly-stale plan onto
  // sessions that were actually paying per token.
  assert.equal(detectBillingSource({}), BillingSource.UNKNOWN);
});

test('an empty OPENAI_API_KEY is not a signal', () => {
  assert.equal(detectBillingSource({ OPENAI_API_KEY: '' }), BillingSource.UNKNOWN);
});

test('normalizePlan maps ChatGPT tiers and rejects unknowns', () => {
  assert.equal(normalizePlan('plus'), 'plus');
  assert.equal(normalizePlan('Team'), 'team');
  assert.equal(normalizePlan('enterprise'), 'enterprise');
  assert.equal(normalizePlan('mystery'), 'unknown');
  assert.equal(normalizePlan(null), 'unknown');
});

test('a quota failure is proof of api-key billing', () => {
  assert.equal(isApiKeyBillingEvidence([{ details: 'insufficient_quota' }]), true);
  assert.equal(isApiKeyBillingEvidence([{ text: 'You exceeded your current quota' }]), true);
  assert.equal(isApiKeyBillingEvidence([{ details: 'usage_limit_exceeded' }]), false);
  assert.equal(isApiKeyBillingEvidence([]), false);
});

test('a usage-limit failure is proof of subscription billing', () => {
  // The Codex inverse of the credit-balance signal: only a ChatGPT plan has a window to exhaust.
  assert.equal(isSubscriptionBillingEvidence([{ details: 'usage_limit_exceeded' }]), true);
  assert.equal(isSubscriptionBillingEvidence([{ text: "You've hit your usage limit." }]), true);
  assert.equal(isSubscriptionBillingEvidence([{ details: 'insufficient_quota' }]), false);
  assert.equal(isSubscriptionBillingEvidence([]), false);
});

test('malformed error events are not mistaken for evidence', () => {
  const junk = [null, undefined, {}, { details: null, text: null }];
  assert.equal(isApiKeyBillingEvidence(junk), false);
  assert.equal(isSubscriptionBillingEvidence(junk), false);
});
