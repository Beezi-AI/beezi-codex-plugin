import fs from 'fs';
import path from 'path';
import {
  recordIssue as _recordIssue,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SOURCES,
  AUTH_STATES,
  AUTH_REASONS,
  isKnownAuthReason,
} from './diagnostics.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { authStateFile } from './paths.mjs';

// Every authentication diagnostic in one place, so the call sites that own the state changes stay
// one line long and none of them has to know the code vocabulary.
//
// Nothing here throws: an authentication path must never fail because a diagnostic could not be
// written, and recordIssue is already consent-gated and self-suppressing.
const safely = (fn) => { try { return fn(); } catch { return false; } };

// lib/token.mjs answers with hyphenated reasons; the portal's vocabulary is underscored. Listed
// explicitly: a reason with no portal equivalent is sent as null rather than guessed at.
const TOKEN_REASONS = Object.freeze({
  'no-credentials': 'no_credentials',
  'refresh-in-progress': 'refresh_in_progress',
  'invalid-grant': 'invalid_grant',
  'credential-store': 'storage_unavailable',
});

// A token reason mapped through the table; a value already in the portal's vocabulary passes as-is.
export function toAuthReason(reason) {
  if (reason == null) return null;
  if (Object.prototype.hasOwnProperty.call(TOKEN_REASONS, reason)) return TOKEN_REASONS[reason];
  return isKnownAuthReason(reason) ? reason : null;
}

// lib/token.mjs results carry `state`; the portal-shaped ones carry `authState`. A ready token
// result has no reason, which the portal spells `ok`.
function normalize(result) {
  const authState = result.authState != null ? result.authState : result.state;
  const reason = toAuthReason(result.reason);
  return { authState, reason: authState === AUTH_STATES.READY && reason == null ? AUTH_REASONS.OK : reason };
}

// The account's last recorded state, `{ lastState, lastReason, at }`, or {} — never a token.
export function readAuthState(account) {
  try {
    const value = readJson(authStateFile(account), null);
    return value == null || typeof value !== 'object' ? {} : value;
  } catch {
    return {}; // a malformed key names no file
  }
}

// Written only on a transition, so a steady state costs one read per call and no write.
export function recordLastAuthState(account, authState, reason) {
  const state = readAuthState(account);
  if (state.lastState === authState && state.lastReason === reason) return false;
  try {
    const file = authStateFile(account);
    // Linking creates the account directory and logout removes it; a racing hook must not revive it.
    if (!fs.existsSync(path.dirname(file))) return false;
    writeJsonSecure(file, { ...state, lastState: authState, lastReason: reason, at: Date.now() });
    return true;
  } catch {
    return false; // a store we cannot write is never worth failing a hook over
  }
}

export function wasLastStateReady(account) {
  const state = readAuthState(account);
  return state.lastState == null || state.lastState === AUTH_STATES.READY;
}

// An unreadable record reads as "changed": one diagnostic too many beats one never sent.
function isUnchanged(authState, reason, account) {
  if (account == null) return false;
  const last = readAuthState(account);
  return last.lastState === authState && last.lastReason === reason;
}

// The comparison-and-record half. `ready/ok` is deliberately silent: it is the normal case. So is a
// result identical to the last recorded state — the code is `auth_state_changed`, and nothing
// changed. That gate is what stops a permanently unlinked machine emitting a fresh event on every
// hook. It never writes the last state; settleAuthResult does, after this call.
export function recordAuthResult(result, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  return safely(() => {
    if (result == null) return false;
    const { authState, reason } = normalize(result);
    const source = deps.source;
    if (deps.skipUnchanged !== false && isUnchanged(authState, reason, deps.account)) return false;
    if (authState === AUTH_STATES.READY) {
      if (reason !== AUTH_REASONS.RECOVERED) return false;
      return recordIssue({
        code: DIAGNOSTIC_CODES.AUTH_RECOVERED, source,
        authState: AUTH_STATES.READY, reason: AUTH_REASONS.RECOVERED,
      });
    }
    // Two reasons have a code of their own; everything else is the generic transition.
    const code = reason === AUTH_REASONS.STORAGE_CONFLICT
      ? DIAGNOSTIC_CODES.CREDENTIAL_MIGRATION_CONFLICT
      : (reason === AUTH_REASONS.REFRESH_INTERRUPTED
        ? DIAGNOSTIC_CODES.REFRESH_INTERRUPTED
        : DIAGNOSTIC_CODES.AUTH_STATE_CHANGED);
    return recordIssue({ code, source, authState, reason });
  });
}

// The token funnel: every lib/token.mjs result for `account` passes through here. The first ready
// after any non-ready state becomes `recovered`; the result is recorded, then stored as the new
// last state. The caller's result object is never altered — its reason stays C's own.
export function settleAuthResult(account, result, deps = {}) {
  return safely(() => {
    // The env guard refused this data root: nothing may be written into it, not even a hint.
    if (result == null || result.reason === 'environment-blocked') return false;
    const { authState, reason } = normalize(result);
    let recovering = false;
    try {
      recovering = authState === AUTH_STATES.READY && !wasLastStateReady(account);
    } catch { /* unknown: report `ok`, never a false recovery */ }
    const recorded = recordAuthResult(
      { authState, reason: recovering ? AUTH_REASONS.RECOVERED : reason },
      { ...deps, account },
    );
    recordLastAuthState(account, authState, authState === AUTH_STATES.READY ? AUTH_REASONS.OK : reason);
    return recorded;
  });
}

// The only place `logged_out` is emitted, recorded before the account's state is cleared.
export function recordLogout(deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.AUTH_STATE_CHANGED,
    source: DIAGNOSTIC_SOURCES.LOGOUT,
    authState: AUTH_STATES.UNLINKED,
    reason: AUTH_REASONS.LOGGED_OUT,
  }));
}

// Logout removed the local credentials but the server never confirmed the revocation. The reason
// comes from the status alone: 401/403 are what the server said, anything else means it was
// never reached.
export function recordLogoutUnconfirmed(httpStatus, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const reason = httpStatus === 401
    ? AUTH_REASONS.UNAUTHORIZED
    : (httpStatus === 403 ? AUTH_REASONS.FORBIDDEN : AUTH_REASONS.PROBE_UNREACHABLE);
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.LOGOUT_UNLINK_UNCONFIRMED,
    source: DIAGNOSTIC_SOURCES.LOGOUT,
    reason,
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
  }));
}

// Interactive login failed; `reason` is the login/probe outcome the thrown error carried. Delivery
// is the MCP server's periodic flush — there is no detached worker to spawn here.
export function recordLoginFailure(reason, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.LOGIN_FAILED,
    source: DIAGNOSTIC_SOURCES.LOGIN,
    reason: toAuthReason(reason),
  }));
}

// The MCP bridge could not start or complete its handshake.
export function recordMcpStartupFailure(error, reason, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const why = toAuthReason(reason);
  // An unlinked machine is a normal state, not a bridge that failed to start.
  if (why === AUTH_REASONS.NO_CREDENTIALS || why === AUTH_REASONS.LOGGED_OUT) return false;
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.MCP_STARTUP_FAILED,
    source: DIAGNOSTIC_SOURCES.MCP_BRIDGE,
    error,
    reason: why,
  }));
}
