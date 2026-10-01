import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageObservationsFile, usagePendingFile } from './paths.mjs';
import { orDefault, parseTimestampMs } from './compat.mjs';
import { canonicalPlan } from './billing.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

// Codex stamps its whole rate-limit block on every `token_count` event and PERSISTS it to the
// rollout, so unlike the Claude plugin — which had to capture from the status line because no hook
// payload carries rate_limits — the data is already on disk by the time any hook runs. That single
// difference is why this module reads a transcript instead of a stdin payload, and why a session
// missed entirely is recoverable by a later scan rather than lost.
//
// Shape, measured across 201 local rollouts spanning 2025-12 → 2026-09:
//   payload.rate_limits = {
//     limit_id, limit_name,
//     primary:   { used_percent, window_minutes, resets_at },
//     secondary: { used_percent, window_minutes, resets_at },
//     credits: { has_credits, unlimited, balance },
//     individual_limit, spend_control_reached, plan_type, rate_limit_reached_type }

// WINDOWS ARE IDENTIFIED BY SPAN, NEVER BY SLOT. `primary`/`secondary` are not stable roles: of
// 10338 local observations, 7240 had primary=300/secondary=10080, but 2775 carried the WEEKLY
// window in the `primary` slot with `secondary: null`, and 315 carried a 30-day window there.
// Reading `primary` as "the 5-hour window" mislabels 30% of all observations — weekly utilisation
// written into the five_hour column. The parity plan's own description of this payload (repo-root
// docs/plans/2026-07-27-codex-parity-plan.md) has that bug; do not reintroduce it here.
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
// The 30-day window free plans report — 315 of the 10338 local observations. It has no dedicated
// column on UsageSnapshotRequestDto, which is why it used to make the WHOLE observation vanish
// (the row was dropped, not just the window). It now rides the whitelisted `limits[]` array
// instead, so the reading survives without any of it being mislabelled as a 5h or 7d number.
const MONTHLY_MINUTES = 43200;

// Same thresholds as the Claude plugin's lib/statusline-usage.mjs, so a cross-agent comparison is
// not an artefact of two different debounces. The CLOCK still differs and cannot be made to match:
// Claude samples a live status line, so its floor is wall-clock elapsed, while a rollout is a log
// replayed after the fact, so this floor is elapsed BETWEEN THE READINGS. Same spacing in the
// series; a backfill just produces it all at once.
const MATERIAL_DELTA_PCT = 5;
// Codex reports an exhausted window as 99.0 about as often as 100.0 (measured on real rollouts), so
// the exhaustion line is 99. Crossing it DOWN is material too: that reading is what shows a limit
// recovered before its reset time.
const EXHAUSTED_PCT = 99;
const RECORD_FLOOR_MS = 15 * 60 * 1000;
const MAX_PENDING = 40;

// A percentage that is not a finite number at or above zero cannot be sent: the API rounds floats
// on ingest but passes non-finite values through to @IsInt(), and its @Min(0) rejects negatives —
// either way a 400, and a 400 breaks the drain WITHOUT clearing, so one bad row stalls every row
// queued behind it until MAX_PENDING evicts them.
function readPct(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
  return value;
}

function readWindow(node) {
  if (!node || typeof node !== 'object') return null;
  const pct = readPct(node.used_percent);
  const resetsAt = typeof node.resets_at === 'number' ? node.resets_at : null;
  const windowMinutes = typeof node.window_minutes === 'number' ? node.window_minutes : null;
  if (pct === null && resetsAt === null) return null;
  return { pct: pct, resetsAt: resetsAt, windowMinutes: windowMinutes };
}

// Both slots are inspected because the mapping is by span. A span with no column of its own is
// still classified — into `monthly`, which travels in limits[] rather than in a column — and a span
// this module does not recognise at all yields nothing, which is what keeps a future window out of
// the wrong column instead of guessing at it.
export function classifyWindows(limits) {
  const out = { fiveHour: null, sevenDay: null, monthly: null };
  if (!limits || typeof limits !== 'object') return out;
  const slots = ['primary', 'secondary'];
  for (let i = 0; i < slots.length; i++) {
    const w = readWindow(limits[slots[i]]);
    if (!w) continue;
    if (w.windowMinutes === FIVE_HOUR_MINUTES) out.fiveHour = w;
    else if (w.windowMinutes === SEVEN_DAY_MINUTES) out.sevenDay = w;
    else if (w.windowMinutes === MONTHLY_MINUTES) out.monthly = w;
  }
  return out;
}

