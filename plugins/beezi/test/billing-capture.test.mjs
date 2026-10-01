// Imported first, and for its side effect as much as its exports: it redirects every root the
// plugin can resolve into a per-process sandbox and deletes OPENAI_API_KEY from process.env.
// See tools/hermetic-env.mjs for the three leak channels this file used to sit on top of.
import { withCodexAuth, underCodexAuth } from '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig, shouldKeepExisting, captureFromCodexAccount } from '../lib/billing-capture.mjs';
import { readCodexAuthSignals } from '../lib/chatgpt-auth.mjs';

// Force the subscription branch deterministically: a CODEX_HOME with no auth.json, so step 4 of
// the ladder (billing-config.mjs:110-118) has nothing to say and the selfReported declaration at
// step 5 decides. Closes L2 for the `plan:` call sites, which pass no deps to buildConfig and
// would otherwise read whatever ~/.codex/auth.json the author happens to have.
const withSubscriptionEnv = (fn) => underCodexAuth(null, fn);

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
  // L2: inside withSubscriptionEnv, because buildConfig gets no deps and would otherwise resolve
  // step 4 against the author's own ~/.codex/auth.json — three of these fail on an api-key machine.
  withSubscriptionEnv(() => {
    for (const plan of ['free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu']) {
      const cfg = buildConfig({ plan, via: 'login-user' }, {});
      assert.equal(cfg.plan, plan, `${plan} is accepted`);
      assert.equal(cfg.source, 'subscription');
      assert.equal(cfg.selfReported, true);
    }
  });
});

test('a self-reported tier named the way Codex names it is accepted, not rejected', () => {
  // The user reads their plan off ChatGPT, which still calls the $200 tier "Pro". Rejecting the
  // word they have in front of them captures nothing, which is the outcome this path exists to fix.
  withSubscriptionEnv(() => { // L2 — see above
    assert.equal(buildConfig({ plan: 'pro' }, {}).plan, 'pro_20x');
    assert.equal(buildConfig({ plan: 'prolite' }, {}).plan, 'pro_5x');
  });
});

test('free is offerable — the API prices it like any other tier', () => {
  // Was rejected while the API required a paid plan; that restriction is gone, and refusing the
  // tier the user actually has forced them into either lying or capturing nothing.
  withSubscriptionEnv(() => { // L2 — see above
    const cfg = buildConfig({ plan: 'free', via: 'login-user' }, {});
    assert.equal(cfg.plan, 'free');
    assert.equal(cfg.source, 'subscription');
  });
});

test('the rejection message lists every value the user may pick', () => {
  assert.throws(() => buildConfig({ plan: 'nope' }, {}), (e) => {
    for (const v of ['free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu', 'api_key']) {
      assert.match(e.message, new RegExp(v));
    }
    return true;
  });
});

// Tier 1 of the capture ladder is a SUBPROCESS (`codex app-server`). Every test below injects this
// instead of letting it run: an uninjected probe launches a real Codex against the developer's own
// ~/.codex, which tools/hermetic-env.mjs records as an escape. `unavailable` is the answer on a
// machine with no Codex CLI, so it is also the tier-2 path these tests are about.
const noProbe = async () => ({ ok: false, reason: 'unavailable' });

// captureFromCodexAccount is shared by the SessionStart hook and scripts/billing-capture.mjs. It
// exists because the expired-claim rule once lived in only one of them, and the nudge that rule
// produces sent the user straight to the caller that lacked it.
const account = (over = {}) => () => ({ authMode: 'chatgpt', subscriptionType: 'pro_20x', plan: 'pro_20x', expiresAt: null, ...over });

// Both tests below assert a SUBSCRIPTION outcome, which the ladder can only reach through step 4.
// `env: {}` closes L3 (captureFromCodexAccount's `env = process.env` default, billing-capture.mjs:135,
// which an exported OPENAI_API_KEY would win at step 1); withCodexAuth closes L1 (the un-threaded
// `deps` that makes step 4 open the real ~/.codex/auth.json). Both are needed — either alone
// still leaves the answer up to the machine the suite happens to run on.
test('captureFromCodexAccount records a valid claim as-is', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  const { config, reason } = await captureFromCodexAccount({ via: 'login', env: {}, deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account() } });
  assert.equal(reason, 'captured');
  assert.equal(config.plan, 'pro_20x');
  assert.equal(config.capturedBy, 'login');
});

