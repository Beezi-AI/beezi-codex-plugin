import { BillingSource, normalizePlan, canonicalPlan, CHATGPT_PLANS } from './billing.mjs';
import { resolveSource as _resolveSource } from './billing-config.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import {
  readAccountViaAppServer as _readAccountViaAppServer,
  mergeAccounts,
} from './codex-app-server.mjs';
import { UserError } from './friendly-error.mjs';
import { boundedLabel, orDefault } from './compat.mjs';

// The credential fields are short opaque labels. Anything token-shaped (a secret,
// an over-long string, or embedded whitespace) is refused so a misdirected value
// can never be persisted.
//
// Deliberately NOT built on boundedLabel: that helper RETURNS NULL for an over-long value, while
// this one THROWS. Layering them would silently downgrade this refusal — the point of which is to
// stop a secret being written — into a quietly dropped field.
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

// The identity billing.json carries alongside the plan. Same bounds the two DTOs state
// (@MaxLength 64 on accountUuid, 320 on email); boundedLabel (lib/compat.mjs) drops an oversized
// value rather than truncating it, because a truncated uuid names a DIFFERENT account.
//
// It is persisted at all because tier 1 is the only source of an account id on a machine whose
// credentials never touch auth.json, and the probe runs at most weekly. Without a home in
// billing.json the id would exist for exactly the one session that spawned the probe.
const MAX_ACCOUNT_ID = 64;
const MAX_ACCOUNT_EMAIL = 320;

// A capture that learned no identity must not ERASE the one already recorded: the self-report path
// (`--plan`) never knows an account id, and it rewrites the whole config.
//
// `authType` is carried the same way, and it is LOAD-BEARING rather than informational: it is step
// 4b of the source ladder (billing-config.mjs), the only thing that resolves a machine whose
// credentials never touch ~/.codex/auth.json. Dropped on a rewrite, such a machine falls back to
// `unknown` on its next session and the plan it just captured stops travelling on its reports.
// Only `chatgpt` and `apikey` are recorded; anything else is not an auth mode the ladder speaks.
const AUTH_TYPES = Object.freeze(['chatgpt', 'apikey']);

function identityFields(args, existingConfig) {
  const existing = orDefault(existingConfig, {});
  const authType = boundedLabel(args.authType, 16);
  return {
    accountId: orDefault(boundedLabel(args.accountId, MAX_ACCOUNT_ID), orDefault(existing.accountId, null)),
    email: orDefault(boundedLabel(args.email, MAX_ACCOUNT_EMAIL), orDefault(existing.email, null)),
    authType: AUTH_TYPES.indexOf(authType) === -1
      ? orDefault(existing.authType, null)
      : authType,
  };
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

// Self-reported plans a user can pick in the sign-in fallback. `api_key` is not a plan — it is
// the escape hatch for a user who bills pay-as-you-go and would otherwise be forced to claim a
// ChatGPT tier they do not have.
const SELF_REPORTED_API_KEY = 'api_key';
// Derived from the one tier list, not restated: a hand-maintained copy is exactly how `go` came to
// be missing everywhere. Every tier the API prices is offerable, including `free` — refusing the
// tier a user actually has leaves them a choice between claiming a paid plan and capturing nothing.
const SELF_REPORTED_VALUES = Object.freeze([...CHATGPT_PLANS, SELF_REPORTED_API_KEY]);

// The user's own answer is the point of this path, so it is passed to the ladder as
// `selfReported` rather than being second-guessed against a machine that exposed no signal.
function declaredSource(declared, existingConfig, env, deps) {
  const seed = declared
    ? { ...(existingConfig || {}), source: declared, selfReported: true }
    : existingConfig;
  return (deps.resolveSource || _resolveSource)(seed, env, deps);
}

// `deps` is the fifth parameter, threaded to BOTH resolveSource calls below (G-10-1 L1). Dropped,
// step 4 of the ladder (`resolveSource` in billing-config.mjs) opens the real ~/.codex/auth.json
// through codexAuthFile(), so a caller that injected every other resolver still resolves billing
// off the host machine. Two seams are honoured: `deps.resolveSource` replaces the ladder wholesale
// (what runSessionStart injects, so its outer and inner resolutions cannot disagree), and
// `deps.readCodexAuthSignals` replaces only step 4's read of auth.json.
export function buildConfig(args, env = process.env, now = new Date(), existingConfig = null, deps = {}) {
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
    const source = declaredSource(declared, existingConfig, env, deps);
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
      capturedBy: orDefault(safeField(args.via), 'manual'),
      selfReported: true,
      ...identityFields(args, existingConfig),
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = orDefault(safeField(args.via), 'manual');
  // resolveSource, not the bare env check: with UNKNOWN now reachable, an env-only lookup would
  // return UNKNOWN on every ChatGPT machine and silently drop the plan fields below.
  const source = (deps.resolveSource || _resolveSource)(existingConfig, env, deps);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: 1,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via,
    ...identityFields(args, existingConfig),
  };
}

// A self-reported plan must survive automatic re-capture: when the fresh account fields still
// normalize to 'unknown', overwriting would destroy the only good data and restart the
// refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  return freshConfig.plan === 'unknown'
    && (existingConfig || {}).selfReported === true
    && Boolean(existingConfig.plan)
    && existingConfig.plan !== 'unknown';
}

