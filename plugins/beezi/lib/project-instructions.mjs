import fs from 'fs';
import path from 'path';

const UNKNOWN = { status: 'unknown' };
const MISSING = { status: 'missing' };

function lineCount(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

function readCandidate(repoRoot, name) {
  try {
    return { kind: 'file', text: fs.readFileSync(path.join(repoRoot, name), 'utf8') };
  } catch (error) {
    return error && error.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' };
  }
}

// Observe the project-level instructions Codex loads for this repository. Only the two root
// filenames participate: nested and user-global files belong to a different scope. A non-empty
// override wins; an empty candidate is retained as a real zero-line answer only when no later
// non-empty candidate is available.
export function probeProjectInstructions(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) return UNKNOWN;
  try {
    if (!fs.statSync(repoRoot).isDirectory()) return UNKNOWN;
    // `.git` is a directory in a normal checkout and a file in a worktree/submodule. Its presence
    // distinguishes a real resolved repository root from an arbitrary readable directory, where
    // absent instruction files would otherwise be misreported as a trustworthy `missing` result.
    fs.statSync(path.join(repoRoot, '.git'));
  } catch {
    return UNKNOWN;
  }

  let sawEmpty = false;
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const candidate = readCandidate(repoRoot, name);
    if (candidate.kind === 'unknown') return UNKNOWN;
    if (candidate.kind === 'absent') continue;
    if (candidate.text !== '') return { status: 'present', lineCount: lineCount(candidate.text) };
    sawEmpty = true;
  }

  return sawEmpty ? { status: 'present', lineCount: 0 } : MISSING;
}