// Guards the class of failure, not one member of it: a millisecond value read as seconds lands in
// year +058639, and an expanded-year ISO string fails the API's @IsISO8601(). Out of range means
// the key is absent, never a malformed string.
function isoInRange(d) {
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return d.toISOString();
}

function epochToIso(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return null;
  return isoInRange(new Date(seconds * 1000));
}

// fetched_at is half the server's (tenant, user, account_uuid, fetched_at) dedup key and lands on
// an @IsISO8601() column, so it earns the same guard the resets_at values get. The server's own
// toStrictDate drops an unparseable timestamp silently while still answering 200 "stored", and the
// drain would then clear a row that was never written — so the rejection has to happen here.
function recordTimestampToIso(value) {
  // The typeof guard stays AHEAD of the parse: parseTimestampMs coerces its input the same way,
  // so a bare number would otherwise be read as a year and stored as a plausible ISO date.
  if (typeof value !== 'string' || value === '') return null;
  const parsed = parseTimestampMs(value);
  if (parsed === null) return null;
  return isoInRange(new Date(parsed));
}

export function isMaterial(next, last) {
  if (!next) return false;
  if (!last) return true;
  if (next.resetsAt !== last.resetsAt) return true;
  if (next.pct === null) return false;
  const lastPct = last.pct == null ? 0 : last.pct;
  if ((next.pct >= EXHAUSTED_PCT) !== (lastPct >= EXHAUSTED_PCT)) return true;
  return Math.abs(next.pct - lastPct) >= MATERIAL_DELTA_PCT;
}

// The sub-fields the five whitelisted columns cannot express, for the `raw` jsonb passthrough
// (`usage-snapshot.request.dto.ts` in the hb-ai-agent-portal repo, "stored as jsonb passthrough").
// A NAMED list, never a spread of the whole block: the list is what makes the round-trip
// assertable, and it stops a future Codex build's new — possibly large — field from riding along
// unreviewed.
//
// What each one buys: `credits.*` is the difference between "out of window" and "out of money",
// which today is only recoverable AFTER the fact from an insufficient_quota error
// (`classifyError` in delta-codex.mjs); `plan_type` is the server's own plan label for
// this reading; `spend_control_reached` and `rate_limit_reached_type` say why a limit bit;
// `primary`/`secondary` preserve the untranslated windows including the `window_minutes` that
// classified them.
//
// `limit_name` and `individual_limit` are measured on the block and deliberately absent: they are
// not on §4 G-4-9's list and carry nothing we can read.
const RAW_KEYS = Object.freeze([
  'limit_id', 'plan_type', 'credits', 'spend_control_reached', 'rate_limit_reached_type',
  'primary', 'secondary',
]);

function rawBlock(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const out = {};
  let any = false;
  for (let i = 0; i < RAW_KEYS.length; i++) {
    const key = RAW_KEYS[i];
    // hasOwnProperty, not a bare lookup: `limits` is parsed off a file on disk, and an
    // Object.prototype key like `constructor` would otherwise resolve to something that is not data
    // at all. Same guard `canonicalPlan` in lib/billing.mjs puts on a reported plan label.
    if (!Object.prototype.hasOwnProperty.call(limits, key)) continue;
    out[key] = limits[key];
    any = true;
  }
  return any ? out : null;
}

// One observation per token_count that carries a window this module recognises. `observedAt` is
// the RECORD's timestamp, not wall-clock now: a rollout is a log, so a drain running an hour late
// must still report when each reading was true. That choice also makes replay free — re-scanning a
// rollout yields a byte-identical fetched_at, which the server's unique key collapses.
export function rateLimitObservationFromRecord(rec) {
  const p = rec && rec.payload;
  if (!rec || rec.type !== 'event_msg' || !p || p.type !== 'token_count') return null;
  const limits = p.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const cls = classifyWindows(limits);
  if (!cls.fiveHour && !cls.sevenDay && !cls.monthly) return null;
  const observedAt = recordTimestampToIso(rec.timestamp);
  if (observedAt === null) return null;
  return {
    observedAt: observedAt,
    fiveHour: cls.fiveHour,
    sevenDay: cls.sevenDay,
    monthly: cls.monthly,
    limitId: typeof limits.limit_id === 'string' ? limits.limit_id : null,
    // The plan the SERVER attached to this reading. Preferred over the auth.json id_token decode as
    // a plan source: no JWT parse, no signature we do not check, and it is stamped by the same event
    // that carries the quota. Null on roughly two thirds of local observations (older builds), which
    // is exactly why it is an extra rung above the ladder and never a replacement for it.
    // NOTE: this lives on the OBSERVATION, never on the row — see buildRow.
    planType: typeof limits.plan_type === 'string' && limits.plan_type !== '' ? limits.plan_type : null,
    raw: rawBlock(limits),
  };
}

