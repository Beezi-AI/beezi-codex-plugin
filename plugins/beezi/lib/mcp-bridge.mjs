import { getAuthentication as _getAuthentication } from './token.mjs';
import {
  getAccount as _getAccount,
  getDefaultKey as _getDefaultKey,
  listAccounts as _listAccounts,
} from './accounts.mjs';
import { checkEnvironment } from './env-guard.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { apiBase } from './config.mjs';
import { performLogin as _performLogin, refusedSameTenantMessage } from './login.mjs';
import {
  linkStatus as _linkStatus, describeLink, describeReporting, LinkState, NO_DEFAULT_ACCOUNT,
} from './link-status.mjs';
import { ensureHooks as _ensureHooks, TRUST_STEP } from './hooks-install.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';
import { orDefault } from './compat.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Codex runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// login credentials the hooks use (refresh included). Server→client push (the
// standing GET stream) is not bridged: the drafting tools are strictly
// request/response.

// Bounds a hung request, not normal tool latency (board writes take seconds).
//
// On the streaming path this is an IDLE window, not a total cap (G-9-7). It is armed when the
// request goes out, restarted when the response headers land, and restarted again by every chunk
// of the SSE body — so what it bounds is *silence*: the wait for a first byte, then each gap
// between chunks. A stream that keeps delivering may legitimately run far longer than this, and
// that is the point. The earlier deadline was cleared the moment `fetch` resolved, which is at the
// headers, so the body read that follows was bounded by nothing at all: a stream that went quiet
// after its headers hung the tool call forever, with no error and no output.
//
// Deliberately no total ceiling on that path. A long tool call that is still streaming is a
// working tool call; capping it would put back exactly the failure this window exists to avoid.
//
// The non-streaming path is the asymmetry to know about: `res.text()` exposes no per-chunk hook,
// so a plain JSON body gets this as a hard cap on the whole read rather than an idle window. That
// is deliberate — 120s is far beyond any JSON-RPC response body — but it is a cap, not an idle
// window, and a future abort on a large non-streaming payload will come from here.
const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_HEADER = 'mcp-session-id';

// Codex spawns this server eagerly at the start of every session, so an unlinked machine must not
// make the handshake fail — that reads to the user as "the plugin is broken" and takes the skill
// down with it. Unlinked, the bridge answers `initialize` locally and serves the two tools defined
// below — signing in and reporting status, LOCAL_TOOLS — so the model always has a way out. That
// is also the whole auto-login story: Codex's native MCP OAuth only covers streamable-HTTP
// servers, and using it would put the token in Codex's store while the analytics hooks read
// ~/.beezi-codex/credentials.json, so the machine would have to be linked twice.
const PROTOCOL_VERSION = '2025-06-18';