// Read the ChatGPT plan and account id, and build the config to persist. CLAUDE.md states the
// three-tier ladder (`codex app-server`, the auth.json id_token decode, the user's own answer) and
// the single-definition rule over it. The tiers meet in mergeAccounts, which produces ONE account
// object shaped exactly like tier 2's, so every consumer below this line is unchanged.
//
// THE EXPIRY RULE lives here, not in either caller, because when it lived in only one of them the
// nudge it produces sent the user to the caller that did not have it — which wrote the bad plan
// back. It is tier 2's rule alone: a live tier-1 reading has no expiry to go stale.
//
// The plan in auth.json is a SNAPSHOT, not a live lookup, and it goes stale in place. Measured on
// a real machine, an id_token that expired three days earlier still asserted
// `chatgpt_plan_type: "free"` with a subscription window six weeks past. Believing that files a
// paying user under `free` — and `free` is a valid plan, so it then looks settled enough that
// nothing ever asks again. So the EXPIRY is kept and the LABEL is not: an expired claim records
// `plan: 'unknown'`, which leaves the config stale, which brings the next session start back here.
// Codex refreshes auth.json on use, so the real plan is picked up automatically when it does.
//
// `env` defaults to process.env because that IS the right answer in production — step 1 of the
// ladder asks what key the process will actually use. It is a parameter rather than a read so a
// caller that has already resolved an environment can hand its own over (G-10-1 L3);
// runSessionStart does, and scripts/billing-capture.mjs deliberately takes the default.
//
// ASYNC because tier 1 is a subprocess. Nothing on the checkpoint hot path calls this, so no hot
// path grew a spawn — see the gate at lib/session-start.mjs.
//
// Returns { config, reason, tier }; `config` is null unless there is something to write.
// reason ∈ no-account | kept-self-reported | expired-claim | captured.
// tier ∈ app-server | auth-json | none — WHICH TIER ANSWERED. Named `tier`, not `source`: the
// config's own `source` is the billing source, and one field name for two meanings is how this
// repo's single-definition invariants got written in the first place.
export async function captureFromCodexAccount({
  via, existing = null, env = process.env, now = new Date(), deps = {},
} = {}) {
  const readChatgptAuth = deps.readChatgptAuth || _readChatgptAuth;
  const probeAppServer = deps.readAccountViaAppServer || _readAccountViaAppServer;

  // Tier 1. Never allowed to throw or hang the caller: readAccountViaAppServer returns a typed
  // failure for every outcome it knows, and the catch covers the ones it does not.
  let live = null;
  try {
    live = await probeAppServer({ env: env, timeoutMs: deps.appServerTimeoutMs });
  } catch { live = null; }

  // Tier 2, read unconditionally: it carries `hasStoredApiKey`, which tier 1 does not report and
  // which billing-config.mjs step 4 genuinely needs (see the signals note below).
  let fileAccount = null;
  try { fileAccount = readChatgptAuth(); } catch { fileAccount = null; }

  const account = mergeAccounts(live, fileAccount);
  if (!account || !account.plan) return { config: null, reason: 'no-account', tier: 'none' };
  const tier = account.live === true ? 'app-server' : 'auth-json';

  // Step 4 of the source ladder is answered from the account we ALREADY read, rather than letting
  // resolveSource open ~/.codex/auth.json a second time (G-10-1 L1). Beyond hermeticity that is one
  // fewer stat + read + JSON.parse on the SessionStart hook path, which runs under HOOK_BUDGET_MS,
  // and it removes the window in which the two reads could disagree about the same file.
  //
  // `hasStoredApiKey` is load-bearing, not decoration: auth_mode is null under a ChatGPT sign-in
  // (chatgpt-auth.mjs), so `resolveSource`'s stored-key rung is genuinely reached with authMode
  // === null. Signals synthesized without it resolve a machine holding a stored key to `unknown`
  // instead of `openai_api_key`, and syncBillingSource then writes that wrong source into
  // billing.json.
  const signals = {
    authMode: orDefault(account.authMode, null),
    hasStoredApiKey: account.hasStoredApiKey === true,
  };
  // A spread is safe HERE and deliberately not in usage-report-codex.mjs's billingDepsFrom: this
  // deps object is small and purpose-built by this function's two callers, while that one is the
  // rate-limit drain's grab-bag and carries a `now` that is a clock FUNCTION rather than the epoch
  // resolveSource expects. An explicitly injected reader still wins over the synthesized one.
  const resolveDeps = {
    ...deps,
    readCodexAuthSignals: deps.readCodexAuthSignals || function () { return signals; },
  };

  // THE EXPIRED-CLAIM RULE IS A TIER-2 RULE ONLY. It exists because the plan in auth.json is a
  // snapshot that rots in place — measured, a token three days expired still asserted `free` with
  // a subscription window six weeks past. A live app-server answer cannot rot, and mergeAccounts
  // gives it `expiresAt: null` for exactly that reason; applying the rule to it would downgrade a
  // correct `plus` to `unknown`, leave the config stale, and re-nudge the user every session.
  const claimExpired = account.live !== true
    && typeof account.expiresAt === 'number'
    && account.expiresAt <= now.getTime();
  const config = buildConfig(
    {
      subscriptionType: claimExpired ? null : account.subscriptionType,
      rateLimitTier: null,
      expiresAt: account.expiresAt,
      // Persisted with the plan so the account id survives between probes. An expired claim still
      // names the right account — only its PLAN label is untrustworthy.
      accountId: account.accountId,
      email: account.email,
      // ONLY from a live reading. From tier 2 it would be a copy of a file the ladder already reads
      // at step 4 — no new information, and a value that would outlive the file it came from.
      authType: account.live === true ? account.authMode : null,
      via,
    },
    env,
    now,
    existing,
    resolveDeps,
  );
  if (shouldKeepExisting(config, existing)) {
    return { config: null, reason: 'kept-self-reported', tier: tier };
  }
  return { config, reason: claimExpired ? 'expired-claim' : 'captured', tier: tier };
}
