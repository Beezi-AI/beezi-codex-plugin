import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { beeziCodexHome } from './paths.mjs';
import { orDefault } from './compat.mjs';
import { safeFileName } from './fs-store.mjs';

// One lock contract for every Beezi Codex writer (G-8-3 / R3). R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT THE CLAUDE PORT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Claude's lib/single-instance-lock.mjs and this plugin's own inline mutex in lib/token.mjs share
// one shape: mkdir an empty directory, judge staleness from its mtime, and take over with
// remove-then-mkdir. Three properties of that shape are unusable for the checkpoint transaction:
//
//   1. An empty directory carries no owner, so a handle cannot prove it is still the owner and a
//      release cannot tell its own lock from a successor's. PID + hostname would not fix it
//      either: one process legitimately acquires the same lock twice over its life, and the
//      second acquisition must not be able to release or renew the first one's.
//   2. remove-then-create is two operations. Two contenders that both read the same stale mtime
//      both remove and both create; the second remover deletes the first's freshly created lock
//      and both callers believe they hold it. That is the exact race R3 names.
//   3. mtime alone never proves the holder is dead, and a lock that a live holder keeps renewing
//      must never be taken from it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PRIMITIVE THIS IS BUILT ON, AND WHAT WAS MEASURED ON WINDOWS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Everything below rests on exactly one atomic operation: exclusive create,
// `writeFileSync(p, text, { flag: 'wx' })`, which either creates the file or raises EEXIST.
//
// Measured on Windows 11 / NTFS with Node v24.11.1, 6 OS processes racing 400 rounds on one path:
// 400 winners over 400 rounds, no round with two winners and no round with none. Exclusive create
// is a sound mutual-exclusion primitive here.
//
// `renameSync` is NOT, and this is why no takeover in this file is expressed as a rename. Same
// machine, 4 processes racing 300 rounds to rename one source to per-process destinations:
// renameSync returned success to more than one process in 240 of 300 rounds, and 401 of those
// successes had no destination on disk when the same process stat()ed it immediately afterwards.
// The filesystem itself stayed consistent — a readdir found exactly 300 destination files for 300
// sources, none duplicated — so the anomaly is confined to the return value. The mechanism was not
// isolated further; what matters here is the conclusion: on Windows a process cannot infer "I won"
// from renameSync returning success, so rename-aside takeover is unsound on this platform.
//
// Also measured, because the liveness probe depends on it: `process.kill(pid, 0)` succeeds for the
// current pid and raises ESRCH for an absent one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PROTOCOL
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The lock is a single file holding a JSON record. Its `token` is the ACQUISITION TOKEN: unique
// per acquisition, not per process, so two acquisitions by one pid are distinguishable. The token
// is also the lock's GENERATION.
//
//   * Take a free lock       — exclusive create. Atomic; at most one winner.
//   * Remove or rewrite a    — only inside a BREAKER-guarded section (below), after re-reading the
//     lock                     file and confirming the generation is still the one we judged.
//
// A breaker is a second file, `<lock>.take-<hash(generation)>`, taken by exclusive create. Its
// path is derived from the generation being acted on, so every party that wants to mutate
// generation G — a contender taking it over, and equally G's own owner renewing or releasing it —
// competes for the same file, and exactly one of them is inside the section at a time.
//
// That single fact is what closes R3's races:
//   * Two contenders reading the same stale record contend for one breaker. One wins; the loser
//     never unlinks anything, so it cannot delete the winner's replacement.
//   * A takeover and the holder's own renew cannot interleave, so a contender that judged the
//     record expired re-judges it inside the section and backs off if the holder renewed first.
//   * A release re-reads under the breaker: an old holder releasing after it was taken over sees
//     a different generation and returns 'lost' WITHOUT unlinking, so a successor's lock survives.
//   * A renew re-reads under the breaker; a holder that lost the lock learns it from renew()
//     rather than by overwriting the successor.
//
// RESIDUAL, STATED PLAINLY. Exclusive create alone cannot make "re-read then unlink" one
// operation, so the breaker has to be recoverable or a process killed inside a guarded section
// would wedge that generation forever. Recovery needs BOTH that the breaker record is older than
// breakerStaleMs AND that its holder fails a liveness probe, so a live process's breaker is never
// recovered. The one interleaving that still produces two parties in a section for the same
// generation requires a party to be suspended for longer than breakerStaleMs inside a section of
// about four synchronous filesystem calls while its liveness probe also fails. It is not silent:
// the party whose lock is removed learns it from the next verify() or renew(), which returns
// 'lost', and the contract is that a caller aborts its transaction on 'lost' rather than
// committing. This module claims serialization, not a filesystem compare-and-swap.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// LOCK KINDS AND LOCK ORDER
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A global election lock only excludes other watchers; it does nothing about a Stop hook writing
// the same session's state underneath one. Two kinds are therefore needed, plus three narrower
// ones, and they are ranked coarse-to-fine. Acquiring a lock of equal or finer rank than one this
// process already holds is refused with reason 'lock-order' — that refusal is the deadlock
// prevention, not a comment asking callers to be careful.
//
//   election (0) → run (1) → session (2) → shared (3) → credential (4)
//
// Per-session locks are keyed on the ROOT session id. Subagent work runs under its root's lock, so
// no caller ever needs two session locks at once and same-rank nesting stays refused. The same
// applies within rank 3: take one shared-file lock, finish with it, release it, then take the
// next. Holding tracking.json's lock while reaching for the audit ledger's is refused, and it is
// refused for the reason that would otherwise let two writers deadlock on the pair.
//
// HOW TO READ A REFUSAL. 'held' and 'contended' are transient: the caller may defer and retry on
// its next tick, and withLock reports them as skipped work. 'lock-order' is neither — it is a
// programming error in the caller's own acquisition sequence, and retrying it will fail forever.
// Surface it; never treat it as a busy lock. 'mkdir-failed', 'write-failed' and 'unlink-failed'
// carry the errno and mean the filesystem refused, not that someone else holds the lock.
//
// Path note: the lock directory is composed here from beeziCodexHome() rather than added to
// lib/paths.mjs, so this module introduces no new export there. Same reasoning as the comment on
// lib/token.mjs's lock path — this plugin's own data root, never the Claude plugin's ~/.beezi.

