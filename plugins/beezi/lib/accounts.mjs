import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  accountsIndexFile, accountDir, accountsMigrationJournalFile,
  trackingStateFile, auditLedgerFile, accountSyncStateFile,
  coverageFile, usagePendingFile, queueDir,
  beeziCodexHome, usageObservationsFile,
} from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { withLock, acquireLock, sharedLock } from './single-instance-lock.mjs';
import { UserError } from './friendly-error.mjs';
import { removeDirSync, removeFileSync } from './compat.mjs';
import {
  readLegacyCredential, deleteLegacyCredential, setCredentials,
  subjectAuthorityPath, LEGACY_SUBJECT,
} from './credentials.mjs';

// The one definition of "which Beezi accounts are linked on this machine". accounts.json is its
// only home; lib/paths.mjs names the file and every per-account directory under it.
//
// This module owns CRUD, locking, and the one-time conversion of a pre-0.13 single-account install
// into the keyed layout. That conversion hangs off readIndex(): an ABSENT index is the only trigger,
// and it runs once, under a lock, journalling the key it minted (accountsMigrationJournalFile) so a
// retry after a crash reuses it instead of stranding the keyed entry the first attempt wrote.

const INDEX_VERSION = 1;
const FIELDS = ['email', 'name', 'tenantId', 'tenantName', 'clientId', 'linkedAt', 'status'];

export const AccountStatus = Object.freeze({ LINKED: 'linked', REVOKED: 'revoked' });

export function newAccountKey() {
  return crypto.randomBytes(4).toString('hex');
}

function emptyIndex() {
  return { version: INDEX_VERSION, default: null, accounts: [] };
}

// accounts.json is hand-editable (see the note on assertAccountKey in lib/paths.mjs), so a row can
// arrive carrying a type no reader expects. The row filter is this module's ONLY gate on that, and
// a row that survives it must already hold the types every reader below assumes — otherwise a
// half-malformed index throws a bare TypeError out of a hook instead of degrading.
//
// `email` is the one field read as a string rather than compared with ===, so it is the one that
// has to be coerced. It becomes null rather than its String() form: a number or an object in that
// field names no address, and letting `123` match a query of '123' would be worse than not
// matching at all.
function normalizeRow(a) {
  if (typeof a.email === 'string' || a.email === null) return a;
  return { ...a, email: null };
}

// Returns null for anything unreadable, so callers can tell "no index" from "broken index".
function normalize(raw) {
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts
    .filter((a) => a && typeof a.key === 'string' && /^[0-9a-f]{8}$/.test(a.key))
    .map(normalizeRow);
  let def = accounts.some((a) => a.key === raw.default) ? raw.default : null;
  if (def == null) {
    const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
    if (linked.length === 1) def = linked[0].key;
  }
  return { version: INDEX_VERSION, default: def, accounts };
}

export function writeIndex(index) {
  writeJsonSecure(accountsIndexFile(), index);
}

// ── the one-time migration of a pre-0.13 install ────────────────────────────────────────────
//
// A pre-0.13 machine holds one keyring entry (account attribute 'token') and a handful of
// root-level state files. From 0.13 on each of those belongs to an account directory. The
// conversion COPIES, PUBLISHES, then deletes — in that order and never another — so a crash at
// any point leaves the legacy install intact and the next read re-runs the whole thing.

const MIGRATION_WAIT_MS = 8000;
const UNAVAILABLE = 'Saved Beezi authorization is temporarily unavailable. Retry when the credential store is accessible.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each pre-0.13 root-level file keeps its basename inside the account directory.
function legacyMoves(key) {
  return [
    trackingStateFile(key), auditLedgerFile(key), accountSyncStateFile(key),
    coverageFile(key), queueDir(key),
  ].map((to) => ({ from: path.join(beeziCodexHome(), path.basename(to)), to }));
}

