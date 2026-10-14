import { apiBase, ENDPOINTS } from './config.mjs';
import { getJson, sessionOf } from './http.mjs';
import { orDefault } from './compat.mjs';

// Server-supplied names reach model-read lines, so control characters and line breaks collapse to one space.
function oneLine(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return text === '' ? null : text;
}

// Absent list → null (unknown, old server), never []; entries without a string id are dropped.
function parseTenants(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t) => t != null && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      name: oneLine(t.name),
      role: oneLine(t.role),
      type: oneLine(t.type),
      joinedAt: typeof t.joinedAt === 'string' && Number.isFinite(Date.parse(t.joinedAt)) ? t.joinedAt : null,
    }));
}

// Resolve one session's validity/identity against the portal.
// Returns { valid: true, email, name, tenantId, tenantName, tenantTier, trackingMode,
// backfillCompleted, tenants } | { valid: false } | null (offline/unknown). The tracking/backfill fields
// drive the session-history import: trackingMode gates live reporting, backfillCompleted is the
// server's authority on whether this account+tool's one-time pull is already sealed.
//
// `session` is { token, clientId }, not a bare token — getJson demands it, because the client id
// has to travel with the bearer once a machine can have several accounts linked.
//
// Bounded, via getJson. Every caller treats "no answer" as a soft outcome — performLogin only
// wants a display name for a link it has already stored, and linkStatus reports UNREACHABLE — so
// an unbounded request here converts a recoverable server stall into a permanent hang of whatever
// called it: the login tool, the status tool, or a lifecycle hook.
export async function whoami(session, deps = {}) {
  // Validated HERE, before the try. getJson would raise the same TypeError one line later, but the
  // catch below maps every throw to null — which every caller reads as "offline" — so a call site
  // still passing a bare token would look like a network blip forever instead of announcing itself.
  // A programming error must escape; only a transport failure becomes null.
  sessionOf(session);
  const base = deps.base || apiBase();
  try {
    const res = await getJson(`${base}${ENDPOINTS.whoami}`, session, deps);
    if (res.status === 401 || res.status === 403) return { valid: false };
    if (!res.ok) return null;
    let body = {};
    try { body = await res.json(); } catch { /* keep {} */ }
    return {
      valid: true,
      email: orDefault(body.email, null),
      name: orDefault(body.name, null),
      // The web-side workspace, display data only: it never scopes a request (X-Beezi-Tenant comes
      // from a per-workspace session clone). Null against a portal older than ADO PR #3893.
      tenantId: orDefault(body.tenantId, null),
      tenantName: orDefault(body.tenantName, null),
      tenantTier: orDefault(body.tenantTier, null),
      trackingMode: orDefault(body.trackingMode, null),
      backfillCompleted: body.backfillCompleted === true,
      // Every workspace this user belongs to; null (not []) when the portal predates the list.
      tenants: parseTenants(body.tenants),
    };
  } catch {
    return null;
  }
}
