import { ENV_API_BASE, environment } from "./paths.mjs";

// The release default — PRODUCTION as of the cutover release (G-1-2, P1).
//
// It was staging for every build before this one, which was drift rather than intent: the public
// plugin mirrored to the public GitHub repo pointed customers at a staging API. R1 sequenced the
// correction, and all three of its steps are now in place — the environment readers and namespace
// isolation (G-2-2), the staging variant and internal publisher that give displaced installs a
// destination (G-1-7), and the migration guard that moves them there before anything is uploaded
// (lib/env-migration.mjs, wired at every entry point through lib/env-guard.mjs). R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// The guard is not optional scaffolding around this line: an install that was capturing against
// staging holds cursors pointing into rollouts whose earlier lines are already delivered, and a
// queue of segments addressed to a staging tenant. Without the guard this constant alone would
// post both to production. If the guard is ever removed, this default must go back with it.
const RELEASE_DEFAULT = 'https://beezi-api-prod.azurewebsites.net/api';

// Explicit override → the variant's baked apiBase → the release default (G-1-2).
//
// The environment assertion comes first, and that is the whole point of it: the API and the
// namespace are resolved out of one record in lib/paths.mjs, so a variant whose metadata we could
// not read refuses to name an API rather than quietly answering with the release default. The
// explicit BEEZI_API_URL override stays live (`linkStatus` in link-status.mjs documents processes
// that disagree about it), and it deliberately cannot move the namespace — a stored environment
// binding is enforced where the credentials are, in lib/credentials.mjs.
export function apiBase() {
  environment.assertEnvironment();
  return process.env.BEEZI_API_URL || ENV_API_BASE || RELEASE_DEFAULT;
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
  sessionsBackfill: "/sessions/backfill",
  sessionsBackfillComplete: "/sessions/backfill/complete",
  // Repeatable history repair (lib/session-coverage.mjs, G-3-3/G-9-3), as distinct from the
  // one-time backfill above: /sessions/sync is tracking-policy-aware and never seals, and
  // /sessions/coverage answers what the server actually holds. Both are agent-scoped by the
  // X-Beezi-Agent header rather than by the path.
  sessionsSync: "/sessions/sync",
  sessionsCoverage: "/sessions/coverage",
  reposStatus: "/repos/status",
  whoami: "/me/codex/whoami",
  machine: "/me/codex/machine",
  usageSnapshot: "/me/codex/usage",
  // Crash telemetry (lib/diagnostics.mjs). NOT codex-scoped: the route is the shared cli-agent one
  // the Claude plugin already posts to, and the client is told apart by the X-Beezi-Agent header
  // that lib/http.mjs puts on every request. Until this entry existed flushDiagnostics refused to
  // guess a URL and no-opped with skipped: 'no-endpoint'.
  pluginDiagnostics: "/cli-agent/plugin-diagnostics",
  // Vendor-generic on purpose: the server reads the vendor off the X-Beezi-Agent header
  // machineHeaders() already sends (AGENT = 'codex'), so both plugins share one account row
  // shape. The /me/codex/* routes above are the codex-SCOPED ones; this is not one of them.
  accountSync: "/me/cli-agent/account",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