// ── Defaults ────────────────────────────────────────────────────────────────────────────────
// A lease long enough that a normal checkpoint never has to renew, short enough that a crashed
// hook does not block the next one for long. Callers override per use.
export const DEFAULT_LEASE_MS = 30_000;
// A record may not claim a lease longer than this. A malformed or hostile record with a
// thousand-year expiry would otherwise wedge the lock permanently.
export const MAX_HOLDER_LEASE_MS = 30 * 60 * 1000;
// Expired but the holder's pid is still alive: wait this much longer before taking it. The probe
// cannot tell a genuinely busy holder from a reused pid, so it buys time rather than a veto —
// "alive" must not mean "never take over", or a reused pid wedges the lock for good.
export const LIVENESS_GRACE_MS = 60_000;
// Expired and the holder is on another host, where no probe is possible. Age is all there is, so
// it gets the same extra margin and the decision is reported as 'age-only'.
const FOREIGN_HOST_GRACE_MS = 60_000;
// A lock file that is empty or unparseable has no token to age, so it is aged by mtime — against
// its own small constant, never against the caller's lease. A backfill's ten-minute lease must not
// mean a truncated lock file blocks every hook for ten minutes.
export const CORRUPT_GRACE_MS = 15_000;
// A breaker-guarded section is about four synchronous filesystem calls. Anything holding one for
// this long is a corpse — but see breakerRecoverable(): age alone is not enough to recover it.
export const BREAKER_STALE_MS = 30_000;
// Bounded work per acquire: no sleeping, no unbounded retry. Each attempt is one re-read after a
// generation moved underneath us.
const DEFAULT_ATTEMPTS = 3;
// Opportunistic cleanup of breaker files nothing will ever look at again. locks/ is outside
// prune.mjs's state/ + queue/ sweep, so without this the directory only grows.
const BREAKER_SWEEP_MAX = 20;

export const LOCK_KINDS = Object.freeze({
  ELECTION: 'election',
  RUN: 'run',
  SESSION: 'session',
  SHARED: 'shared',
  CREDENTIAL: 'credential',
});

// Coarse to fine. Index is the rank; acquiring at an index <= the highest currently held is a
// lock-order violation.
// Credential commits can occur beneath a refresh lock, itself a shared-file lock.
export const LOCK_ORDER = Object.freeze(['election', 'run', 'session', 'shared', 'credential']);

