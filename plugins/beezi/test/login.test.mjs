import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performLogin, openBrowser } from '../lib/login.mjs';

// Enough of the flow to reach the browser step and past it, with nothing touching the network.
function loginDeps(overrides = {}) {
  return {
    getCredentials: async () => null,
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test' }),
    deleteCredentials: async () => {},
    discover: async () => ({
      authorizationEndpoint: 'https://auth.test/authorize',
      tokenEndpoint: 'https://auth.test/token',
      registrationEndpoint: 'https://auth.test/register',
    }),
    pkcePair: () => ({ verifier: 'v', challenge: 'c' }),
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:1234/callback',
      port: 1234,
      code: Promise.resolve('auth-code'),
      cancel: () => {},
    }),
    registerClient: async () => 'client-123',
    exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    setCredentials: async () => 'the OS keyring',
    whoami: async () => ({ valid: true, name: 'Dev Eloper', email: null }),
    openBrowser: async () => ({ ok: true }),
    ...overrides,
  };
}

test('login emits the authorize URL before it tries to open a browser', async () => {
  const steps = [];
  const order = [];
  await performLogin({
    onStep: (s) => { steps.push(s); order.push(`step:${s.type}`); },
    deps: loginDeps({ openBrowser: async () => { order.push('openBrowser'); return { ok: true }; } }),
  });
  assert.equal(order[0], 'step:authorize-url');
  assert.equal(order[1], 'openBrowser');
  assert.match(steps[0].url, /^https:\/\/auth\.test\/authorize\?/);
});

// The launcher used to be fire-and-forget with stdio ignored, so a sandboxed shell or a machine
// with no http association failed invisibly: no browser, no message, and — through the MCP tool —
// no URL either. The outcome now reaches the caller.
test('a launcher that fails is surfaced as a browser-failed step', async () => {
  const steps = [];
  const result = await performLogin({
    onStep: (s) => steps.push(s),
    deps: loginDeps({ openBrowser: async () => ({ ok: false, detail: 'no http association' }) }),
  });

  const failed = steps.find((s) => s.type === 'browser-failed');
  assert.ok(failed, 'no browser-failed step was emitted');
  assert.equal(failed.detail, 'no http association');
  assert.match(failed.url, /^https:\/\/auth\.test\/authorize\?/);
  // The sign-in itself still completes — the user can open the URL by hand.
  assert.equal(result.type, 'linked');
  assert.equal(result.account, 'Dev Eloper');
});

test('an openBrowser that resolves ok emits no browser-failed step', async () => {
  const steps = [];
  await performLogin({ onStep: (s) => steps.push(s), deps: loginDeps() });
  assert.equal(steps.find((s) => s.type === 'browser-failed'), undefined);
});

// whoami is a display-name lookup that runs *after* the credentials are stored. It must never be
// able to fail the login — that is what stranded a completed sign-in behind a pending request.
test('a whoami that fails still yields a linked result', async () => {
  const result = await performLogin({
    deps: loginDeps({ whoami: async () => { throw new Error('unreachable'); } }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(result.account, null);
});

test('openBrowser refuses a non-http(s) URL instead of handing it to a shell', async () => {
  const result = await openBrowser('file:///c:/windows/system32/calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.detail, /non-http/);
});

test('openBrowser reports a launcher it cannot start', { skip: process.platform !== 'win32' }, async (t) => {
  // Point the launcher at a directory that holds no powershell.exe: the spawn fails, and the
  // caller has to learn about it rather than believing a browser opened.
  const prev = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\beezi-no-such-root';
  t.after(() => {
    if (prev === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prev;
  });

  const result = await openBrowser('https://auth.test/authorize?x=1');
  assert.equal(result.ok, false);
  assert.ok(result.detail, 'the failure carries a reason');
});
