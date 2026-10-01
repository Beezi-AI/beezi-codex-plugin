import { fetchCompat } from './fetch-compat.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { orDefault } from './compat.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import { readChatgptIdentity } from './chatgpt-identity.mjs';
import { readBillingConfig as _readBillingConfig, resolveBilling as _resolveBilling } from './billing-config.mjs';
import {
  readPendingRateLimits as _readPendingRateLimits,
  clearPendingRateLimits as _clearPendingRateLimits,
  readObservedPlan as _readObservedPlan,
} from './rate-limits-codex.mjs';

// The billing ladder's deps, picked BY NAME out of the caller's bag rather than spread from it.
//
// This is the one place a spread would be actively wrong. `drainRateLimitSnapshots` hands its own
// deps straight through to usageIdentityFields, and there `now` is a CLOCK FUNCTION
// (`orDefault(deps.now, Date.now)`, used for the drain deadline) while resolveSource's `now` is an
// EPOCH NUMBER (`resolveSource` in billing-config.mjs). Passing the function through would make
// every evidence-freshness comparison `now - ms` NaN and silently discard an hours-old API-key
// stamp — the same trap `runCheckpoint` in checkpoint.mjs spells out at its own call site. So `now`
// travels only when it is already a number, and nothing the ladder does not name travels at all.
function billingDepsFrom(deps) {
  const out = {};
  if (deps.readCodexAuthSignals != null) out.readCodexAuthSignals = deps.readCodexAuthSignals;
  if (typeof deps.now === 'number') out.now = deps.now;
  return out;
}

// Step 4 of the source ladder answered from the account this function ALREADY read, so
// resolveSource does not open ~/.codex/auth.json a second time (G-10-1 L1). A null account is the
// same two cases readCodexAuthSignals answers with its `none` — file absent, or unparseable — so
// synthesizing `none` for it is exact rather than a guess. `hasStoredApiKey` is carried because
// auth_mode is null under a ChatGPT sign-in, which makes `resolveSource`'s stored-key rung in
// billing-config.mjs reachable.
function signalsFromAccount(account) {
  if (account == null) return { authMode: null, hasStoredApiKey: false };
  return {
    authMode: orDefault(account.authMode, null),
    hasStoredApiKey: account.hasStoredApiKey === true,
  };
}

