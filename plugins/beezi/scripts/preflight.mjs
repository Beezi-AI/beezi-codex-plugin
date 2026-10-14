import { sessionPermissions, renderPreflight } from '../lib/codex-permissions.mjs';

// The one script the skills run INSIDE the sandbox, before any other: it says whether this Codex
// session can let the rest out (lib/codex-permissions.mjs). That is also why it skips the env guard
// every other entry point runs first — the guard reads the credential store, which
// the sandbox blocks, and this script reads nothing of Beezi's and writes nothing at all.
async function main() {
  const result = sessionPermissions();
  for (const line of renderPreflight(result)) console.log(line);
  if (result.verdict === 'blocked') process.exitCode = 1;
}

main().catch(() => {
  // A preflight that crashes must not block anything: report it as unknown and let the skill go on.
  console.log('preflight=unknown reason=error approval=unknown sandbox=unknown');
});