// The API deep-whitelists nested limit entries: the global pipe traverses @ValidateNested()
// (`usage-snapshot.request.dto.ts` in the hb-ai-agent-portal repo), so ONE unknown key inside
// limits[] 400s the whole snapshot — and a 400 breaks the drain WITHOUT clearing. This is the
// Claude plugin's sanitizeLimit (lib/usage-snapshot-report.mjs in the beezi-claude-plugins repo)
// verbatim in shape: exactly the seven keys UsageSnapshotLimitDto declares, whatever the caller
// hands in. JSON.stringify drops the undefined ones, so `window_minutes` — the classifier, which
// the DTO has no column for — can never ride along even if someone passes a whole window object in.
export function sanitizeLimit(limit) {
  return {
    kind: limit.kind,
    group: limit.group,
    percent: limit.percent,
    severity: limit.severity,
    resets_at: limit.resets_at,
    is_active: limit.is_active,
    scope: limit.scope,
  };
}

// limits[] carries ONLY windows this contract has no dedicated column for — today just the 30-day
// one. The 5h and 7d windows already ride the top-level columns; promoting them here as well would
// hand the backend a second, duplicate view of the same numbers. Do not "complete" this by adding
// them.
function limitsFor(o) {
  if (o.monthly == null) return null;
  return [sanitizeLimit({
    kind: 'monthly',
    // Omitted rather than nulled, the same rule the identity fields follow: @IsOptional() skips an
    // absent key, while a null is a claim.
    percent: orDefault(o.monthly.pct, undefined),
    resets_at: orDefault(epochToIso(o.monthly.resetsAt), undefined),
  })];
}

// The five whitelisted columns, plus the two passthrough keys UsageSnapshotRequestDto declares for
// everything they cannot express: `limits` (@ValidateNested, deep-whitelisted — see sanitizeLimit)
// and `raw` (@IsObject jsonb passthrough). forbidNonWhitelisted rejects the WHOLE payload on an
// unknown key, so nothing speculative belongs here — and `plan_type` in particular does NOT: it has
// no column of its own, it travels inside `raw`, and the plan it names reaches the wire through the
// whitelisted `subscription_plan` that usage-report-codex.mjs resolves.
//
// null rather than absent for the two passthroughs is the shape the Claude plugin already ships
// (usage-snapshot-report.mjs in the beezi-claude-plugins repo posts `limits: null, raw: null`), and
// @IsOptional() skips a null.
function buildRow(o) {
  return {
    fetched_at: o.observedAt,
    five_hour_pct: o.fiveHour == null ? null : o.fiveHour.pct,
    five_hour_resets_at: o.fiveHour == null ? null : epochToIso(o.fiveHour.resetsAt),
    seven_day_pct: o.sevenDay == null ? null : o.sevenDay.pct,
    seven_day_resets_at: o.sevenDay == null ? null : epochToIso(o.sevenDay.resetsAt),
    limits: limitsFor(o),
    raw: orDefault(o.raw, null),
  };
}

// Debounce state is keyed by limit_id. Five local rollouts carry both a `codex` and a `premium`
// bucket; `premium` reports null windows today so it never reaches here, but if a build populates
// them, two independent series sharing one baseline would make the 5-point gate fire and suppress
// against the wrong previous reading.
function seriesFor(state, limitId) {
  const key = limitId == null ? '_' : String(limitId);
  const series = state[key];
  if (series == null) {
    return { key: key, lastFiveHour: null, lastSevenDay: null, lastMonthly: null, lastRecordedMs: 0 };
  }
  return {
    key: key,
    lastFiveHour: orDefault(series.lastFiveHour, null),
    lastSevenDay: orDefault(series.lastSevenDay, null),
    lastMonthly: orDefault(series.lastMonthly, null),
    lastRecordedMs: orDefault(series.lastRecordedMs, 0),
  };
}

// The plan the SERVER stamped on the most recent reading that named one, normalized through the one
// tier table (billing.mjs) rather than a second copy of it. Two rules, both load-bearing:
//
//  * a tier canonicalPlan does not recognise is NOT stored. 'unknown' as a plan reads as a fact on
//    the wire and would also leave billing.json permanently stale — the same failure `go` used to
//    cause (`canonicalPlan` in lib/billing.mjs).
//  * a `plan_type: null` reading (roughly two thirds of local observations, older Codex builds)
//    returns null here, and the caller must then leave the stored value ALONE rather than clear it.
function planLabelOf(observation) {
  const raw = observation == null ? null : observation.planType;
  if (typeof raw !== 'string' || raw === '') return null;
  return canonicalPlan(raw);
}

