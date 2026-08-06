import { getAccessToken as _getAccessToken } from './token.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { apiBase } from './config.mjs';
import { performLogin as _performLogin } from './login.mjs';
import { linkStatus as _linkStatus, describeLink, describeReporting } from './link-status.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Codex runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// login credentials the hooks use (refresh included). Server→client push (the
// standing GET stream) is not bridged: the drafting tools are strictly
// request/response.

// Bounds a hung request, not normal tool latency (board writes take seconds).
const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_HEADER = 'mcp-session-id';

// Codex spawns this server eagerly at the start of every session, so an unlinked machine must not
// make the handshake fail — that reads to the user as "the plugin is broken" and takes the skill
// down with it. Unlinked, the bridge answers `initialize` locally and serves exactly one tool:
// signing in. That is also the whole auto-login story — Codex's native MCP OAuth only covers
// streamable-HTTP servers, and using it would put the token in Codex's store while the analytics
// hooks read ~/.beezi-codex/credentials.json, so the machine would have to be linked twice.
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

export function mcpUrl() {
  return process.env.BEEZI_MCP_URL ?? `${apiBase()}/mcp`;
}

// Yields the data payload of each SSE event (multi-line `data:` fields joined
// per the SSE spec). The server closes the stream once every response for the
// POST has been sent, which ends the iteration.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
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
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const getToken = deps.getAccessToken ?? _getAccessToken;
  const url = deps.url ?? mcpUrl();
  const write = deps.write;
  const logError = deps.logError ?? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const performLogin = deps.performLogin ?? _performLogin;
  const linkStatus = deps.linkStatus ?? _linkStatus;

  let sessionId = null;
  let initializeMsg = null;
  let reinit = null; // in-flight transparent re-initialize, shared by concurrent 404s
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
  const localToolCall = (msg) =>
    methodOf(msg) === 'tools/call'
      ? LOCAL_TOOLS.find((t) => t.name === msg.params?.name)?.name ?? null
      : null;

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

  async function post(msg, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
          ...machineHeaders(),
        },
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so
  // each lands as one line. `silent` drains instead — used for the transparent
  // re-initialize, whose response the client must not see twice. `transform`
  // rewrites each message on the way out.
  async function emit(res, { silent = false, transform = (m) => m } = {}) {
    const newSession = res.headers.get(SESSION_HEADER);
    if (newSession) sessionId = newSession;
    if (res.status === 202 || res.status === 204) return;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const data of sseEvents(res.body)) {
        if (!silent) writeMessage(transform(JSON.parse(data)));
      }
      return;
    }
    const text = await res.text();
    if (text && !silent) writeMessage(transform(JSON.parse(text)));
  }

  // The portal serves neither of the local tools — it authenticates by bearer token and knows
  // nothing about this machine's hooks — so the bridge appends them to every tool listing. Without
  // this, a link revoked mid-session leaves the model with no listed way to recover, and "why is
  // nothing being tracked?" has no answer that does not involve a sandboxed shell.
  const withLocalTools = (msg) => {
    if (!Array.isArray(msg?.result?.tools)) return msg;
    const missing = LOCAL_TOOLS.filter((t) => !msg.result.tools.some((u) => u?.name === t.name));
    return missing.length
      ? { ...msg, result: { ...msg.result, tools: [...msg.result.tools, ...missing] } }
      : msg;
  };

  // The portal's MCP sessions are in-memory; an API restart between turns loses
  // them (HTTP 404). Rebuild one transparently — replay initialize (response
  // hidden) and the initialized notification — so the client never notices.
  function reinitialize(token) {
    reinit ??= (async () => {
      sessionId = null;
      const res = await post(initializeMsg, token);
      if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
      await emit(res, { silent: true });
      await emit(await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token));
      upstreamReady = true;
    })().finally(() => {
      reinit = null;
    });
    return reinit;
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
  const GRACE_MS = deps.loginGraceMs ?? 25_000;

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

    const settled = await Promise.race([
      login.then((result) => ({ result })).catch((error) => ({ error })),
      // The whole point of the grace period: the rest of this flow waits on a human in a browser.
      // Blocking the JSON-RPC request for that is what showed up as a tool call that never returns
      // — the client spins with no output, and if the browser never opened there is nothing on
      // screen to act on. Answer with the URL instead, and let the link complete in the background.
      new Promise((resolve) => { setTimeout(() => resolve({ pending: true }), GRACE_MS).unref?.(); }),
    ]);

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
        .catch((error) => logError(`background sign-in failed: ${error?.message ?? error}`))
        .finally(() => { loginInFlight = false; });
      return;
    }

    loginInFlight = false;
    if (settled.error) {
      const detail = settled.error?.message ?? String(settled.error);
      const fallback = authorizeUrl ? ` Open this URL to finish signing in: ${authorizeUrl}` : '';
      toolText(id, `Beezi sign-in failed: ${detail}.${fallback}`, true);
      return;
    }
    const { result } = settled;
    const account = result.account ? ` as ${result.account}` : '';
    const where = result.apiBase ? ` (API: ${result.apiBase})` : '';
    const text = result.type === 'already-linked'
      ? `This machine is already linked to Beezi${account}${where}.`
      : `Signed in to Beezi${account}. This machine is now linked; the Beezi tools are available.`;
    toolText(id, text);
    writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  async function runStatusTool(id) {
    try {
      const status = await linkStatus();
      const reporting = describeReporting(status);
      toolText(id, [describeLink(status), reporting].filter(Boolean).join('\n'));
    } catch (error) {
      toolText(id, `Beezi status check failed: ${error?.message ?? String(error)}`, true);
    }
  }

  // Unlinked: keep the server alive and useful. `initialize` succeeds locally, the tool list holds
  // exactly one entry — signing in — so the model has an obvious way out, notifications are
  // dropped, and any other tool call is refused with the same pointer.
  async function handleUnlinked(msg, ids) {
    if (isInitialize(msg)) {
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
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
    ids.forEach((id) =>
      errorResponse(id, `This machine is not linked to Beezi. Call the ${LOGIN_TOOL.name} tool first, then retry.`),
    );
  }

  async function serverErrorMessage(res) {
    try {
      const message = (await res.json())?.error?.message;
      if (message) return `Beezi MCP error: ${message}`;
    } catch {
      /* non-JSON body */
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
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

    const token = await getToken();
    if (!token) {
      await handleUnlinked(msg, ids);
      return;
    }
    // Linked machines still ask for these ("re-link me", "why is nothing tracked?"); answer
    // locally rather than forwarding tools the portal does not have.
    const local = localToolCall(msg);
    if (local) {
      await runLocalTool(local, msg.id);
      return;
    }

    try {
      if (!upstreamReady && initializeMsg && !isInitialize(msg)) {
        await reinitialize(token);
      }
      let res = await post(msg, token);
      if (res.status === 404 && initializeMsg && !isInitialize(msg)) {
        await reinitialize(token);
        res = await post(msg, token);
      }
      if (res.ok) {
        if (isInitialize(msg)) upstreamReady = true;
        await emit(res, isToolsList(msg) ? { transform: withLocalTools } : {});
        return;
      }
      if (res.status === 401 || res.status === 403) {
        ids.forEach((id) => errorResponse(id, REJECTED_MESSAGE));
        return;
      }
      const message = await serverErrorMessage(res);
      ids.forEach((id) => errorResponse(id, message));
    } catch (error) {
      ids.forEach((id) =>
        errorResponse(id, `Beezi MCP request failed: ${error?.message ?? String(error)}`),
      );
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

  return { handleLine, handleMessage };
}
