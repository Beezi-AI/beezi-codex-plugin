// First import, for the same module-load reason as test/paths.test.mjs: apiBase() now resolves
// through the frozen environment record, so BEEZI_ENV has to be gone before lib/config.mjs and its
// lib/paths.mjs import evaluate.
import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, apiOrigin, AGENT, ENDPOINTS, OAUTH_SCOPES } from '../lib/config.mjs';
import { ENV_API_BASE, environment } from '../lib/paths.mjs';

const PRODUCTION = 'https://beezi-api-prod.azurewebsites.net/api';

// Swap an env var for one test and put it back, whether or not it was set.
function withEnv(t, name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

test('apiBase defaults to the PRODUCTION API (G-1-2 cutover)', (t) => {
  // The cutover release. Staging was drift — the public plugin, mirrored to the public GitHub
  // repo, pointed customers at a staging API. All three R1 steps are in place: the readers and
  // namespace isolation (G-2-2), the staging variant that gives displaced installs a destination
  // (G-1-7), and the migration guard wired at every entry point (lib/env-guard.mjs), which is
  // what stops a staging queue and staging cursors being flushed to a production tenant.
  withEnv(t, 'BEEZI_API_URL', undefined);
  assert.equal(apiBase(), PRODUCTION);
});

test('BEEZI_API_URL overrides the default', (t) => {
  withEnv(t, 'BEEZI_API_URL', 'https://example.test/api');
  assert.equal(apiBase(), 'https://example.test/api');
});

// ── the three-rung precedence (G-1-2 reader half) ─────────────────────────────────────────────

test('the shipped build has no baked apiBase, so the release default answers', () => {
  assert.equal(environment.environmentError(), null);
  assert.equal(ENV_API_BASE, null);
});

test('precedence is BEEZI_API_URL → the variant\'s baked apiBase → the release default', () => {
  // apiBase() reads the first rung live and the second from the frozen environment record, so
  // the ordering itself is asserted through the resolver that produces that record.
  const variant = {
    present: true,
    value: { name: 'staging', apiBase: 'https://baked.test/api' },
  };
  const none = { present: false, value: {} };
  const pick = (envJson, env) => {
    const r = environment.resolveEnvironment({ envJson, env });
    assert.equal(r.error, undefined);
    return env.BEEZI_API_URL || r.apiBase || PRODUCTION;
  };
  assert.equal(pick(variant, { BEEZI_API_URL: 'https://override.test/api' }), 'https://override.test/api');
  assert.equal(pick(variant, {}), 'https://baked.test/api');
  assert.equal(pick(none, {}), PRODUCTION);
});

test('an unresolvable environment makes apiBase refuse rather than answer the default', () => {
  // "Resolve API and namespace together" (R1): the namespace assertion is the first thing
  // apiBase() does, so a variant whose metadata could not be read never quietly reports the
  // release default as its API. Proven here on the resolver — the wired-up throw is exercised in
  // a fresh child process in test/env-namespace.test.mjs, because the record is frozen at load.
  const broken = { present: true, value: {}, error: 'env.json is present but is not valid JSON' };
  assert.ok(environment.resolveEnvironment({ envJson: broken, env: {} }).error);
  assert.ok(environment.resolveEnvironment({ envJson: broken, env: { BEEZI_API_URL: 'https://x.test/api' } }).error);
});

test('apiOrigin drops the /api path', (t) => {
  // The OAuth discovery documents are mounted at the root, outside the /api prefix.
  withEnv(t, 'BEEZI_API_URL', undefined);
  assert.equal(apiOrigin(), 'https://beezi-api-prod.azurewebsites.net');
});

test('apiOrigin follows an overridden base', (t) => {
  withEnv(t, 'BEEZI_API_URL', 'https://example.test:8443/api/v2');
  assert.equal(apiOrigin(), 'https://example.test:8443');
});

test('the identity endpoints stay codex-scoped', () => {
  // Regression guard: the Claude Code plugin uses /me/claude-code/*. Sharing that surface would
  // attribute this machine and its analytics to the wrong client.
  assert.equal(ENDPOINTS.whoami, '/me/codex/whoami');
  assert.equal(ENDPOINTS.machine, '/me/codex/machine');
});

test('the account check-in route is vendor-generic, not codex-scoped', () => {
  // The server reads the vendor off X-Beezi-Agent, so both plugins share one account-row shape.
  // Scoping this to /me/codex/* would split that row in two.
  assert.equal(ENDPOINTS.accountSync, '/me/cli-agent/account');
});

test('the analytics endpoints are agent-neutral', () => {
  assert.equal(ENDPOINTS.sessionsReport, '/sessions/report');
  assert.equal(ENDPOINTS.sessionErrors, '/sessions/errors');
  assert.equal(ENDPOINTS.sessionsTimeline, '/sessions/timeline');
  assert.equal(ENDPOINTS.reposStatus, '/repos/status');
});

test('AGENT identifies this client as codex', () => {
  assert.equal(AGENT, 'codex');
  assert.equal(OAUTH_SCOPES, 'email profile');
});
