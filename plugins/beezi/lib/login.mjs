// A DEFAULT import, not a named one: tools/hermetic-env.mjs patches the child_process object, and
// a named binding is snapshotted at instantiation and bypasses that guard entirely.
import childProcess from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { apiBase, ENDPOINTS, OAUTH_SCOPES } from './config.mjs';
import { base64urlEncode, orDefault } from './compat.mjs';
import { markLinked, recordWhoami } from './tracking.mjs';
import { discover, registerClient, pkcePair, exchangeCode } from './oauth.mjs';
import { getCredentials, setCredentials } from './credentials.mjs';
import { startLoopback } from './loopback.mjs';
import { whoami } from './whoami.mjs';
import { getAuthentication } from './token.mjs';
import { syncAccountIfNeeded } from './account-sync.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';
import {
  AccountStatus, addAccount, findByEmail, findByTenant, getAccount,
  getDefaultKey, listAccounts, newAccountKey, updateAccount,
} from './accounts.mjs';

// The browser PKCE flow that links a Beezi account to this machine. It lives in lib because two
// very different callers need it: the CLI script, which prints as it goes, and the MCP bridge's
// `beezi_login` tool, whose process owns stdout for JSON-RPC and must not print a single byte.
// Hence `onStep` rather than console.log — the default is silence, and only the CLI opts into
// output.

// The launcher timeout. Declared above its use rather than relying on hoisting.
const LAUNCH_TIMEOUT_MS = 5000;

// Non-blocking, but *observed*. NEVER SYNCHRONOUS: this also runs inside the MCP server, and a
// synchronous spawn blocks its event loop — cold PowerShell costs several hundred ms, during which
// readline stops draining stdin and the loopback listener cannot accept the very callback we are
// waiting for. Not detached-and-forgotten either: under a sandboxed shell (Codex sandboxes what it
// runs) or on a machine with no http association, a launcher that fails silently leaves the user
// staring at a spinner with nothing to go on. Resolves { ok } | { ok: false, detail }.
function launch(file, args, env) {
  return new Promise((resolve) => {
    let child;
    try {
      // stderr piped, not ignored: ShellExecute failures ("No application is associated with the
      // specified file for this operation") are reported by the launcher, not by the spawn.
      child = childProcess.spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    } catch (error) {
      resolve({ ok: false, detail: orDefault((error || {}).message, String(error)) });
      return;
    }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 500); });
    let done = false;
    // Settle once, then stop holding the event loop open on the launcher's account — the caller is
    // about to wait on the loopback callback, which may take minutes. Listeners are left attached
    // rather than stripped: removeAllListeners would also drop the ones Node uses to tear down the
    // child's stdio.
    const settle = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.unref) child.unref();
      resolve(result);
    };
    // The launcher only asks the OS to open a URL, so it should exit immediately. If it does not,
    // treat the launch as unobserved rather than waiting: the caller has already shown the URL.
    const timer = setTimeout(() => settle({ ok: true }), LAUNCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.on('error', (error) => settle({ ok: false, detail: orDefault((error || {}).message, String(error)) }));
    child.on('exit', (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() || `launcher exited ${code}` }));
  });
}

// Ask the OS to open `url` in the user's browser. Resolves { ok } | { ok: false, detail } — never
// rejects, and never throws: the caller has the URL and can always fall back to showing it.
export async function openBrowser(url) {
  // The URL comes from the server response — never pass it through a shell. Require a
  // plain http(s) URL and hand it to the launcher as a single argv element (no shell,
  // no interpolation), so it cannot smuggle command-line metacharacters.
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: 'refusing to open a non-http(s) URL' };
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      // Start-Process uses ShellExecute → the default browser's http(s) association, and
      // handles query strings (?code=…&…) correctly. explorer.exe mis-parses such URLs and
      // can pop a File Explorer / search window instead of the browser. Absolute PowerShell
      // path avoids resolving a bare name against the current directory; the URL is passed
      // as an env var, never spliced into the command text, so it can't be run as script.
      const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return await launch(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:BEEZI_LOGIN_URL'],
        { ...process.env, BEEZI_LOGIN_URL: url },
      );
    }
    if (process.platform === 'darwin') return await launch('/usr/bin/open', [url], process.env);
    return await launch('xdg-open', [url], process.env);
  } catch (error) {
    return { ok: false, detail: orDefault((error || {}).message, String(error)) };
  }
}