export function lockRank(kind) {
  return LOCK_ORDER.indexOf(kind);
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────

export function locksDir() {
  return path.join(beeziCodexHome(), 'locks');
}

export function lockFilePath(name) {
  return path.join(locksDir(), `${safeFileName(name, { max: 160, fallback: 'lock' })}.lock`);
}

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function breakerPathFor(file, generation) {
  return `${file}.take-${shortHash(generation)}`;
}

// ── Descriptors ─────────────────────────────────────────────────────────────────────────────
// Every lock is named through one of these, so a reader of a call site can see which kind — and
// therefore which rank — is being taken without looking the string up.

function descriptor(kind, name) {
  return { kind, name, file: lockFilePath(name) };
}

// Excludes other watchers from electing themselves. This is the ONLY thing it excludes.
export function electionLock(scope) {
  return descriptor(LOCK_KINDS.ELECTION, `election-${orDefault(scope, 'watcher')}`);
}

// A one-time or long-running run that must not overlap itself: the backfill's scan and its seal.
export function runLock(name) {
  return descriptor(LOCK_KINDS.RUN, `run-${orDefault(name, 'default')}`);
}

// The checkpoint transaction for ONE ROOT session: read cursor, compute delta, enqueue, write
// state. Taken by every writer of that session — watcher, Stop, PostToolUse, pulse, manual track,
// backfill and sync — or it protects nothing.
export function sessionLock(sessionId) {
  return descriptor(LOCK_KINDS.SESSION, `session-${orDefault(sessionId, 'unknown')}`);
}

// Cross-process read-modify-write of a shared file: queue drain, tracking.json, the audit ledger.
export function sharedLock(name) {
  return descriptor(LOCK_KINDS.SHARED, `shared-${orDefault(name, 'default')}`);
}

function toDescriptor(target) {
  if (!target || typeof target !== 'object') throw new TypeError('lock target must be a descriptor');
  const kind = orDefault(target.kind, LOCK_KINDS.SHARED);
  const name = target.name;
  if (typeof name !== 'string' || !name) throw new TypeError('lock descriptor needs a name');
  return { kind, name, file: orDefault(target.file, lockFilePath(name)) };
}

// ── Injected operations ─────────────────────────────────────────────────────────────────────
// Every filesystem call, the clock, the host, the pid, the liveness probe and the token source go
// through here. Removal included: a test that mocks acquire must not reach a real remover, which
// is why compat's removeFileSync (it closes over compat's own module-level fs) is deliberately not
// used anywhere in this file.

let tokenCounter = 0;

function defaultRandomToken(hostname, pid, nowMs) {
  tokenCounter += 1;
  // Unique per ACQUISITION. host+pid identify the process, the counter separates two acquisitions
  // within it, and the random tail separates two processes that share a pid across a reboot. The
  // Node 14.17+ built-in UUID helper is below this plugin's 13.2 floor, so randomBytes it is —
  // the same call lib/oauth.mjs and lib/login.mjs already make.
  return [
    String(hostname).slice(0, 32),
    pid,
    nowMs,
    tokenCounter,
    crypto.randomBytes(9).toString('hex'),
  ].join('.');
}

// true = running, false = definitely gone, null = cannot tell (bad pid, or an errno we do not
// recognise). Signal 0 sends nothing; it only asks the kernel whether the pid is addressable.
function defaultIsProcessAlive(pid) {
  if (typeof pid !== 'number' || !isFinite(pid) || Math.floor(pid) !== pid || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error && error.code) || '';
    if (code === 'EPERM') return true; // exists, owned by someone else
    if (code === 'ESRCH') return false;
    return null;
  }
}

function resolveDeps(deps) {
  const d = orDefault(deps, {});
  const fsImpl = orDefault(d.fs, fs);
  const now = orDefault(d.now, Date.now);
  const hostname = orDefault(d.hostname, () => String(os.hostname()));
  const pid = orDefault(d.pid, () => process.pid);
  return {
    fs: fsImpl,
    now,
    hostname,
    pid,
    isProcessAlive: orDefault(d.isProcessAlive, defaultIsProcessAlive),
    randomToken: orDefault(d.randomToken, defaultRandomToken),
  };
}

// ── Thin filesystem wrappers ────────────────────────────────────────────────────────────────
// Each returns a verdict rather than throwing, so the protocol reads as a sequence of decisions.

function errCode(error) {
  return (error && error.code) || 'UNKNOWN';
}

function tryExclusiveCreate(fsImpl, file, text) {
  try {
    fsImpl.writeFileSync(file, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errCode(error) };
  }
}

function tryOverwrite(fsImpl, file, text) {
  try {
    fsImpl.writeFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errCode(error) };
  }
}

function tryRead(fsImpl, file) {
  try {
    return { ok: true, text: String(fsImpl.readFileSync(file, 'utf-8')) };
  } catch (error) {
    return { ok: false, code: errCode(error) };
  }
}

function tryUnlink(fsImpl, file) {
  try {
    fsImpl.unlinkSync(file);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errCode(error) };
  }
}

function tryMtime(fsImpl, file) {
  try {
    const st = fsImpl.statSync(file);
    return st && typeof st.mtimeMs === 'number' ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function ensureLocksDir(fsImpl, file) {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errCode(error) };
  }
}

// ── Observation and judgement ───────────────────────────────────────────────────────────────

// What is at the lock path right now, reduced to a generation plus whatever the record says.
// An unparseable or tokenless file still gets a generation — derived from its bytes — so that a
// torn or truncated lock is serialized on the breaker exactly like a well-formed one.
function observe(fsImpl, file) {
  const read = tryRead(fsImpl, file);
  if (!read.ok) return { present: false, code: read.code };
  const raw = read.text;
  let parsed = null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') parsed = value;
  } catch {
    /* corrupt — handled below */
  }
  if (!parsed || typeof parsed.token !== 'string' || parsed.token === '') {
    return {
      present: true,
      corrupt: true,
      raw,
      record: null,
      generation: `raw:${shortHash(raw)}`,
      mtimeMs: tryMtime(fsImpl, file),
    };
  }
  return { present: true, corrupt: false, raw, record: parsed, generation: parsed.token };
}

