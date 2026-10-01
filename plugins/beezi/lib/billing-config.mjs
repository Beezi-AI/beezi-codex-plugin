import { billingConfigFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import {
  BillingSource,
  detectBillingSource as detectBillingSourceFromEnv,
} from './billing.mjs';
import { readCodexAuthSignals } from './chatgpt-auth.mjs';
import { orDefault, parseTimestampMs } from './compat.mjs';

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // refresh plan info at least weekly

export function readBillingConfig() {
  return readJson(billingConfigFile());
}

export function writeBillingConfig(obj) {
  writeJsonSecure(billingConfigFile(), obj);
}

// Stale only matters for subscription billing: env-based sources carry no plan.
export function isStale(config, now = Date.now(), staleMs = STALE_MS) {
  if (!config || config.source !== BillingSource.SUBSCRIPTION) return false;
  if (!config.plan || config.plan === 'unknown') return true;
  // A self-reported plan can never be re-resolved automatically, so age must not
  // invalidate it; the user signs in again when their tier changes.
  if (config.selfReported) return false;
  if (typeof config.credentialsExpiresAt === 'number' && config.credentialsExpiresAt <= now) return true;
  const capturedAt = parseTimestampMs(config.capturedAt);
  if (capturedAt === null) return true;
  return now - capturedAt > staleMs;
}

// Should this machine spend a `codex app-server` probe now? (lib/session-start.mjs's gate.)
//
// A SEPARATE PREDICATE FROM isStale, because isStale answers a different question: it asks whether
// a SUBSCRIPTION machine's plan has gone stale, and returns false for every other source — including
// `unknown`, which is exactly the machine that has never been able to name its plan. Gating the
// probe on isStale alone would mean a machine with no ~/.codex/auth.json never probes, never
// captures, and is nudged about it forever.
//
// Bounded the same way in both branches (weekly, via capturedAt), so the subprocess stays rare.
// `deps.isStale` is honoured rather than closed over: runSessionStart threads its own isStale
// through every other billing call, and a predicate that quietly used the module's would make that
// seam stop working exactly where the cost of being wrong is a subprocess.
export function shouldProbeAccount(config, source, now = Date.now(), deps = {}) {
  const staleImpl = orDefault(deps.isStale, isStale);
  const staleMs = orDefault(deps.staleMs, STALE_MS);
  // A plan the user answered by hand always wins; we do not even look.
  if ((config || {}).selfReported === true) return false;
  if (source === BillingSource.SUBSCRIPTION) return staleImpl(config, now, staleMs);
  // An api-key or third-party machine bills no subscription: there is no plan to go and find.
  if (source !== BillingSource.UNKNOWN) return false;
  const capturedAt = parseTimestampMs((config || {}).capturedAt);
  if (capturedAt === null) return true;
  return now - capturedAt > staleMs;
}

// The report payload keys for the subscription plan, or {} when not applicable.
export function subscriptionReportFields(billingSource, config) {
  if (billingSource !== BillingSource.SUBSCRIPTION || !config) return {};
  return {
    subscription_type: orDefault(config.subscriptionType, null),
    rate_limit_tier: orDefault(config.rateLimitTier, null),
    subscription_plan: orDefault(config.plan, null),
  };
}

// How long a recorded API error keeps vouching for the billing mode it proved. Short on purpose:
// it must lapse quickly once the user switches back, and a session still on that mode re-earns it
// the next time the error fires.
const EVIDENCE_MS = 24 * 60 * 60 * 1000;

function hasFreshStamp(at, now) {
  const ms = parseTimestampMs(at);
  if (ms === null) return false;
  // `ms <= now` guards a clock that jumped backwards: a stamp from the future is not evidence.
  return now - ms <= EVIDENCE_MS && ms <= now;
}

export function hasFreshApiKeyEvidence(config, now = Date.now()) {
  return hasFreshStamp((config || {}).apiKeyEvidenceAt, now);
}

export function hasFreshSubscriptionEvidence(config, now = Date.now()) {
  return hasFreshStamp((config || {}).subscriptionEvidenceAt, now);
}

// Stamp proof of a billing mode. Always returns an updated config object — the null-when-fresh
// short-circuit lives one level up, in recordApiKeyEvidence/recordSubscriptionEvidence. Creates a
// minimal config when none exists — the evidence has to survive on a machine that never captured a
// plan.
function record(config, field, now) {
  return { version: 1, ...(config || {}), [field]: now.toISOString() };
}

export function recordApiKeyEvidence(config, now = new Date()) {
  if (hasFreshApiKeyEvidence(config, now.getTime())) return null;
  return record(config, 'apiKeyEvidenceAt', now);
}

export function recordSubscriptionEvidence(config, now = new Date()) {
  if (hasFreshSubscriptionEvidence(config, now.getTime())) return null;
  return record(config, 'subscriptionEvidenceAt', now);
}

// The single source-of-truth resolution, shared by the session-start hook and every checkpoint so
// the two can never disagree about what this machine is billing.
//
// billing.json's own `source` is never consulted for resolution — it is a record of the last
// resolution, not an input to the next one, so a switch the user made outside our sight cannot
// keep asserting itself. The file contributes plan detail only, and self-reported testimony last.
export function resolveSource(config, env = process.env, deps = {}) {
  const readSignals = deps.readCodexAuthSignals || readCodexAuthSignals;
  // orDefault, not ||: an injected epoch of 0 is a legitimate clock.
  const now = orDefault(deps.now, Date.now());

  // 1. The environment wins: an exported key is what the process will actually use.
  const fromEnv = detectBillingSourceFromEnv(env);
  if (fromEnv !== BillingSource.UNKNOWN) return fromEnv;

  // 2-3. Errors that actually fired, within the last 24h. These outrank auth.json because a stale
  // login can linger on disk, but a quota / usage-limit error cannot happen unless that mode is
  // live. API-key proof is checked first: it is the mode that costs money per token.
  if (hasFreshApiKeyEvidence(config, now)) return BillingSource.OPENAI_API_KEY;
  if (hasFreshSubscriptionEvidence(config, now)) return BillingSource.SUBSCRIPTION;

  // 4. What Codex recorded on disk. Best-effort: an unreadable auth.json must degrade to
  // `unknown`, never throw on the checkpoint hot path.
  let signals = null;
  try { signals = readSignals(); } catch { signals = null; }
  // auth_mode outranks mere key presence — it is the field Codex itself uses to pick a credential,
  // so a machine with a leftover key but a ChatGPT sign-in bills the subscription.
  if ((signals || {}).authMode === 'apikey') return BillingSource.OPENAI_API_KEY;
  if ((signals || {}).authMode === 'chatgpt') return BillingSource.SUBSCRIPTION;
  if (signals && signals.hasStoredApiKey) return BillingSource.OPENAI_API_KEY;

  // 4b. What CODEX ITSELF last told us, recorded by the `codex app-server` probe
  // (lib/codex-app-server.mjs → lib/billing-capture.mjs). Ranked immediately below auth.json and
  // above self-report because it is observed rather than claimed — but it is a RECORDING, and
  // auth.json is live, so anything that file says outranks it.
  //
  // WITHOUT THIS STEP THE WHOLE APP-SERVER TIER IS DEAD ON THE MACHINE IT EXISTS FOR. A machine
  // whose credentials live in the OS keychain has no auth.json, so steps 1-4 all decline and the
  // ladder answers `unknown`. Session start then skips the capture (it is gated on `subscription`),
  // and a plan captured by hand through the login skill is overwritten back to `unknown` by
  // syncBillingSource on the very next session — so the user captures a plan and watches it revert.
  // IT GOES STALE, AND IT IS BOUNDED AT A WEEK. Nothing expires this recording in place, so a
  // machine that moves to an API key held only in the keychain keeps resolving as `subscription`
  // until `capturedAt` ages past STALE_MS — at which point isStale() is true, shouldProbeAccount()
  // fires, and mergeAccounts lets the live auth type overwrite it. Same bound every other staleness
  // rule here uses; it is why the live answer, not the recorded one, wins that field.
  const observed = config && typeof config.authType === 'string' ? config.authType : null;
  if (observed === 'apikey') return BillingSource.OPENAI_API_KEY;
  if (observed === 'chatgpt') return BillingSource.SUBSCRIPTION;

  // 5. Weakest evidence, deliberately last: what the user told us at sign-in. It is the only thing
  // that works on a machine exposing no observable signal at all — but it is unverifiable
  // testimony, so anything above overrules it, and a live error (checked above) revokes it.
  const declared = config && config.selfReported === true ? config.source : null;
  if (
    declared === BillingSource.SUBSCRIPTION ||
    declared === BillingSource.OPENAI_API_KEY ||
    declared === BillingSource.THIRD_PARTY
  ) {
    return declared;
  }

  // 6. Reported honestly rather than guessed.
  return BillingSource.UNKNOWN;
}

// The full set of billing keys for a report payload, from one resolution.
export function resolveBilling(config, env = process.env, deps = {}) {
  const source = resolveSource(config, env, deps);
  return {
    billing_source: source,
    ...subscriptionReportFields(source, config),
  };
}

// Realign billing.json's recorded source to the resolved one, preserving plan detail. Returns the
// updated config, or null when it already agrees (nothing to write). `capturedAt` is deliberately
// NOT bumped: that timestamp tracks when the plan was captured, and a source realignment tells us
// nothing new about the plan — bumping it would hide a plan going stale.
export function syncBillingSource(config, source) {
  if (!source || (config || {}).source === source) return null;
  return { version: 1, ...(config || {}), source };
}