// Which ChatGPT account these numbers belong to, plus the plan they were measured against.
//
// ONLY the keys `UsageSnapshotRequestDto` whitelists may appear. `resolveBilling()` also returns
// `billing_source` and `third_party_provider`, which it does not — spreading it wholesale would
// 400 every row under forbidNonWhitelisted, and a 400 breaks the drain WITHOUT clearing. So the
// three subscription keys are picked out by name and nothing else travels.
//
// Keys are omitted rather than nulled when unknown: the server treats an explicit null as a claim,
// and an absent account_uuid falls to its own '' default, which is the unattributed series.
//
// The plan ladder, stated once so nothing downstream has to re-derive it:
//   1. billing.json's SELF-REPORTED plan — a tier the user typed always wins.
//   2. the `plan_type` on the most recent rate-limit observation (rate-limits-codex.mjs).
//   3. billing.json's captured (non-self-reported) plan.
//   4. readChatgptAuth().plan, the live id_token decode.
// Rungs 3 and 4 are unchanged; rung 2 was added because `plan_type` was on disk and unread.
export function usageIdentityFields(deps = {}) {
  // `readChatgptAuth` / `chatgptAccount`, not `readAccount` / `account`: from 0.13 on "account"
  // means a linked BEEZI account, and what these read is the ChatGPT sign-in Codex holds.
  const readChatgptAuth = deps.readChatgptAuth || _readChatgptAuth;
  const readBilling = deps.readBillingConfig || _readBillingConfig;

  let chatgptAccount = null;
  try { chatgptAccount = readChatgptAuth(); } catch (e) { chatgptAccount = null; }
  let billing = null;
  try { billing = readBilling(); } catch (e) { billing = null; }

  const out = readChatgptIdentity({
    readBillingConfig: () => billing,
    readChatgptAuth: () => chatgptAccount,
  });

  // The plugin's own resolution ladder decides whether a plan is even meaningful — under API-key
  // billing it returns no subscription fields at all, and stating one would be a false claim.
  const env = deps.env == null ? process.env : deps.env;
  const resolveBilling = deps.resolveBilling || _resolveBilling;
  let fields = {};
  try {
    fields = resolveBilling(billing, env, {
      readCodexAuthSignals: function () { return signalsFromAccount(chatgptAccount); },
      ...billingDepsFrom(deps),
    });
  } catch (e) { fields = {}; }

  // ── Rung 2 of the plan ladder: the plan the SERVER stamped on the most recent rate-limit reading.
  //
  // Above billing.json's captured plan and above the live id_token decode, because it needs neither
  // a JWT parse nor a signature we do not check, and it has no dependency on token freshness — it
  // is a value already written into a log on disk, timestamped and re-readable forever. On this
  // machine it dated a real free→plus change to within a few days, which is the event the refresh
  // flow exists to catch and which happened here without anyone running refresh.
  //
  // Below a SELF-REPORTED plan, always: a tier the user typed by hand is the one thing the ladder
  // must never overwrite (`isStale` and `shouldProbeAccount`, both in billing-config.mjs).
  //
  // Gated on a SUBSCRIPTION resolution for the same reason every other plan field is: on an api-key
  // or third-party machine there is no subscription plan to state, and stamping one would be a
  // false claim the resolver deliberately refuses to make.
  //
  // Absent (~2/3 of local observations carry `plan_type: null`) it falls straight through to the two
  // rungs below, unchanged. It is an enrichment source, never a replacement.
  if (fields.billing_source === 'subscription' && (billing || {}).selfReported !== true) {
    const readObservedPlan = deps.readObservedPlan || _readObservedPlan;
    let observed = null;
    try { observed = readObservedPlan(); } catch (e) { observed = null; }
    const observedPlan = observed == null ? null : observed.plan;
    if (observedPlan != null && observedPlan !== 'unknown') {
      // The PAIR moves together. On Codex the subscription type IS the plan tier (`normalizePlan`
      // in lib/billing.mjs), so leaving billing.json's `plus` beside a rollout's `free` would put
      // two different tiers in one row. Whichever source wins the plan owns the type.
      fields = { ...fields, subscription_plan: observedPlan, subscription_type: observedPlan };
    }
  }

  // billing.json is the reconciled record, but it goes stale: a login that could not resolve the
  // tier writes plan 'unknown' and never revisits it, so a machine on Plus reports nothing forever.
  // The live id_token is the fallback, but the cached uuid and live plan can describe different
  // accounts. Only use that plan when
  // the live account does not contradict the resolved identity. A real plan on disk still wins,
  // and so does the observed plan above.
  const stated = fields.subscription_plan;
  const sameAccount = !out.account_uuid || !(chatgptAccount || {}).accountId || out.account_uuid === chatgptAccount.accountId;
  if ((stated == null || stated === 'unknown') && fields.billing_source === 'subscription' && sameAccount) {
    const livePlan = chatgptAccount == null ? null : chatgptAccount.plan;
    if (livePlan != null && livePlan !== 'unknown') {
      fields = {
        ...fields,
        subscription_plan: livePlan,
        subscription_type: orDefault(fields.subscription_type, chatgptAccount.subscriptionType),
      };
    }
  }

  const keys = ['subscription_type', 'rate_limit_tier', 'subscription_plan'];
  for (let i = 0; i < keys.length; i++) {
    const value = fields[keys[i]];
    // 'unknown' is what the normalizer returns when it recognised nothing, and the server keeps an
    // unmapped plan name verbatim in subscription_type. Sending it would record the literal string
    // "unknown" as this account's plan, which reads as a fact; omitting says nothing, which is true.
    if (value != null && value !== 'unknown') out[keys[i]] = value;
  }
  return out;
}