export const LOGIN_TOOL = Object.freeze({
  name: 'beezi_login',
  title: 'Sign in to Beezi',
  description:
    'Link this machine to Beezi. Opens a browser to sign in with the user’s Beezi account and ' +
    'stores the credentials locally. Call this when Beezi reports that the machine is not linked, ' +
    'or when the user asks to sign in, log in, or connect to Beezi. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

// Answering "am I linked / why is nothing reported" has to happen here, not in a script the model
// shells out to: this server is spawned by Codex and inherits BEEZI_API_URL and the credential
// store, while a sandboxed shell command may see neither — which is exactly how the login tool and
// a status script ended up contradicting each other.
export const STATUS_TOOL = Object.freeze({
  name: 'beezi_status',
  title: 'Beezi status',
  description:
    'Report whether this machine is linked to Beezi, which account it is linked as, which Beezi ' +
    'API it is talking to, and whether the analytics hooks are installed. Call this when the user ' +
    'asks about their Beezi link or connection status, or asks why their Beezi analytics are ' +
    'empty or not being tracked. Prefer this over running any status script. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

export const LOCAL_TOOLS = Object.freeze([LOGIN_TOOL, STATUS_TOOL]);

const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Call the beezi_login tool to relink.";

// The three states in which this bridge has no account to forward a request as. They are kept
// apart because their remedies differ and because the first sentence is FALSE of the other two: a
// machine with two accounts linked is not "not linked", and a sign-in links ANOTHER account rather
// than picking among the ones already here.
const NOT_LINKED_MESSAGE =
  `This machine is not linked to Beezi. Call the ${LOGIN_TOOL.name} tool first, then retry.`;
const NO_DEFAULT_MESSAGE =
  'Beezi accounts are linked on this machine, but none is set as the one the analytics tools read '
  + 'from. Run the accounts skill to choose one, then retry.';
const DEFAULT_UNUSABLE_MESSAGE =
  'Beezi could not use the saved credentials for the account the analytics tools read from. '
  + `Run the accounts skill to choose another account, or call the ${LOGIN_TOOL.name} tool to sign in again.`;

export function mcpUrl() {
  return process.env.BEEZI_MCP_URL || `${apiBase()}/mcp`;
}

// Yields the data payload of each SSE event (multi-line `data:` fields joined
// per the SSE spec). The server closes the stream once every response for the
// POST has been sent, which ends the iteration.
//
// `onChunk` fires on every raw chunk, before parsing, and is how the idle deadline is refreshed.
// It has to be here rather than around the yielded events: an SSE keep-alive is a comment frame
// (`: ping`) with no `data:` field, so it yields nothing — counting only yielded events would let
// a server that is dutifully sending keep-alives be timed out as silent.
async function* sseEvents(body, onChunk) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    if (onChunk) onChunk();
    buf += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

export function createBridge(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const getDefaultKey = deps.getDefaultKey || _getDefaultKey;
  const getAuthentication = deps.getAuthentication || _getAuthentication;
  const listAccounts = deps.listAccounts || _listAccounts;
  const getAccount = deps.getAccount || _getAccount;
  const url = deps.url || mcpUrl();
  const write = deps.write;
  const logError = deps.logError || ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`));
  const timeoutMs = orDefault(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
  const performLogin = deps.performLogin || _performLogin;
  const linkStatus = deps.linkStatus || _linkStatus;

  let sessionId = null;
  // Which account the upstream session id above belongs to. Remembered rather than re-derived,
  // because the id and the bearer are only valid together: the portal issued that session to THAT
  // account's token, and what it answers to a mismatched pair is not established anywhere in this
  // repo. A 404 would be recovered transparently; a 401 becomes REJECTED_MESSAGE, "call the
  // beezi_login tool to relink" — the exact wrong diagnosis this task exists to remove.
  //
  // So `accountKey` gates BOTH ENDS, and it took a review to get the second one: `emit` may only
  // publish a session id while the response's account is still current, and `post` may only send
  // one while the request's account is. Gating the write alone left every request between the key
  // check and the wire reading an ambient id that could already belong to somebody else — which
  // test/account-bridge.test.mjs cases 8 and 9 caught sending, with the pairs printed.
  let accountKey = null;
  let initializeMsg = null;
  // { key, promise } — an in-flight transparent re-initialize, shared by concurrent 404s OF THE
  // SAME ACCOUNT. Keyed, because two accounts' handshakes are different operations producing
  // different upstream sessions: a waiter that inherited another account's would proceed on a
  // session its own bearer was never issued.
  let reinit = null;
  // Has an `initialize` reached the portal? False while unlinked (we answered it ourselves), so a
  // machine linked mid-session hands the portal its handshake before the first real request.
  let upstreamReady = false;

  // `JSON.parse('null')` and `JSON.parse('7')` both succeed, so handleLine's guard lets non-objects
  // through — and these run before the token check, on the very path that exists to keep an
  // unlinked server alive. An unguarded deref here throws outside handleMessage's try/catch and
  // takes the whole bridge down with an unhandled rejection.
  const methodOf = (msg) => (msg && !Array.isArray(msg) ? msg.method : undefined);
  const isInitialize = (msg) => methodOf(msg) === 'initialize';
  const isToolsList = (msg) => methodOf(msg) === 'tools/list';
  // Which locally-served tool, if any, a message is calling.
  const localToolCall = (msg) => {
    if (methodOf(msg) !== 'tools/call') return null;
    const wanted = (msg.params || {}).name;
    const tool = LOCAL_TOOLS.find((t) => t.name === wanted);
    return tool ? tool.name : null;
  };

  // Ids of the requests in the message (single or legacy batch); responses and
  // notifications carry none and get no synthesized error.
  function requestIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.method !== undefined)
      .map((m) => m.id);
  }

  function writeMessage(obj) {
    write(JSON.stringify(obj));
  }

  function errorResponse(id, message) {
    writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  // One request's idle deadline, shared by the POST and by the body read that follows it. The
  // controller has to outlive the fetch promise: `fetch` resolves at the response headers, and
  // everything G-9-7 is about happens after that, while the SSE body is being drained.
  //
  // Cleared, never unref'd — the same rule the login grace timer is under. An unref'd timer lets
  // the loop drain out from under whatever is waiting on it; `stop()` gives the same "never delays
  // exit" property with no hole. `stop` is idempotent and latching, so a late refresh after the
  // response is finished cannot re-arm a timer nobody will clear.
  function armDeadline() {
    const controller = makeAbortController();
    let timer = null;
    let finished = false;
    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const refresh = () => {
      if (finished) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        // Latch here too, not only in stop(). Once we have aborted, the request is over: a chunk
        // that was already buffered when the abort landed must not re-arm a fresh window on the
        // way out. Today `stop()` always runs in emit's finally and would clear it anyway — this
        // keeps the invariant inside armDeadline instead of depending on that chain.
        finished = true;
        controller.abort();
      }, timeoutMs);
    };
    const stop = () => {
      finished = true;
      clear();
    };
    refresh();
    return { signal: controller.signal, refresh, stop };
  }

  // res -> its deadline. Keyed on the response so `emit` can refresh and release the timer that
  // `post` armed without every call site having to thread it through. Weak so a response that is
  // dropped without being read (the 404 we re-post over) cannot pin anything.
  const deadlines = new WeakMap();

  // Idempotent: several paths can reach the same response, and the discard paths below call this
  // defensively rather than reasoning about which one got there first.
  function releaseDeadline(res) {
    const deadline = res ? deadlines.get(res) : undefined;
    if (!deadline) return;
    deadlines.delete(res);
    deadline.stop();
  }

  function refreshDeadline(res) {
    const deadline = res ? deadlines.get(res) : undefined;
    if (deadline) deadline.refresh();
  }

  // `session` is one account's { key, token, clientId } — the bearer and the client id inseparably,
  // the same object every other posting site in this plugin takes. machineHeaders() used to be
  // called with nothing here, so every forwarded request went out with no X-Beezi-Client at all.
  async function post(msg, session) {
    const deadline = armDeadline();
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          // THE READ SIDE OF THE PAIRING, and the half that was missing. `sessionId` is ambient by
          // protocol, and every await between handleMessage's key check and this line — inside
          // reinitialize, and either side of the 404 retry — is a window in which the default can
          // move. Gating only the WRITE (emit) left those requests reading an id that by then
          // belonged to another account: measured, not theorised — test/account-bridge.test.mjs
          // cases 8 and 9 print the exact pairs this used to send.
          //
          // What this establishes is the whole of what it establishes: a stale request goes out
          // WITHOUT a session id. How the portal answers a sessionless non-`initialize` POST is not
          // established anywhere in this repo, and the recovery below keys on 404 alone — so do not
          // read this as "it recovers". That request belongs to an account that is no longer the
          // default; before this gate it went out carrying a mismatched pair instead, and what the
          // portal made of THAT is no better established here. The gate's claim is only that it can
          // no longer reach REJECTED_MESSAGE — "call the beezi_login tool to relink" — on a machine
          // whose credentials are perfectly good.
          ...((sessionId && isCurrent(session.key)) ? { [SESSION_HEADER]: sessionId } : {}),
          ...machineHeaders(session.clientId),
        },
        body: JSON.stringify(msg),
        signal: deadline.signal,
      });
    } catch (error) {
      // Nothing downstream will ever see this response, so the timer has no later owner.
      deadline.stop();
      throw error;
    }
    // Headers are activity: restart the window before handing the body to whoever reads it.
    deadline.refresh();
    // A WeakMap key must be an object. A fetchImpl that answered with something else is already a
    // bug, but it must surface as the caller's own TypeError, not as one thrown from in here.
    if (res && typeof res === 'object') deadlines.set(res, deadline);
    else deadline.stop();
    return res;
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so
  // each lands as one line. `silent` drains instead — used for the transparent
  // re-initialize, whose response the client must not see twice. `transform`
  // rewrites each message on the way out.
  // Upstream state — the session id and the handshake flag — belongs to ONE account, and only the
  // account we are currently forwarding as may publish it. scripts/mcp.mjs starts each line's
  // handling WITHOUT awaiting the previous, so a default switch can land between a request going
  // out and its response coming back; without this check, that older response writes its session id
  // over state `accountKey` already says belongs to another bearer, and the very next request pairs
  // the two. Check-then-act is unavoidable here (there is one ambient sessionId, by protocol), so
  // the act is gated on the check still holding.
  const isCurrent = (key) => key === accountKey;

  async function emit(res, { silent = false, transform = (m) => m, key = null } = {}) {
    try {
      const newSession = res.headers.get(SESSION_HEADER);
      if (newSession && isCurrent(key)) sessionId = newSession;
      if (res.status === 202 || res.status === 204) return;
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        // Every chunk restarts the idle window, so a stream that keeps talking is never cut off
        // and one that goes quiet is aborted after `timeoutMs` of silence (G-9-7).
        for await (const data of sseEvents(res.body, () => refreshDeadline(res))) {
          if (!silent) writeMessage(transform(JSON.parse(data)));
        }
        return;
      }
      const text = await res.text();
      if (text && !silent) writeMessage(transform(JSON.parse(text)));
    } finally {
      // The body is drained, aborted or thrown past — either way nothing else will read it.
      releaseDeadline(res);
    }
  }

  // The portal serves neither of the local tools — it authenticates by bearer token and knows
  // nothing about this machine's hooks — so the bridge appends them to every tool listing. Without
  // this, a link revoked mid-session leaves the model with no listed way to recover, and "why is
  // nothing being tracked?" has no answer that does not involve a sandboxed shell.
  const withLocalTools = (msg) => {
    if (!msg || !msg.result || !Array.isArray(msg.result.tools)) return msg;
    const missing = LOCAL_TOOLS.filter((t) => !msg.result.tools.some((u) => u && u.name === t.name));
    return missing.length
      ? { ...msg, result: { ...msg.result, tools: [...msg.result.tools, ...missing] } }
      : msg;
  };

  // The portal's MCP sessions are in-memory; an API restart between turns loses
  // them (HTTP 404). Rebuild one transparently — replay initialize (response
  // hidden) and the initialized notification — so the client never notices.
  function reinitialize(session) {
    if (!reinit || reinit.key !== session.key) {
      // `sessionId = null` stays UNGUARDED: clearing is always safe (the worst it costs is one 404
      // and the recovery that follows), while setting under the wrong account is the pairing this
      // whole mechanism exists to prevent.
      const promise = (async () => {
        sessionId = null;
        const res = await post(initializeMsg, session);
        if (!res.ok) {
          // Discarded unread, so `emit` will never reach its release.
          releaseDeadline(res);
          throw new Error(`re-initialize failed (HTTP ${res.status})`);
        }
        await emit(res, { silent: true, key: session.key });
        await emit(await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session), { key: session.key });
        if (isCurrent(session.key)) upstreamReady = true;
      })();
      // Identity-checked, or a slow handshake for the account we have just left would clear the
      // entry belonging to the one we are now on.
      reinit = { key: session.key, promise };
      promise.catch(() => {}).then(() => {
        if (reinit && reinit.promise === promise) reinit = null;
      });
    }
    return reinit.promise;
  }

  const toolText = (id, text, isError = false) => {
    writeMessage({ jsonrpc: '2.0', id, result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] } });
  };

  async function runLocalTool(name, id) {
    if (name === STATUS_TOOL.name) return runStatusTool(id);
    return runLoginTool(id);
  }

  // One sign-in at a time. performLogin binds a loopback port, registers an OAuth client and opens
  // a browser; a second concurrent run registers a second client, opens a second window, and races
  // the first on the credential store — whichever setCredentials lands last silently wins, and the
  // loser's registered client is orphaned server-side. Refused rather than queued: the user is
  // looking at a browser tab right now, and queueing would open another one behind it.
  let loginInFlight = false;

  // How long the login tool waits for the whole browser round-trip before answering with the URL
  // and letting the rest finish in the background. Short enough to beat any client-side request
  // timeout, long enough that an already-authenticated user (whose browser round-trip takes a
  // second) still gets the plain "signed in" answer.
  const GRACE_MS = orDefault(deps.loginGraceMs, 25_000);

  // Sign in, then tell the client its tool list changed so the drafting tools appear without a
  // restart. The flow is silent by design: this process's stdout is the JSON-RPC channel, so the
  // authorize URL travels back inside the tool result instead of being printed.
  async function runLoginTool(id) {
    if (loginInFlight) {
      toolText(
        id,
        'A Beezi sign-in is already in progress — finish it in the browser window that opened, then retry.',
        true,
      );
      return;
    }
    loginInFlight = true;
    let authorizeUrl = null;
    let browserFailed = null;
    const onStep = (s) => {
      if (s.type === 'authorize-url') authorizeUrl = s.url;
      if (s.type === 'browser-failed') browserFailed = s;
    };

    const login = performLogin({ onStep });
    // Never let the background continuation surface as an unhandled rejection — Node makes those
    // fatal, and this server has to survive a failed sign-in for the rest of the session.
    login.catch(() => {});

    let graceTimer = null;
    const settled = await Promise.race([
      login.then((result) => ({ result })).catch((error) => ({ error })),
      // The whole point of the grace period: the rest of this flow waits on a human in a browser.
      // Blocking the JSON-RPC request for that is what showed up as a tool call that never returns
      // — the client spins with no output, and if the browser never opened there is nothing on
      // screen to act on. Answer with the URL instead, and let the link complete in the background.
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve({ pending: true }), GRACE_MS);
      }),
    ]);
    // Cleared, not unref'd. An unref'd timer does not hold the loop open, so when the race waits
    // only on this timer (the login is still with the human in the browser) the loop can drain out
    // from under it and the await never settles. Clearing on settle gives the same "never delay
    // exit" property without that hole — and it must happen here, above every return below, or a
    // fast sign-in leaves a 25s timer pending in a server that lives for the whole session.
    clearTimeout(graceTimer);

    if (settled.pending) {
      const lines = browserFailed
        ? [`Could not open a browser automatically${browserFailed.detail ? ` (${browserFailed.detail})` : ''}.`]
        : ['A browser window was opened for you to sign in.'];
      if (authorizeUrl) lines.push(`Open this URL to finish signing in: ${authorizeUrl}`);
      lines.push('The sign-in is still running here — once you have finished in the browser, call beezi_status to confirm the machine is linked.');
      toolText(id, lines.join('\n'));
      // The link still completes (or fails) on its own; announce the new tool list when it lands.
      login
        .then(() => writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
        .catch((error) => logError(`background sign-in failed: ${error && error.message ? error.message : error}`))
        .finally(() => { loginInFlight = false; });
      return;
    }

    loginInFlight = false;
    if (settled.error) {
      const detail = settled.error && settled.error.message ? settled.error.message : String(settled.error);
      const fallback = authorizeUrl ? ` Open this URL to finish signing in: ${authorizeUrl}` : '';
      toolText(id, `Beezi sign-in failed: ${detail}.${fallback}`, true);
      return;
    }
    const { result } = settled;
    // A second user of a tenant this machine already reports into: nothing was stored, so there is
    // no key to hand back and the tool list has not changed.
    if (result.outcome === 'refused-same-tenant') {
      toolText(id, refusedSameTenantMessage(result), true);
      return;
    }
    // `account` is the index row lib/accounts.mjs keeps, not a display string.
    const named = result.account && (result.account.name || result.account.email);
    const account = named ? ` as ${named}` : '';
    const where = result.apiBase ? ` (API: ${result.apiBase})` : '';
    // The same last line scripts/login.mjs prints, for the same reason: the login skill threads
    // the key into the check-in and the history pull, and this tool is the path it prefers.
    const key = result.key ? `\naccount=${result.key}` : '';
    const text = result.outcome === 'already-linked'
      ? `This machine is already linked to Beezi${account}${where}.${key}`
      : `Signed in to Beezi${account}. This machine is now linked; the Beezi tools are available.${key}`;
    toolText(id, text);
    writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  // ── keeping the hooks installed, without asking ───────────────────────────
  //
  // THIS IS THE ONLY PROCESS THAT CAN DO IT. A stale hook entry points at the previous plugin
  // version's script, so Codex's spawn fails and `session-start.mjs` never runs — the hooks cannot
  // repair themselves, by definition of being broken. The MCP server is spawned eagerly at the
  // start of every session, needs no trust, and lives the whole session, so it is the one Beezi
  // code path that still executes on a machine whose hooks are dead. Entries name a stable
  // launcher, so an upgrade no longer produces that machine; a deleted data root or a legacy
  // versioned-path install still does.
  //
  // Bounded hard, because this runs inside the process that must never take the plugin down:
  //   · once per process — a no-op check is cheap but not free, and nothing changes mid-session.
  //   · linked only — a machine that never signed in gets no entries written on its behalf.
  //   · synchronous and fully caught — ensureHooks() is sync fs work under a defer-on-contention
  //     lock, so there is no promise to leak into the message loop and no error to escape it.
  //   · a no-op when healthy — ensureHooks() refuses to rewrite identical entries, because a
  //     rewrite changes each hook's hash and would revoke trust the user already granted.
  //
  // The verdict is REMEMBERED, not just the fact that it ran: the repair usually happens on the
  // session's `initialize`, long before the user asks why nothing is tracked, and the trust step it
  // asks for stays outstanding until they do it. A status call later in the same session has to be
  // able to say so.
  let healed = false;
  let healNote = null;
  function selfHeal() {
    if (healed) return healNote;
    healed = true;
    try {
      const result = (deps.ensureHooks || _ensureHooks)();
      if (!result.repaired) return null;
      const swept = result.swept && result.swept.length
        ? ` ${result.swept.length} dead entr${result.swept.length === 1 ? 'y' : 'ies'} from an older install ${result.swept.length === 1 ? 'was' : 'were'} removed.`
        : '';
      // The trust step is the one half that cannot be automated, so it is the one half reported.
      healNote = `Beezi ${result.before === 'absent' ? 'installed' : 'repaired'} the analytics hooks automatically.${swept}`
        + ` To finish, ${TRUST_STEP} — Codex will not run a hook it has not been shown.`;
      return healNote;
    } catch {
      return null;
    }
  }

  async function runStatusTool(id) {
    try {
      // `healNote`, not another selfHeal() call: on a linked machine the repair has already run —
      // handleMessage does it before any tool is dispatched — so `linkStatus()` below is already
      // reading the repaired registry. On an UNLINKED machine nothing has been written, and nothing
      // should be: hooks are installed at login, for someone who has asked for analytics.
      const repair = healNote;
      // `deps`, not nothing. linkStatus takes a seam for every part of its answer, and handing it
      // none meant this tool reported on a different account resolution than the one the bridge
      // forwards with. In production `deps` carries no such seam, so nothing about a real machine
      // changes; it is what lets the state below be driven against a real index.
      const status = await linkStatus(deps);
      // THE LIFT lib/me.mjs APPLIES, for the same reason. The local names differ: `anyLinked`
      // there; here `healthy` is the accounts that can report and `lift` is the raise itself.
      //
      // A linkStatus answer's TOP-LEVEL fields describe the DEFAULT account. So a machine whose
      // default has lost its credentials while a sibling is perfectly healthy answered "This
      // machine is not linked to Beezi. Sign in to link it." and "Analytics are NOT being
      // reported". Both false — the machine IS linked and the sibling IS reporting — and the remedy
      // sent the user to link a third account they did not need. "Is this machine linked" and "is
      // anything being reported" are true as soon as ONE account can report.
      //
      // Only ever a RAISE, never a lower: an answer that already says LINKED is left exactly as it
      // is. That matters here because lib/link-status.mjs falls back to accounts[0] when the
      // default names no row, so `status.state` can already be LINKED on a machine with no default
      // at all — a separate, pre-existing case this must not reach into or restate.
      const accounts = orDefault(status.accounts, []);
      const healthy = accounts.filter((one) => one.state === LinkState.LINKED);
      const lift = healthy.length > 0 && status.state !== LinkState.LINKED;
      const lifted = lift ? { ...status, state: LinkState.LINKED } : status;
      // Printed only when the lift applied, because only then is there a discrepancy to explain:
      // the machine is fine and one account is not. Worded off `defaultKey` rather than assuming
      // one exists — see the accounts[0] fallback above.
      const note = !lift ? null
        : `${healthy.length} of ${accounts.length} linked Beezi accounts can report. `
          + (status.defaultKey === null
            ? NO_DEFAULT_ACCOUNT
            : 'The one the analytics tools read from cannot report just now — run the me skill for each '
              + 'account’s own state, or the accounts skill to read from a different one.');
      const reporting = describeReporting(lifted);
      toolText(id, [describeLink(lifted), reporting, note, repair].filter(Boolean).join('\n'));
    } catch (error) {
      toolText(id, `Beezi status check failed: ${error && error.message ? error.message : String(error)}`, true);
    }
  }

  // ── which account this bridge forwards as ──────────────────────────────────
  //
  // Resolved PER REQUEST, from the DEFAULT account, because the default is a file another process
  // rewrites: `accounts use` is run in a shell while this server is already alive, and a value read
  // once at spawn would keep serving the previous account's analytics for the rest of the session.
  //
  // Two index reads at most and one credential read — the same credential read this path has always
  // made, now with a key. The index reads are a local JSON file; the row is only consulted when the
  // credential blob carried no client id, which is a pre-0.13 migrated row.
  //
  // Answers { key, session } where `session` is null when nothing can be posted: `key` then says
  // which of the three refusals applies. A THROW from the index (the one-time migration in
  // progress, an unreadable accounts.json) is its own answer again — collapsing it into "not
  // linked" would state something about this machine that nobody established.
  async function resolveAccount() {
    let key;
    try {
      key = await getDefaultKey(deps);
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      return { key: null, session: null, blocked: `Beezi could not read this machine's linked accounts: ${detail}` };
    }
    if (key == null) return { key: null, session: null, blocked: null };
    let auth = null;
    try { auth = await getAuthentication(key, deps); } catch (error) { auth = null; }
    if (!auth || auth.state !== 'ready' || !auth.accessToken) return { key, session: null, blocked: null };
    let clientId = auth.clientId;
    // The stored row is the fallback, not the authority — lib/accounts.mjs's sessionFor states the
    // rule: the credential blob is what the refresh actually rotated, so its client_id wins.
    if (clientId == null) {
      const row = await getAccount(key, deps).catch(() => null);
      clientId = orDefault((row || {}).clientId, null);
    }
    return { key, session: { key, token: auth.accessToken, clientId }, blocked: null };
  }

  // Which of the three refusals a null session earns. The distinction is the whole point: two of
  // the sentences are false of the state the third describes.
  async function refusalFor(resolved) {
    if (resolved.blocked) return resolved.blocked;
    let accounts = [];
    try { accounts = orDefault(await listAccounts(deps), []); } catch (error) { accounts = []; }
    if (accounts.length === 0) return NOT_LINKED_MESSAGE;
    if (resolved.key == null) return NO_DEFAULT_MESSAGE;
    return DEFAULT_UNUSABLE_MESSAGE;
  }

  // Unlinked: keep the server alive and useful. `initialize` succeeds locally, the tool list is
  // exactly LOCAL_TOOLS — signing in and status, both served here — so the model has an obvious way
  // out, notifications are dropped, and any other tool call is refused with `message`.
  async function handleUnlinked(msg, ids, message) {
    if (isInitialize(msg)) {
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
          // listChanged: the tool set grows the moment the machine is linked.
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'beezi', title: 'Beezi (not linked)', version: '0.0.0' },
        },
      });
      return;
    }
    if (!ids.length) return;
    if (isToolsList(msg)) {
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: [...LOCAL_TOOLS] } });
      return;
    }
    const local = localToolCall(msg);
    if (local) {
      await runLocalTool(local, msg.id);
      return;
    }
    ids.forEach((id) => errorResponse(id, orDefault(message, NOT_LINKED_MESSAGE)));
  }

  async function serverErrorMessage(res) {
    try {
      const body = await res.json();
      const message = body && body.error && body.error.message;
      if (message) return `Beezi MCP error: ${message}`;
    } catch {
      /* non-JSON body */
    } finally {
      releaseDeadline(res);
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
  }

  // An abort here is always our own idle deadline — nothing else holds the controller. Saying so
  // beats "The operation was aborted", which reads like a cancelled request the user made.
  function requestFailureMessage(error) {
    const detail = error && error.message ? error.message : String(error);
    if (error && error.name === 'AbortError') {
      return `Beezi MCP request timed out after ${timeoutMs}ms with no response from the server.`;
    }
    return `Beezi MCP request failed: ${detail}`;
  }

  async function handleMessage(msg) {
    const ids = requestIds(msg);
    // Remembered even while unlinked, so a link acquired mid-session can replay the client's own
    // handshake to the portal rather than inventing one.
    if (isInitialize(msg)) {
      initializeMsg = msg;
      sessionId = null;
      upstreamReady = false;
    }

    const guard = (deps.checkEnvironment || checkEnvironment)();
    if (guard.status !== 'ok' && guard.status !== 'migrated') {
      upstreamReady = false;
      sessionId = null;
      if (isInitialize(msg) || isToolsList(msg) || !ids.length) {
        await handleUnlinked(msg, ids);
      } else if (localToolCall(msg) === STATUS_TOOL.name) {
        toolText(msg.id, guard.message || `Beezi environment recovery is ${guard.status}.`);
      } else {
        ids.forEach(id => errorResponse(id, guard.message || `Beezi environment recovery is ${guard.status}. Retry after recovery.`));
      }
      return;
    }
    const resolved = await resolveAccount();
    const session = resolved.session;
    if (!session) {
      await handleUnlinked(msg, ids, await refusalFor(resolved));
      return;
    }
    // The default changed under us — `accounts use` ran in a shell while this server stayed alive.
    // Whatever upstream session id we hold was issued to the PREVIOUS account's bearer, so it is
    // dropped rather than paired with this one: the existing re-initialize path below then rebuilds
    // a session under the new token, exactly as it does after an API restart.
    if (session.key !== accountKey) {
      accountKey = session.key;
      sessionId = null;
      upstreamReady = false;
    }
    // First message from a LINKED machine — the earliest point at which installing hooks on the
    // user's behalf is the obviously right thing to do. Its verdict is dropped here and kept for
    // the status tool to surface; nothing about this message's handling depends on it.
    selfHeal();
    // Linked machines still ask for these ("re-link me", "why is nothing tracked?"); answer
    // locally rather than forwarding tools the portal does not have.
    const local = localToolCall(msg);
    if (local) {
      await runLocalTool(local, msg.id);
      return;
    }

    try {
      if (!upstreamReady && initializeMsg && !isInitialize(msg)) {
        await reinitialize(session);
      }
      let res = await post(msg, session);
      if (res.status === 404 && initializeMsg && !isInitialize(msg)) {
        // Thrown away unread in favour of the retry below: release its timer here or it stays
        // armed for the full idle window with nobody left to clear it.
        releaseDeadline(res);
        await reinitialize(session);
        res = await post(msg, session);
      }
      try {
        if (res.ok) {
          if (isInitialize(msg) && isCurrent(session.key)) upstreamReady = true;
          await emit(res, isToolsList(msg)
            ? { key: session.key, transform: withLocalTools }
            : { key: session.key });
          return;
        }
        if (res.status === 401 || res.status === 403) {
          ids.forEach((id) => errorResponse(id, REJECTED_MESSAGE));
          return;
        }
        const message = await serverErrorMessage(res);
        ids.forEach((id) => errorResponse(id, message));
      } finally {
        // Covers the 401/403 branch, which answers without reading the body at all.
        releaseDeadline(res);
      }
    } catch (error) {
      ids.forEach((id) => errorResponse(id, requestFailureMessage(error)));
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  // The account this bridge last forwarded as, and the upstream session id it holds — the pair the
  // switch above has to keep together. Exposed rather than kept in a parallel store, because the
  // bridge already has to remember both to decide whether the id may travel with the next bearer.
  const state = () => ({ accountKey, sessionId });

  return { handleLine, handleMessage, state };
}