// The observed plan as persisted, or null. Read by the usage drain as rung 2 of its plan ladder.
export function readObservedPlan(deps = {}) {
  const file = deps.file == null ? usageObservationsFile() : deps.file;
  let state = readJson(file);
  if (state == null) state = {};
  const stored = state.observedPlan;
  if (!stored || typeof stored !== 'object') return null;
  const plan = typeof stored.plan === 'string' && stored.plan !== '' ? stored.plan : null;
  if (plan == null) return null;
  return {
    plan: plan,
    observedAt: typeof stored.observedAt === 'string' ? stored.observedAt : null,
  };
}

function queueBusy() {
  const error = new Error('Rate-limit queue is busy; retry this checkpoint');
  error.code = 'RATE_LIMIT_QUEUE_BUSY';
  return error;
}

/**
 * Queue the observations worth posting, once per linked account. Pure file I/O and arithmetic —
 * never network, so it is safe to run inside the hook budget.
 *
 * THE READING IS MACHINE-LEVEL, THE QUEUE IS NOT. A rate-limit block describes the ChatGPT account
 * Codex is signed into, not a Beezi tenant, so the debounce series and the observed plan stay in
 * one file: deciding materiality per account would multiply the 5-point gate by however many
 * workspaces happen to be linked and re-open the 15-minute floor for each of them. What is
 * per-account is DELIVERY — every linked tenant is owed the same row, and each drains and clears
 * its own copy.
 *
 * TWO LOCKS, TAKEN ONE AFTER THE OTHER AND NEVER NESTED. `shared:rate-limit-observations` covers
 * the series; `shared:rate-limit-pending-<key>` covers one account's queue. Both are rank 3, so
 * holding the first while reaching for the second would be refused as 'lock-order' — a permanent
 * failure, not a busy lock. The series section therefore ENDS before the first append begins.
 *
 * Returns `{ recorded, reason?, skippedKeys }`. A refused SERIES lock throws, exactly as before:
 * nothing was decided, so the checkpoint keeps its cursor and the whole window is retried. A
 * refused per-account queue is reported in `skippedKeys` instead — the series has already advanced
 * by then, and failing the entire checkpoint (its segments included) over one contended account's
 * sample, which the next reading re-observes within the 15-minute floor, would cost far more than
 * it saves.
 */
export function recordRateLimitObservations(observations, keys, deps = {}) {
  const decided = withLock(sharedLock('rate-limit-observations'), {},
    () => recordObservationsLocked(observations, deps));
  if (!decided.ok) throw queueBusy();
  const outcome = decided.value;
  const rows = outcome.rows;
  const skippedKeys = [];
  if (rows.length > 0) {
    for (const key of Array.isArray(keys) ? keys : []) {
      if (!appendPending(key, rows, deps)) skippedKeys.push(key);
    }
  }
  return { recorded: outcome.recorded, reason: outcome.reason, skippedKeys };
}

// One account's queue, under that account's own lock. Returns false when the lock was refused —
// see the contract on recordRateLimitObservations.
function appendPending(key, rows, deps) {
  const run = withLock(sharedLock(`rate-limit-pending-${key}`), {}, () => {
    const file = deps.pendingFile == null ? usagePendingFile(key) : deps.pendingFile;
    let state = readJson(file);
    if (state == null) state = {};
    const pending = Array.isArray(state.pending) ? state.pending : [];
    writeJsonSecure(file, { version: 1, pending: pending.concat(rows).slice(-MAX_PENDING) });
  });
  return run.ok;
}

