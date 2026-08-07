import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, buildConfig, shouldKeepExisting, captureFromCodexAccount } from '../lib/billing-capture.mjs';

// Force the subscription branch deterministically: no OPENAI_API_KEY and a CODEX_HOME with no
// auth.json (readCodexAuthMode → null → subscription).
function withSubscriptionEnv(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codexhome-'));
  process.env.CODEX_HOME = dir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

test('parseArgs reads --from-codex and flags', () => {
  assert.deepEqual(parseArgs(['--from-codex', '--via', 'login']), { fromCodex: true, via: 'login' });
});

test('--from-codex and --plan are mutually exclusive', () => {
  assert.throws(() => parseArgs(['--from-codex', '--plan', 'pro']), /mutually exclusive/);
});

test('a self-reported plan builds a subscription config', () => {
  withSubscriptionEnv(() => {
    const cfg = buildConfig({ plan: 'plus', via: 'login-user' }, {}, new Date('2026-01-01T00:00:00Z'));
    assert.equal(cfg.source, 'subscription');
    assert.equal(cfg.plan, 'plus');
    assert.equal(cfg.subscriptionType, 'plus');
    assert.equal(cfg.selfReported, true);
    assert.equal(cfg.capturedBy, 'login-user');
  });
});

test('an unknown self-reported plan is rejected', () => {
  assert.throws(() => buildConfig({ plan: 'ultra' }, {}), /Unknown plan/);
});

test('api-key billing carries no plan', () => {
  const cfg = buildConfig({ plan: 'plus' }, { OPENAI_API_KEY: 'sk-x' });
  assert.equal(cfg.source, 'openai_api_key');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
});

test('shouldKeepExisting protects a self-reported plan from an unknown re-capture', () => {
  const fresh = { plan: 'unknown' };
  const existing = { plan: 'pro', selfReported: true };
  assert.equal(shouldKeepExisting(fresh, existing), true);
  assert.equal(shouldKeepExisting({ plan: 'team' }, existing), false);
});

test('every ChatGPT tier the API prices can be self-reported', () => {
  // The list used to stop at `enterprise`, so a Go or Edu user picking their real tier hit
  // "Unknown plan" and captured nothing — worse than not asking them at all.
  for (const plan of ['plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu']) {
    const cfg = buildConfig({ plan, via: 'login-user' }, {});
    assert.equal(cfg.plan, plan, `${plan} is accepted`);
    assert.equal(cfg.source, 'subscription');
    assert.equal(cfg.selfReported, true);
  }
});

test('a self-reported tier named the way Codex names it is accepted, not rejected', () => {
  // The user reads their plan off ChatGPT, which still calls the $200 tier "Pro". Rejecting the
  // word they have in front of them captures nothing, which is the outcome this path exists to fix.
  assert.equal(buildConfig({ plan: 'pro' }, {}).plan, 'pro_20x');
  assert.equal(buildConfig({ plan: 'prolite' }, {}).plan, 'pro_5x');
});

test('free is deliberately not offerable — Codex needs a paid tier', () => {
  assert.throws(() => buildConfig({ plan: 'free' }, {}), /Unknown plan/);
});

test('the rejection message lists every value the user may pick', () => {
  assert.throws(() => buildConfig({ plan: 'nope' }, {}), (e) => {
    for (const v of ['plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu', 'api_key']) {
      assert.match(e.message, new RegExp(v));
    }
    return true;
  });
});

// captureFromCodexAccount is shared by the SessionStart hook and scripts/billing-capture.mjs. It
// exists because the expired-claim rule once lived in only one of them, and the nudge that rule
// produces sent the user straight to the caller that lacked it.
const account = (over = {}) => () => ({ authMode: 'chatgpt', subscriptionType: 'pro_20x', plan: 'pro_20x', expiresAt: null, ...over });

test('captureFromCodexAccount records a valid claim as-is', () => {
  const { config, reason } = captureFromCodexAccount({ via: 'login', deps: { readCodexAccount: account() } });
  assert.equal(reason, 'captured');
  assert.equal(config.plan, 'pro_20x');
  assert.equal(config.capturedBy, 'login');
});

test('captureFromCodexAccount keeps the expiry of an expired claim but not its plan label', () => {
  const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
  const { config, reason } = captureFromCodexAccount({
    via: 'login',
    deps: { readCodexAccount: account({ subscriptionType: 'free', plan: 'free', expiresAt }) },
  });
  assert.equal(reason, 'expired-claim');
  assert.equal(config.plan, 'unknown', 'a six-week-stale "free" must not be believed');
  assert.equal(config.credentialsExpiresAt, expiresAt, 'the expiry is what makes it revisitable');
});

test('captureFromCodexAccount reports an absent account rather than writing one', () => {
  assert.deepEqual(
    captureFromCodexAccount({ via: 'login', deps: { readCodexAccount: () => null } }),
    { config: null, reason: 'no-account' },
  );
});

test('captureFromCodexAccount never overwrites a self-reported plan with unknown', () => {
  const { config, reason } = captureFromCodexAccount({
    via: 'refresh',
    existing: { source: 'subscription', plan: 'team', selfReported: true },
    deps: { readCodexAccount: account({ subscriptionType: null, plan: 'unknown' }) },
  });
  assert.equal(reason, 'kept-self-reported');
  assert.equal(config, null);
});
