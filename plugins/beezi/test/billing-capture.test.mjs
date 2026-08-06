import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, buildConfig, shouldKeepExisting } from '../lib/billing-capture.mjs';

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
