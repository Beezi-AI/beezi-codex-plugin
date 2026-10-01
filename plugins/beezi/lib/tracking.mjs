import fs from 'fs';
import { trackingStateFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

const STATE_VERSION = 1;

// How long one tracking.json read-modify-write may hold its lock. The section is a small read, an
// object spread and one atomic write — orders of magnitude under this — so the lease exists to
// bound a crashed holder, not to fit the work.
const TRACKING_LOCK_LEASE_MS = 5_000;

// Mirror of the server's TrackingMode enum — the whoami contract, never string-matched inline.
export const TrackingMode = Object.freeze({
  LIVE: 'live',
  BACKFILL_ONLY: 'backfill_only',
  DISABLED: 'disabled',
});

// Cached tenant tracking state, refreshed from whoami on SessionStart and from any 403
// TRACKING_DISABLED. PER ACCOUNT, under accounts/<key>/ — the policy is a TENANT's, and two linked
// workspaces disagree about it routinely: one in audit mode, one live. A machine-wide file would
// let whichever whoami answered last darken the other tenant's reporting.
//
// It lives outside state/ and queue/, the only two directories pruneStale() sweeps, for the reason
// it always did: an expiring gate would silently re-enable dark-mode tenants.
//
// The gate is deliberately FAIL-OPEN: a missing/corrupt file or an old server (no trackingMode
// in whoami) means "allow" — the server's TrackingEnabledGuard is the actual boundary, and
// failing closed would dark-mode every fresh install until its first whoami.
export function readTrackingState(key, deps = {}) {
  const read = orDefault(deps.readJsonImpl, readJson);
  const raw = read(trackingStateFile(key), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

export function writeTrackingState(key, state, deps = {}) {
  const write = orDefault(deps.writeJsonImpl, writeJsonSecure);
  // 0600 like every other file in the account directory; best-effort — a disk failure must never
  // break a hook.
  try {
    write(trackingStateFile(key), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

// One read for every predicate below, so a caller that already holds an account's state (the
// audit, which reads it once and then asks four questions of it) hands its own reader in rather
// than re-opening the file — and so a test that injects one reader steers all of them.
function stateFor(key, deps) {
  const read = orDefault(deps.readTrackingStateImpl, readTrackingState);
  return read(key, deps);
}

export function isLiveTrackingAllowed(key, deps = {}) {
  const mode = orDefault((stateFor(key, deps) || {}).trackingMode, null);
  if (mode === TrackingMode.BACKFILL_ONLY || mode === TrackingMode.DISABLED) return false;
  return true;
}

// Mirrors the server's derivation: every mode except `disabled` is offered the one-time pull
// until it completes — paid tenants included, not just audit ones. A null mode means a
// pre-audit server: it has no backfill routes, so no hint.
export function shouldBackfill(key, deps = {}) {
  const state = stateFor(key, deps);
  if (!state) return false;
  if (state.trackingMode == null) return false;
  if (state.backfillCompleted === true) return false;
  return state.trackingMode !== TrackingMode.DISABLED;
}

// The state belongs to an account, but the server's pull record is per (tenant, user, tool): a
// logout→login into another workspace must not inherit the previous one's flags even under the
// same key. The OAuth client id changes on every login (dynamic registration), so it is the
// natural binding key; email is the fallback for states recorded before the id was known.
//
// FAIL-OPEN on a null `identity`, which is reachable: lib/accounts.mjs's `sessionFor` falls back
// to the stored row's clientId, and a row migrated from a pre-0.13 install whose credential blob
// carried no client_id has none. Such an account is treated as matching whatever is stored, which
// is the same posture the rest of this module takes — the server is the boundary.
export function matchesIdentity(key, identity, deps = {}) {
  const state = stateFor(key, deps);
  if (!state || !state.identity || !identity) return true;
  return state.identity === identity;
}

// Merge `patch` over the stored state. Every mutator below goes through this: writing a bare
// object instead drops whatever fields the caller did not know about, which is exactly how a
// whoami refresh used to clobber the linkedAt stamp written at login.
//
// ONE rank-3 `shared:tracking-<key>` lock around the WHOLE read-modify-write (G-8-3 / R3). The
// read and the write are separately safe — writeJsonSecure is atomic, so a reader never sees a
// torn file — and that is precisely why the hazard is invisible without a lock: two processes that
// both read the same state and then both write it produce two well-formed files, and the second
// one silently erases the first one's field. `markLinked` losing to a concurrent `recordWhoami` is
// that bug. R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// THE NAME CARRIES THE KEY, and the fan-out must therefore write one account at a time. Two
// accounts patched concurrently in ONE process would be two rank-3 locks under different names,
// which lib/single-instance-lock.mjs refuses as 'lock-order' — a permanent failure, so the second
// account's dark-mode verdict would be dropped every time rather than merely deferred. Every
// caller in the sweep loops accounts serially for exactly this reason.
//
// Bare READS are deliberately NOT locked. Nothing they could tear, and locking them would nest a
// second rank-3 lock inside this one at flushQueue's `isLiveTrackingAllowed()` — refused as
// 'lock-order', which is a permanent failure, not a busy lock.
//
// Returns the outcome rather than swallowing it: 'held'/'contended' mean another writer has it and
// the next whoami re-writes what we skipped, while 'lock-order' is a bug in the CALLER's
// acquisition sequence that will fail forever and must be visible to whoever wired it.
function patchTrackingState(key, patch, deps = {}) {
  const run = withLock(
    sharedLock(`tracking-${key}`),
    { leaseMs: TRACKING_LOCK_LEASE_MS },
    () => writeTrackingState(key, { ...orDefault(readTrackingState(key, deps), {}), ...patch }, deps),
  );
  return run.ok
    ? { written: true, skipped: false, reason: null }
    : { written: false, skipped: true, reason: run.reason };
}

// When this account was linked on this machine, as an ISO instant. The audit uses it to skip
// transcripts that live tracking already owns; it used to be approximated by the credentials
// file's mtime, which is only written by the DPAPI/plaintext fallbacks — on any machine with a
// real credential store (CredMan, Keychain, secret-tool) that file never exists and the guard
// silently never fired.
export function markLinked(key, deps = {}) {
  return patchTrackingState(key, { linkedAt: new Date().toISOString() }, deps);
}

export function linkedAtMs(key, deps = {}) {
  const at = (stateFor(key, deps) || {}).linkedAt;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// Persist the whoami verdict. `identity` is the current login's binding key (client id or email).
export function recordWhoami(key, who, identity, deps = {}) {
  if (!who || who.valid !== true) return { written: false, skipped: false, reason: 'not-valid' };
  return patchTrackingState(
    key,
    {
      trackingMode: orDefault(who.trackingMode, null),
      tenantTier: orDefault(who.tenantTier, null),
      backfillCompleted: who.backfillCompleted === true,
      identity: orDefault(identity, null),
      fetchedAt: new Date().toISOString(),
      reason: null,
    },
    deps,
  );
}

// A live endpoint answered 403 TRACKING_DISABLED: the server has spoken — this ACCOUNT goes dark
// until its next whoami says otherwise. One tenant darkening is never a verdict on the machine,
// so no other account's state is touched.
export function markTrackingDisabled(key, reason, deps = {}) {
  return patchTrackingState(
    key,
    {
      trackingMode: TrackingMode.DISABLED,
      fetchedAt: new Date().toISOString(),
      reason: orDefault(reason, null),
    },
    deps,
  );
}

// The pull sealed (locally observed or server-confirmed) — the audit fast path keys off this.
export function markBackfillCompleted(key, deps = {}) {
  return patchTrackingState(key, { backfillCompleted: true, fetchedAt: new Date().toISOString() }, deps);
}

export function clearTrackingState(key) {
  try {
    // unlinkSync instead of rmSync (Node 14.14+): this deletes a single state file, and the
    // catch swallows ENOENT exactly as `force: true` did.
    fs.unlinkSync(trackingStateFile(key));
  } catch { /* best-effort */ }
}
