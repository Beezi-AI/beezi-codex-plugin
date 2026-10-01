import crypto from 'crypto';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { fetchCompat } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { accountSyncStateFile } from './paths.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { boundedLabel, orDefault, parseTimestampMs } from './compat.mjs';

// The vendor-generic account check-in (G-2-1).
//
// Not registration — the portal already mints the machine from the headers machine-identity.mjs
// sends. This refreshes `last_seen_at` on the ACCOUNT row, propagates an account switch (usage rows
// carry account_uuid and would otherwise drift from the portal's copy), and reports a plan change
// on an idle machine, where plan has no usage row to travel on.
//
// Best-effort by contract: it never throws, it is bounded by postJson's own timeout, and it
// swallows every failure. An older API answering 404 is as harmless as being offline.

const STATE_VERSION = 1;

// How long an UNCHANGED payload is trusted before it is re-sent anyway. This is what refreshes
// last_seen_at on an account that never changes; without it the steady state would be permanent
// silence rather than a weekly ping.
export const RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

// The check-in route. Vendor-generic ON PURPOSE, and deliberately not one of config.mjs's
// /me/codex/* routes: the server reads the vendor off the X-Beezi-Agent header that
// machineHeaders() already sends (AGENT === 'codex'), maps it to its OpenAI vendor, and both
// plugins therefore share one account-row shape. There is no vendor field in the body.
export function accountSyncPath() {
  return ENDPOINTS.accountSync;
}

// Hash + timestamp of the last check-in the SERVER confirmed. PER ACCOUNT, and outside state/ and
// queue/ — pruneStale() sweeps those at 14 days, and losing this marker means a redundant POST
// every fortnight. One marker per account rather than one per machine because the payload it
// hashes is what THAT tenant was last told; sharing it would let a check-in to one workspace
// suppress the first-ever check-in to another.
//
// Named by lib/paths.mjs like every other per-account file, so the environment suffix and the
// BEEZI_CODEX_HOME override both apply to it unchanged. Re-exported here because the check-in is
// the only thing that reads or writes it.
export { accountSyncStateFile };

// The bounds of CliAgentAccountSyncRequestDto ITSELF (@MaxLength 64 / 320 / 50 on accountUuid /
// email / subscriptionType). Deliberately restated here rather than imported from
// usage-report-codex.mjs: that module states the bounds of UsageSnapshotRequestDto, a DIFFERENT
// DTO with a different whitelist, and the two agreeing on two of three numbers today is a
// coincidence rather than a contract — generalizing from one to the other is exactly the mistake
// that ships a 400.
//
// The bounds this check-in states. boundedLabel (lib/compat.mjs) enforces them: an oversized value
// is DROPPED, never truncated, for the reason recorded there.
const MAX_ACCOUNT_UUID = 64;
const MAX_ACCOUNT_EMAIL = 320;
const MAX_SUBSCRIPTION_TYPE = 50;

// Which plan, if any, this check-in may claim.
//
// billing.json's `subscriptionType` is ALREADY the source ladder's verdict: buildConfig writes it
// as `isSub ? subscriptionType : null`, so a null there is a decision — "this machine does not
// bill a subscription" — and not a gap to fill in. The live id_token decode is therefore consulted
// only when there is NO billing config at all, i.e. on a machine that has never resolved a source.
// That rule is what keeps this module out of the billing ladder entirely: it never calls
// resolveSource and never reads process.env, so neither of the hermeticity leaks G-10-1 closed
// (L1: a deps-less ladder call reopening ~/.codex/auth.json; L3: a host OPENAI_API_KEY winning
// step 1) can reappear through here.
//
// The expiry rule on that fallback mirrors billing-capture.mjs's, for the same measured reason: an
// id_token that expired three days earlier still asserted `chatgpt_plan_type: "free"` with a
// subscription window six weeks past. The EXPIRY is kept and the LABEL is not, so a paying user is
// never filed under a plan a stale snapshot claimed.
function resolveSubscriptionType(config, account, nowMs) {
  if (config !== null && config !== undefined) {
    return boundedLabel(config.subscriptionType, MAX_SUBSCRIPTION_TYPE);
  }
  if (account === null || account === undefined) return null;
  const expiresAt = account.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt <= nowMs) return null;
  return boundedLabel(account.subscriptionType, MAX_SUBSCRIPTION_TYPE);
}

