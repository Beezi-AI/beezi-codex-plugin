import { apiBase, ENDPOINTS } from './config.mjs';
import { getJson } from './http.mjs';

// Resolve the stored access token's validity/identity against the portal.
// Returns { valid: true, email, name } | { valid: false } | null (offline/unknown).
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
    };
  } catch {
    return null;
  }
}
