// The billing-source vocabulary shared with the Beezi API. Defined once so a stray
// literal typo in a comparison can't silently misclassify.
//
// UNKNOWN is a real, reportable value, not a placeholder. A machine can genuinely expose no signal
// — no key in the environment, no readable ~/.codex/auth.json, nothing said at sign-in — and the
// honest answer there is "we don't know". Guessing SUBSCRIPTION instead stamped a possibly-stale
// plan onto sessions that were paying per token.
export const BillingSource = Object.freeze({
  THIRD_PARTY: 'third_party',
  OPENAI_API_KEY: 'openai_api_key',
  SUBSCRIPTION: 'subscription',
  UNKNOWN: 'unknown',
});

// Environment signals only — no disk. An explicit key in the environment is the one thing that
// overrides everything else, because it is what the process will actually use. Every other signal
// (auth.json, recorded error evidence, what the user told us) is weighed in resolveSource, where
// it can be ordered; keeping this function pure makes that ordering the single place it lives.
//
// Codex's third-party providers are configured in ~/.codex/config.toml, not the environment, so
// THIRD_PARTY is not reachable from here — see the note on detectThirdPartyProvider.
export function detectBillingSource(env = process.env) {
  if (env.OPENAI_API_KEY) return BillingSource.OPENAI_API_KEY;
  return BillingSource.UNKNOWN;
}

// Proof, from this window's API errors, that the machine bills a pay-as-you-go key: only a
// prepaid balance can run out. Outranks a stale auth.json — an old ChatGPT login can linger on
// disk, but a quota error cannot fire unless a key is actually paying.
export function isApiKeyBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some((e) =>
    e?.details === 'insufficient_quota' ||
    /exceeded your current quota|billing[ _]hard[ _]limit/i.test(e?.text ?? ''));
}

// The Codex inverse, which the Claude engine has no counterpart for: hitting a *usage limit* is
// something only a ChatGPT subscription does. A key has no weekly window to exhaust.
export function isSubscriptionBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some((e) =>
    e?.details === 'usage_limit_exceeded' ||
    /hit your usage limit/i.test(e?.text ?? ''));
}

// The specific third-party provider vocabulary shared with the Beezi API.
export const ThirdPartyProvider = Object.freeze({
  AZURE: 'azure',
  GATEWAY: 'gateway',
});

// Codex third-party providers live in config.toml, not the environment, so there is no reliable
// env signal to read here. Returns null (billing is sub or api-key). Kept for API symmetry.
export function detectThirdPartyProvider(/* env = process.env */) {
  return null;
}

// Normalize to a ChatGPT plan label. For Codex the subscriptionType already IS the plan tier
// (plus / pro / team / business / enterprise / free); rateLimitTier is unused (Codex exposes none)
// but kept in the signature for parity with the report/capture flow.
export function normalizePlan(subscriptionType /*, rateLimitTier */) {
  const type = String(subscriptionType ?? '').toLowerCase();
  const known = ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'];
  return known.includes(type) ? type : 'unknown';
}