function recordObservationsLocked(observations, deps) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return { recorded: 0, reason: 'no-observations', rows: [] };
  }
  const file = deps.file == null ? usageObservationsFile() : deps.file;
  let state = readJson(file);
  if (state == null) state = {};
  const series = state.series == null ? {} : state.series;
  // The rows this pass decided are worth sending. They are handed BACK rather than written here:
  // every linked account gets the same list, each into its own queue and under its own lock.
  const rows = [];

  // Rung 2 of the plan ladder, kept beside the debounce state because this file is root-level and
  // survives pruneStale's 14-day sweep (`pruneStale` in lib/prune.mjs) — the plan must outlive the
  // queue it was observed alongside. The baseline only moves FORWARD in observation time, and only
  // a reading that actually names a tier can move it: a null must leave the last known plan
  // standing.
  const storedPlan = state.observedPlan && typeof state.observedPlan === 'object'
    ? state.observedPlan : null;
  let observedPlan = storedPlan;
  let observedPlanMs = -1;
  if (storedPlan != null) {
    const storedMs = parseTimestampMs(storedPlan.observedAt);
    if (storedMs !== null) observedPlanMs = storedMs;
  }

  let recorded = 0;
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i];
    const s = seriesFor(series, o.limitId);
    const atMs = parseTimestampMs(o.observedAt);
    if (atMs === null) continue;
    // Before the debounce, deliberately: whether a READING is worth queueing says nothing about
    // whether the PLAN it names is worth remembering, and the plan is the cheaper of the two.
    const label = planLabelOf(o);
    if (label != null && atMs >= observedPlanMs) {
      observedPlan = { plan: label, observedAt: o.observedAt };
      observedPlanMs = atMs;
    }
    const material = isMaterial(o.fiveHour, s.lastFiveHour)
      || isMaterial(o.sevenDay, s.lastSevenDay)
      || isMaterial(o.monthly, s.lastMonthly);
    if (!material && atMs - s.lastRecordedMs < RECORD_FLOOR_MS) continue;
    rows.push(buildRow(o));
    recorded += 1;
    // The baseline only ever moves FORWARD. Unlike the Claude plugin's wall-clock debounce, this
    // floor is measured against a record's own timestamp, and two writers can interleave — a second
    // Codex session, or a subagent hook running beside the parent's checkpoint. An observation
    // older than one already recorded must not drag lastRecordedMs back (which reopens the
    // 15-minute window early) nor overwrite a newer reading with a staler one.
    const newer = atMs >= s.lastRecordedMs;
    series[s.key] = {
      lastFiveHour: newer && o.fiveHour ? o.fiveHour : s.lastFiveHour,
      lastSevenDay: newer && o.sevenDay ? o.sevenDay : s.lastSevenDay,
      lastMonthly: newer && o.monthly ? o.monthly : s.lastMonthly,
      lastRecordedMs: newer ? atMs : s.lastRecordedMs,
    };
  }
  // A plan CHANGE is worth a write of its own even when every reading was debounced away — that is
  // the free→plus transition this machine made without anyone running refresh, and the reason the
  // observed plan is worth having at all. A plan that merely repeats writes nothing.
  const planChanged = (storedPlan == null ? null : storedPlan.plan)
    !== (observedPlan == null ? null : observedPlan.plan);
  if (recorded === 0 && !planChanged) return { recorded: 0, reason: 'immaterial', rows: rows };

  // `pending` is gone from this file — it lives per account now — but a machine that migrated from
  // a pre-0.13 layout still has the emptied key here (lib/accounts.mjs splitUsageObservations), and
  // rewriting the record without it would be the one write that could resurrect a stale queue.
  const next = { version: 1, series: series, pending: [] };
  if (observedPlan != null) next.observedPlan = observedPlan;
  writeJsonSecure(file, next);
  if (recorded === 0) return { recorded: 0, reason: 'plan-only', rows: rows };
  return { recorded: recorded, rows: rows };
}

export function readPendingRateLimits(key, deps = {}) {
  const file = deps.pendingFile == null ? usagePendingFile(key) : deps.pendingFile;
  let state = readJson(file);
  if (state == null) state = {};
  return Array.isArray(state.pending) ? state.pending : [];
}

// Drops only the rows confirmed stored, re-reading state first so a row appended by another
// process mid-drain is not discarded along with them.
//
// Matched BY VALUE, never by index. The re-read is the whole point, and it is also what makes an
// index meaningless: another writer (a second Codex session, or a subagent hook running beside the
// parent's checkpoint) appending to a queue already at MAX_PENDING makes the slice(-MAX_PENDING)
// above evict from the FRONT, so every surviving index shifts left. Slicing a count off the front
// of the re-read queue would then take exactly as many never-posted rows as were evicted.
//
// fetched_at is the identity: it is half the server's (tenant, user, account_uuid, fetched_at)
// unique key, so two local rows sharing one can never both be stored — dropping both when one
// posts loses nothing the server would have kept.
export function clearPendingRateLimits(key, posted, deps = {}) {
  return withLock(sharedLock(`rate-limit-pending-${key}`), {},
    () => clearPendingLocked(key, posted, deps));
}

function clearPendingLocked(key, posted, deps) {
  const rows = Array.isArray(posted) ? posted : [];
  if (rows.length === 0) return;
  const file = deps.pendingFile == null ? usagePendingFile(key) : deps.pendingFile;
  let state = readJson(file);
  if (state == null) state = {};
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const sent = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].fetched_at != null) sent.add(rows[i].fetched_at);
  }
  const next = [];
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (row && sent.has(row.fetched_at)) continue;
    next.push(row);
  }
  writeJsonSecure(file, { ...state, version: 1, pending: next });
}
