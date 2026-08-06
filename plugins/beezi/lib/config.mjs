export function apiBase() {
  return (
    process.env.BEEZI_API_URL ??
    "https://beezi-api-staging.azurewebsites.net/api"
  );
}

// Origin of the API host — the OAuth discovery documents are mounted at the
// root, outside the /api prefix.
export function apiOrigin() {
  return new URL(apiBase()).origin;
}

// Identifies this client to the Beezi API. Sent as the X-Beezi-Agent header on every
// request and used to select the codex-scoped identity endpoints below, so the server
// can distinguish Codex traffic from the Claude Code plugin.
export const AGENT = "codex";

export const OAUTH_SCOPES = "email profile";

// The Beezi REST surface, in one place. Paths are relative to apiBase(). The identity
// routes are codex-scoped (parallel to the Claude plugin's /me/claude-code/*) so a linked
// machine and its analytics are attributed to the Codex client.
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
  whoami: "/me/codex/whoami",
  machine: "/me/codex/machine",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
