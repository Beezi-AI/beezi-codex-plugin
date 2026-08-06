import { BillingSource, normalizePlan } from './billing.mjs';
import { resolveSource } from './billing-config.mjs';
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
const SELF_REPORTED_PLANS = Object.freeze(['plus', 'pro', 'team', 'business', 'enterprise']);
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
    const plan = String(args.plan).trim().toLowerCase();
    if (!SELF_REPORTED_VALUES.includes(plan)) {
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
