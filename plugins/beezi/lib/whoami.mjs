import { apiBase, ENDPOINTS } from './config.mjs';
import { getJson } from './http.mjs';

// Resolve the stored access token's validity/identity against the portal.
// Returns { valid: true, email, name, tenantTier, trackingMode, backfillCompleted }
// | { valid: false } | null (offline/unknown). The tracking/backfill fields drive the
// session-history import: trackingMode gates live reporting, backfillCompleted is the
// server's authority on whether this account+tool's one-time pull is already sealed.
//
// Bounded, via getJson. Every caller treats "no answer" as a soft outcome — performLogin only
// wants a display name for a link it has already stored, and linkStatus reports UNREACHABLE — so
// an unbounded request here converts a recoverable server stall into a permanent hang of whatever
// called it: the login tool, the status tool, or a lifecycle hook.
export async function whoami(token, deps = {}) {
  const base = deps.base ?? apiBase();
  try {
    const res = await getJson(`${base}${ENDPOINTS.whoami}`, token, deps);
    if (res.status === 401 || res.status === 403) return { valid: false };
    if (!res.ok) return null;
    let body = {};
    try { body = await res.json(); } catch { /* keep {} */ }
    return {
      valid: true,
      email: body.email ?? null,
      name: body.name ?? null,
      tenantTier: body.tenantTier ?? null,
      trackingMode: body.trackingMode ?? null,
      backfillCompleted: body.backfillCompleted === true,
    };
  } catch {
    return null;
  }
}
