import {
  getCredentials as _getCredentials,
  setCredentials as _setCredentials,
  deleteCredentials as _deleteCredentials,
  credentialRevision,
} from './credentials.mjs';
import { refreshTokens as _refreshTokens } from './oauth.mjs';
import { recordIssue as _recordIssue, DIAGNOSTIC_CODES } from './diagnostics.mjs';
import { acquireLock, sharedLock } from './single-instance-lock.mjs';
import { orDefault } from './compat.mjs';
import { environment } from './paths.mjs';
import { checkEnvironment, shouldCheckEnvironment } from './env-guard.mjs';

const SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
// `clientId` rides along with the token because the two are one credential from the server's point
// of view: the bearer says who, the X-Beezi-Client header says which machine row. Returning the id
// here is what replaced the module-global in lib/machine-identity.mjs — with several accounts
// linked, a global would attach one account's client id to another account's bearer.
const result = (state, reason, accessToken = null, clientId = null) => ({
  state, reason, accessToken, clientId,
});
const ready = (creds) => result('ready', null, creds.access_token, orDefault(creds.client_id, null));

// The index write is best-effort but NOT fire-and-forget: withLock is immediate-fail, so a single
// attempt loses to any momentary holder. Two retries at 100ms cover ordinary contention without
// putting a visible pause in a hook.
const REVOKE_ATTEMPTS = 3;
const REVOKE_RETRY_MS = 100;

/**
 * Mark an account revoked — AFTER the refresh lock has been released, never inside it.
 *
 * lib/accounts.mjs mutates the index under sharedLock('accounts-index'), rank 3 in LOCK_ORDER. The
 * refresh lock is sharedLock('token-refresh-<key>'), also rank 3, under a different name — and
 * lib/single-instance-lock.mjs refuses a lock of equal-or-finer rank than one this process already
 * holds unless the NAME matches. Called from inside the lock this write would be refused every
 * time, so an invalid grant would look like a transient error forever: hooks would retry a grant
 * the server has already rejected and /beezi:me would never say to sign in again.
 *
 * THIS WRITE IS THE ONLY CHANCE TO MARK THE ROW. deleteCreds has already committed by the time we
 * get here, so the next hook's getCreds returns null and getAuthentication answers
 * unlinked/no-credentials — it never meets the invalid grant again. A dropped write therefore does
 * not "heal on the next hook": it leaves a row that is 'linked' with no credentials behind it,
 * which linkedSessions silently skips forever and /beezi:me never explains. Hence the retry, and
 * hence the diagnostic when the retry is exhausted rather than a silent return.
 *
 * BOTH refusals are retried, including BEEZI_LOCK_ORDER. That code normally means the CALLER built
 * a bad acquisition sequence and retrying is futile — but here the blocker is another account's
 * refresh lock held concurrently in this same process (lock bookkeeping is process-global, and
 * linkedSessions resolves accounts concurrently), and that sibling does release. The refusal is
 * transient for this one call site, and only this one.
 *
 * Never throws. The caller's verdict is already decided and a failed bookkeeping write must not
 * replace reauth_required with an exception — getAccessToken's contract is string|null.
 *
 * Imported lazily because lib/accounts.mjs imports this module back for linkedSessions(). Both
 * directions are lazy, so neither module is half-evaluated when the other loads.
 */
async function markAccountRevoked(key, deps, recordIssue) {
  const sleep = orDefault(deps.sleep, ms => new Promise(r => setTimeout(r, ms)));
  for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(REVOKE_RETRY_MS);
    try {
      const accounts = await import('./accounts.mjs');
      await accounts.updateAccount(key, { status: accounts.AccountStatus.REVOKED }, deps);
      return true;
    } catch (error) { /* contended, refused, or the index is unreadable — try again, then report */ }
  }
  // The row is now a credential-less 'linked' entry that nothing will correct on its own. Say so.
  try { recordIssue({ code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED }); } catch (error) { /* never fatal */ }
  return false;
}

