import { fetchCompat } from './fetch-compat.mjs';
import { checkForUpdate as _checkForUpdate, updateNotice } from './update-check.mjs';
import fs from 'fs';
import path from 'path';
import { getAuthentication as _getAuthentication } from './token.mjs';
import {
  linkedSessions as _linkedSessions,
  listAccounts as _listAccounts,
  updateAccount as _updateAccount,
  AccountStatus,
} from './accounts.mjs';
import { flushQueue, SESSION_LOCK_LEASE_MS } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { codexAuthFile, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { withLock, sessionLock } from './single-instance-lock.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { whoami } from './whoami.mjs';
import { recordWhoami } from './tracking.mjs';
import { BillingSource } from './billing.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
  shouldProbeAccount as _shouldProbeAccount,
} from './billing-config.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import { orDefault } from './compat.mjs';
import { captureFromCodexAccount } from './billing-capture.mjs';
import { readAccountViaAppServer as _readAccountViaAppServer } from './codex-app-server.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
// Also records where the session lives (cwd + transcript path) so the track script can find
// the transcript after the session cd's away from its launch directory — the mapping is
// refreshed on every start (resume may happen from a different directory).
//
// Under the same rank-2 `session:<id>` lock runCheckpoint takes, and for the same reason (G-8-3 /
// R3). This is the FIFTH writer of state/<id>.json and it is a read-modify-write like the others:
// it reads the file to preserve `cursor` and writes the whole object back. A checkpoint that
// advances the cursor between that read and this write has its advance erased — the session
// re-processes and re-bills a window it already delivered. Resuming a session while a Stop hook
// from the previous turn is still finishing is exactly that interleaving. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// Contention DEFERS: the mapping this refreshes is a hint the checkpoint can re-derive, and the
// cursor it was protecting is untouched, which is the whole point of not writing.
export function initSessionState(sessionId, { cwd = null, transcriptPath = null } = {}, deps = {}) {
  const run = withLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS }, () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = path.join(dir, `${sessionId}.json`);
    const state = readJson(p, { cursor: 0 });
    state.cwd = cwd;
    state.transcriptPath = transcriptPath;
    state.updatedAt = new Date().toISOString();
    writeJsonSecure(p, state);
  });
  return run.ok
    ? { written: true, skipped: false, reason: null }
    : { written: false, skipped: true, reason: run.reason };
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = orDefault(deps.fs, fs);
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    // Lazy fallback preserved: originFromGitConfig reads the repo's config file and must only
    // run when the remote lookup came back empty.
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin === undefined || origin === null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      recordRoot(orDefault(resolveRepoRoot(gitImpl, child, cache, map), child));
    }
  }
  return { map, dirty };
}

