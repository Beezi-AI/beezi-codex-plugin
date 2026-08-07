import fs from 'node:fs';
import path from 'node:path';
import { queueDir, stateDir } from './paths.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Deletes entries in the state + queue dirs whose mtime is older than maxAgeMs.
// Best-effort: never throws. `now` injectable for deterministic tests.
export function pruneStale(now = Date.now(), maxAgeMs = FOURTEEN_DAYS_MS) {
  for (const dir of [stateDir(), queueDir()]) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; } // dir missing → skip
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      try {
        const { mtimeMs } = fs.statSync(p);
        if (now - mtimeMs <= maxAgeMs) continue;
        // A session's subagent records live in a `<sessionId>.agents/` directory beside its state
        // file. unlinkSync cannot remove a directory, so without this branch those would accumulate
        // forever while every other stale entry was swept.
        if (entry.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      } catch { /* skip unreadable/racing entry */ }
    }
  }
}
