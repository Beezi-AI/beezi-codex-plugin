import fs from 'fs';
import { codexAuthFile } from './paths.mjs';
import { normalizePlan } from './billing.mjs';
import { base64urlDecode, orDefault, readString } from './compat.mjs';

// Read the non-secret ChatGPT subscription info Codex stores in ~/.codex/auth.json. The plan tier
// lives in the id_token's `https://api.openai.com/auth` claim as `chatgpt_plan_type`; we decode the
// JWT payload WITHOUT verifying it (we only read a public plan label) and NEVER return or persist
// the access/refresh/id tokens themselves.
const AUTH_CLAIM = 'https://api.openai.com/auth';

// Decode a JWT payload (middle segment) without signature verification. Returns the claims object
// or null. base64url, tolerant of missing padding.
function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64urlDecode(parts[1]).toString('utf-8'));
  } catch {
    return null;
  }
}

// ChatGPT plan tiers, normalized to a lowercase label. Unknown/absent → 'unknown'. The normalizer
// is imported, not restated: a second copy here is exactly how `go` came to be missing from both,
// and a re-implementation would also miss the Codex→label aliases (`prolite` → `pro_5x`).
export const normalizeCodexPlan = normalizePlan;

function toEpochMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Read ONLY the non-secret subscription fields from ~/.codex/auth.json. Returns null when the file
// is absent or unparseable — the same two cases readCodexAuthSignals answers with its `none`, which
// is why a caller may synthesize signals from a null account. `authMode` and `hasStoredApiKey` are
// exposed on BOTH return shapes so the billing source detector can tell subscription from API-key
// auth off this one read (`resolveSource` in billing-config.mjs).
export function readChatgptAuth(deps = {}) {
  const readFile = orDefault(deps.readFile, (p) => fs.readFileSync(p, 'utf-8'));
  const exists = orDefault(deps.exists, (p) => fs.existsSync(p));
  const authFile = orDefault(deps.authFile, codexAuthFile());

  if (!exists(authFile)) return null;
  let auth;
  try {
    auth = JSON.parse(readFile(authFile));
  } catch {
    return null;
  }

  const authMode = typeof auth.auth_mode === 'string' ? auth.auth_mode : null;
  // Presence only, never the key itself — the same contract readCodexAuthSignals below states, read
  // here so ONE parse of auth.json answers both questions the billing ladder asks of that file.
  //
  // LOAD-BEARING, not a convenience. `auth_mode` is null under a ChatGPT sign-in (see the note on
  // readCodexAuthSignals), so `resolveSource`'s `if (signals && signals.hasStoredApiKey)` rung is
  // genuinely reached with `authMode === null`. A caller that synthesizes signals from this object
  // without this field resolves such a machine to `unknown` instead of `openai_api_key`, and
  // syncBillingSource then writes the wrong billing source into billing.json.
  const hasStoredApiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
  const claims = decodeJwtPayload(((auth || {}).tokens || {}).id_token);
  const authNs = claims && typeof claims[AUTH_CLAIM] === 'object' ? claims[AUTH_CLAIM] : null;
  // The ChatGPT account this machine bills to, and the address on it. Both identify the account a
  // usage row belongs to; neither is a credential. `tokens.account_id` is the same value as the
  // claim (verified equal locally) and survives an id_token we cannot decode, so it is the fallback
  // rather than the primary — the claim is read alongside the plan, from one decode.
  const tokenAccountId = readString(((auth || {}).tokens || {}).account_id);
  const email = readString(claims == null ? null : claims.email);
  // The undecodable / absent id_token shape — a stale sign-in, or an api-key machine. It carries
  // `hasStoredApiKey` too: this is exactly the machine whose billing source can only be told apart
  // by the stored key, so dropping the field here is the way the fix ships broken.
  if (!authNs) {
    return {
      authMode,
      hasStoredApiKey,
      subscriptionType: null,
      plan: null,
      expiresAt: null,
      accountId: tokenAccountId,
      email,
    };
  }

  const plan = normalizeCodexPlan(authNs.chatgpt_plan_type);
  // Prefer the subscription window end; fall back to the id_token's own expiry.
  const expiresAt = orDefault(
    toEpochMs(authNs.chatgpt_subscription_active_until),
    typeof claims.exp === 'number' ? claims.exp * 1000 : null,
  );

  return {
    authMode,
    hasStoredApiKey,
    subscriptionType: plan === 'unknown' ? null : plan,
    plan,
    expiresAt,
    accountId: orDefault(readString(authNs.chatgpt_account_id), tokenAccountId),
    email,
  };
}

// Just the auth mode ('chatgpt' | 'apikey' | null), for billing-source detection without decoding.
export function readCodexAuthMode(deps = {}) {
  const readFile = orDefault(deps.readFile, (p) => fs.readFileSync(p, 'utf-8'));
  const exists = orDefault(deps.exists, (p) => fs.existsSync(p));
  const authFile = orDefault(deps.authFile, codexAuthFile());
  if (!exists(authFile)) return null;
  try {
    const auth = JSON.parse(readFile(authFile));
    return typeof auth.auth_mode === 'string' ? auth.auth_mode : null;
  } catch {
    return null;
  }
}

// Presence-only auth signals from ~/.codex/auth.json, for resolving how this machine bills.
//
// `~/.codex/auth.json` carries a top-level `OPENAI_API_KEY` alongside `auth_mode` (null under a
// ChatGPT sign-in, set under key auth) — the Codex analogue of Claude's `primaryApiKey`.
//
// NEITHER THE KEY NOR ANY TOKEN IS READ OR RETURNED. Only whether a key is present, and which
// mode Codex recorded. Returns { authMode, hasStoredApiKey }; both null/false when unreadable.
export function readCodexAuthSignals(deps = {}) {
  const readFile = orDefault(deps.readFile, (p) => fs.readFileSync(p, 'utf-8'));
  const exists = orDefault(deps.exists, (p) => fs.existsSync(p));
  const authFile = orDefault(deps.authFile, codexAuthFile());
  const none = { authMode: null, hasStoredApiKey: false };
  if (!exists(authFile)) return none;
  try {
    const auth = JSON.parse(readFile(authFile));
    return {
      authMode: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
      hasStoredApiKey: typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0,
    };
  } catch {
    return none;
  }
}
