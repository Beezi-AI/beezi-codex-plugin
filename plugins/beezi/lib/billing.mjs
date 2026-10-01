import { orDefault } from './compat.mjs';

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
// THIRD_PARTY is not reachable from here.
export function detectBillingSource(env = process.env) {
  if (env.OPENAI_API_KEY) return BillingSource.OPENAI_API_KEY;
  return BillingSource.UNKNOWN;
}

// Proof, from this window's API errors, that the machine bills a pay-as-you-go key: only a
// prepaid balance can run out. Outranks a stale auth.json — an old ChatGPT login can linger on
// disk, but a quota error cannot fire unless a key is actually paying.
export function isApiKeyBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some((e) =>
    (e || {}).details === 'insufficient_quota' ||
    /exceeded your current quota|billing[ _]hard[ _]limit/i.test(orDefault((e || {}).text, '')));
}

// The Codex inverse, which the Claude engine has no counterpart for: hitting a *usage limit* is
// something only a ChatGPT subscription does. A key has no weekly window to exhaust.
export function isSubscriptionBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some((e) =>
    (e || {}).details === 'usage_limit_exceeded' ||
    /hit your usage limit/i.test(orDefault((e || {}).text, '')));
}

// The ChatGPT plan tiers the Beezi API prices under vendor `openai`. ONE list, imported by every
// normalizer that needs it.
//
// This was previously duplicated here and in chatgpt-auth.mjs, and `go` was missing from both: a
// ChatGPT Go machine normalized to 'unknown', so nothing was ever captured, the config never stopped
// being stale, and the "refresh your plan" nudge fired on every single session with no way for the
// user to end it. Two copies is how that happens — keep it at one.
//
// `pro` is absent on purpose: since the 2026-04-09 Pro split there is no single "Pro" seat to price
// (5× is $100, 20× is $200), so the bare word is only ever an input, never a label we emit.
export const CHATGPT_PLANS = Object.freeze([
  'free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu',
]);

// Codex's own plan vocabulary (`PlanType`, openai/codex app-server-protocol schema) folded onto the
// labels above. Codex reports tier names we do not price verbatim, and anything unmapped normalizes
// to 'unknown' — which is not a harmless default: it leaves billing.json permanently stale, so the
// "refresh your plan" nudge fires every session with no way for the user to end it. This table is
// what keeps the rest of the vocabulary out of that state.
//
// The Pro split (2026-04-09): the $200 tier kept the name `pro` and became 20×, and the new $100 5×
// tier ships as `prolite`. So plain `pro` means 20×, and it is folded to the explicit label rather
// than kept — one bucket per seat price, whichever plugin version reported it.
const CODEX_PLAN_ALIASES = Object.freeze({
  prolite: 'pro_5x',
  pro: 'pro_20x',
  self_serve_business_prolite: 'business',
  ent26: 'enterprise',
  enterprise_cbp_automation: 'enterprise',
  // Usage-based orgs pay per token, not per seat. `enterprise` is the API's no-published-seat-rate
  // tier, which values these rows at their token list cost instead of inventing a seat fee.
  self_serve_business_usage_based: 'enterprise',
  enterprise_cbp_usage_based: 'enterprise',
});

// A reported tier as one of CHATGPT_PLANS, or null when it is not a tier we price. Separate from
// normalizePlan because the self-report path has to tell "not a plan" from the plan named 'unknown'.
export function canonicalPlan(reported) {
  const type = String(orDefault(reported, '')).trim().toLowerCase();
  // hasOwn, not a bare lookup: `reported` is user/claim input, and Object.prototype keys like
  // `constructor` would otherwise resolve to something that is not a plan label at all.
  const label = Object.prototype.hasOwnProperty.call(CODEX_PLAN_ALIASES, type)
    ? CODEX_PLAN_ALIASES[type] : type;
  return CHATGPT_PLANS.includes(label) ? label : null;
}

// Normalize to a ChatGPT plan label. For Codex the subscriptionType already IS the plan tier.
export function normalizePlan(subscriptionType) {
  return orDefault(canonicalPlan(subscriptionType), 'unknown');
}