// The check-in body. Built from values the plugin has ALREADY parsed — one small read of
// ~/.codex/auth.json and one of billing.json, no subprocess, no network — so it stays cheap on the
// session-start hot path.
//
// EVERY key here is one CliAgentAccountSyncRequestDto whitelists, and nothing else travels. That
// DTO is validated with forbidNonWhitelisted, so a single unknown key 400s the entire check-in;
// unlike the usage drain there is no queue to stall behind it, which makes the failure silent and
// permanent-looking.
//
// DELIBERATELY ABSENT:
//   rateLimitTier — Anthropic-shaped. On Codex `subscriptionType` IS the plan and the tier is
//                   hardcoded null everywhere (billing-capture.mjs), so stating one would be an
//                   invented claim rather than a missing field.
//   keys[]        — omitted in v1. Sending a credential fingerprint ALONGSIDE a uuid/email lets
//                   the server fill that credential's account binding, and bindings are filled but
//                   never moved; doing it safely means porting the whole identity-suppression
//                   subsystem, which on Codex would guard OPENAI_API_KEY — a metered-billing key
//                   with no subscription behind it and so nothing to resolve. Every field is
//                   optional by contract, so omitting it is legal, not a degradation.
//
// Keys are OMITTED rather than nulled when unknown — the same rule usage-report-codex.mjs applies:
// the server treats an explicit null as a claim, and a present null can overwrite a good stored
// value where an absent key cannot.
//
// No credential, token, absolute path or prompt text can reach this payload: the only inputs are
// an account id, an email address and a short plan label.
export function buildAccountSyncPayload({ config = null, account = null, now = Date.now() } = {}) {
  const nowMs = now;
  const payload = {};
  // billing.json first, ~/.codex/auth.json second — the same precedence lib/chatgpt-identity.mjs
  // states, and for the same reason: the config is the only place a `codex app-server` identity is
  // written down, and on a keychain-only machine auth.json names no account at all.
  const field = (source, key, max) => boundedLabel(
    source === null || source === undefined ? null : source[key],
    max,
  );
  const accountUuid = orDefault(
    field(config, 'accountId', MAX_ACCOUNT_UUID),
    field(account, 'accountId', MAX_ACCOUNT_UUID),
  );
  if (accountUuid !== null) payload.accountUuid = accountUuid;
  const email = orDefault(
    field(config, 'email', MAX_ACCOUNT_EMAIL),
    field(account, 'email', MAX_ACCOUNT_EMAIL),
  );
  if (email !== null) payload.email = email;
  const subscriptionType = resolveSubscriptionType(config, account, nowMs);
  if (subscriptionType !== null) payload.subscriptionType = subscriptionType;
  return payload;
}

// A payload that names nothing at all. It would create no rows server-side, so it is not worth a
// request on a hook path — and on Codex this is a real state, not a theoretical one: a machine
// with no Codex sign-in and no captured billing knows nothing about its account.
export function isEmptyPayload(payload) {
  return payload === null || payload === undefined || Object.keys(payload).length === 0;
}

// Deterministic serialization for the change hash: object keys sorted at every level, so a
// reordered build can never look like new information. Only the payload is hashed, and no
// credential is in it.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function readAccountSyncState(key, deps = {}) {
  const read = orDefault(deps.readJsonImpl, readJson);
  let raw = null;
  try {
    raw = read(accountSyncStateFile(key), null);
  } catch {
    return null;
  }
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeAccountSyncState(key, state, deps = {}) {
  const write = orDefault(deps.writeJsonImpl, writeJsonSecure);
  try {
    write(accountSyncStateFile(key), { version: STATE_VERSION, ...state });
  } catch { /* best-effort — a marker we could not write costs one redundant POST */ }
}