// Copy, not move: the original has to survive until the index naming the new home is published.
function copyIfPresent(from, to) {
  try {
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(from)) copyIfPresent(path.join(from, entry), path.join(to, entry));
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The pending ROWS belong to an account; the series and the observed plan stay machine-level,
// because the plan must outlive the queue it was observed alongside (pruneStale sweeps the queue).
function splitUsageObservations(key) {
  const machine = readJson(usageObservationsFile(), null);
  if (machine == null || !Array.isArray(machine.pending) || machine.pending.length === 0) return;
  writeJsonSecure(usagePendingFile(key), { version: 1, pending: machine.pending });
  writeJsonSecure(usageObservationsFile(), { ...machine, pending: [] });
}

export async function migrateSingleAccount(deps = {}) {
  let legacy;
  try { legacy = await readLegacyCredential(deps); }
  catch (error) { throw new UserError(UNAVAILABLE); }
  // A genuinely absent entry is not an error: this is a machine that was never linked. It is also
  // not journalled. accounts.migration.json is in lib/env-migration.mjs's DATA_ENTRIES, so a file
  // written here would make a never-linked root answer rootHasData() with "used" — and a used root
  // with no binding classifies as `migrate`, taking a production cutover it never needed.
  if (legacy == null) return emptyIndex();

  // Journalled before the first mutation, which is the only ordering the key needs: a crash after
  // setCredentials must reuse this key rather than mint a second one and orphan the entry it wrote.
  const journal = readJson(accountsMigrationJournalFile(), null);
  const key = journal && /^[0-9a-f]{8}$/.test(journal.key) ? journal.key : newAccountKey();
  writeJsonSecure(accountsMigrationJournalFile(), { key });

  fs.mkdirSync(accountDir(key), { recursive: true, mode: 0o700 });
  await setCredentials(key, legacy, deps);
  const moves = legacyMoves(key);
  for (const move of moves) copyIfPresent(move.from, move.to);
  splitUsageObservations(key);

  const tracking = readJson(trackingStateFile(key), null);
  const index = emptyIndex();
  index.default = key;
  index.accounts.push({
    key,
    email: null,
    name: null,
    tenantId: null,
    tenantName: null,
    clientId: legacy.client_id == null ? null : legacy.client_id,
    linkedAt: tracking && typeof tracking.linkedAt === 'string' ? tracking.linkedAt : null,
    status: AccountStatus.LINKED,
  });
  writeIndex(index);

  // Last, and best-effort. A crash before this re-runs the migration; a crash after it is done.
  // removeDirSync/removeFileSync rather than fs.rmSync: the Node 13.2 floor bans rmSync outright.
  for (const move of moves) {
    try { removeDirSync(move.from); removeFileSync(move.from); } catch (error) { /* ignore */ }
  }
  try { await deleteLegacyCredential(deps); } catch (error) { /* ignore */ }
  // The pre-0.13 authority record retires with the entry it described. Left behind, it would tell
  // a later legacy read that a committed backend still holds a credential that has just been
  // deleted — which reads as "the store is broken", not as "this machine is keyed now".
  removeFileSync(subjectAuthorityPath(beeziCodexHome(), LEGACY_SUBJECT));
  return index;
}

/**
 * The index, migrating a pre-0.13 install into it on the way if there is one.
 *
 * withLock is not usable here: it releases before an async callback's promise settles, which would
 * hand the lock away mid-copy. The acquire/release pair is lib/token.mjs's refresh-lock shape.
 */
export async function readIndex(deps = {}) {
  const existing = normalize(readJson(accountsIndexFile(), null));
  if (existing) return existing;
  // A present-but-corrupt index is NOT a migration trigger: migrating over it would unlink
  // whatever it still named. Report it empty and let mutate() refuse.
  if (fs.existsSync(accountsIndexFile())) return emptyIndex();

  const acquired = acquireLock(sharedLock('accounts-migrate'), { leaseMs: 30_000 });
  if (!acquired.ok) {
    // The environment migration is holding the whole root closed and is about to MOVE the files
    // this migration would copy (spec decision 10). That is not contention to wait out: say so now
    // rather than spend the poll window on a lock that will stay refused.
    if (acquired.reason === 'migration') {
      throw new UserError('Beezi is finishing an environment migration. Run the command again in a moment.');
    }
    // 'lock-order' is the caller's own acquisition sequence, not a busy lock — the same rule
    // mutate() follows, for the same reason: retrying it fails forever.
    if (acquired.reason === 'lock-order') {
      const error = new Error(`the accounts migration lock was refused: ${acquired.detail || 'lock order'}`);
      error.code = 'BEEZI_LOCK_ORDER';
      throw error;
    }
    const until = Date.now() + MIGRATION_WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      const again = normalize(readJson(accountsIndexFile(), null));
      if (again) return again;
    }
    throw new UserError('Beezi accounts migration is in progress. Retry in a moment.');
  }
  try {
    const again = normalize(readJson(accountsIndexFile(), null));
    if (again) return again;
    return await migrateSingleAccount(deps);
  } finally {
    acquired.handle.release();
  }
}

function unreadableIndex() {
  return new UserError('The Beezi accounts index is unreadable. Restore accounts.json before changing linked accounts.');
}

// What a mutation starts from, read INSIDE the lock. An ABSENT index is an empty one; a CORRUPT
// one is not. Falling back to empty here would write the file out with no rows in it and silently
// unlink every account it still named, so it refuses instead — the file is never overwritten and
// never deleted on this path.
function readIndexForMutation() {
  const normalized = normalize(readJson(accountsIndexFile(), null));
  if (normalized != null) return normalized;
  if (fs.existsSync(accountsIndexFile())) throw unreadableIndex();
  return emptyIndex();
}

