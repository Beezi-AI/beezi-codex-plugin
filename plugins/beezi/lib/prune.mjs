import fs from 'fs';
import path from 'path';
import { queueDir, stateDir } from './paths.mjs';
import { listAccountsSync } from './accounts.mjs';
import { locksDir, MAX_HOLDER_LEASE_MS, acquireLock, runLock } from './single-instance-lock.mjs';
import { removeDirSync } from './compat.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Age is only a scan filter. Ownership is checked by the guarded lock protocol.
export const LOCK_STALE_AGE_MS = 2 * MAX_HOLDER_LEASE_MS;

export function pruneStale(now = Date.now(), maxAgeMs = FOURTEEN_DAYS_MS) {
  const acquired = acquireLock(runLock('prune'), {});
  if (!acquired.ok) return;
  try { return pruneLocked(now, maxAgeMs); }
  finally { acquired.handle.release(); }
}

function pruneLocked(now, maxAgeMs) {
  let locks = null;
  try { locks = locksDir(); } catch { locks = null; } // an unresolvable environment names no root
  // state/ is machine-level; every linked account has a queue of its own, and all of them expire
  // on the same 14-day rule. listAccountsSync, not listAccounts: a prune must never be the thing
  // that runs the one-time migration, and it must stay synchronous for its hook-path callers.
  const dirs = [stateDir()];
  try { for (const account of listAccountsSync()) dirs.push(queueDir(account.key)); }
  catch { /* an unreadable index sweeps no queue, which deletes nothing */ }
  if (locks !== null) dirs.push(locks);

  for (const dir of dirs) {
    const ageMs = dir === locks ? LOCK_STALE_AGE_MS : maxAgeMs;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; } // dir missing → skip
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      try {
        const { mtimeMs } = fs.statSync(p);
        if (now - mtimeMs <= ageMs) continue;
        if (dir === locks) {
          // Breaker recovery remains the primitive's responsibility.
          if (!entry.name.endsWith('.lock') || !entry.isFile()) continue;
          const acquired = acquireLock({ kind: 'shared', name: entry.name, file: p }, {}, { now: () => now });
          if (acquired.ok) acquired.handle.release();
          continue;
        }
        // A session's subagent records live in a `<sessionId>.agents/` directory beside its state
        // file. unlinkSync cannot remove a directory, so without this branch those would accumulate
        // forever while every other stale entry was swept.
        if (entry.isDirectory()) removeDirSync(p);
        else fs.unlinkSync(p);
      } catch { /* skip unreadable/racing entry */ }
    }
  }
}
