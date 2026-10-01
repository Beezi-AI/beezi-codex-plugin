import { matchKnownRoot, findRepoRootByWalk } from './repo-map.mjs';

// git repo root for `dir`, memoized in `cache`. Resolution order: `git rev-parse --show-toplevel`
// (authoritative — handles subdirs/worktrees/submodules), then the persisted known-root map
// (longest-prefix), then a filesystem walk-up. The last two rescue git false-nulls (git not on
// PATH, 5s timeout, Windows dubious-ownership) where the dir genuinely is inside a repo.
// Returns null when `dir` is falsy or no layer resolves a root.
//
// NOTE for test authors: the `try/catch` below SWALLOWS a throwing `gitImpl` and falls through to
// the filesystem walk, so an "exhaustive, throwing" stub does not fail loudly — it silently
// resolves from the real disk. See the two guards in test/attribution-integration.test.mjs.
export function resolveRepoRoot(gitImpl, dir, cache, map = null) {
  if (!dir) return null;
  if (cache && cache.has(dir)) return cache.get(dir);
  let root = null;
  try {
    const out = gitImpl(['rev-parse', '--show-toplevel'], dir).trim();
    root = out === '' ? null : out;
  } catch {
    root = null;
  }
  if (root === null && map) root = matchKnownRoot(dir, map);
  if (root === null) root = findRepoRootByWalk(dir);
  if (cache) cache.set(dir, root);
  return root;
}