test('captureFromCodexAccount keeps the expiry of an expired claim but not its plan label', async (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
  const { config, reason } = await captureFromCodexAccount({
    via: 'login',
    env: {},
    deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account({ subscriptionType: 'free', plan: 'free', expiresAt }) },
  });
  assert.equal(reason, 'expired-claim');
  assert.equal(config.plan, 'unknown', 'a six-week-stale "free" must not be believed');
  assert.equal(config.credentialsExpiresAt, expiresAt, 'the expiry is what makes it revisitable');
});

test('captureFromCodexAccount reports an absent account rather than writing one', async () => {
  assert.deepEqual(
    await captureFromCodexAccount({ via: 'login', deps: { readAccountViaAppServer: noProbe, readChatgptAuth: () => null } }),
    { config: null, reason: 'no-account', tier: 'none' },
  );
});

// ─── G-10-1: the deps seam, and the field that decides whether it ships broken ────────────────

// Step 4 of the ladder is now answered from the account already read, so nothing here opens a real
// ~/.codex/auth.json. `underCodexAuth(null, …)` proves it: there is no file to read at all.
test('the source ladder resolves from the account, with no auth.json on disk', async () => {
  await underCodexAuth(null, async () => {
    const { config } = await captureFromCodexAccount({
      via: 'login', env: {}, deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account() },
    });
    assert.equal(config.source, 'subscription');
    assert.equal(config.plan, 'pro_20x');
  });
});

// THE way this fix ships broken. auth_mode is null under a ChatGPT sign-in, so billing-config.mjs:118
// is genuinely reached with authMode === null; signals synthesized without `hasStoredApiKey` resolve
// a machine holding a stored key to `unknown`, and syncBillingSource writes that wrong source into
// billing.json. The two sides are asserted to agree, not just to be non-unknown.
test('a machine whose auth_mode is null resolves by its stored key, not to unknown', async () => {
  const auth = {
    auth_mode: null,
    OPENAI_API_KEY: 'sk-live-not-a-real-key',
    tokens: { id_token: 'header.not-decodable.sig' },
  };
  await underCodexAuth(auth, async () => {
    // From the account object (what captureFromCodexAccount synthesizes) …
    const fromAccount = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account({ authMode: null, hasStoredApiKey: true }) },
    });
    assert.equal(fromAccount.config.source, 'openai_api_key', 'not "unknown"');
    assert.equal(fromAccount.config.plan, null, 'a key bills per token — there is no tier to state');

    // … and from the real reader over the same file. They must agree.
    const fromFile = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readAccountViaAppServer: noProbe,
        readChatgptAuth: account({ authMode: null, hasStoredApiKey: true }),
        readCodexAuthSignals: readCodexAuthSignals,
      },
    });
    assert.equal(fromFile.config.source, fromAccount.config.source);
  });
});

// runSessionStart resolves the source once, then captures the plan. Before the seam was threaded
// the capture reached billing-capture.mjs's MODULE-LEVEL resolveSource, so the second, unseen
// resolution could contradict the first and drop the plan fields the first had just earned.
test('an injected resolveSource reaches the inner resolution too', async () => {
  await underCodexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }, async () => {
    const { config } = await captureFromCodexAccount({
      via: 'session-start',
      env: {},
      deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account(), resolveSource: () => 'subscription' },
    });
    assert.equal(config.source, 'subscription', 'the injected ladder decided, not the file on disk');
    assert.equal(config.plan, 'pro_20x');
  });
});

test('buildConfig threads its deps into both resolveSource call sites', () => {
  // The `--plan` branch (declaredSource) and the auto-capture branch, in that order.
  const declared = buildConfig({ plan: 'plus' }, {}, new Date(), null, { resolveSource: () => 'openai_api_key' });
  assert.equal(declared.source, 'openai_api_key');
  assert.equal(declared.plan, null, 'a declared subscription cannot outrank a live key');
  const captured = buildConfig({ subscriptionType: 'plus' }, {}, new Date(), null, { resolveSource: () => 'subscription' });
  assert.equal(captured.source, 'subscription');
  assert.equal(captured.plan, 'plus');
});

test('captureFromCodexAccount never overwrites a self-reported plan with unknown', async () => {
  const { config, reason } = await captureFromCodexAccount({
    via: 'refresh',
    existing: { source: 'subscription', plan: 'team', selfReported: true },
    deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account({ subscriptionType: null, plan: 'unknown' }) },
  });
  assert.equal(reason, 'kept-self-reported');
  assert.equal(config, null);
});

// ─── the three-tier ladder ────────────────────────────────────────────────────────────────────
// Tier 1 is `codex app-server`, tier 2 the ~/.codex/auth.json decode, tier 3 the user's own answer
// (skills/login/SKILL.md step 3, unchanged). These assert the seam between 1 and 2; tier 3 is
// reached only when neither names a plan, which is the `no-account` case above.