// Mutations serialise on one shared lock, and refuse outright while the file is unreadable:
// overwriting a corrupt index would silently unlink every account it still named. The check is
// made here so a broken file is refused without contending for the lock at all, and again inside
// it by readIndexForMutation, which is what closes the window between the two.
async function mutate(deps, fn) {
  if (fs.existsSync(accountsIndexFile()) && normalize(readJson(accountsIndexFile(), null)) == null) {
    throw unreadableIndex();
  }
  const result = withLock(sharedLock('accounts-index'), {}, () => fn());
  if (result.ok) return result.value;
  // 'lock-order' is the caller's own acquisition sequence, not a busy lock — retrying it fails
  // forever. lib/single-instance-lock.mjs's contract is to surface it as itself.
  if (result.reason === 'lock-order') {
    const error = new Error(`the accounts index lock was refused: ${result.detail || 'lock order'}`);
    error.code = 'BEEZI_LOCK_ORDER';
    throw error;
  }
  throw new UserError('Accounts are being updated by another Beezi process. Try again.');
}

export async function listAccounts(deps = {}) {
  return (await readIndex(deps)).accounts;
}

/**
 * The index EXACTLY AS WRITTEN — no migration, no lock, no await.
 *
 * The machine-wide sweeps (pruneStale, the poisoned-queue quarantine) need the list of account
 * directories and nothing else, and they are synchronous by contract: pruneStale runs inside a
 * run lock on a hook path and quarantinePoisonedSessionState is called from a script that prints
 * its result. Reaching readIndex() there would make both async AND would let a 14-day prune be
 * the thing that converts a pre-0.13 install — a migration has to be triggered by a caller that
 * can report its failure, not by a housekeeping pass that swallows everything.
 *
 * An absent or unreadable index answers with no accounts, which is the safe direction: a sweep
 * that finds nothing deletes nothing.
 */
export function listAccountsSync() {
  const index = normalize(readJson(accountsIndexFile(), null));
  return index === null ? [] : index.accounts;
}

export async function getAccount(key, deps = {}) {
  return (await listAccounts(deps)).find((a) => a.key === key) || null;
}

export async function findByEmail(email, deps = {}) {
  if (!email) return null;
  const wanted = String(email).toLowerCase();
  return (await listAccounts(deps)).find((a) => a.email != null && a.email.toLowerCase() === wanted) || null;
}

export async function findByTenant(tenantId, deps = {}) {
  if (!tenantId) return null;
  return (await listAccounts(deps))
    .find((a) => a.tenantId === tenantId && a.status === AccountStatus.LINKED) || null;
}

export async function getDefaultKey(deps = {}) {
  return (await readIndex(deps)).default;
}

export async function setDefault(key, deps = {}) {
  return mutate(deps, () => {
    const index = readIndexForMutation();
    if (!index.accounts.some((a) => a.key === key)) throw new UserError('No such linked account.');
    index.default = key;
    writeIndex(index);
    return index;
  });
}

export async function addAccount(row, deps = {}) {
  return mutate(deps, () => {
    const index = readIndexForMutation();
    index.accounts = index.accounts.filter((a) => a.key !== row.key);
    index.accounts.push({
      key: row.key,
      email: row.email == null ? null : String(row.email).toLowerCase(),
      name: row.name == null ? null : row.name,
      tenantId: row.tenantId == null ? null : row.tenantId,
      tenantName: row.tenantName == null ? null : row.tenantName,
      clientId: row.clientId == null ? null : row.clientId,
      linkedAt: row.linkedAt == null ? new Date().toISOString() : row.linkedAt,
      status: row.status == null ? AccountStatus.LINKED : row.status,
    });
    if (index.default == null) index.default = row.key;
    fs.mkdirSync(accountDir(row.key), { recursive: true, mode: 0o700 });
    writeIndex(index);
    return index;
  });
}

// null and undefined both mean "leave it alone": no caller clears a field.
export async function updateAccount(key, patch, deps = {}) {
  return mutate(deps, () => {
    const index = readIndexForMutation();
    const found = index.accounts.find((a) => a.key === key);
    if (!found) return index;
    for (const field of FIELDS) {
      if (patch[field] == null) continue;
      found[field] = field === 'email' ? String(patch[field]).toLowerCase() : patch[field];
    }
    writeIndex(index);
    return index;
  });
}