// Ships ONE ACCOUNT's queued rate-limit rows. Each row carries the timestamp of the reading it
// describes, so the server's (tenant, user, account_uuid, fetched_at) unique key collapses a
// replay for free — which is what makes re-scanning an old rollout safe.
//
// Rows are cleared only up to the last CONFIRMED store. A non-2xx stops THAT ACCOUNT's loop with
// the rest still queued: the API rejects an entire payload on one bad field, and clearing past a
// failure would silently drop every row behind it. One tenant refusing a row says nothing about
// another, so each account drains and clears its own queue.
//
// `deps.deadline` is now SHARED across the accounts rather than granted to each: the caller passes
// the same epoch to every drain, so N linked accounts split one hook budget instead of
// multiplying it. Whatever the deadline cuts off stays on disk for the next turn end.
export async function drainRateLimitSnapshots(key, session, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const now = orDefault(deps.now, Date.now);
  const readPending = deps.readPendingRateLimits || _readPendingRateLimits;
  const clearPending = deps.clearPendingRateLimits || _clearPendingRateLimits;
  if (!session || !session.token) return { posted: 0, reason: 'no-token' };

  const pending = readPending(key, deps);
  if (!pending.length) return { posted: 0, reason: 'empty' };

  const url = `${apiBase()}${ENDPOINTS.usageSnapshot}`;
  // Epoch ms after which no further row is STARTED, plus a per-request cap. Null deadline = drain
  // the whole queue (the CLI path). Hooks pass one, for the same reason flushQueue takes one: this
  // is a serial loop over up to MAX_PENDING rows, so a per-request bound alone costs N × that
  // bound — 40 rows × POST_TIMEOUT_MS is minutes against a 7.5s budget, and Codex kills the hook
  // long before it returns, taking the state write and the segment flush that follow it with it.
  // Deferring is free: unposted rows stay on disk and the next turn end retries them.
  const deadline = orDefault(deps.deadline, null);
  const capMs = orDefault(deps.timeoutMs, null);
  // Enrich unidentified readings using the billing-first identity, including existing queues.
  // Keep a captured identity together so a later sign-in cannot supply another account's email.
  const { account_uuid, account_email, ...identity } = (deps.usageIdentityFields || usageIdentityFields)(deps);

  let posted = 0;
  let stopped = null;
  for (let i = 0; i < pending.length; i++) {
    if (deadline !== null && now() >= deadline) {
      stopped = 'deadline';
      break;
    }
    // Never hand a request more time than the budget has left, or the last one overruns the kill.
    const remaining = deadline === null ? null : Math.max(1, deadline - now());
    const perRequest = remaining === null
      ? capMs
      : (capMs === null ? remaining : Math.min(capMs, remaining));
    const postOpts = perRequest === null ? { fetchImpl } : { fetchImpl, timeoutMs: perRequest };
    let res = null;
    try {
      // The row last, so a stored observation can never be overwritten by an identity field.
      const row = pending[i];
      const rowIdentity = row.account_uuid != null || row.account_email != null
        ? {} : { account_uuid, account_email };
      res = await postJson(url, session, { ...identity, ...rowIdentity, ...row }, postOpts);
    } catch (e) {
      stopped = 'network';
      break;
    }
    if (res.status < 200 || res.status >= 300) {
      stopped = 'rejected';
      break;
    }
    posted += 1;
  }
  // The rows themselves, not a count: the queue is re-read inside clearPending and its indices may
  // have shifted under us. See the note there.
  if (posted > 0) clearPending(key, pending.slice(0, posted), deps);
  // Rows still on disk when the drain stopped, WHATEVER stopped it. `pending.length - posted` is
  // exact on every path because a non-success breaks immediately, so `posted` is always the index
  // the loop stopped at. It used to be counted only on the deadline path, which reported `deferred:
  // 0` for a queue stalled behind a rejection — the one case where the number matters most, since a
  // non-2xx keeps the failed row AND its whole tail (REVIEW §R4). `reason` names which of the three
  // it was, so a caller can tell "still working through a backlog" from "stuck". R-numbers cite
  // docs/plans/2026-09-10-sections/REVIEW.md.
  return { posted: posted, deferred: pending.length - posted, reason: orDefault(stopped, 'drained') };
}
