import { BillingSource, normalizePlan, canonicalPlan, CHATGPT_PLANS } from './billing.mjs';
import { resolveSource } from './billing-config.mjs';
import { readCodexAccount as _readCodexAccount } from './codex-account.mjs';
import { UserError } from './friendly-error.mjs';

// The credential fields are short opaque labels. Anything token-shaped (a secret,
// an over-long string, or embedded whitespace) is refused so a misdirected value
// can never be persisted.
const TOKEN_LIKE = /sk-|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new UserError('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--from-codex') out.fromCodex = true;
  }
  // The script's --from-codex branch rebuilds args from ~/.codex/auth.json, which would
  // silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromCodex && out.plan != null) {
    throw new UserError('--plan and --from-codex are mutually exclusive.');
  }
  return out;
}

// Self-reported plans a user can pick in the sign-in fallback. `free` is absent: Codex
// subscription billing needs a paid ChatGPT plan. `api_key` is not a plan — it is the escape
// hatch for a user who bills pay-as-you-go and would otherwise be forced to claim a ChatGPT tier
// they do not have.
const SELF_REPORTED_API_KEY = 'api_key';
// Derived from the one tier list, not restated: a hand-maintained copy is exactly how `go` came to
// be missing everywhere. `free` is the only exclusion — Codex subscription billing needs a paid
// ChatGPT plan, so offering it in the picker would let a user record something unusable.
const SELF_REPORTED_PLANS = Object.freeze(CHATGPT_PLANS.filter((p) => p !== 'free'));
const SELF_REPORTED_VALUES = Object.freeze([...SELF_REPORTED_PLANS, SELF_REPORTED_API_KEY]);

// The user's own answer is the point of this path, so it is passed to the ladder as
// `selfReported` rather than being second-guessed against a machine that exposed no signal.
function declaredSource(declared, existingConfig, env) {
  const seed = declared
    ? { ...(existingConfig ?? {}), source: declared, selfReported: true }
    : existingConfig;
  return resolveSource(seed, env);
}

export function buildConfig(args, env = process.env, now = new Date(), existingConfig = null) {
  if (args.plan != null) {
    const raw = String(args.plan).trim().toLowerCase();
    // Through canonicalPlan, so a user who types the tier the way Codex names it (`pro`, `prolite`)
    // is accepted and lands on the same label the automatic capture would have written.
    const plan = raw === SELF_REPORTED_API_KEY ? SELF_REPORTED_API_KEY : canonicalPlan(raw);
    if (plan == null || !SELF_REPORTED_VALUES.includes(plan)) {
      throw new UserError(`Unknown plan '${args.plan}'. Valid: ${SELF_REPORTED_VALUES.join(', ')}.`);
    }
    const declared = plan === SELF_REPORTED_API_KEY
      ? BillingSource.OPENAI_API_KEY
      : BillingSource.SUBSCRIPTION;
    const source = declaredSource(declared, existingConfig, env);
    const isSub = source === BillingSource.SUBSCRIPTION;
    return {
      version: 1,
      source,
      // The plan label is the single source of the derived fields; the tier was never observed.
      subscriptionType: isSub ? plan : null,
      rateLimitTier: null,
      plan: isSub ? plan : null,
      credentialsExpiresAt: null,
      capturedAt: now.toISOString(),
      capturedBy: safeField(args.via) ?? 'manual',
      selfReported: true,
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via) ?? 'manual';
  // resolveSource, not the bare env check: with UNKNOWN now reachable, an env-only lookup would
  // return UNKNOWN on every ChatGPT machine and silently drop the plan fields below.
  const source = resolveSource(existingConfig, env);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: 1,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via,
  };
}

// A self-reported plan must survive automatic re-capture: when the fresh account fields still
// normalize to 'unknown', overwriting would destroy the only good data and restart the
// refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  return freshConfig.plan === 'unknown'
    && existingConfig?.selfReported === true
    && Boolean(existingConfig.plan)
    && existingConfig.plan !== 'unknown';
}

// Read the ChatGPT plan out of ~/.codex/auth.json and build the config to persist.
//
// Shared by the SessionStart hook and scripts/billing-capture.mjs deliberately: both do this, and
// when the expiry rule below lived in only one of them, the nudge it produces sent the user
// straight to the caller that did not have it — which promptly wrote the bad plan back.
//
// The expiry rule: the plan in auth.json is a SNAPSHOT, not a live lookup, and it goes stale in
// place. Measured on a real machine, an id_token that expired three days earlier still asserted
// `chatgpt_plan_type: "free"` with a subscription window six weeks past. Believing that files a
// paying user under `free` — and `free` is a valid plan, so it then looks settled enough that
// nothing ever asks again. So the EXPIRY is kept and the LABEL is not: an expired claim records
// `plan: 'unknown'`, which leaves the config stale, which brings the next session start back here.
// Codex refreshes auth.json on use, so the real plan is picked up automatically when it does.
//
// Returns { config, reason }; `config` is null unless there is something to write.
// reason ∈ no-account | kept-self-reported | expired-claim | captured.
export function captureFromCodexAccount({
  via, existing = null, env = process.env, now = new Date(), deps = {},
} = {}) {
  const readCodexAccount = deps.readCodexAccount ?? _readCodexAccount;
  const account = readCodexAccount();
  if (!account?.plan) return { config: null, reason: 'no-account' };

  const claimExpired = typeof account.expiresAt === 'number' && account.expiresAt <= now.getTime();
  const config = buildConfig(
    {
      subscriptionType: claimExpired ? null : account.subscriptionType,
      rateLimitTier: null,
      expiresAt: account.expiresAt,
      via,
    },
    env,
    now,
    existing,
  );
  if (shouldKeepExisting(config, existing)) return { config: null, reason: 'kept-self-reported' };
  return { config, reason: claimExpired ? 'expired-claim' : 'captured' };
}