export async function removeAccount(key, deps = {}) {
  return mutate(deps, () => {
    const index = readIndexForMutation();
    index.accounts = index.accounts.filter((a) => a.key !== key);
    if (index.default === key) index.default = null;
    writeIndex(index);
    // fs.rmSync is banned by the Node 13.2 floor; lib/compat.mjs is the sanctioned removal.
    try { removeDirSync(accountDir(key)); } catch (error) { /* best-effort */ }
    return index;
  });
}

function sessionFor(a, auth) {
  return {
    key: a.key,
    email: a.email,
    name: a.name,
    tenantName: a.tenantName,
    token: auth.accessToken,
    // The stored row is the fallback, not the authority: the credential blob is what the refresh
    // actually rotated, so its client_id wins whenever it has one.
    clientId: auth.clientId == null ? a.clientId : auth.clientId,
  };
}

/**
 * The object every fan-out site loops over: one { key, email, name, tenantName, token, clientId }
 * per account that can currently produce a token. An account that cannot is DROPPED, never thrown
 * — a transient failure must cost one account, not the whole hook.
 *
 * TWO PASSES, AND THE SECOND ONE IS NOT AN OPTIMISATION. getAuthentication takes
 * sharedLock('token-refresh-<key>') whenever a token needs renewing. That is rank 3 in LOCK_ORDER,
 * and lib/single-instance-lock.mjs refuses a rank-3 lock while this process holds another rank-3
 * lock under a different name. So resolving two EXPIRING accounts concurrently gets the second one
 * refused with 'lock-order', which getAuthentication reports as 'refreshing' — and a session that
 * is merely dropped is an account that silently stops reporting, which is the exact failure this
 * fan-out exists to prevent. The refused accounts are retried serially, each getting the lock to
 * itself.
 *
 * The concurrent first pass stays, because it is free in the common case and not in the rare one:
 * getAuthentication answers `ready` BEFORE acquiring any lock when the stored token is still
 * fresh, so an ordinary tick takes no locks at all and the credential read — a PowerShell spawn on
 * Windows, inside a hook budget with room for one — is not multiplied by the number of accounts.
 * Only simultaneous expiry serializes, and that path is network-bound anyway.
 */
export async function linkedSessions(deps = {}) {
  const { getAuthentication } = await import('./token.mjs');
  const linked = (await listAccounts(deps)).filter((a) => a.status === AccountStatus.LINKED);
  const authenticate = async (a) => {
    try { return await getAuthentication(a.key, deps); } catch (error) { return null; }
  };
  const first = await Promise.all(linked.map(authenticate));
  const sessions = [];
  for (let i = 0; i < linked.length; i += 1) {
    let auth = first[i];
    // Refused because a sibling account held the refresh lock, or because another process is
    // genuinely mid-refresh. Retried alone it gets its own; if a real holder is still there the
    // account drops exactly as it would have before.
    if (auth && auth.state === 'refreshing') auth = await authenticate(linked[i]);
    if (!auth || auth.state !== 'ready' || !auth.accessToken) continue;
    sessions.push(sessionFor(linked[i], auth));
  }
  return sessions;
}

export function describeAccount(a) {
  if (a == null) return 'unknown account';
  let who;
  if (a.name) who = `${a.name} <${a.email == null ? 'unknown' : a.email}>`;
  else if (a.email) who = a.email;
  // NOT "details on next session", and not a promise of any kind. Two call sites now write an
  // anonymous row's identity — lib/session-start.mjs's per-account whoami and lib/login.mjs's
  // resolveAnonymousRows — but both need a token this row can still produce AND a portal that
  // answers with an email, so neither is a fact this string may assert. It says what the row holds.
  else who = 'linked account (no name or email recorded)';
  return a.tenantName ? `${who} - ${a.tenantName}` : who;
}

export async function resolveAccountRef(ref, deps = {}) {
  const accounts = await listAccounts(deps);
  const value = ref == null ? '' : String(ref).trim();
  if (!value) throw new UserError('No account given.');
  const byKey = accounts.find((a) => a.key === value);
  if (byKey) return byKey.key;
  const byEmail = accounts.find((a) => a.email != null && a.email.toLowerCase() === value.toLowerCase());
  if (byEmail) return byEmail.key;
  if (/^\d+$/.test(value)) {
    const found = accounts[Number(value) - 1];
    if (found) return found.key;
  }
  throw new UserError(`No linked account matches "${value}". Run the accounts skill to list them.`);
}

export async function parseAccountFlag(argv, deps = {}) {
  const rest = [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--account') {
      ref = argv[++i];
      if (ref == null) throw new UserError('--account needs a value: a key, an email, or a position from the accounts skill.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { account: ref == null ? null : await resolveAccountRef(ref, deps), rest };
}
