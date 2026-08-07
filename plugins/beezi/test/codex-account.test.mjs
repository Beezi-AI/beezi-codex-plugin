import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCodexAccount,
  readCodexAuthMode,
  readCodexAuthSignals,
  normalizeCodexPlan,
} from '../lib/codex-account.mjs';

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.sig`;
}

function authFileWith(payload, authMode = 'chatgpt') {
  const id_token = jwt(payload);
  const content = JSON.stringify({ auth_mode: authMode, tokens: { id_token } });
  return { readFile: () => content, exists: () => true, authFile: '/fake/auth.json' };
}

const AUTH_CLAIM = 'https://api.openai.com/auth';

test('extracts the ChatGPT plan and subscription expiry from the id_token', () => {
  const deps = authFileWith({
    exp: 1893456000,
    [AUTH_CLAIM]: {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-07-20T10:39:54+00:00',
    },
  });
  const account = readCodexAccount(deps);
  assert.equal(account.plan, 'plus');
  assert.equal(account.subscriptionType, 'plus');
  assert.equal(account.authMode, 'chatgpt');
  assert.equal(account.expiresAt, Date.parse('2026-07-20T10:39:54+00:00'));
});

test('an unknown plan type normalizes to unknown with a null subscriptionType', () => {
  const deps = authFileWith({ [AUTH_CLAIM]: { chatgpt_plan_type: 'mystery' } });
  const account = readCodexAccount(deps);
  assert.equal(account.plan, 'unknown');
  assert.equal(account.subscriptionType, null);
});

test('falls back to token exp when no subscription window is present', () => {
  const deps = authFileWith({ exp: 1893456000, [AUTH_CLAIM]: { chatgpt_plan_type: 'pro' } });
  const account = readCodexAccount(deps);
  assert.equal(account.expiresAt, 1893456000 * 1000);
});

test('returns null when auth.json is absent', () => {
  const account = readCodexAccount({ exists: () => false });
  assert.equal(account, null);
});

test('readCodexAuthMode surfaces the auth mode', () => {
  const deps = authFileWith({ [AUTH_CLAIM]: { chatgpt_plan_type: 'plus' } }, 'apikey');
  assert.equal(readCodexAuthMode(deps), 'apikey');
});

test('normalizeCodexPlan maps known tiers and rejects the rest', () => {
  assert.equal(normalizeCodexPlan('Enterprise'), 'enterprise');
  assert.equal(normalizeCodexPlan('business'), 'business');
  assert.equal(normalizeCodexPlan(''), 'unknown');
  assert.equal(normalizeCodexPlan(null), 'unknown');
});

// ─── presence-only auth signals ───────────────────────────────────────────────────────────────

const signalsFrom = (obj) => ({
  readFile: () => JSON.stringify(obj),
  exists: () => true,
  authFile: '/fake/auth.json',
});

test('readCodexAuthSignals reports the auth mode and whether a key is stored', () => {
  // Real shape: auth.json carries a top-level OPENAI_API_KEY alongside auth_mode.
  const s = readCodexAuthSignals(signalsFrom({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-live-xyz' }));
  assert.equal(s.authMode, 'apikey');
  assert.equal(s.hasStoredApiKey, true);
});

test('a null stored key under a ChatGPT sign-in is not a key', () => {
  const s = readCodexAuthSignals(signalsFrom({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
  assert.equal(s.authMode, 'chatgpt');
  assert.equal(s.hasStoredApiKey, false);
});

test('an empty stored key is not a key', () => {
  assert.equal(readCodexAuthSignals(signalsFrom({ OPENAI_API_KEY: '' })).hasStoredApiKey, false);
});

test('an absent or unparseable auth.json yields no signals rather than throwing', () => {
  assert.deepEqual(readCodexAuthSignals({ exists: () => false }), { authMode: null, hasStoredApiKey: false });
  assert.deepEqual(
    readCodexAuthSignals({ exists: () => true, readFile: () => 'not json', authFile: '/x' }),
    { authMode: null, hasStoredApiKey: false },
  );
});

test('no key material or token ever leaves readCodexAuthSignals', () => {
  // The whole point of the presence-only contract: the billing ladder must never handle secrets.
  const s = readCodexAuthSignals(signalsFrom({
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'sk-live-SECRET',
    tokens: { id_token: 'jwt.SECRET.sig', access_token: 'at-SECRET', refresh_token: 'rt-SECRET' },
  }));
  assert.deepEqual(Object.keys(s).sort(), ['authMode', 'hasStoredApiKey']);
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);
});

test('normalizeCodexPlan knows every tier the API prices, including go', () => {
  for (const plan of ['free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu']) {
    assert.equal(normalizeCodexPlan(plan), plan);
    assert.equal(normalizeCodexPlan(plan.toUpperCase()), plan);
  }
  assert.equal(normalizeCodexPlan('max_20x'), 'unknown'); // an Anthropic tier, not a ChatGPT one
  assert.equal(normalizeCodexPlan(undefined), 'unknown');
});

// The whole Codex PlanType vocabulary, not just the tiers whose name we happened to reuse. Each
// value left unmapped is a machine that captures nothing and is nudged to "refresh your plan"
// forever — a $200 Pro 20× seat priced at nothing is the expensive case.
test('normalizeCodexPlan folds every Codex PlanType onto a priced tier', () => {
  assert.equal(normalizeCodexPlan('prolite'), 'pro_5x', 'the $100 Pro 5× tier');
  assert.equal(normalizeCodexPlan('pro'), 'pro_20x', 'bare `pro` has been 20× since 2026-04-09');
  assert.equal(normalizeCodexPlan('self_serve_business_prolite'), 'business');
  assert.equal(normalizeCodexPlan('self_serve_business_usage_based'), 'enterprise');
  assert.equal(normalizeCodexPlan('ent26'), 'enterprise');
  assert.equal(normalizeCodexPlan('enterprise_cbp_automation'), 'enterprise');
  assert.equal(normalizeCodexPlan('enterprise_cbp_usage_based'), 'enterprise');
});

test('a prototype key is not a plan', () => {
  // `chatgpt_plan_type` is claim input; a bare alias lookup would resolve these to a function.
  assert.equal(normalizeCodexPlan('constructor'), 'unknown');
  assert.equal(normalizeCodexPlan('__proto__'), 'unknown');
});

test('the account plan list and the normalizer share one source', async () => {
  // Two copies is how `go` came to be missing from both; assert they cannot drift again.
  const { CHATGPT_PLANS, normalizePlan } = await import('../lib/billing.mjs');
  for (const plan of CHATGPT_PLANS) {
    assert.equal(normalizeCodexPlan(plan), plan);
    assert.equal(normalizePlan(plan), plan);
  }
});
