import path from 'path';
import { linkedSessions as _linkedSessions, listAccounts as _listAccounts } from './accounts.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { currentBranch as _currentBranch, taskFromBranch } from './git.mjs';
import {
  isUsableSessionId,
  resolveTranscriptByCwd as _resolveTranscriptByCwd,
} from './transcript-codex.mjs';
import { orDefault } from './compat.mjs';

// What /beezi:track will report on, or a refusal — `{ ok: true, sessionId, transcriptPath }` or
// `{ ok: false, message }`.
//
// This is where the strict id validation lives, and it is deliberately NOT in the resolver.
// resolveTranscriptByCwd answers `{ sessionId: null, transcriptPath }` for a rollout it can locate
// but not name, and one of its two callers NEEDS that: liveSession() (lib/session-audit.mjs)
// resolves the current session only to exclude it from the backfill, and matches on the transcript
// PATH. Rejecting at the resolver would make it blind, the backfill would stop excluding the live
// session, and it would re-segment a transcript the live hooks are already reporting on different
// boundaries — double-billing the spend. test/session-audit.test.mjs case 7 pins that tolerance.
//
// This caller is the asymmetric one. Every durable key it produces is derived from the id: the
// state file `state/<id>.json`, the `<id>:<from>-<to>` segmentId, the queue filename derived from
// that segmentId, and the sessionId on the wire. A null id here writes `state/null.json` — one
// file shared by every id-less session in this directory, whose cursor and coveredIntervals they
// clobber for each other — and, before the resolver learned to skip it, made every later track
// from this cwd report as a session literally called "null".
export function resolveTrackTarget(cwd, deps = {}) {
  const resolveTranscript = orDefault(deps.resolveTranscriptByCwdImpl, _resolveTranscriptByCwd);
  const transcript = resolveTranscript(cwd);
  if (!transcript || !transcript.transcriptPath) {
    return { ok: false, message: 'Beezi: could not find this session’s transcript to track.' };
  }
  if (!isUsableSessionId(transcript.sessionId)) {
    return {
      ok: false,
      message: 'Beezi: could not identify this session — its transcript records no session id, '
        + 'so there is no id to save the analytics under. Nothing was written.',
    };
  }
  return { ok: true, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
}

// The manual track flow for one session: checkpoint, flush, word the outcome.
// Returns { ok, message, lines } (unprefixed); expected failures never throw.
//
// `lines` is the SAME text as `message`, split per account and each carrying its own verdict. The
// two are not redundant: with several accounts linked, "analytics saved" and "the server rejected
// this report" can both be true of one run, so a caller that printed one marker over the whole
// block would label the account that succeeded a failure. `message` stays for every caller that
// only needs the text.
//
// No budgetMs is passed to the checkpoint: hooks bound their network work because Codex kills an
// overrunning hook, but a user waiting at a terminal would rather see the whole queue drained.
// `drainRateLimits` is set for the same reason: this is the one path with no budget to protect, so
// it is the last place the queued rate-limit rows should be left sitting on disk. The timeline POST
// stays off — it is derived from the whole transcript and re-sent at every real turn end anyway.
export async function trackSession({ sessionId, transcriptPath, cwd }, deps = {}) {
  // Second gate, on the value actually handed to runCheckpoint. resolveTrackTarget above is the
  // one the script calls, but this is the function that turns an id into `state/<id>.json` and a
  // segmentId, so it refuses rather than trust every future caller to have checked.
  if (!isUsableSessionId(sessionId)) {
    return refusal('Beezi: could not identify this session, so there is nothing to save it under.');
  }
  const listSessions = orDefault(deps.linkedSessions, _linkedSessions);
  const listAccounts = orDefault(deps.listAccounts, _listAccounts);
  const runCheckpoint = orDefault(deps.runCheckpoint, _runCheckpoint);
  const currentBranch = orDefault(deps.currentBranch, _currentBranch);

  // Label only. The checkpoint attributes every segment from the rollout, so a cwd outside
  // any repo — or a repo with no origin — is not a reason to refuse; those report under a
  // `local:<folder>` remote like the automatic hooks do.
  let branch = null;
  try { branch = currentBranch(cwd); } catch { /* not a repo */ }
  let label = taskFromBranch(branch);
  if (label === undefined || label === null) label = branch;
  if (label === undefined || label === null) label = path.basename(orDefault(cwd, '')) || cwd;

  let sessions;
  try { sessions = orDefault(await listSessions(deps), []); } catch { sessions = []; }
  // "Not linked" is only true when nothing IS linked. linkedSessions() also comes back empty when
  // every linked account's token is momentarily unusable at once — a locked keyring, expired
  // refreshes, revoked grants — and telling a user with two accounts in the index that their
  // machine is not linked is the same falsehood scripts/sync.mjs, scripts/backfill.mjs and the MCP
  // bridge stopped printing. The index is the only thing that tells the two apart.
  if (sessions.length === 0) {
    let rows;
    try {
      rows = orDefault(await listAccounts(deps), []);
    } catch (error) {
      // A THIRD state, and collapsing it into the empty-index branch would put the falsehood
      // straight back: readIndex throws for a migration in progress, an unreadable accounts.json
      // and a refused lock, and none of those means nothing is linked. Same treatment
      // lib/mcp-bridge.mjs gives its own blocked read — the error keeps its own words.
      const detail = error && error.message ? error.message : String(error);
      return refusal(`Beezi: could not read this machine's linked accounts: ${detail}`);
    }
    return refusal(rows.length === 0
      ? 'Beezi: this machine is not linked. Sign in to Beezi first.'
      : 'Beezi: could not use the saved credentials for any linked Beezi account. Sign in to Beezi again.');
  }

  // ONE checkpoint, not one per account. The delta is a read of this session's transcript against
  // a cursor that the first run would advance, so a second pass would find nothing left to bill
  // and the later accounts would silently receive an empty report. runCheckpoint fans the one
  // delta out into every allowed account's queue itself and hands back a drain result each.
  const { enqueued, flushes, outcome, reason } = await runCheckpoint(
    {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
    },
    {},
    { drainRateLimits: true },
  );

  if (outcome !== 'committed') {
    return refusal(`Beezi: checkpoint ${outcome || 'deferred'} (${reason || 'not committed'}); retry tracking.`);
  }

  // One outcome per account. With a single account linked the lines are byte-identical to what a
  // single-account install has always printed; with several, each is named, because "saved" and
  // "the server rejected this report" can both be true of the same run.
  const drains = orDefault(flushes, []);
  const many = drains.length > 1;
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const lines = [];
  let ok = true;
  for (const drain of drains) {
    const who = byKey.get(drain.key);
    const name = who ? orDefault(orDefault(who.tenantName, who.email), who.key) : drain.key;
    const saved = orDefault(drain.flushed, 0);
    let lineOk = true;
    let text;
    if (drain.failed) {
      lineOk = false;
      text = 'Beezi: could not reach the server — analytics will be retried automatically.';
    } else if (drain.rejected) {
      lineOk = false;
      text = `Beezi: ${orDefault(drain.lastError, 'the server rejected this report')}.`;
    } else if (enqueued === 0 && saved === 0) {
      text = `Beezi: nothing new to save for ${label} — already up to date.`;
    } else {
      text = `Beezi: analytics saved for ${label} (${saved} segment${saved === 1 ? '' : 's'}).`;
    }
    if (!lineOk) ok = false;
    lines.push({ ok: lineOk, text: many ? `${name} — ${text}` : text });
  }
  if (lines.length === 0) {
    const nothing = `Beezi: nothing new to save for ${label} — already up to date.`;
    return { ok: true, message: nothing, lines: [{ ok: true, text: nothing }] };
  }
  return { ok, message: lines.map((line) => line.text).join('\n'), lines };
}

// An outcome that belongs to no account: the session could not be identified, nothing is linked, or
// the checkpoint never committed. One line, and it is not a success.
function refusal(message) {
  return { ok: false, message, lines: [{ ok: false, text: message }] };
}
