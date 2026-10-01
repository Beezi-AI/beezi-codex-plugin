import { fetchCompat } from './fetch-compat.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
//
// A failure here is invisible by design — the caller drops the result — so it is also recorded as a
// diagnostic. What travels is the HTTP status and the error's class/errno, never the payload: the
// payload carries `lastAssistantMessage`, which is model output, and none of it may reach a
// diagnostic. See lib/diagnostics.mjs — consent-gated, default off.
export async function postSessionError(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const recordIssueImpl = deps.recordIssue || recordIssue;
  if (!payload || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  // `session` is { token, clientId }, never a bare token: the client id names the machine row this
  // report belongs to, and with several accounts linked one account's id on another's bearer is a
  // silent misattribution. postJson would throw; answering 'no-token' for an absent one keeps the
  // fire-and-forget contract.
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  try {
    const url = `${apiBase()}${ENDPOINTS.sessionErrors}`;
    let res = await postJson(url, session, payload, { fetchImpl });
    // Portals deploy independently of the plugin, and one that predates `resetsAt` rejects the
    // unknown key (forbidNonWhitelisted) with a 400. Without this retry the event would park in
    // pendingErrors and be re-sent, and rejected, on every checkpoint.
    if (res.status === 400 && payload.resetsAt) {
      const { resetsAt, ...withoutResetsAt } = payload;
      res = await postJson(url, session, withoutResetsAt, { fetchImpl });
    }
    const reported = res.status >= 200 && res.status < 300;
    if (!reported) {
      recordIssueImpl({
        code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR,
        source: DIAGNOSTIC_SOURCES.REPORT,
        httpStatus: res.status,
      });
    }
    return { reported, status: res.status };
  } catch (error) {
    recordIssueImpl({
      code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR,
      source: DIAGNOSTIC_SOURCES.REPORT,
      error,
    });
    return { reported: false, reason: 'network' };
  }
}