// The remote is resolved ONCE by the caller and handed in: it is a git shell-out and it is the
// same answer for every linked account, so resolving it per account would multiply a subprocess
// inside the hook budget by however many workspaces happen to be linked.
async function announceRepo(remote, session, fetchImpl) {
  if (!remote) return null; // not a git repo — silent
  try {
    // postJson, not a bare fetch: this runs inside the SessionStart hook's 10s budget, and an
    // unbounded request against a stalled API would hold the whole turn open rather than
    // degrading to the silent "offline" path below.
    const res = await postJson(`${apiBase()}${ENDPOINTS.reposStatus}`, session, { remote }, { fetchImpl });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    // Both branches are informational only. Nothing downstream gates on `connected`: the
    // checkpoint reports every branch of every repo, and work with no origin at all under a
    // `local:<folder>` remote. Saying "no analytics tracked here" would be false.
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Sessions here are tracked.`
      : 'Beezi: this repo is not connected to a Beezi project. Sessions are still tracked, against the repo itself.';
  } catch { return null; } // offline — silent
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user signing in again.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
async function isTokenRejected(key, session, fetchImpl, deps = {}) {
  const who = await whoami(session, { fetchImpl });
  // Piggyback the tracking-policy refresh on the check we already make: the trackingMode /
  // backfillCompleted cache goes stale between logins otherwise, and the live gate plus the
  // backfill fast-path both key off it. Best-effort — never blocks session start.
  if ((who || {}).valid === true) {
    // The account's OWN client id, carried on the session this whoami was made with — never a
    // process-global, which with several accounts linked would bind one tenant's policy under
    // another's identity and make matchesIdentity discard the wrong cache.
    try { recordWhoami(key, who, orDefault(session.clientId, null)); } catch { /* best-effort */ }
    // And fill the index row's identity while a valid answer is in hand. A row whose email is null
    // — migrated from a pre-0.13 install, or linked while the portal was unreachable — can never be
    // matched by lib/accounts.mjs's findByEmail, so a re-login as its own user mints a SECOND
    // linked row and the machine fans out two reports of every session into one workspace.
    //
    // AFTER recordWhoami, never inside it. recordWhoami takes `shared:tracking-<key>` and
    // updateAccount takes `shared:accounts-index`; both are rank 3 in LOCK_ORDER and
    // lib/single-instance-lock.mjs refuses a rank-3 lock while this process holds another rank-3
    // lock under a different name. recordWhoami is synchronous and its lock is released by the time
    // it returns, so this call is sequential rather than nested.
    //
    // Only when the row has nothing recorded and the portal named somebody: updateAccount treats
    // null as "leave it alone", so an older portal's null tenant fields cannot blank a known one.
    if (session.email == null && who.email != null) {
      const updateAccount = orDefault(deps.updateAccount, _updateAccount);
      try {
        await updateAccount(key, {
          email: who.email, name: who.name, tenantId: who.tenantId, tenantName: who.tenantName,
        }, deps);
      } catch { /* best-effort — a session must not fail because a row could not be labelled */ }
    }
  }
  return (who || {}).valid === false;
}

// How a warning line names an account. Only reached when more than one is linked — with one,
// naming it in every message would be noise about a fact the user already knows.
function workspaceLabel(account) {
  return orDefault(orDefault(account.tenantName, account.email), account.key);
}

// How long the SessionStart hook will wait on `codex app-server` before falling through to the
// auth.json decode. The hook's own budget is 10s and already covers a queue flush and a repo probe.
// MEASURED on Windows with codex-cli 0.154.0: 2929ms cold, ~1050ms warm — the launch is the slow
// part (an npm .cmd shim → node → the platform binary), not the protocol. A 3s bound would have cut
// the cold run off and quietly dropped every first probe on a machine like that.
//
// Shorter than the module's own default: this one is spent inside a hook budget, at most weekly.
const APP_SERVER_TIMEOUT_MS = 5000;

function readAuthFileMtimeMs() {
  try {
    const value = fs.statSync(codexAuthFile()).mtimeMs;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const gitImpl = orDefault(deps.gitImpl, _git);
  const resolveSource = orDefault(deps.resolveSource, _resolveSource);
  const readBillingConfig = orDefault(deps.readBillingConfig, _readBillingConfig);
  const writeBillingConfig = orDefault(deps.writeBillingConfig, _writeBillingConfig);
  const isStale = orDefault(deps.isStale, _isStale);
  const shouldProbeAccount = orDefault(deps.shouldProbeAccount, _shouldProbeAccount);
  const readChatgptAuth = orDefault(deps.readChatgptAuth, _readChatgptAuth);
  // Tier 1 of the plan/account ladder. Threaded like every other reader on this path: a bare call
  // would SPAWN A REAL `codex app-server` from the test suite, which tools/hermetic-env.mjs records
  // as an escape to the developer's own ~/.codex.
  const readAccountViaAppServer = orDefault(deps.readAccountViaAppServer, _readAccountViaAppServer);
  const syncAccount = orDefault(deps.syncAccount, _syncAccountIfNeeded);
  const readAuthMtime = orDefault(deps.readAuthFileMtimeMs, readAuthFileMtimeMs);
  // Threaded rather than read inside the ladder: step 1 of resolveSource is an environment lookup
  // (`resolveSource` in billing-config.mjs) and a caller with a resolved environment must be able
  // to hand it over instead of having the host's consulted behind its back (G-10-1 L3).
  const env = orDefault(deps.env, process.env);
  const checkForUpdate = orDefault(deps.checkForUpdate, _checkForUpdate);

  const listSessions = orDefault(deps.linkedSessions, _linkedSessions);
  const listAccounts = orDefault(deps.listAccounts, _listAccounts);
  const authenticate = orDefault(deps.getAuthentication, _getAuthentication);

  // Every account that can currently produce a token. linkedSessions DROPS one it cannot — that is
  // what keeps a single failing account from costing the whole hook — so an account missing from
  // this list still has to be explained, below, or a machine whose only account is mid-refresh
  // would be told it is "not linked" and the user sent to sign in again for nothing.
  let sessions;
  try { sessions = orDefault(await listSessions(deps), []); } catch { sessions = []; }
  let indexed;
  try { indexed = orDefault(await listAccounts(deps), []); } catch { indexed = []; }
  const linked = indexed.filter((account) => account.status !== AccountStatus.REVOKED);
  const many = linked.length > 1;

  // One authentication read per unresolved account, SERIALLY: getAuthentication takes
  // `shared:token-refresh-<key>` when it renews, and two rank-3 locks under different names at
  // once in one process is a 'lock-order' refusal rather than a wait.
  const unresolved = [];
  for (const account of linked) {
    if (sessions.some((session) => session.key === account.key)) continue;
    let state = 'unavailable';
    try { state = orDefault((await authenticate(account.key, deps)).state, 'unavailable'); }
    catch { state = 'unavailable'; }
    unresolved.push({ account, state });
  }
  const isTemporary = (state) => state === 'unavailable' || state === 'refreshing';

  if (sessions.length === 0) {
    if (unresolved.some((one) => isTemporary(one.state))) {
      return 'Beezi authentication is temporarily unavailable or refreshing. Your saved link is preserved; analytics will retry.';
    }
    if (unresolved.some((one) => one.state === 'reauth_required')) {
      return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
    }
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Ask Beezi to sign you in.';
  }

  // Lines about accounts that will not report this session. With one account linked these are the
  // whole answer and the function has already returned above; past that point they ride alongside
  // the accounts that DID resolve, because one broken workspace must not silence a working one.
  const warnings = [];
  for (const one of unresolved) {
    if (!many) continue;
    warnings.push(isTemporary(one.state)
      ? `Beezi: ${workspaceLabel(one.account)} is temporarily unavailable or refreshing — its analytics will retry.`
      : `⚠ Beezi: ${workspaceLabel(one.account)} is not reporting — its link was rejected. Ask Beezi to sign you in again.`);
  }

  // The token check, per account and serially for the same lock-order reason as above.
  const active = [];
  for (const session of sessions) {
    let current = session;
    if (await isTokenRejected(session.key, current, fetchImpl, deps)) {
      // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
      // omits expires_in leaves it a guess. Take the server's word and refresh once before
      // declaring the link bad — otherwise a token that died earlier than we estimated is never
      // renewed, and every session reports a rejection that a single refresh would have fixed.
      const retry = await authenticate(session.key, deps, { forceRefresh: true })
        .catch(() => ({ state: 'unavailable' }));
      if (!retry.accessToken && isTemporary(retry.state)) {
        if (!many) return 'Beezi authentication is temporarily unavailable or refreshing. Your saved link is preserved; analytics will retry.';
        warnings.push(`Beezi: ${workspaceLabel(session)} is temporarily unavailable or refreshing — its analytics will retry.`);
        continue;
      }
      const refreshed = retry.accessToken;
      if (!refreshed || await isTokenRejected(session.key, { ...current, token: refreshed }, fetchImpl, deps)) {
        if (!many) return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
        warnings.push(`⚠ Beezi: ${workspaceLabel(session)} is not reporting — its link was rejected. Ask Beezi to sign you in again.`);
        continue;
      }
      current = { ...current, token: refreshed };
    }
    active.push(current);
  }
  if (active.length === 0) return warnings.length ? warnings.join('\n') : null;

  // Best-effort like every other write here: writeJsonSecure refuses to overwrite a file it could
  // not replace atomically, and losing this mapping costs one checkpoint's cwd hint — not the
  // flush, the repo probe or the billing capture below.
  try {
    initSessionState(input.session_id, {
      cwd: orDefault(input.cwd, null),
      transcriptPath: orDefault(input.transcript_path, null),
    });
  } catch { /* best-effort */ }

  // The repo's origin: one git shell-out for the machine, then one probe per account, because the
  // repo→project mapping is a fact about a TENANT and two workspaces answer it differently.
  let remote = null;
  try { remote = resolveOriginRemote(gitImpl, input.cwd); } catch { remote = null; }

  // SERIAL over the accounts: flushQueue takes `shared:queue-<key>`, rank 3, so two drains at once
  // in this one process would be refused as 'lock-order' — an account silently not uploading,
  // which is the exact failure the fan-out exists to prevent. The repo probe carries no lock, so
  // it rides along inside each account's turn.
  const announcements = [];
  for (const session of active) {
    const [, line] = await Promise.all([
      flushQueue(session.key, session, { fetchImpl }),
      announceRepo(remote, session, fetchImpl),
    ]);
    if (line) announcements.push(many ? `${workspaceLabel(session)} — ${line}` : line);
  }
  const systemMessage = announcements.length ? announcements.join('\n') : null;
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // The user may have switched auth method since the last session (exporting a key over a ChatGPT
  // sign-in, or back). Realign billing.json to the resolved source before the staleness check
  // reads it — otherwise the stored source stays wrong until the next plan capture. Best-effort:
  // a disk failure must not break session start.
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  // Whether the auto-capture below learned information outside an auth-file change that needs an
  // immediate check-in. Auth-file validation relies on the payload hash, so a token-only rewrite
  // does not create network traffic; a true first sync has no matching marker and posts anyway.
  let forceAccountSync = false;
  try {
    billingConfig = readBillingConfig();
    billingSource = resolveSource(billingConfig, env);
    const synced = syncBillingSource(billingConfig, billingSource);
    if (synced) {
      writeBillingConfig(synced);
      billingConfig = synced;
    }

    // Codex rewrites auth.json when the signed-in ChatGPT account changes or its credentials are
    // refreshed. A fresh plan must not hide that newer identity until the weekly plan probe: only
    // a timestamp already attached to a successful capture counts as validated.
    const authFileMtimeMs = readAuthMtime();
    const validatedAuthMtimeMs = (billingConfig || {}).authFileMtimeMs;
    const authFileChanged = typeof authFileMtimeMs === 'number'
      && (typeof validatedAuthMtimeMs !== 'number' || authFileMtimeMs > validatedAuthMtimeMs);
    const authChangeNeedsProbe = authFileChanged
      && (billingSource === BillingSource.SUBSCRIPTION || billingSource === BillingSource.UNKNOWN);

    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // shouldProbeAccount is THE gate — the single predicate that decides whether this runs at all.
    // Its reasoning is below, at the `if`.
    //
    // The reading and the expired-claim rule live in lib/billing-capture.mjs, shared with
    // scripts/billing-capture.mjs so the two cannot disagree about what an expired claim means.
    //
    // Cost when it runs: ONE SHORT-LIVED `codex app-server` SUBPROCESS (tier 1, bounded by
    // APP_SERVER_TIMEOUT_MS below), one stat, one small read of ~/.codex/auth.json, a base64url
    // decode of the id_token payload, and at most one 0600 write. No network. No token is read.
    //
    // The subprocess is why this gate matters more than it used to. shouldProbeAccount still bounds
    // the work to ~weekly — but the cost behind it is now a process launch rather than a file read,
    // so nothing may move this call out from under the gate, and nothing on the checkpoint hot path
    // may call captureFromCodexAccount at all.
    //
    // It is shouldProbeAccount rather than the old `SUBSCRIPTION && !selfReported && isStale`
    // because THAT TRIO EXCLUDED THE MACHINE TIER 1 EXISTS FOR. With credentials in the OS keychain
    // there is no ~/.codex/auth.json, so the ladder answers `unknown`, `isStale` returns false for
    // every non-subscription source, and the capture that would have resolved it never ran.
    if (authChangeNeedsProbe || shouldProbeAccount(billingConfig, billingSource, Date.now(), { isStale })) {
      // `resolveSource` and `env` travel with it (G-10-1 L1/L3). Without them the capture reached
      // billing-capture.mjs's MODULE-LEVEL resolveSource and the real process.env, so the inner
      // resolution could contradict the outer one on the line above — a machine resolved here as
      // `subscription` could still have its plan fields dropped by a second, unseen resolution
      // reading a different environment and a different auth.json.
      const { config } = await captureFromCodexAccount({
        via: 'session-start',
        existing: billingConfig,
        env: env,
        deps: {
          readChatgptAuth,
          resolveSource,
          readAccountViaAppServer,
          // Shorter than the module default: this sits inside the hook's 10s budget alongside a
          // queue flush and a repo probe, and a machine with no `codex` on its PATH must fall
          // through to tier 2 quickly rather than spending the budget proving it.
          appServerTimeoutMs: APP_SERVER_TIMEOUT_MS,
        },
      });
      if (config) {
        // Advance the marker only after capture succeeded. A transient app-server/auth read failure
        // therefore retries on the next session instead of sealing the stale account indefinitely.
        const captured = typeof authFileMtimeMs === 'number'
          ? { ...config, authFileMtimeMs }
          : config;
        writeBillingConfig(captured);
        billingConfig = captured;
        // A changed auth file already changes the payload hash when the identity or plan changed.
        // Do not force its check-in: a token-only refresh should remain a zero-network event.
        forceAccountSync = !authChangeNeedsProbe;
        // RE-RESOLVE on the config we just wrote. The capture can teach the ladder something it
        // did not know a moment ago — step 4b reads the `authType` only a live app-server reading
        // can record — and on a machine with no auth.json that is the difference between
        // `subscription` and `unknown`. Left un-resolved, the nudge below would tell a machine that
        // just captured `plus` that its billing cannot be determined, and the realignment above
        // would have written `unknown` over the source the capture had earned.
        const resolved = resolveSource(billingConfig, env);
        if (resolved !== billingSource) {
          billingSource = resolved;
          const realigned = syncBillingSource(billingConfig, resolved);
          if (realigned) {
            writeBillingConfig(realigned);
            billingConfig = realigned;
          }
        }
      }
    }
  } catch { /* best-effort */ }

  // Tell Beezi which ChatGPT account and plan this machine is on (G-2-1). Best-effort and gated:
  // its steady state — unchanged payload, checked in within the week — is two reads and NO network.
  //
  // Three things travel that are not optional:
  //   fetchImpl / readChatgptAuth — the seams this hook already threads. A bare call would run the
  //                                  real reader and the real fetch, reopening exactly the
  //                                  hermeticity class G-10-1 closed on this path.
  //   timeoutMs: 1500              — a refusal never seals the marker, so an unreachable API would
  //                                  otherwise cost the full POST_TIMEOUT_MS on EVERY session start,
  //                                  forever, inside the hook's 10s budget.
  //   readBillingConfig            — reuses the config this hook just resolved: one fewer read, and
  //                                  the check-in cannot disagree with the hook about the plan. If
  //                                  the billing try threw before its read, billingConfig is null
  //                                  and the module falls through to the id_token decode, which is
  //                                  the correct answer for a machine with no config.
  //
  // `force` is reserved for periodic/non-file captures. An auth-file revalidation already moves the
  // payload hash when account or plan changed; leaving force false keeps token-only refreshes
  // network-free while still propagating an account switch in this run.
  //
  // One check-in per account, serially. The payload is the same for all of them — it describes
  // the ChatGPT sign-in and plan this MACHINE is on — but the marker that suppresses a redundant
  // POST is per account, so a workspace linked yesterday still gets its first check-in even
  // though another was told the same thing last week.
  for (const session of active) {
    try {
      await syncAccount(session.key, session, { force: forceAccountSync }, {
        fetchImpl,
        readChatgptAuth,
        readBillingConfig: () => billingConfig,
        timeoutMs: 1500,
      });
    } catch { /* best-effort */ }
  }

  let message = warnings.length
    ? (systemMessage ? `${warnings.join('\n')}\n${systemMessage}` : warnings.join('\n'))
    : systemMessage;
  let nudge = null;
  if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
    // Reached only when the auto-capture above could not name a plan it trusts — so pointing the
    // user at a "refresh" would send them to the command that just failed.
    const expiredAt = (billingConfig || {}).credentialsExpiresAt;
    nudge = (typeof expiredAt === 'number' && expiredAt <= Date.now())
      // Name the date: this is fixable at the source, and "sign in again" is a different and much
      // cheaper action than answering a tier questionnaire.
      ? `Beezi: your Codex sign-in expired on ${new Date(expiredAt).toISOString().slice(0, 10)}, so your plan cannot be read — sign in to Codex again, or ask Beezi to record your plan.`
      : 'Beezi: could not read your ChatGPT plan — usage is reported without a plan. Ask Beezi to sign you in.';
  } else if (billingSource === BillingSource.UNKNOWN) {
    // Reported honestly rather than guessed — but the user can resolve it, so say so.
    nudge = 'Beezi: cannot determine how this machine bills Codex — usage is reported as "unknown". Ask Beezi to sign you in.';
  }
  if (nudge) message = message ? `${message}\n${nudge}` : nudge;

  // The stale-version check (G-8-4). Last, and deliberately after everything that reports
  // analytics: it is the only thing here the user can act on outside this session, and it must
  // never be the reason a checkpoint did not flush. At most one request an hour, bounded at 1.5s,
  // and silent on every outcome except a published version newer than this one.
  try {
    const update = updateNotice(await checkForUpdate({ fetchImpl }));
    if (update) message = message ? `${message}\n${update}` : update;
  } catch { /* best-effort */ }
  return message;
}