// The HOLDER'S OWN lease decides when its lock expires, never the contender's stale policy. A
// Stop hook that wants a 5s lease for itself must still respect the ten-minute lease the backfill
// wrote, or it would take the run lock away mid-seal. `maxHolderLeaseMs` is a ceiling against a
// malformed record, not a way to overrule a healthy one.
function holderExpiry(record, policy) {
  const cap = policy.maxHolderLeaseMs;
  const renewedAt = typeof record.renewedAt === 'number' && isFinite(record.renewedAt)
    ? record.renewedAt
    : (typeof record.acquiredAt === 'number' && isFinite(record.acquiredAt) ? record.acquiredAt : null);
  const claimed = typeof record.expiresAt === 'number' && isFinite(record.expiresAt)
    ? record.expiresAt
    : null;
  if (renewedAt === null) {
    // No timestamp to age the lease from. This module never writes a record like that, so it is
    // malformed — judge() routes it through the malformed path, which ages it by the file's own
    // mtime and caps whatever expiry it claims. Returning null here is what selects that path.
    return null;
  }
  const leaseMs = typeof record.leaseMs === 'number' && isFinite(record.leaseMs) && record.leaseMs > 0
    ? Math.min(record.leaseMs, cap)
    : cap;
  const fromLease = renewedAt + leaseMs;
  if (claimed === null) return fromLease;
  // Both are the holder's own numbers and this module always writes them in agreement. When they
  // disagree the record is malformed, and the shorter one wins: an inconsistent record must fail
  // towards being recoverable, never towards wedging the lock.
  return Math.min(claimed, fromLease);
}

// Should a contender be allowed to take this lock? Returns the verdict and — importantly — the
// reason, so a caller can log that a takeover was decided on age alone.
function judge(obs, policy, ctx) {
  const nowMs = ctx.deps.now();
  const expiresAt = obs.corrupt ? null : holderExpiry(obs.record, policy);

  // Malformed: no parseable record at all, or a record with no timestamp to age its lease from.
  // Both are shapes this module never writes, and both would be permanently un-takeable if the
  // record were simply trusted — so they are aged by the file's own mtime instead. A malformed
  // record must fail towards recoverable; a wedged lock has no way out.
  if (obs.corrupt || expiresAt === null) {
    const mtimeMs = obs.corrupt ? obs.mtimeMs : tryMtime(ctx.deps.fs, ctx.file);
    if (mtimeMs === null) return { takeover: true, decision: 'malformed-no-mtime', expiresAt: null };
    // A malformed record may still CLAIM an expiry. Honour it, but only up to the ceiling, and
    // never sooner than the small grace that protects a lock file created microseconds ago.
    const claimed = !obs.corrupt && obs.record && typeof obs.record.expiresAt === 'number'
      && isFinite(obs.record.expiresAt)
      ? Math.min(obs.record.expiresAt, mtimeMs + policy.maxHolderLeaseMs)
      : null;
    const until = Math.max(mtimeMs + policy.corruptGraceMs, claimed === null ? 0 : claimed);
    return {
      takeover: nowMs > until,
      decision: obs.corrupt ? 'corrupt-grace' : 'malformed-grace',
      expiresAt: until,
    };
  }
  if (nowMs <= expiresAt) return { takeover: false, decision: 'lease', expiresAt };

  const sameHost = String(obs.record.host) === String(ctx.host);
  if (!sameHost) {
    // No probe is possible across hosts. Age is the only evidence, so it gets a wider margin and
    // the decision says so.
    const ready = nowMs > expiresAt + policy.foreignHostGraceMs;
    return { takeover: ready, decision: 'age-only', expiresAt, alive: null };
  }
  const alive = ctx.deps.isProcessAlive(obs.record.pid);
  if (alive === false) {
    // Expired AND the process is gone. This is the only branch where age alone is not what
    // decided it, and it is the fast path for a hard-killed owner.
    return { takeover: true, decision: 'holder-dead', expiresAt, alive: false };
  }
  // Alive, or unknowable. Expiry stands, but only after an extra grace — a live holder that is
  // simply slow gets time to renew, and a reused pid cannot wedge the lock forever.
  const ready = nowMs > expiresAt + policy.livenessGraceMs;
  return {
    takeover: ready,
    decision: alive === true ? 'holder-alive-grace' : 'liveness-unknown-grace',
    expiresAt,
    alive,
  };
}

function summarizeHolder(obs) {
  if (!obs.present) return null;
  if (obs.corrupt) return { corrupt: true, token: null, host: null, pid: null, mtimeMs: obs.mtimeMs };
  const r = obs.record;
  return {
    corrupt: false,
    token: r.token,
    kind: orDefault(r.kind, null),
    host: orDefault(r.host, null),
    pid: orDefault(r.pid, null),
    acquiredAt: orDefault(r.acquiredAt, null),
    renewedAt: orDefault(r.renewedAt, null),
    expiresAt: orDefault(r.expiresAt, null),
    leaseMs: orDefault(r.leaseMs, null),
  };
}

// ── The breaker ─────────────────────────────────────────────────────────────────────────────