// Bind the loopback listener and register a FRESH OAuth client on it. Clerk matches redirect URIs
// exactly (port included), so client_id and redirect_uri always travel together.
//
// The old reuse of a stored client's port is gone with the single-account machine. With several
// accounts linked there is no "this machine's client" to reuse: borrowing account A's client id
// for a round-trip that turns out to be account B would attribute B's bearer to A's machine row.
// Decision 6 therefore mints a client per round-trip, and the branch table below is what disposes
// of the one a re-login does not end up keeping.
async function bindClient(meta, state, deps) {
  const lb = await deps.startLoopback({ port: 0, expectedState: state });
  try {
    const clientId = await deps.registerClient(meta.registrationEndpoint, lb.redirectUri);
    return { ...lb, clientId };
  } catch (error) {
    // The listener is already bound; abandoning it here would hold the port and leave `code`
    // pending until it rejects into nothing — fatal in the MCP server, which lives for the session.
    if (lb.cancel) lb.cancel();
    throw error;
  }
}

const UNLINK_TIMEOUT_MS = 5000;

/**
 * Hand a freshly minted grant back to the portal.
 *
 * Two branches reach this: a re-login of an account that is already linked and healthy, and a
 * second user of a tenant this machine already reports into. Both have a brand-new OAuth client
 * that the whoami above has already registered as a machine row, and neither is going to store it
 * — left behind it is a machine row on the user's Connections tab that nothing will ever report
 * through. 401/403 means the grant is already gone, which is the same outcome.
 *
 * Never throws: the branch's verdict is already decided and a failed cleanup must not replace it.
 */
export async function unlinkMachine(session) {
  const controller = makeAbortController();
  const timer = setTimeout(() => controller.abort(), UNLINK_TIMEOUT_MS);
  try {
    const res = await fetchCompat(`${apiBase()}${ENDPOINTS.machine}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}`, ...machineHeaders(session.clientId) },
      signal: controller.signal,
    });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole browser round-trip, as one injectable step: discover, register, authorize, exchange.
 *
 * It returns the credentials object the store holds — the same shape `setCredentials` writes — so
 * the branch table below never has to know how the tokens were obtained. That seam is also what
 * lets the account tests drive the four branches without a network, a port or a browser.
 */
