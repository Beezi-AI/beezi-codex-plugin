import fs from 'node:fs';
import { codexAuthFile } from './paths.mjs';
import { CHATGPT_PLANS } from './billing.mjs';

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
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// ChatGPT plan tiers, normalized to a lowercase label. Unknown/absent → 'unknown'. The tier list is
// imported, not restated: a second copy here is exactly how `go` came to be missing from both.
const KNOWN_PLANS = new Set(CHATGPT_PLANS);

export function normalizeCodexPlan(planType) {
  const t = String(planType ?? '').trim().toLowerCase();
  return KNOWN_PLANS.has(t) ? t : 'unknown';
}

function toEpochMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Read ONLY the non-secret subscription fields from ~/.codex/auth.json. Returns null when no
// ChatGPT account info exists (e.g. API-key auth or unlinked). `authMode` is exposed so the billing
// source detector can tell subscription from API-key auth.
export function readCodexAccount(deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const authFile = deps.authFile ?? codexAuthFile();

  if (!exists(authFile)) return null;
  let auth;
  try {
    auth = JSON.parse(readFile(authFile));
  } catch {
    return null;
  }

  const authMode = typeof auth.auth_mode === 'string' ? auth.auth_mode : null;
  const claims = decodeJwtPayload(auth?.tokens?.id_token);
  const authNs = claims && typeof claims[AUTH_CLAIM] === 'object' ? claims[AUTH_CLAIM] : null;
  if (!authNs) {
    return { authMode, subscriptionType: null, plan: null, expiresAt: null };
  }

  const plan = normalizeCodexPlan(authNs.chatgpt_plan_type);
  // Prefer the subscription window end; fall back to the id_token's own expiry.
  const expiresAt =
    toEpochMs(authNs.chatgpt_subscription_active_until) ??
    (typeof claims.exp === 'number' ? claims.exp * 1000 : null);

  return {
    authMode,
    subscriptionType: plan === 'unknown' ? null : plan,
    plan,
    expiresAt,
  };
}

// Just the auth mode ('chatgpt' | 'apikey' | null), for billing-source detection without decoding.
export function readCodexAuthMode(deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const authFile = deps.authFile ?? codexAuthFile();
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
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const authFile = deps.authFile ?? codexAuthFile();
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
