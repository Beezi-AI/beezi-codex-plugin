import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHATGPT_PLANS } from '../lib/billing.mjs';
import {
  TIER_CHOICES, capturePlan, parseLinkedAccounts, pickAccount, planSettled, signIn,
} from '../lib/setup-wizard.mjs';
import { failed, fakeCtx, ok } from '../tools/setup-fixtures.mjs';

const KEY = 'a1b2c3d4';
const OTHER = '99887766';
const LIST = [
  'Beezi: 3 accounts linked. The default is the account the analytics skill reads from.',
  `  1. Ann <ann@example.com> - Acme [${OTHER}]`,
  `  2. Bob [ops] <bob@example.com> - Beta [${KEY}]  (default)`,
  '  3. old@example.com [0badc0de]  (revoked)',
].join('\n');
const CAPTURE = `billing-capture.mjs --from-codex --via login --account ${KEY}`;
const captured = (source, plan, via = ' via=app-server') => `✓ Beezi billing captured: source=${source} plan=${plan}${via}.`;

test('parseLinkedAccounts reads each row with its key and marks and skips every other line', () => {
  assert.deepEqual(parseLinkedAccounts(`Beezi: this machine's data moved.\n${LIST}\n`), [
    { description: 'Ann <ann@example.com> - Acme', key: OTHER, isDefault: false, revoked: false },
    { description: 'Bob [ops] <bob@example.com> - Beta', key: KEY, isDefault: true, revoked: false },
    { description: 'old@example.com', key: '0badc0de', isDefault: false, revoked: true },
  ]);
  assert.deepEqual(parseLinkedAccounts(`  1. Cy - Gamma [${KEY}]  (default, revoked)\r\n`), [
    { description: 'Cy - Gamma', key: KEY, isDefault: true, revoked: true },
  ]);
  assert.deepEqual(parseLinkedAccounts('No Beezi accounts are linked on this machine.\n'), []);
});

test('pickAccount signs in when no usable account is linked, and reports a failing list first', async () => {
  for (const listing of [
    ok('No Beezi accounts are linked on this machine.\n'),
    ok('  1. old@example.com [0badc0de]  (revoked)\n'),
  ]) {
    const ctx = fakeCtx({ 'accounts.mjs list': listing }, []);
    assert.equal(await pickAccount(ctx), null);
    assert.equal(ctx.asked.length, 0);
    assert.deepEqual(ctx.printed, []);
  }
  const migrating = "✗ Beezi is migrating this machine's data to the production namespace. Try again in a moment.";
  const ctx = fakeCtx({ 'accounts.mjs list': failed(`${migrating}\n`) }, []);
  assert.equal(await pickAccount(ctx), null);
  assert.deepEqual(ctx.printed, [migrating]);
});

test('pickAccount offers the analytics default first and preselected, then the other usable accounts, then Link another account', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': ok(LIST) }, [0]);
  assert.equal(await pickAccount(ctx), KEY);
  assert.deepEqual(ctx.runs, ['accounts.mjs list']);
  assert.equal(ctx.asked[0].question, 'This machine is already linked to Beezi. Which account should setup use?');
  assert.deepEqual(ctx.asked[0].options, [
    { label: 'Continue with Bob [ops] <bob@example.com> - Beta', description: 'Keep this account; no browser sign-in' },
    { label: 'Continue with Ann <ann@example.com> - Acme', description: 'Keep this account; no browser sign-in' },
    { label: 'Link another account', description: 'Sign in through your browser' },
  ]);
  assert.equal(ctx.asked[0].defaultIndex, 0);
});

test('pickAccount returns the picked account, null for Link another account, and false on a dismissal', async () => {
  const listing = { 'accounts.mjs list': ok(LIST) };
  assert.equal(await pickAccount(fakeCtx(listing, [0])), KEY);
  assert.equal(await pickAccount(fakeCtx(listing, [1])), OTHER);
  assert.equal(await pickAccount(fakeCtx(listing, [2])), null);
  assert.equal(await pickAccount(fakeCtx(listing, [null])), false);
  const noDefault = fakeCtx({ 'accounts.mjs list': ok(`  1. Ann [${OTHER}]\n  2. Bob [${KEY}]\n`) }, [0]);
  assert.equal(await pickAccount(noDefault), OTHER);
  assert.equal(noDefault.asked[0].defaultIndex, 0);
});

test('signIn streams login.mjs, hides its key line and takes the last key', async () => {
  const ctx = fakeCtx({
    'login.mjs': ok(`✓ Beezi analytics linked as Ann. Credentials stored in the macOS keychain.\naccount=${OTHER}\naccount=${KEY}\n`),
  }, []);
  const result = await signIn(ctx);
  assert.equal(result.key, KEY);
  assert.match(result.output, /linked as Ann/);
  assert.deepEqual(ctx.runs, ['login.mjs']);
  assert.deepEqual(ctx.opts['login.mjs'], { stream: true, hide: /^account=/ });
  assert.deepEqual(ctx.printed, []);
});

