import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { apiBase, OAUTH_SCOPES } from './config.mjs';
import { discover, registerClient, pkcePair, exchangeCode } from './oauth.mjs';
import { getCredentials, setCredentials, deleteCredentials } from './credentials.mjs';
import { startLoopback } from './loopback.mjs';
import { setMachineClientId } from './machine-identity.mjs';
import { whoami } from './whoami.mjs';
import { linkStatus, LinkState } from './link-status.mjs';

// The browser PKCE flow that links this machine. It lives in lib because two very different
// callers need it: the CLI script, which prints as it goes, and the MCP bridge's `beezi_login`
// tool, whose process owns stdout for JSON-RPC and must not print a single byte. Hence `onStep`
// rather than console.log — the default is silence, and only the CLI opts into output.

// Non-blocking, but *observed*. It stays async — this used to be execFileSync, which is harmless
// in a CLI but blocks the event loop of the MCP server that now also signs in; cold PowerShell
// costs several hundred ms, during which readline stops draining stdin and the loopback listener
// cannot accept the very callback we are waiting for. It is no longer detached-and-forgotten
// though: a launcher that fails is the difference between "a tab opened" and a user staring at a
// spinner, and under a sandboxed shell (Codex sandboxes what it runs) or a machine with no http
// association, failing silently leaves nothing to go on. Resolves { ok } | { ok: false, detail }.
function launch(file, args, env, { timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stderr piped, not ignored: ShellExecute failures ("No application is associated with the
      // specified file for this operation") are reported by the launcher, not by the spawn.
      child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    } catch (error) {
      resolve({ ok: false, detail: error?.message ?? String(error) });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, 500); });
    let done = false;
    // Settle once, then stop holding the event loop open on the launcher's account — the caller is
    // about to wait on the loopback callback, which may take minutes. Listeners are left attached
    // rather than stripped: removeAllListeners would also drop the ones Node uses to tear down the
    // child's stdio.
    const settle = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.unref?.();
      resolve(result);
    };
    // The launcher only asks the OS to open a URL, so it should exit immediately. If it does not,
    // treat the launch as unobserved rather than waiting: the caller has already shown the URL.
    const timer = setTimeout(() => settle({ ok: true }), timeoutMs);
    timer.unref?.();
    child.on('error', (error) => settle({ ok: false, detail: error?.message ?? String(error) }));
    child.on('exit', (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() || `launcher exited ${code}` }));
  });
}

const LAUNCH_TIMEOUT_MS = 5000;

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
    return { ok: false, detail: error?.message ?? String(error) };
  }
}

// Bind the loopback listener, reusing this machine's registered client when its
// callback port is free; otherwise register a fresh client on a new port. Clerk
// matches redirect URIs exactly (port included), so client_id and redirect_uri
// always travel together.
async function bindClient(meta, existing, state, deps) {
  if (existing?.client_id && existing.redirect_uri) {
    const port = Number(new URL(existing.redirect_uri).port);
    try {
      const lb = await deps.startLoopback({ port, expectedState: state });
      return { ...lb, clientId: existing.client_id };
    } catch {
      // Port taken by another process — fall through to a fresh registration.
    }
  }
  const lb = await deps.startLoopback({ port: 0, expectedState: state });
  try {
    const clientId = await deps.registerClient(meta.registrationEndpoint, lb.redirectUri);
    return { ...lb, clientId };
  } catch (error) {
    // The listener is already bound; abandoning it here would hold the port and leave `code`
    // pending until it rejects into nothing — fatal in the MCP server, which lives for the session.
    lb.cancel?.();
    throw error;
  }
}

// Link this machine, or report that it already is.
//
// `onStep` receives progress events instead of them being printed: `{ type: 'already-linked',
// account }`, `{ type: 'authorize-url', url }`, `{ type: 'linked', account, storedIn }`. Returns
// the same shape as the terminal event, so a caller that ignores onStep still learns the outcome.
export async function performLogin({ onStep = () => {}, deps = {} } = {}) {
  const d = {
    discover, registerClient, exchangeCode, startLoopback, whoami, linkStatus,
    getCredentials, setCredentials, deleteCredentials, openBrowser, pkcePair,
    ...deps,
  };
  const base = apiBase();

  // The stored client is still needed for `bindClient` (its redirect port), but whether the
  // machine counts as linked is decided by linkStatus — the same check `me.mjs` and the status
  // tool use, and refresh-aware. Asking the raw credentials here is what let this report
  // "already linked" while a script reported the opposite in the same minute.
  let existing = await d.getCredentials().catch(() => null);
  if (existing) {
    setMachineClientId(existing.client_id);
    const status = await d.linkStatus();
    if (status.state === LinkState.LINKED) {
      const result = { type: 'already-linked', account: status.account, apiBase: status.apiBase };
      onStep(result);
      return result;
    }
    if (status.state === LinkState.REVOKED || status.state === LinkState.NOT_LINKED) {
      // Either the portal rejected the token, or refreshing it hit invalid_grant and getAccessToken
      // already wiped the store. Both mean the OAuth client registered with that grant is gone, so
      // reusing `existing.client_id` would fail the authorize request with invalid_client — the
      // stale object has to be dropped even though the credentials themselves may already be.
      await d.deleteCredentials().catch(() => {});
      existing = null;
    }
    // UNREACHABLE → the credentials may be perfectly good; keep the client and reuse its port.
  }

  const meta = await d.discover();
  const { verifier, challenge } = d.pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const { redirectUri, clientId, code } = await bindClient(meta, existing, state, d);

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
  const launched = await d.openBrowser(authorizeUrl);
  if (!launched?.ok) onStep({ type: 'browser-failed', url: authorizeUrl, detail: launched?.detail ?? null });

  const authCode = await code; // blocks until the callback or timeout

  const tokens = await d.exchangeCode({
    tokenEndpoint: meta.tokenEndpoint,
    clientId,
    redirectUri,
    code: authCode,
    verifier,
  });

  const storedIn = await d.setCredentials({
    client_id: clientId,
    redirect_uri: redirectUri,
    token_endpoint: meta.tokenEndpoint,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 86_400) * 1000,
  });
  setMachineClientId(clientId);

  const who = await d.whoami(tokens.access_token, { base }).catch(() => null);
  // apiBase travels with every outcome, not just the already-linked one: a machine signed in
  // against the wrong BEEZI_API_URL is exactly the case this field exists to make visible.
  const result = { type: 'linked', account: who?.name || who?.email || null, storedIn, apiBase: base };
  onStep(result);
  return result;
}