const liveProbe = (over = {}) => async () => ({
  ok: true,
  reason: 'ok',
  authType: 'chatgpt',
  plan: 'plus',
  subscriptionType: 'plus',
  accountId: 'live-uuid',
  email: 'live@example.com',
  ...over,
});

test('a live app-server answer outranks the auth.json decode', async () => {
  await underCodexAuth(null, async () => {
    const { config, tier } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: { readAccountViaAppServer: liveProbe(), readChatgptAuth: account() },
    });
    assert.equal(tier, 'app-server');
    assert.equal(config.plan, 'plus', 'the live reading, not the id_token claim');
    assert.equal(config.source, 'subscription');
  });
});

// THE way this ships broken. The expired-claim rule exists because auth.json is a snapshot that
// rots in place; a live lookup cannot rot. Applied to tier 1 it downgrades a correct plan to
// `unknown`, which leaves the config stale, which re-nudges the user every single session.
test('the expired-claim rule is not applied to a live reading', async () => {
  await underCodexAuth(null, async () => {
    const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
    const { config, reason } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readAccountViaAppServer: liveProbe(),
        // auth.json's own claim is six weeks expired — irrelevant once Codex itself answered.
        readChatgptAuth: account({ subscriptionType: 'free', plan: 'free', expiresAt }),
      },
    });
    assert.equal(reason, 'captured');
    assert.equal(config.plan, 'plus');
    assert.equal(config.credentialsExpiresAt, null, 'a live reading carries no expiry to go stale');
  });
});

test('a machine with no auth.json at all still captures a plan from the app server', async () => {
  await underCodexAuth(null, async () => {
    const { config, tier } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: { readAccountViaAppServer: liveProbe(), readChatgptAuth: () => null },
    });
    assert.equal(tier, 'app-server');
    assert.equal(config.source, 'subscription', 'the auth type is the only signal there is');
    assert.equal(config.plan, 'plus');
  });
});

test('the account id and address are persisted with the plan', async () => {
  await underCodexAuth(null, async () => {
    const { config } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: { readAccountViaAppServer: liveProbe(), readChatgptAuth: () => null },
    });
    // Without this the id would exist only for the one session that ran the probe — it runs at
    // most weekly, behind isStale().
    assert.equal(config.accountId, 'live-uuid');
    assert.equal(config.email, 'live@example.com');
  });
});

test('a capture that learns no identity keeps the one already recorded', async () => {
  await underCodexAuth(null, async () => {
    const existing = { version: 1, source: 'subscription', accountId: 'known-uuid', email: 'known@example.com' };
    const { config } = await captureFromCodexAccount({
      via: 'session-start',
      env: {},
      existing,
      deps: { readAccountViaAppServer: noProbe, readChatgptAuth: account({ accountId: null, email: null }) },
    });
    assert.equal(config.accountId, 'known-uuid');
    assert.equal(config.email, 'known@example.com');
  });
});

test('a self-reported plan does not erase the recorded identity', () => {
  withSubscriptionEnv(() => {
    const existing = { version: 1, accountId: 'known-uuid', email: 'known@example.com' };
    const cfg = buildConfig({ plan: 'team', via: 'login-user' }, {}, new Date(), existing);
    assert.equal(cfg.plan, 'team');
    assert.equal(cfg.accountId, 'known-uuid');
  });
});

test('an oversized account id is dropped, never truncated into another account', async () => {
  await underCodexAuth(null, async () => {
    const { config } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readAccountViaAppServer: liveProbe({ accountId: 'x'.repeat(65) }),
        readChatgptAuth: () => null,
      },
    });
    assert.equal(config.accountId, null);
  });
});

test('a probe that throws falls through to the auth.json tier instead of failing the capture', async () => {
  await underCodexAuth(null, async () => {
    const { config, tier } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readAccountViaAppServer: async () => { throw new Error('spawn exploded'); },
        readChatgptAuth: account(),
      },
    });
    assert.equal(tier, 'auth-json');
    assert.equal(config.plan, 'pro_20x');
  });
});

test('an app-server api-key machine captures no subscription plan', async () => {
  await underCodexAuth(null, async () => {
    const { config, reason } = await captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readAccountViaAppServer: liveProbe({ authType: 'apikey', plan: null, subscriptionType: null, email: null }),
        readChatgptAuth: () => null,
      },
    });
    assert.equal(reason, 'no-account', 'a key bills per token — there is no tier to state');
    assert.equal(config, null);
  });
});
