import { getCredentials, deleteCredentials } from './credentials.mjs';
import { getAuthentication } from './token.mjs';
import { unlinkMachine } from './login.mjs';
import {
  AccountStatus, getAccount, getDefaultKey, listAccounts, removeAccount, setDefault,
  describeAccount,
} from './accounts.mjs';
import { REVOKED_DEFAULT_NOTE } from './accounts-cli.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';
import { orDefault } from './compat.mjs';
import { UserError, friendlyMessage } from './friendly-error.mjs';

// Removing ONE account, or every account, from this machine.
//
// The unit is an account, never "the machine": with several linked, unlinking the machine on one
// account's bearer would drop that account's row and leave the others reporting into a portal that
// no longer lists them. Every step below therefore names a key.
//
// WHAT IS NEVER TOUCHED. billing.json, telemetry.json, repo-map.json and state/ are MACHINE-level:
// the ChatGPT plan that pays for this Codex install, the crash-reporting consent, the repo map and
// the session bookkeeping all outlive any one Beezi account, and two of them (consent, plan) would
// be actively wrong to reset on a logout. Only the account's own directory goes, which is what
// removeAccount already deletes.

const TIMEOUT_MS = 5000;

// The one phrasing of "there was nothing to unlink", reached from two places — the script's own
// zero-account check and logoutAll's — and branched on by the logout skill. Two spellings and the
// skill matches one of them, reading the other as an unexplained empty answer.
export const NOTHING_TO_DO = 'Beezi: this machine is not linked. Nothing to do.';

// The one phrasing of each outcome, so the CLI and the logout skill cannot drift apart. `{who}` is
// the account being logged out — the skill branches on the rest of the sentence.
// ── THE OUTCOME TABLE ────────────────────────────────────────────────────────────────────────
//
// Three review rounds were spent on sentences here that were true of the state they were written
// for and false of another state that reached them. So the rule for this table is: a sentence may
// assert ONLY what is established by the facts the branch tests, and any branch that did not
// establish the grant is dead carries the Connections-tab remedy.
//
// The four facts, all computed below and all in scope at the branch:
//   serverUnlinked  the portal accepted the DELETE — machine row AND grant both gone
//   revoked         the authorization server accepted the RFC 7009 revoke — grant gone, row may remain
//   contacted       a request was actually made (either of the two above was attempted)
//   credsUnreadable the credential READ THREW — the store is present and momentarily unreadable
//
// `credsUnreadable` is not `creds === null`, and the difference is load-bearing:
// lib/credentials.mjs says so in capitals — "UNREADABLE" AND "NEVER LINKED" MUST NOT LOOK THE SAME
// — because a locked keychain and a killed spawn both collapse to null otherwise. Treating them
// alike here told a user with a locked keychain that nothing was stored and nothing was
// outstanding, while the grant stayed live and the credentials stayed on disk.
const OUTCOME = Object.freeze({
  unlinked: 'Logged out {who}. The account is unlinked from Beezi.',
  revoked: 'Logged out {who} and access revoked.',
  // The grant was ALREADY dead before this command ran: getAuthentication deletes the credentials
  // the moment a refresh comes back invalid_grant and marks the row revoked. Guarded on `contacted`
  // as well as on the row, because with a readable credential and an offline portal this branch was
  // reached AFTER a failed unlink and a failed revoke — and then claimed there was nothing to
  // unlink, having just tried twice.
  alreadyRevoked: 'Logged out {who}. Its access had already been revoked, so there was nothing left to unlink.',
  // The store is there and could not be read. NOT "no credentials were stored": they WERE stored,
  // and the grant is live because nothing was attempted against it.
  //
  // It does not follow that the credentials survive. PROBED: the delete is a different call from
  // the read — a locked keychain fails `find-generic-password` and still accepts
  // `delete-generic-password` — so after this outcome the entry is gone, the control file is a
  // tombstone, a later read on a working store answers null, and the index row is removed. An
  // earlier version of this comment claimed the opposite and a skill bullet was written from it.
  storeUnreadable: 'Logged out {who} from this machine\'s account list. Its saved credentials could not be read, so Beezi was not contacted.',
  // No usable credentials here and nothing attempted. Reached by a re-run after a partial logout
  // and by a malformed blob. It says nothing about the PORTAL, because this machine cannot know:
  // the earlier run may have unlinked before it failed, or may not have got that far.
  notContacted: 'Logged out {who} from this machine\'s account list. There were no usable credentials for it here, so Beezi was not contacted.',
  local: 'Logged out {who} locally.',
});