async function browserExchange(deps, onStep) {
  const meta = await deps.discover();
  const { verifier, challenge } = deps.pkcePair();
  const state = base64urlEncode(crypto.randomBytes(16));
  const { redirectUri, clientId, code } = await bindClient(meta, state, deps);

  const authorizeUrl = `${meta.authorizationEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  // Emitted before the browser opens so a caller can show the URL even if the launcher fails.
  onStep({ type: 'authorize-url', url: authorizeUrl });
  // Awaited so a failed launch is reported rather than swallowed. The loopback listener is already
  // bound, so a callback arriving during this window is still captured.
  const launched = await deps.openBrowser(authorizeUrl);
  if (!(launched && launched.ok)) onStep({ type: 'browser-failed', url: authorizeUrl, detail: orDefault((launched || {}).detail, null) });

  const authCode = await code; // blocks until the callback or timeout

  const tokens = await deps.exchangeCode({
    tokenEndpoint: meta.tokenEndpoint,
    clientId,
    redirectUri,
    code: authCode,
    verifier,
  });

  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    token_endpoint: meta.tokenEndpoint,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + orDefault(tokens.expires_in, 86_400) * 1000,
  };
}

// One account's own { token, clientId }, or null when its stored state cannot produce one — a
// revoked grant, a locked keyring, a refresh another process is holding. Null is what sends a
// known email down the re-arm branch instead of the already-linked one.
//
// The INDEX ROW is the fallback for the client id, never the authority — lib/accounts.mjs's own
// sessionFor states the rule: the credential blob is what the refresh actually rotated, so its
// client_id wins whenever it has one. A row migrated from a pre-0.13 install whose blob carried no
// client_id still names one, and dropping it would null the account's tracking identity and strip
// X-Beezi-Client from the check-in that follows.
async function sessionFor(row, deps) {
  const authenticate = orDefault(deps.getAuthentication, getAuthentication);
  let auth;
  try { auth = await authenticate(row.key, deps); } catch { return null; }
  if (!auth || auth.state !== 'ready' || !auth.accessToken) return null;
  return {
    token: auth.accessToken,
    clientId: auth.clientId == null ? orDefault(row.clientId, null) : auth.clientId,
  };
}

/**
 * The whoami, with "we could not ask" kept apart from "the answer was no".
 *
 * `'unknown'` is a transport failure — offline, a 5xx, a throw. `'invalid'` is the portal's own
 * 401/403 verdict on that token (lib/whoami.mjs returns `{ valid: false }` for exactly those two
 * and `null` for everything else). Collapsing them cost branch 1 its meaning: a blip while
 * re-checking a HEALTHY account read as a dead grant, so the branch table replaced good credentials
 * with the new ones, rebound the tracking identity to the new client, and left the old client a
 * machine row nothing will ever report through — branch 2 unlinks nothing.
 *
 * Returns { state: 'valid', who } | { state: 'invalid' } | { state: 'unknown' }.
 */
async function probeWhoami(deps, session, base) {
  let answer;
  try { answer = await deps.whoami(session, { base }); } catch { return { state: 'unknown' }; }
  if (answer == null) return { state: 'unknown' };
  return answer.valid === true ? { state: 'valid', who: answer } : { state: 'invalid' };
}

// The display lookup: the identity, or null when this token does not currently name anyone. Kept
// as a projection of the probe above so the two cannot disagree about what a valid answer is.
async function askWhoami(deps, session, base) {
  const probe = await probeWhoami(deps, session, base);
  return probe.state === 'valid' ? probe.who : null;
}

/**
 * Give every LINKED row whose email is null the identity its own token names.
 *
 * `findByEmail` can only match a row that HAS an email, so without this a re-login as the same user
 * skips their own row and mints a second one — and `linkedSessions` filters on status, not identity,
 * so the machine then fans out two reports of every session into one workspace. That is the exact
 * double-count decision 4 exists to prevent, and the same-tenant refusal cannot catch it either: it
 * keys on the STORED row's tenantId, which is null on precisely these rows.
 *
 * Two kinds of row arrive here with a null email: one migrated from a pre-0.13 install
 * (migrateSingleAccount writes null for all four fields), and one linked while the portal was
 * unreachable (the whoami below answered nothing, which must still link — test/login.test.mjs).
 *
 * SEQUENTIAL, and it has to be. sessionFor may take `shared:token-refresh-<key>` and updateAccount
 * takes `shared:accounts-index`; both are rank 3, and lib/single-instance-lock.mjs refuses a rank-3
 * lock while this process holds another rank-3 lock under a different name. Each call releases
 * before the next is made, and nothing is held across them.
 *
 * Best-effort throughout: a sign-in must not fail because a row could not be labelled.
 */
async function resolveAnonymousRows(d, base) {
  let rows;
  try { rows = await listAccounts(d); } catch { return; }
  for (const row of rows) {
    if (row.email != null || row.status !== AccountStatus.LINKED) continue;
    const session = await sessionFor(row, d);
    if (session === null) continue;
    const probe = await probeWhoami(d, session, base);
    if (probe.state !== 'valid' || probe.who.email == null) continue;
    try {
      await updateAccount(row.key, {
        email: probe.who.email, name: probe.who.name,
        tenantId: probe.who.tenantId, tenantName: probe.who.tenantName,
      }, d);
    } catch { /* best-effort: the branch table still runs, it just cannot match this row */ }
  }
}

/**
 * The one sentence for a refusal, so the CLI script and the MCP tool cannot drift apart.
 *
 * Decision 4: the plugin reports every session to every linked account, so two users of one tenant
 * would have that tenant counting the same sessions twice.
 */
export function refusedSameTenantMessage(result) {
  const held = result.account || {};
  const workspace = orDefault(held.tenantName, 'that workspace');
  const holder = orDefault(held.email, 'another account');
  const wanted = orDefault((result.who || {}).email, 'this account');
  return `Workspace ${workspace} is already linked as ${holder}. Log that account out first to link ${wanted}.`;
}

/**
 * Link ONE more Beezi account to this machine, leaving every account already linked alone.
 *
 * `deps` is one flat bag: the seams below plus whatever `lib/credentials.mjs` and
 * `lib/accounts.mjs` read out of it (`run`, `platform`), handed on unchanged so a caller that
 * injects a fake credential store steers the whole flow with one object.
 *
 * `deps.onStep` receives progress events instead of them being printed:
 * `{ type: 'authorize-url', url }`, `{ type: 'browser-failed', url, detail }`, and the result
 * itself as the terminal event — so a caller that ignores onStep still learns the outcome.
 *
 * Returns `{ outcome, key, account, defaultKey, who, storedIn, apiBase }`, where `outcome` is one
 * of `'linked'`, `'relinked'`, `'already-linked'` or `'refused-same-tenant'`, `key` is the account
 * key (null on the refusal alone) and `account` is that account's INDEX ROW, not a display string.
 */
export async function performLogin(deps = {}) {
  // The guard runs unless the caller replaced the browser round-trip, which is what a test does;
  // an injected `checkEnvironment` opts back in. R1 names login first among the things the guard
  // precedes: a production sign-in on a machine whose queue was captured against staging is the
  // exact sequence that flushes one tenant's segments to another.
  if ((!deps.exchange && !deps.startLoopback) || deps.checkEnvironment) {
    const { checkEnvironment } = await import('./env-guard.mjs');
    const guard = (deps.checkEnvironment || checkEnvironment)();
    if (guard.status !== 'ok' && guard.status !== 'migrated') throw new Error(guard.message || 'Beezi environment recovery is pending');
  }
  // `getCredentials` is in the bag for `getAuthentication`'s sake, not because this function calls
  // it: lib/token.mjs re-runs the environment guard unless a credential reader was handed in, and
  // the guard's verdict for this whole flow was already taken above — under the caller's seams,
  // which its own unseamed re-check would not see.
  const d = {
    discover, registerClient, exchangeCode, startLoopback, whoami, pkcePair,
    getCredentials, setCredentials, openBrowser, unlinkMachine, getAuthentication,
    syncAccountIfNeeded,
    ...deps,
  };
  const onStep = orDefault(deps.onStep, () => {});
  const base = apiBase();

  const fresh = deps.exchange ? await deps.exchange({ base }) : await browserExchange(d, onStep);
  const newSession = { token: fresh.access_token, clientId: orDefault(fresh.client_id, null) };

  // The whoami is not only a display lookup: it is the request that registers the new client as a
  // machine row, and it is where the email and tenant the branch table reads come from. A portal
  // older than ADO PR #3893 answers with null tenant fields, which disables the same-tenant
  // refusal below and nothing else.
  const who = await askWhoami(d, newSession, base);
  const answer = orDefault(who, {});
  const email = orDefault(answer.email, null);

  // Before the branch table reads the index, give any anonymous row the identity its own token
  // names — otherwise findByEmail cannot see it and branch 4 mints a duplicate. See the function.
  await resolveAnonymousRows(d, base);

  const existingByEmail = await findByEmail(email, d);
  const sameTenant = answer.tenantId ? await findByTenant(answer.tenantId, d) : null;
  const finish = async (outcome, key, account, storedIn) => {
    const result = { outcome, key, account, defaultKey: await getDefaultKey(d), who, storedIn, apiBase: base };
    onStep(result);
    return result;
  };

  // 1. Already linked and healthy: keep the OLD credentials, drop the new client. Replacing the
  //    stored client id would move linkedAt and break the audit's "live tracking owns everything
  //    after the link" rule (decision 6).
  if (existingByEmail && existingByEmail.status === AccountStatus.LINKED) {
    const existing = await sessionFor(existingByEmail, d);
    const probe = existing === null ? { state: 'unknown' } : await probeWhoami(d, existing, base);
    // `unknown` keeps the stored credentials, and that is the point of the three-state probe. The
    // stored token produced a session, and a portal we could not reach has established NOTHING
    // about it — only an `invalid` verdict does. Falling through to branch 2 on a blip replaces a
    // working grant, moves the tracking identity to the new client, and strands the old client as
    // a machine row nothing reports through. `existing === null` is a different fact — the stored
    // state could not produce a token at all — and still falls through to be re-armed.
    const stillValid = probe.state === 'valid' ? probe.who : null;
    if (probe.state === 'valid' || (probe.state === 'unknown' && existing !== null)) {
      try { await d.unlinkMachine(newSession); } catch { /* best-effort */ }
      // Same-identity re-login: refresh the cached tracking policy (trackingMode /
      // backfillCompleted) so the backfill step that follows acts on current facts. The identity
      // stays the STORED client's — nothing about this account's link changed. recordWhoami is a
      // no-op on a null answer, so an unreachable portal leaves the cached policy alone.
      try { recordWhoami(existingByEmail.key, stillValid, existing.clientId); } catch { /* best-effort */ }
      // Check the account in, UNFORCED (G-2-1). A re-login on an unchanged machine is not news:
      // the payload hash still gates it, so this only refreshes last_seen_at once a week rather
      // than posting on every login a user runs to read their status back.
      try { await d.syncAccountIfNeeded(existingByEmail.key, existing, {}); } catch { /* best-effort */ }
      return finish('already-linked', existingByEmail.key, existingByEmail, null);
    }
  }

  // 2. Known email whose stored token is dead: re-arm the SAME key in place. THIS MUST COME BEFORE
  //    THE TENANT CHECK, or re-logging into a revoked account whose tenant still has a live row
  //    would be refused instead of repaired. The directory and its linkedAt stay — the account is
  //    the same one, so its ledger and coverage are still its own.
  if (existingByEmail) {
    const relinkedIn = await d.setCredentials(existingByEmail.key, fresh, d);
    await updateAccount(existingByEmail.key, {
      status: AccountStatus.LINKED, clientId: fresh.client_id,
      name: answer.name, tenantId: answer.tenantId, tenantName: answer.tenantName,
    }, d);
    // The new client id is what the account's reports will carry from here, so the tracking state
    // has to bind to it — a state still naming the dead client reads as another login's.
    try { recordWhoami(existingByEmail.key, who, fresh.client_id); } catch { /* best-effort */ }
    // FORCED: this account has been unable to report for as long as its grant was dead, so its
    // marker describes a check-in the server may never have seen.
    try { await d.syncAccountIfNeeded(existingByEmail.key, newSession, { force: true }); } catch { /* best-effort */ }
    return finish('relinked', existingByEmail.key, await getAccount(existingByEmail.key, d), relinkedIn);
  }

  // 3. A different user of a tenant we already report into: fan-out would count its sessions twice
  //    (decision 4). NOTHING is stored on this path — not the credentials, not a row, not a
  //    directory — and the grant just minted is handed back.
  if (sameTenant) {
    try { await d.unlinkMachine(newSession); } catch { /* best-effort */ }
    return finish('refused-same-tenant', null, sameTenant, null);
  }

  // 4. A new account. It becomes the default only when it is the first one (addAccount's rule):
  //    login never switches the default, the accounts skill does (decision 2).
  //
  //    setCredentials and addAccount are SEQUENTIAL, never nested. The credential lock is rank 4
  //    in LOCK_ORDER and sharedLock('accounts-index') is rank 3, and lib/single-instance-lock.mjs
  //    refuses a lock of equal-or-finer rank than one this process already holds — an index write
  //    inside a held credential lock is refused every time.
  const key = newAccountKey();
  const storedIn = await d.setCredentials(key, fresh, d);
  await addAccount({
    key, email, name: answer.name,
    tenantId: answer.tenantId, tenantName: answer.tenantName, clientId: fresh.client_id,
  }, d);
  // markLinked stamps linkedAt BEFORE anything can be tracked under this account — the backfill
  // uses that instant to skip transcripts live tracking already owns. Nothing is cleared first:
  // the key was minted three lines up, so the account directory the keyed layout gives it is
  // empty by construction and no previous login's ledger or policy can be in it.
  try { markLinked(key); } catch { /* best-effort */ }
  if (who) {
    try { recordWhoami(key, who, fresh.client_id); } catch { /* best-effort */ }
  }
  // Check the account in, FORCED (G-2-1). This is the one trigger where force is load-bearing: a
  // fresh identity inherits the PREVIOUS one's marker, and an unchanged payload hash would suppress
  // the single check-in that is guaranteed to be news. Best-effort — the sign-in is already
  // complete and stored, and nothing here may strand it.
  //
  // It lives in performLogin rather than in scripts/login.mjs because this function is the shared
  // entry for both the CLI script and the `beezi_login` MCP tool.
  try { await d.syncAccountIfNeeded(key, newSession, { force: true }); } catch { /* best-effort */ }
  // apiBase travels with every outcome: a machine signed in against the wrong BEEZI_API_URL is
  // exactly the case this field exists to make visible.
  return finish('linked', key, await getAccount(key, d), storedIn);
}