function dueForResync(state, nowMs) {
  const stamp = state === null || state === undefined ? null : state.lastSyncedAt;
  const at = parseTimestampMs(stamp);
  if (at === null) return true;
  // A stamp from the future is a clock change, not a fresh sync.
  return nowMs - at > RESYNC_MS || at > nowMs;
}

// Tell Beezi which ChatGPT account and plan this machine is on.
//
// NEVER BLOCKS A SESSION. Its steady state — same payload, checked in within the week — is two
// small file reads and ZERO network. When it does POST it is bounded by postJson's
// POST_TIMEOUT_MS (3s), shrinkable further via `deps.timeoutMs` by a caller working against a
// hook budget. Every failure path returns a plain object; nothing here throws.
//
// `options.force` skips the hash gate: a fresh login is a fresh identity, and a marker left by the
// PREVIOUS identity would otherwise suppress the one check-in that is guaranteed to be news.
//
// Return: { synced, reason?, status? }.
//   no-token      — the caller had no session for this account. This is also what a credential
//                   store bound to another environment looks like: lib/credentials.mjs reads a
//                   mismatched binding as NO credentials, so linkedSessions() drops that account
//                   entirely. Quiet by design — that machine is not ours to talk about.
//   nothing-known — the payload named nothing; no request was made.
//   unchanged     — same payload, inside RESYNC_MS; no request was made.
//   rejected      — the server refused. THE MARKER IS LEFT UNTOUCHED, so the next trigger retries.
//                   Sealing it on a 404 from an older API would freeze the account row for a week
//                   while looking like a success.
//   network       — offline, DNS failure, or the bounded request timed out. Marker untouched.
export async function syncAccountIfNeeded(key, session, options = {}, deps = {}) {
  if (!session || !session.token) return { synced: false, reason: 'no-token' };

  const fetchImpl = orDefault(deps.fetchImpl, fetchCompat);
  // `readChatgptAuth`, not `readAccount`: from 0.13 on "account" means a linked BEEZI account, and
  // the value this reads is the ChatGPT sign-in Codex holds (Task 1's rename).
  const readChatgptAuth = orDefault(deps.readChatgptAuth, _readChatgptAuth);
  const readConfig = orDefault(deps.readBillingConfig, _readBillingConfig);
  const now = orDefault(deps.now, new Date());
  const force = options.force === true;

  // Everything below is inside the try, including the path and apiBase resolutions: both call
  // through lib/paths.mjs's environment assertion, which THROWS on an unresolvable env.json. A
  // build we cannot attribute to an environment must skip the check-in quietly, not crash a hook.
  try {
    let config = null;
    try { config = readConfig(); } catch { config = null; }
    let chatgptAccount = null;
    try { chatgptAccount = readChatgptAuth(); } catch { chatgptAccount = null; }

    const payload = buildAccountSyncPayload({ config, account: chatgptAccount, now: now.getTime() });
    if (isEmptyPayload(payload)) return { synced: false, reason: 'nothing-known' };

    const hash = payloadHash(payload);
    const state = readAccountSyncState(key, deps);
    const unchanged = state !== null && state.lastSyncedHash === hash;
    if (!force && unchanged && !dueForResync(state, now.getTime())) {
      return { synced: false, reason: 'unchanged' };
    }

    // timeoutMs travels only when a caller actually set one; otherwise postJson applies its own
    // 3s bound. Forwarding it at all is what lets a caller working against a hook deadline shrink
    // the bound to what the budget has left, rather than discovering the overrun afterwards.
    const postDeps = { fetchImpl };
    if (deps.timeoutMs !== null && deps.timeoutMs !== undefined) postDeps.timeoutMs = deps.timeoutMs;

    const res = await postJson(`${apiBase()}${accountSyncPath()}`, session, payload, postDeps);
    const status = res === null || res === undefined ? null : res.status;
    if (typeof status === 'number' && status >= 200 && status < 300) {
      writeAccountSyncState(key, { lastSyncedHash: hash, lastSyncedAt: now.toISOString() }, deps);
      return { synced: true, status };
    }
    return { synced: false, status, reason: 'rejected' };
  } catch {
    return { synced: false, reason: 'network' };
  }
}
