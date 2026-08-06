// Bounded POST of a JSON body with bearer auth. Returns the fetch Response so callers
// own the status/body handling; throws on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-identity.mjs';

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function postJson(url, token, body, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return bounded(fetchImpl, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...machineHeaders(),
    },
    body: JSON.stringify(body),
  }, timeoutMs);
}

// Bounded GET with bearer auth. Returns the fetch Response; throws on network error or timeout.
export async function getJson(url, token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  return bounded(fetchImpl, url, {
    headers: { 'Authorization': `Bearer ${token}`, ...machineHeaders() },
  }, timeoutMs);
}
