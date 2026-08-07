import fs from 'node:fs';
import path from 'node:path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { flushQueue } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { whoami } from './whoami.mjs';
import { BillingSource } from './billing.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
} from './billing-config.mjs';
import { readCodexAccount as _readCodexAccount } from './codex-account.mjs';
import { captureFromCodexAccount } from './billing-capture.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
// Also records where the session lives (cwd + transcript path) so the track script can find
// the transcript after the session cd's away from its launch directory — the mapping is
// refreshed on every start (resume may happen from a different directory).
export function initSessionState(sessionId, { cwd = null, transcriptPath = null } = {}) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${sessionId}.json`);
  const state = readJson(p, { cursor: 0 });
  state.cwd = cwd;
  state.transcriptPath = transcriptPath;
  state.updatedAt = new Date().toISOString();
  writeJsonSecure(p, state);
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs ?? fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    const origin = resolveOriginRemote(gitImpl, root) ?? originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      recordRoot(resolveRepoRoot(gitImpl, child, cache, map) ?? child);
    }
  }
  return { map, dirty };
}

async function announceRepo(cwd, token, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    // postJson, not a bare fetch: this runs inside the SessionStart hook's 10s budget, and an
    // unbounded request against a stalled API would hold the whole turn open rather than
    // degrading to the silent "offline" path below.
    const res = await postJson(`${apiBase()}${ENDPOINTS.reposStatus}`, token, { remote }, { fetchImpl });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    // Both branches are informational only. Nothing downstream gates on `connected`: the
    // checkpoint reports every branch of every repo, and work with no origin at all under a
    // `local:<folder>` remote. Saying "no analytics tracked here" would be false.
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Sessions here are tracked.`
      : 'Beezi: this repo is not connected to a Beezi project. Sessions are still tracked, against the repo itself.';
  } catch { return null; } // offline — silent
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user signing in again.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
async function isTokenRejected(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  return who?.valid === false;
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const gitImpl = deps.gitImpl ?? _git;
  const resolveSource = deps.resolveSource ?? _resolveSource;
  const readBillingConfig = deps.readBillingConfig ?? _readBillingConfig;
  const writeBillingConfig = deps.writeBillingConfig ?? _writeBillingConfig;
  const isStale = deps.isStale ?? _isStale;
  const readCodexAccount = deps.readCodexAccount ?? _readCodexAccount;

  let token = null;
  try { token = await getAccessToken(); } catch { token = null; }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Ask Beezi to sign you in.';

  if (await isTokenRejected(token, fetchImpl)) {
    // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
    // omits expires_in leaves it a guess. Take the server's word and refresh once before
    // declaring the link bad — otherwise a token that died earlier than we estimated is never
    // renewed, and every session reports a rejection that a single refresh would have fixed.
    const refreshed = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    if (!refreshed || await isTokenRejected(refreshed, fetchImpl)) {
      return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
    }
    token = refreshed;
  }

  // Best-effort like every other write here: writeJsonSecure refuses to overwrite a file it could
  // not replace atomically, and losing this mapping costs one checkpoint's cwd hint — not the
  // flush, the repo probe or the billing capture below.
  try {
    initSessionState(input.session_id, { cwd: input.cwd ?? null, transcriptPath: input.transcript_path ?? null });
  } catch { /* best-effort */ }
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    announceRepo(input.cwd, token, fetchImpl, gitImpl),
  ]);
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // The user may have switched auth method since the last session (exporting a key over a ChatGPT
  // sign-in, or back). Realign billing.json to the resolved source before the staleness check
  // reads it — otherwise the stored source stays wrong until the next plan capture. Best-effort:
  // a disk failure must not break session start.
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  try {
    billingConfig = readBillingConfig();
    billingSource = resolveSource(billingConfig);
    const synced = syncBillingSource(billingConfig, billingSource);
    if (synced) {
      writeBillingConfig(synced);
      billingConfig = synced;
    }

    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // Three gates, in order:
    //   SUBSCRIPTION      — never touch billing.json on an api-key or third-party machine. The
    //                       source ladder already outranks auth.json with env and error evidence,
    //                       so this defers to it rather than going around it.
    //   !selfReported     — a plan the user answered by hand always wins; we do not even look.
    //   isStale           — the exact predicate the nudge below uses, so a capture that succeeds
    //                       silences it in this same run. Normally bounds the work to ~weekly.
    //
    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // Three gates, in order:
    //   SUBSCRIPTION      — never touch billing.json on an api-key or third-party machine. The
    //                       source ladder already outranks auth.json with env and error evidence,
    //                       so this defers to it rather than going around it.
    //   !selfReported     — a plan the user answered by hand always wins; we do not even look.
    //   isStale           — the exact predicate the nudge below uses, so a capture that succeeds
    //                       silences it in this same run. Normally bounds the work to ~weekly.
    //
    // The reading and the expired-claim rule live in lib/billing-capture.mjs, shared with
    // scripts/billing-capture.mjs so the two cannot disagree about what an expired claim means.
    //
    // Cost when it runs: one stat, one small read of ~/.codex/auth.json, a base64url decode of the
    // id_token payload, and at most one 0600 write. No network, no subprocess. No token is read.
    if (billingSource === BillingSource.SUBSCRIPTION
        && billingConfig?.selfReported !== true
        && isStale(billingConfig)) {
      const { config } = captureFromCodexAccount({
        via: 'session-start',
        existing: billingConfig,
        deps: { readCodexAccount },
      });
      if (config) {
        writeBillingConfig(config);
        billingConfig = config;
      }
    }
  } catch { /* best-effort */ }

  let message = systemMessage;
  let nudge = null;
  if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
    // Reached only when the auto-capture above could not name a plan it trusts — so pointing the
    // user at a "refresh" would send them to the command that just failed.
    const expiredAt = billingConfig?.credentialsExpiresAt;
    nudge = (typeof expiredAt === 'number' && expiredAt <= Date.now())
      // Name the date: this is fixable at the source, and "sign in again" is a different and much
      // cheaper action than answering a tier questionnaire.
      ? `Beezi: your Codex sign-in expired on ${new Date(expiredAt).toISOString().slice(0, 10)}, so your plan cannot be read — sign in to Codex again, or ask Beezi to record your plan.`
      : 'Beezi: could not read your ChatGPT plan — usage is reported without a plan. Ask Beezi to sign you in.';
  } else if (billingSource === BillingSource.UNKNOWN) {
    // Reported honestly rather than guessed — but the user can resolve it, so say so.
    nudge = 'Beezi: cannot determine how this machine bills Codex — usage is reported as "unknown". Ask Beezi to sign you in.';
  }
  if (nudge) message = message ? `${message}\n${nudge}` : nudge;
  return message;
}