function readBreaker(fsImpl, file) {
  const read = tryRead(fsImpl, file);
  if (!read.ok) return null;
  try {
    const value = JSON.parse(read.text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// A breaker is recoverable only when it is BOTH old and its holder fails a liveness probe. Age
// alone would let a merely slow process have its section stolen; the liveness probe is what makes
// the residual described in the header require a suspension AND a failed probe together.
function breakerRecoverable(fsImpl, file, policy, ctx) {
  const nowMs = ctx.deps.now();
  const record = readBreaker(fsImpl, file);
  if (!record) {
    // Unreadable, empty or unparseable: there is no pid to probe, so age it by mtime alone. An
    // absent mtime means the file went away underneath us, which is itself a free path.
    const mtimeMs = tryMtime(fsImpl, file);
    return mtimeMs === null || nowMs - mtimeMs > policy.breakerStaleMs;
  }
  const startedAt = typeof record.startedAt === 'number' && isFinite(record.startedAt)
    ? record.startedAt
    : null;
  if (startedAt === null) {
    const mtimeMs = tryMtime(fsImpl, file);
    return mtimeMs === null || nowMs - mtimeMs > policy.breakerStaleMs;
  }
  if (nowMs - startedAt <= policy.breakerStaleMs) return false;
  // Old. Now the probe decides, and only a probe that says "not running" releases it.
  if (String(record.host) !== String(ctx.host)) return true; // old, and unprobeable from here
  return ctx.deps.isProcessAlive(record.pid) !== true;
}

// Run `fn` with exclusive rights to mutate `generation` of this lock. `fn` receives a `stillMine`
// probe: a section whose breaker was recovered underneath it must not go on to touch the lock.
function withBreaker(ctx, policy, generation, fn) {
  const fsImpl = ctx.deps.fs;
  const file = breakerPathFor(ctx.file, generation);
  const id = ctx.deps.randomToken(ctx.host, ctx.pid, ctx.deps.now());
  const text = JSON.stringify({ v: 1, id, host: ctx.host, pid: ctx.pid, startedAt: ctx.deps.now() });

  let created = tryExclusiveCreate(fsImpl, file, text);
  if (!created.ok && created.code === 'EEXIST') {
    if (!breakerRecoverable(fsImpl, file, policy, ctx)) {
      return { ok: false, reason: 'contended', stage: 'breaker' };
    }
    tryUnlink(fsImpl, file);
    created = tryExclusiveCreate(fsImpl, file, text);
  }
  if (!created.ok) {
    return created.code === 'EEXIST'
      ? { ok: false, reason: 'contended', stage: 'breaker' }
      : { ok: false, reason: 'breaker-write-failed', code: created.code };
  }

  const stillMine = () => {
    const current = readBreaker(fsImpl, file);
    return current !== null && current.id === id;
  };
  try {
    return fn(stillMine);
  } finally {
    // Only clear it if it is still ours; deleting a recoverer's breaker would hand the section to
    // a third party while that recoverer is inside it.
    if (stillMine()) tryUnlink(fsImpl, file);
  }
}

// ── Lock-order bookkeeping ──────────────────────────────────────────────────────────────────
// Process-local. It cannot see another process's locks and does not try to: it exists to stop THIS
// process from building a cycle by taking a coarser lock while holding a finer one.

const heldByToken = new Map();

export function heldLocks() {
  const out = [];
  for (const entry of heldByToken.values()) {
    out.push({ token: entry.token, kind: entry.kind, name: entry.name, rank: entry.rank });
  }
  return out;
}

// Test and recovery use only. Clears the process-local view without touching any lock file, so a
// suite cannot leak ordering state between cases and a caller that lost its handles is not wedged.
export function forgetHeldLocks() {
  heldByToken.clear();
}

// `'migration'` is deliberately OUTSIDE LOCK_KINDS: lockRank returns -1 for it, and this early
// return is why that never matters. Do not add it — a rank would change acquisition behaviour.
function checkLockOrder(desc, rank) {
  if (desc.kind === 'migration') return null;
  let worstRank = -1;
  let worstName = null;
  for (const entry of heldByToken.values()) {
    // The same lock name is not an ordering question — let the filesystem answer it, so a
    // same-process reacquire is refused as 'held' with the real holder attached.
    if (entry.name === desc.name) return null;
    if (entry.rank > worstRank) {
      worstRank = entry.rank;
      worstName = entry.name;
    }
  }
  if (worstRank >= 0 && rank <= worstRank) {
    return {
      reason: 'lock-order',
      detail: `${desc.kind} lock "${desc.name}" (rank ${rank}) may not be taken while holding "${worstName}" (rank ${worstRank})`,
    };
  }
  return null;
}

// ── Housekeeping ────────────────────────────────────────────────────────────────────────────

// Breakers for generations that are long gone. Bounded, prefix-scoped to this one lock, and only
// for files older than ten times the breaker stale window — a live section is never in range.
function sweepAbandonedBreakers(ctx, policy) {
  const fsImpl = ctx.deps.fs;
  const dir = path.dirname(ctx.file);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return 0;
  }
  const prefix = `${path.basename(ctx.file)}.take-`;
  const nowMs = ctx.deps.now();
  let removed = 0;
  for (let i = 0; i < names.length; i += 1) {
    if (removed >= BREAKER_SWEEP_MAX) break;
    const name = String(names[i]);
    if (name.indexOf(prefix) !== 0) continue;
    const full = path.join(dir, name);
    const mtimeMs = tryMtime(fsImpl, full);
    if (mtimeMs === null) continue;
    if (nowMs - mtimeMs <= policy.breakerStaleMs * 10) continue;
    if (tryUnlink(fsImpl, full).ok) removed += 1;
  }
  return removed;
}

// ── Policy and context ──────────────────────────────────────────────────────────────────────

function resolvePolicy(options) {
  const o = orDefault(options, {});
  const num = (value, fallback) => (typeof value === 'number' && isFinite(value) && value >= 0 ? value : fallback);
  return {
    leaseMs: num(o.leaseMs, DEFAULT_LEASE_MS),
    maxHolderLeaseMs: num(o.maxHolderLeaseMs, MAX_HOLDER_LEASE_MS),
    // Constants, not options: the four grace windows are the primitive's own safety margins and
    // every caller takes them as given. They stay on the policy object because the protocol below
    // reads them from it — they are simply no longer overridable.
    livenessGraceMs: LIVENESS_GRACE_MS,
    foreignHostGraceMs: FOREIGN_HOST_GRACE_MS,
    corruptGraceMs: CORRUPT_GRACE_MS,
    breakerStaleMs: BREAKER_STALE_MS,
    attempts: Math.max(1, num(o.attempts, DEFAULT_ATTEMPTS)),
    sweep: o.sweep !== false,
  };
}

function makeContext(desc, deps) {
  const resolved = resolveDeps(deps);
  return {
    deps: resolved,
    file: desc.file,
    kind: desc.kind,
    name: desc.name,
    host: resolved.hostname(),
    pid: resolved.pid(),
  };
}

function recordFor(ctx, policy, token, acquiredAt, nowMs) {
  return JSON.stringify({
    v: 1,
    token,
    kind: ctx.kind,
    name: ctx.name,
    host: ctx.host,
    pid: ctx.pid,
    acquiredAt,
    renewedAt: nowMs,
    leaseMs: policy.leaseMs,
    expiresAt: nowMs + policy.leaseMs,
  });
}

// ── The handle ──────────────────────────────────────────────────────────────────────────────

function makeHandle(ctx, policy, token, acquiredAt, expiresAt) {
  const state = { live: true, expiresAt, renewedAt: acquiredAt };

  const retire = () => {
    state.live = false;
    heldByToken.delete(token);
  };

  const handle = {
    kind: ctx.kind,
    name: ctx.name,
    file: ctx.file,
    // The acquisition token. Unique to THIS acquisition — a second acquisition by the same
    // process gets a different one, which is what makes release and renew safe.
    token,
    host: ctx.host,
    pid: ctx.pid,
    acquiredAt,
    get expiresAt() { return state.expiresAt; },
    get renewedAt() { return state.renewedAt; },
    get live() { return state.live; },

    // Read-only ownership check. Cheap enough to call before committing anything.
    verify() {
      if (!state.live) return { ok: false, reason: 'released' };
      const obs = observe(ctx.deps.fs, ctx.file);
      if (!obs.present) {
        retire();
        return { ok: false, reason: 'lost', detail: 'lock file is gone', holder: null };
      }
      if (obs.generation !== token) {
        retire();
        return { ok: false, reason: 'lost', holder: summarizeHolder(obs) };
      }
      const nowMs = ctx.deps.now();
      const until = holderExpiry(obs.record, policy);
      if (until !== null && nowMs > until) return { ok: false, reason: 'expired', expiresAt: until };
      return { ok: true, expiresAt: until };
    },

    // Extend the lease. Guarded, so it can never overwrite a successor's record, and it reports
    // 'lost' instead — a caller that gets 'lost' must abort, not commit.
    renew(renewOptions) {
      if (!state.live) return { ok: false, reason: 'released' };
      const leaseMs = renewOptions && typeof renewOptions.leaseMs === 'number' && isFinite(renewOptions.leaseMs)
        ? renewOptions.leaseMs
        : policy.leaseMs;
      const outcome = withBreaker(ctx, policy, token, (stillMine) => {
        const obs = observe(ctx.deps.fs, ctx.file);
        if (!obs.present) return { ok: false, reason: 'lost', detail: 'lock file is gone' };
        if (obs.generation !== token) return { ok: false, reason: 'lost', holder: summarizeHolder(obs) };
        if (!stillMine()) return { ok: false, reason: 'contended', stage: 'breaker-recovered' };
        const nowMs = ctx.deps.now();
        const next = recordFor(ctx, { leaseMs }, token, acquiredAt, nowMs);
        // A plain overwrite is correct HERE and only here: inside the breaker, no other party may
        // remove or rewrite this generation, and a reader that catches a torn write derives a
        // 'raw:' generation from the bytes, fails its own re-check and backs off rather than
        // taking the lock. Writing via a temp + rename would be worse on Windows, where the
        // measurements in the header show rename cannot be trusted under contention.
        const written = tryOverwrite(ctx.deps.fs, ctx.file, next);
        if (!written.ok) return { ok: false, reason: 'write-failed', code: written.code };
        state.renewedAt = nowMs;
        state.expiresAt = nowMs + leaseMs;
        return { ok: true, expiresAt: state.expiresAt, renewedAt: nowMs };
      });
      if (!outcome.ok && outcome.reason === 'lost') retire();
      return outcome;
    },

    // Release. Never unlinks a file that is not this acquisition's — that is the whole point of
    // the token, and it is what makes an old holder's late release harmless.
    release() {
      if (!state.live) return { ok: true, reason: 'already-released' };
      const outcome = withBreaker(ctx, policy, token, (stillMine) => {
        const obs = observe(ctx.deps.fs, ctx.file);
        if (!obs.present) return { ok: true, reason: 'already-gone' };
        if (obs.generation !== token) return { ok: false, reason: 'lost', holder: summarizeHolder(obs) };
        if (!stillMine()) return { ok: false, reason: 'contended', stage: 'breaker-recovered' };
        const removed = tryUnlink(ctx.deps.fs, ctx.file);
        if (!removed.ok && removed.code !== 'ENOENT') {
          return { ok: false, reason: 'unlink-failed', code: removed.code };
        }
        return { ok: true };
      });
      // The process-local ordering entry goes either way. A release that reported 'lost' has
      // already lost the lock, and keeping the entry would wedge lock ordering for this process.
      retire();
      return outcome;
    },
  };
  return handle;
}

// ── Acquire ─────────────────────────────────────────────────────────────────────────────────

/**
 * Non-blocking acquire. Never sleeps and never waits on another process.
 *
 * @param target  a descriptor from electionLock/runLock/sessionLock/sharedLock. Nothing else is
 *                accepted — a non-object throws TypeError, as does one without a name.
 * @param options per-use policy: leaseMs, maxHolderLeaseMs, attempts, sweep. The four grace
 *                windows are module constants, not overrides — see resolvePolicy.
 * @param deps    injected fs / now / hostname / pid / isProcessAlive / randomToken.
 * @returns {{ok: true, handle: object}} or {{ok: false, reason: string, holder: object|null}}.
 *          Refusal reasons: 'held', 'contended', 'lock-order', 'write-failed', 'mkdir-failed',
 *          'unlink-failed', 'breaker-write-failed', 'migration' (the migration barrier is up) and
 *          'reconciliation' (a backfill barrier is up over this session).
 */
export function acquireLock(target, options, deps) {
  const desc = toDescriptor(target);
  const policy = resolvePolicy(options);
  const ctx = makeContext(desc, deps);
  // Migration first closes the root to new lock holders, then checks existing holders.
  // Check again after exclusive creation to close the registration race.
  const migrationFile = path.join(path.dirname(desc.file), 'migration-barrier.lock');
  const isBarrier = desc.name === 'migration-barrier'
    || (options && options.migrationPermit && observe(ctx.deps.fs, migrationFile).generation === options.migrationPermit);
  ctx.migrationAllowed = isBarrier;
  ctx.recoveryPermit = options && options.recoveryPermit;
  if (!isBarrier && observe(ctx.deps.fs, migrationFile).present) return { ok: false, reason: 'migration', holder: null };
  const rank = lockRank(desc.kind);

  const ordering = checkLockOrder(desc, rank);
  if (ordering) return { ok: false, reason: ordering.reason, detail: ordering.detail, holder: null };

  const dir = ensureLocksDir(ctx.deps.fs, ctx.file);
  if (!dir.ok) return { ok: false, reason: 'mkdir-failed', code: dir.code, holder: null };

  let lastRefusal = { ok: false, reason: 'contended', holder: null };

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    const nowMs = ctx.deps.now();
    const token = ctx.deps.randomToken(ctx.host, ctx.pid, nowMs);

    // 1. The free path. Exclusive create is the atomic operation the whole protocol rests on.
    const created = tryExclusiveCreate(ctx.deps.fs, ctx.file, recordFor(ctx, policy, token, nowMs, nowMs));
    if (created.ok) {
      if (!isBarrier && observe(ctx.deps.fs, migrationFile).present) {
        tryUnlink(ctx.deps.fs, ctx.file);
        return { ok: false, reason: 'migration', holder: null };
      }
      return finishAcquire(ctx, policy, token, nowMs, rank);
    }
    if (created.code !== 'EEXIST') {
      return { ok: false, reason: 'write-failed', code: created.code, holder: null };
    }

    // 2. Someone holds it. Decide with the HOLDER's lease and a liveness probe, not our own clock
    //    preference and not age alone.
    const obs = observe(ctx.deps.fs, ctx.file);
    if (!obs.present) continue; // it vanished between the create and the read — try again
    const verdict = judge(obs, policy, ctx);
    if (!verdict.takeover) {
      return {
        ok: false,
        reason: 'held',
        decision: verdict.decision,
        expiresAt: verdict.expiresAt,
        holder: summarizeHolder(obs),
      };
    }

    // 3. Takeover, serialized on the generation we judged. Two contenders holding the same stale
    //    read contend for one breaker; the loser leaves without unlinking anything.
    const outcome = withBreaker(ctx, policy, obs.generation, (stillMine) => {
      const again = observe(ctx.deps.fs, ctx.file);
      if (!again.present) return { retry: true };
      // A different generation means someone already replaced it. Ours is not the lock we judged.
      if (again.generation !== obs.generation) return { retry: true };
      // Same generation, but the holder may have renewed since. Re-judge inside the section: the
      // holder's own renew needs this same breaker, so what we read here is settled.
      const reJudged = judge(again, policy, ctx);
      if (!reJudged.takeover) {
        return {
          ok: false,
          reason: 'held',
          decision: reJudged.decision,
          expiresAt: reJudged.expiresAt,
          holder: summarizeHolder(again),
        };
      }
      if (!stillMine()) return { ok: false, reason: 'contended', stage: 'breaker-recovered' };

      const removed = tryUnlink(ctx.deps.fs, ctx.file);
      if (!removed.ok && removed.code !== 'ENOENT') {
        return { ok: false, reason: 'unlink-failed', code: removed.code };
      }
      const takeAt = ctx.deps.now();
      const write = tryExclusiveCreate(ctx.deps.fs, ctx.file, recordFor(ctx, policy, token, takeAt, takeAt));
      if (write.ok) return { ok: true, acquiredAt: takeAt };
      // Losing the create means a third party got in. It owns the lock; we simply refuse.
      if (write.code === 'EEXIST') return { retry: true };
      return { ok: false, reason: 'write-failed', code: write.code };
    });

    if (outcome.retry) {
      lastRefusal = { ok: false, reason: 'contended', holder: null };
      continue;
    }
    if (outcome.ok) return finishAcquire(ctx, policy, token, outcome.acquiredAt, rank);
    lastRefusal = {
      ok: false,
      reason: outcome.reason,
      code: orDefault(outcome.code, undefined),
      decision: orDefault(outcome.decision, undefined),
      holder: orDefault(outcome.holder, null),
    };
    if (outcome.reason === 'held') return lastRefusal;
  }
  return lastRefusal;
}

function finishAcquire(ctx, policy, token, acquiredAt, rank) {
  const recovery = ctx.kind === 'session'
    ? observe(ctx.deps.fs, path.join(path.dirname(ctx.file), 'run-backfill.lock')) : null;
  if (recovery && recovery.present && recovery.generation !== ctx.recoveryPermit) {
    if (observe(ctx.deps.fs, ctx.file).generation === token) tryUnlink(ctx.deps.fs, ctx.file);
    return { ok: false, reason: 'reconciliation', holder: null };
  }
  if (!ctx.migrationAllowed && observe(ctx.deps.fs, path.join(path.dirname(ctx.file), 'migration-barrier.lock')).present) {
    if (observe(ctx.deps.fs, ctx.file).generation === token) tryUnlink(ctx.deps.fs, ctx.file);
    return { ok: false, reason: 'migration', holder: null };
  }
  const handle = makeHandle(ctx, policy, token, acquiredAt, acquiredAt + policy.leaseMs);
  heldByToken.set(token, { token, kind: ctx.kind, name: ctx.name, rank });
  if (policy.sweep) sweepAbandonedBreakers(ctx, policy);
  return { ok: true, handle };
}

// ── Transaction helpers ─────────────────────────────────────────────────────────────────────

/**
 * Run a SYNCHRONOUS critical section under the lock, releasing it however the section ends.
 * On contention it does not run `fn` at all and reports `skipped: true` — the defer-on-contention
 * behaviour a hook needs when it has a few milliseconds and no right to block another writer.
 */
export function withLock(target, options, fn, deps) {
  const acquired = acquireLock(target, options, deps);
  if (!acquired.ok) {
    return { ok: false, skipped: true, reason: acquired.reason, holder: acquired.holder, detail: acquired.detail };
  }
  let out = null;
  try {
    out = { ok: true, skipped: false, value: fn(acquired.handle), handle: acquired.handle };
  } finally {
    // The release verdict is part of the result, not something to swallow: a release that reports
    // 'lost' means the section ran while somebody else owned the lock, and the caller has to be
    // able to see that before it treats the work as committed.
    const released = acquired.handle.release();
    if (out) out.release = released;
  }
  return out;
}

/**
 * The same for an async critical section. Kept separate rather than sniffing the return value, so
 * a caller cannot accidentally get the lock released before its promise settles.
 */
export async function withLockAsync(target, options, fn, deps) {
  const acquired = acquireLock(target, options, deps);
  if (!acquired.ok) {
    return { ok: false, skipped: true, reason: acquired.reason, holder: acquired.holder, detail: acquired.detail };
  }
  let out = null;
  try {
    out = { ok: true, skipped: false, value: await fn(acquired.handle), handle: acquired.handle };
  } finally {
    const released = acquired.handle.release();
    if (out) out.release = released;
  }
  return out;
}

/**
 * Read who holds a lock without contending for it. For status output and diagnostics only —
 * nothing may act on the answer, because it is stale the moment it is returned.
 */
export function inspectLock(target, options, deps) {
  const desc = toDescriptor(target);
  const policy = resolvePolicy(options);
  const ctx = makeContext(desc, deps);
  const obs = observe(ctx.deps.fs, ctx.file);
  if (!obs.present) return { held: false, holder: null, file: ctx.file };
  const verdict = judge(obs, policy, ctx);
  return {
    held: true,
    holder: summarizeHolder(obs),
    file: ctx.file,
    takeoverReady: verdict.takeover,
    decision: verdict.decision,
    expiresAt: verdict.expiresAt,
  };
}