test('signIn has no key after a failed exit, a refusal, or output without a well-formed key line', async () => {
  const outcomes = [
    { code: 1, stdout: 'Opening your browser to sign in with your Beezi account…\n', stderr: '\n✗ Could not reach the Beezi server. Check your internet connection and try again.\n' },
    { code: 1, stdout: '', stderr: '\n✗ The login server took too long to respond. Check BEEZI_API_URL, then try again.\n' },
    failed("✗ Beezi is migrating this machine's data to the production namespace. Try again in a moment.\n"),
    { code: 1, stdout: `account=${KEY}\n`, stderr: '' },
    ok('✓ Beezi analytics linked as Ann. Credentials stored in the macOS keychain.\n'),
    ok('account=K1\n'),
  ];
  for (const outcome of outcomes) {
    const ctx = fakeCtx({ 'login.mjs': outcome }, []);
    assert.equal((await signIn(ctx)).key, null);
    assert.deepEqual(ctx.printed, []);
  }
});

test('planSettled accepts a priced plan or a non-subscription source and nothing else', () => {
  for (const plan of CHATGPT_PLANS) assert.equal(planSettled(captured('subscription', plan)), true, plan);
  assert.equal(planSettled(captured('subscription', 'plus', '')), true);
  assert.equal(planSettled(captured('openai_api_key', 'n/a', ' via=auth-json')), true);
  assert.equal(planSettled(captured('third_party', 'n/a')), true);
  assert.equal(planSettled(captured('subscription', 'unknown')), false);
  assert.equal(planSettled(captured('unknown', 'n/a')), false);
  assert.equal(planSettled('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.'), false);
  assert.equal(planSettled('Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.'), false);
  assert.equal(planSettled(''), false);
});

test('capturePlan prints the capture line and asks nothing once the plan is settled', async () => {
  for (const line of [captured('subscription', 'pro_5x'), captured('openai_api_key', 'n/a', ' via=auth-json'), captured('third_party', 'n/a')]) {
    const ctx = fakeCtx({ [CAPTURE]: ok(`${line}\n`) }, []);
    await capturePlan(ctx, KEY);
    assert.deepEqual(ctx.runs, [CAPTURE]);
    assert.deepEqual(ctx.printed, [line]);
    assert.equal(ctx.asked.length, 0);
  }
});

test('capturePlan sends an expired Codex sign-in to codex login instead of asking the tier', async () => {
  const expired = 'Beezi: your Codex sign-in expired on 2026-09-30, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.';
  const ctx = fakeCtx({ [CAPTURE]: ok(`${expired}\n`) }, []);
  await capturePlan(ctx, KEY);
  assert.deepEqual(ctx.printed, [expired, 'Run `codex login`, then run this installer again.']);
  assert.equal(ctx.asked.length, 0);
  assert.deepEqual(ctx.runs, [CAPTURE]);
});

test("capturePlan asks the ChatGPT tier with the login skill's ten choices and records the answer once", async () => {
  const PLAN = `billing-capture.mjs --plan pro_20x --via login-user --account ${KEY}`;
  const ctx = fakeCtx({
    [CAPTURE]: ok('Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.\n'),
    [PLAN]: ok('✓ Beezi billing captured: source=subscription plan=pro_20x.\n'),
  }, [3]);
  await capturePlan(ctx, KEY);
  assert.equal(ctx.asked[0].question, 'How does this machine pay for Codex?');
  assert.deepEqual(ctx.asked[0].options.map((o) => o.label), [
    'ChatGPT Free', 'ChatGPT Plus', 'ChatGPT Pro — $100/mo (5× Plus usage)', 'ChatGPT Pro — $200/mo (20× Plus usage)',
    'ChatGPT Go', 'ChatGPT Team', 'ChatGPT Business', 'ChatGPT Enterprise', 'ChatGPT Edu',
    'An OpenAI API key (no ChatGPT subscription)',
  ]);
  assert.equal(ctx.asked[0].defaultIndex, undefined);
  assert.deepEqual(ctx.runs, [CAPTURE, PLAN]);
  assert.deepEqual(ctx.printed, [
    'Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.',
    '✓ Beezi billing captured: source=subscription plan=pro_20x.',
  ]);
});

test('the tier values are every self-reportable plan, then api_key', () => {
  assert.deepEqual(TIER_CHOICES.map((choice) => choice.value), [...CHATGPT_PLANS, 'api_key']);
});

test('capturePlan asks the tier after an unknown plan or a failed capture, and records nothing when dismissed', async () => {
  for (const first of [ok(`${captured('subscription', 'unknown')}\n`), failed('✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n')]) {
    const ctx = fakeCtx({ [CAPTURE]: first }, [null]);
    await capturePlan(ctx, KEY);
    assert.equal(ctx.asked.length, 1);
    assert.deepEqual(ctx.runs, [CAPTURE]);
    assert.equal(ctx.printed.length, 2);
    assert.equal(ctx.printed[1], 'No plan was saved. Your Beezi link itself already succeeded.');
  }
});