// The one line offering the only remedy the user has when this machine could not prove the grant
// is dead. Conditional on purpose — "if it is still listed" — because every branch that reaches it
// is a branch that does not know.
const CONNECTIONS_REMEDY = '  If this account is still listed in the portal\'s Connections tab, remove it there.';

// The failure that arrives AFTER the credential delete has committed. What it may claim depends on
// whether the grant was actually killed: `--all` under a held index lock with an OFFLINE portal
// reaches this with nothing unlinked anywhere, and the unconditional "was signed out" told the user
// to skip a portal cleanup that had never happened.
function removeFailed(who, error, grantDead) {
  const got = grantDead
    ? `${who} was signed out, but its row could not be removed from this machine's account list`
    : `${who} could not be signed out at Beezi, and its row could not be removed from this machine's account list`;
  return new UserError(`${got} (${friendlyMessage(error)}). Run the command again to finish.`);
}

// Fallback when the portal is unreachable: revoke the grant at the authorization
// server directly (RFC 7009 endpoint sits next to the token endpoint).
//
// `deps.fetchImpl` is the repo-wide seam (lib/http.mjs, audit-flush, checkpoint, diagnostics,
// account-sync all take it). Without it a test of the local-only path would POST to whatever
// token_endpoint the fixture happened to carry, out of the hermetic sandbox.
// Returns { attempted, revoked }. `attempted` is separate because the early returns below make no
// request at all, and a branch downstream may not say "could not reach the server" about a server
// nobody reached.
async function revokeAtAuthServer(creds, deps) {
  const no = { attempted: false, revoked: false };
  if (!creds || !creds.token_endpoint || !creds.client_id) return no;
  const token = creds.refresh_token || creds.access_token;
  if (!token) return no;
  const doFetch = deps.fetchImpl || fetchCompat;
  const controller = makeAbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${creds.token_endpoint.replace(/\/$/, '')}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: creds.refresh_token ? 'refresh_token' : 'access_token',
        client_id: creds.client_id,
      }).toString(),
      signal: controller.signal,
    });
    return { attempted: true, revoked: res.ok === true };
  } catch (error) {
    // The request went out and failed. That IS a contact attempt — a caller saying "could not
    // reach the server" about this case is telling the truth.
    return { attempted: true, revoked: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THIS account's own { token, clientId }, renewed once if a sibling holds the refresh lock.
 *
 * The bearer and the client id travel together — lib/machine-identity.mjs states why: an
 * X-Beezi-Client borrowed from another account names the wrong machine row, so a logout carrying
 * one would ask the portal to drop a row belonging to an account that is staying.
 *
 * `null` when the account cannot produce a token at all (a revoked grant, a locked keyring). That
 * is not a failure — it sends the logout down the revoke-at-the-auth-server branch, and then the
 * local one, both of which still remove the account from this machine.
 */
async function sessionFor(row, deps) {
  const authenticate = orDefault(deps.getAuthentication, getAuthentication);
  let auth;
  try { auth = await authenticate(row.key, deps); } catch (error) { return null; }
  // Renewed ONCE. 'refreshing' means sharedLock('token-refresh-<key>') was held — by another
  // process mid-renewal, or by a sibling account in this same process during logoutAll. Retried
  // alone it gets the lock; if a real holder is still there the account falls back exactly as it
  // would have.
  if (auth && auth.state === 'refreshing') {
    try { auth = await authenticate(row.key, deps); } catch (error) { return null; }
  }
  if (!auth || auth.state !== 'ready' || !auth.accessToken) return null;
  return {
    token: auth.accessToken,
    clientId: auth.clientId == null ? orDefault(row.clientId, null) : auth.clientId,
  };
}

/**
 * Log ONE account out: unlink it server-side with its own session, revoke the grant if the portal
 * could not be reached, then delete its credentials, its directory and its index row.
 *
 * `options.nextDefault` is a KEY, already resolved by the caller — a position resolved after the
 * removal would name a different row, because removing an account renumbers every row after it.
 * `options.reportDefault` is false only for logoutAll, which has its own closing line.
 *
 * NO LOCK IS HELD ACROSS ANOTHER. deleteCredentials takes the rank-4 credential lock and
 * removeAccount/setDefault take rank-3 sharedLock('accounts-index'); lib/single-instance-lock.mjs
 * refuses a lock of equal-or-finer rank than one this process already holds, so the index write
 * must happen only once the credential lock has been released. Sequential awaits, never nested.
 */
export async function logoutAccount(key, options = {}, deps = {}) {
  const opts = options === null || options === undefined ? {} : options;
  const row = await getAccount(key, deps);
  if (row === null) throw new UserError(`No linked account matches "${key}". Run the accounts skill to list them.`);
  const who = describeAccount(row);

  const session = await sessionFor(row, deps);
  // READ AFTER the renewal above, never before it: a refresh rotates refresh_token, and the revoke
  // fallback has to present the token the authorization server currently holds.
  let creds = null;
  // A THROW IS NOT AN ABSENCE. lib/credentials.mjs raises CREDENTIALS_UNAVAILABLE for a store that
  // is present but momentarily unreadable — a locked keychain, a killed spawn — and collapsing that
  // into `null` is the exact conflation its own comment forbids in capitals.
  let credsUnreadable = false;
  try { creds = await getCredentials(key, deps); } catch (error) { creds = null; credsUnreadable = true; }

  const unlink = orDefault(deps.unlinkMachine, unlinkMachine);
  let serverUnlinked = false;
  let contacted = false;
  if (session !== null) {
    contacted = true;
    try { serverUnlinked = (await unlink(session)) === true; } catch (error) { serverUnlinked = false; }
  }
  let revoked = false;
  if (!serverUnlinked) {
    const attempt = await revokeAtAuthServer(creds, deps);
    revoked = attempt.revoked;
    if (attempt.attempted) contacted = true;
  }
  // The single fact every sentence below turns on: is the grant certainly dead?
  const grantDead = serverUnlinked || revoked;

  try { await deleteCredentials(key, deps); } catch (error) { /* the row goes either way */ }
  // The one step that may THROW. Everything above is best-effort and has already committed — the
  // portal unlink, the revoke and the credential delete all happen whether or not this succeeds —
  // so the error it raises has to say that, not "nothing happened". Nothing after this line may
  // discard the outcome by throwing.
  try { await removeAccount(key, deps); } catch (error) { throw removeFailed(who, error, grantDead); }

  const next = orDefault(opts.nextDefault, null);
  let nextDefaultFailure = null;
  if (next !== null && next !== key) {
    // NOT allowed to throw away the outcome above. mutate() is an immediate-fail lock, so any
    // concurrent index write loses this acquisition — and a caller that saw the exception would
    // report "nothing was unlinked" about an account that has already gone.
    try { await setDefault(next, deps); } catch (error) { nextDefaultFailure = friendlyMessage(error); }
  }

  // FIRST MATCH WINS, and the order is the order of certainty. Only the first branch establishes
  // that both the grant and the portal's machine row are gone; every other one ends with the
  // conditional remedy, because none of them can prove the row is not still there.
  const lines = [];
  if (serverUnlinked) {
    lines.push(`✓ ${OUTCOME.unlinked.replace('{who}', who)}`);
  } else if (revoked) {
    lines.push(`✓ ${OUTCOME.revoked.replace('{who}', who)}`);
    lines.push(CONNECTIONS_REMEDY);
  } else if (credsUnreadable && !contacted) {
    // `!contacted` is the rule at the top of OUTCOME applied to this branch: the sentence asserts
    // "Beezi was not contacted", so the branch has to test it rather than infer it from the read
    // having thrown. Production reaches the two through one getCredentials, so a contacted-yet-
    // unreadable state needs the store to change between the session resolve and the blob read —
    // but a sentence that asserts more than its branch establishes is the defect this whole table
    // was rewritten to stop.
    lines.push(`✓ ${OUTCOME.storeUnreadable.replace('{who}', who)}`);
    lines.push(CONNECTIONS_REMEDY);
  } else if (row.status === AccountStatus.REVOKED && !contacted) {
    lines.push(`✓ ${OUTCOME.alreadyRevoked.replace('{who}', who)}`);
    lines.push(CONNECTIONS_REMEDY);
  } else if (contacted) {
    lines.push(`✓ ${OUTCOME.local.replace('{who}', who)}`);
    lines.push('  Could not reach the server — this account may still appear linked in the portal.');
    lines.push(CONNECTIONS_REMEDY);
  } else {
    lines.push(`✓ ${OUTCOME.notContacted.replace('{who}', who)}`);
    lines.push(CONNECTIONS_REMEDY);
  }

  const remaining = await listAccounts(deps);
  const defaultKey = await getDefaultKey(deps);
  if (nextDefaultFailure !== null) {
    lines.push(`  The account was logged out, but the new default could not be set (${nextDefaultFailure}).`);
  }
  if (opts.reportDefault !== false && remaining.length > 0) {
    if (defaultKey === null) {
      lines.push('  No default account is set — run the accounts skill to choose which account analytics read from.');
    } else {
      const still = remaining.find((a) => a.key === defaultKey);
      lines.push(`  Analytics now read from ${describeAccount(still)}.`);
      // setDefault checks index MEMBERSHIP only, and normalize() auto-elects a default solely when
      // the stored one is missing — never when it is revoked. So the default can be an account the
      // list marked `(revoked)` one line earlier, and announcing it unqualified would promise
      // reporting that cannot happen.
      if (still && still.status === AccountStatus.REVOKED) lines.push(`  ${REVOKED_DEFAULT_NOTE}`);
    }
  }
  return { key, account: row, serverUnlinked, revoked, remaining: remaining.length, defaultKey, lines };
}

/**
 * Log every account out.
 *
 * SERIAL, and not as a style choice: each iteration takes sharedLock('accounts-index') and, when a
 * token needs renewing, sharedLock('token-refresh-<key>'). Both are rank 3, and two rank-3 locks
 * under different names at once in one process are refused as 'lock-order' — a permanent failure,
 * so a concurrent sweep would silently leave accounts behind.
 *
 * Each account is removed with its OWN session, so the portal drops each machine row against the
 * grant that created it. An account whose unlink fails still leaves this machine: the local half
 * is what stops it reporting, and the outcome line says which half happened.
 *
 * EVERY ACCOUNT IS REPORTED, INCLUDING THE ONES THAT FAILED. The loop body is caught and continues,
 * because the alternative is silence about work that was already done: nothing is printed until
 * this function returns, so a throw at account 3 of 5 would discard the outcome lines for the two
 * already gone and leave the caller with nothing but an error. And it is not a rare throw —
 * lib/accounts.mjs's mutate() is an immediate-fail lock (lib/token.mjs states the property: "a
 * single attempt loses to any momentary holder"), so any concurrent index write — a hook marking a
 * grant revoked, a login, another CLI — is enough.
 */
export async function logoutAll(deps = {}) {
  const accounts = await listAccounts(deps);
  if (accounts.length === 0) {
    return { count: 0, results: [], lines: [NOTHING_TO_DO] };
  }
  const lines = [];
  const results = [];
  const failed = [];
  for (const account of accounts) {
    let result;
    try {
      result = await logoutAccount(account.key, { reportDefault: false }, deps);
    } catch (error) {
      failed.push(account.key);
      // friendlyMessage, not a prefix of our own: removeFailed's sentence already names the
      // account AND says how far the logout got, which a `<who>: <reason>` wrapper would bury.
      lines.push(`✗ ${friendlyMessage(error)}`);
      continue;
    }
    results.push(result);
    for (const line of result.lines) lines.push(line);
  }
  // The index is left in place and EMPTY rather than deleted. An absent accounts.json is what
  // readIndex() treats as the pre-0.13 migration trigger, and it is one of lib/env-migration.mjs's
  // data entries — deleting it would make a root that has plainly been used look untouched.
  if (failed.length === 0) {
    lines.push(`✓ All ${accounts.length} Beezi account${accounts.length === 1 ? ' is' : 's are'} logged out on this machine.`);
  } else {
    // Deliberately says nothing about HOW FAR each one got: the per-account lines above do, and
    // they disagree with one another — one account's unlink can succeed while the next one's fails.
    lines.push(`✗ ${failed.length} of ${accounts.length} accounts could not be fully logged out. Run the command again to finish.`);
  }
  lines.push('  This machine\'s settings are untouched: the captured plan, the crash-reporting choice and the analytics hooks all stay as they were.');
  return { count: accounts.length, failed, results, lines };
}