// Preserve the reason a token is unavailable for status/login callers. Analytics callers can
// continue using getAccessToken, which projects this result onto token-or-null.
export async function getAuthentication(key, deps = {}, options = {}) {
  environment.assertAccountKey(key);
  if (shouldCheckEnvironment(deps, 'getCredentials', 'checkEnvironment')) {
    const guard = (deps.checkEnvironment || checkEnvironment)();
    if (guard.status !== 'ok' && guard.status !== 'migrated') return result('unavailable', 'environment-blocked');
  }
  const getCreds = orDefault(deps.getCredentials, _getCredentials);
  const setCreds = orDefault(deps.setCredentials, _setCredentials);
  const deleteCreds = orDefault(deps.deleteCredentials, _deleteCredentials);
  const refresh = orDefault(deps.refreshTokens, _refreshTokens);
  const now = orDefault(deps.now, Date.now);
  const sleep = orDefault(deps.sleep, ms => new Promise(r => setTimeout(r, ms)));
  const recordIssue = orDefault(deps.recordIssue, _recordIssue);
  const fresh = c => c && orDefault(c.expires_at, 0) - now() > SKEW_MS;
  let creds;
  try { creds = await getCreds(key, deps); } catch { return result('unavailable', 'credential-store'); }
  if (!creds) return result('unlinked', 'no-credentials');
  if (!options.forceRefresh && fresh(creds)) return ready(creds);

  const before = creds;
  const acquired = acquireLock(sharedLock(`token-refresh-${key}`), { leaseMs: 30_000 });
  if (!acquired.ok) {
    await sleep(750);
    try { creds = await getCreds(key, deps); } catch { return result('unavailable', 'credential-store'); }
    if (fresh(creds) && (!options.forceRefresh || creds.access_token !== before.access_token)) return ready(creds);
    return result('refreshing', 'refresh-in-progress');
  }
  // The locked section assigns its verdict rather than returning it. A `return` inside the try
  // would pass through the `finally` that releases the lock, leaving nowhere to do the index write
  // that has to happen after the release — see markAccountRevoked.
  let verdict;
  let revokeAfterRelease = false;
  try {
    // The pre-lock snapshot may already have been rotated by a different hook.
    creds = await getCreds(key, deps);
    if (!creds) {
      verdict = result('unlinked', 'no-credentials');
    } else if (fresh(creds) && (!options.forceRefresh || creds.access_token !== before.access_token)) {
      verdict = ready(creds);
    } else {
      const expectedRevision = credentialRevision(creds);
      const r = await refresh({ tokenEndpoint: creds.token_endpoint,
        clientId: creds.client_id, refreshToken: creds.refresh_token }, deps);
      if (!acquired.handle.verify().ok) {
        verdict = result('unavailable', 'refresh-lock-lost');
      } else if (r.invalidGrant) {
        await deleteCreds(key, deps, { expectedRevision });
        // Only once the delete has COMMITTED. deleteCreds throws CREDENTIALS_SUPERSEDED when a
        // logout or a newer login won the race, and marking the row revoked then would kill the
        // login that just superseded this one.
        revokeAfterRelease = true;
        verdict = result('reauth_required', 'invalid-grant');
      } else if (!r.tokens || !r.tokens.access_token) {
        recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED });
        verdict = result('unavailable', 'refresh-failed');
      } else {
        const next = { ...creds, access_token: r.tokens.access_token,
          refresh_token: orDefault(r.tokens.refresh_token, creds.refresh_token),
          expires_at: now() + orDefault(r.tokens.expires_in, DEFAULT_EXPIRES_IN_S) * 1000 };
        // Login/logout share the commit lock and change the revision. A delayed response must
        // never replace a later login or recreate a deleted credential set.
        await setCreds(key, next, deps, { expectedRevision });
        verdict = ready(next);
      }
    }
  } catch (error) {
    verdict = result('unavailable', 'credential-or-refresh-failure');
    if (error && error.code === 'CREDENTIALS_SUPERSEDED') {
      try {
        const current = await getCreds(key, deps);
        if (fresh(current)) verdict = ready(current);
        else if (!current) verdict = result('unlinked', 'no-credentials');
      } catch { /* temporary storage failure */ }
    }
  } finally {
    acquired.handle.release();
  }
  // Bookkeeping only: the verdict stands whether or not the index write lands.
  if (revokeAfterRelease) await markAccountRevoked(key, deps, recordIssue);
  return verdict;
}

export async function getAccessToken(key, deps = {}, options = {}) {
  return (await getAuthentication(key, deps, options)).accessToken;
}
