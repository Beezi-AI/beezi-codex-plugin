import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, apiOrigin, AGENT, ENDPOINTS, OAUTH_SCOPES } from '../lib/config.mjs';

const STAGING = 'https://beezi-api-staging.azurewebsites.net/api';

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

test('apiBase defaults to the staging API', (t) => {
  withEnv(t, 'BEEZI_API_URL', undefined);
  assert.equal(apiBase(), STAGING);
});

test('BEEZI_API_URL overrides the default', (t) => {
  withEnv(t, 'BEEZI_API_URL', 'https://example.test/api');
  assert.equal(apiBase(), 'https://example.test/api');
});

test('apiOrigin drops the /api path', (t) => {
  // The OAuth discovery documents are mounted at the root, outside the /api prefix.
  withEnv(t, 'BEEZI_API_URL', undefined);
  assert.equal(apiOrigin(), 'https://beezi-api-staging.azurewebsites.net');
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
