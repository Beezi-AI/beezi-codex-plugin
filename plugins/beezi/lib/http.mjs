// Bounded POST of a JSON body with bearer auth. Returns the fetch Response so callers
// own the status/body handling; throws on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-identity.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';
import { orDefault } from './compat.mjs';

// Exported so a caller working against a deadline can shrink it to what the budget has left,
// rather than discovering the overrun after the fact.
export const POST_TIMEOUT_MS = 3000;
const DEFAULT_TIMEOUT_MS = POST_TIMEOUT_MS;

// Interactive reads (whoami, repo status) are not on the hook's 3s budget, but they must still be
// bounded: Node's fetch has no default timeout, so a server that accepts the connection and then
// goes quiet — an API paused in a debugger, one mid-restart, a proxy holding the socket — leaves
// the promise pending for the life of the process. That is what stranded a *completed* login: the
// credentials were already stored and the browser round-trip was done, but the display-name lookup
// that runs afterwards never settled, so the MCP tool call never returned a result.
const DEFAULT_READ_TIMEOUT_MS = 10_000;

async function bounded(fetchImpl, url, init, timeoutMs) {
  const controller = makeAbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// A bare token used to be enough. It no longer is: the client id travels with the token, and a
// caller that still passes a string would post with no X-Beezi-Client at all — a silent
// misattribution, not an error. Throwing is how the sweep finds the sites no type checker will.
export function sessionOf(session) {
  if (typeof session !== 'object' || session === null || typeof session.token !== 'string') {
    throw new TypeError('http: expected a session object { token, clientId }, not a bare token');
  }
  return session;
}

export async function postJson(url, session, body, deps = {}) {
  const { token, clientId } = sessionOf(session);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const timeoutMs = orDefault(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
  return bounded(fetchImpl, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...machineHeaders(clientId),
    },
    body: JSON.stringify(body),
  }, timeoutMs);
}

// Bounded GET with bearer auth. Returns the fetch Response; throws on network error or timeout.
export async function getJson(url, session, deps = {}) {
  const { token, clientId } = sessionOf(session);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const timeoutMs = orDefault(deps.timeoutMs, DEFAULT_READ_TIMEOUT_MS);
  return bounded(fetchImpl, url, {
    headers: { 'Authorization': `Bearer ${token}`, ...machineHeaders(clientId) },
  }, timeoutMs);
}
