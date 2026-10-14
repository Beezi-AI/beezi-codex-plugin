import childProcess from 'child_process';

// Starts a node script that outlives this process: no stdio, unref'd. → false when the spawn itself failed.
export function spawnDetached(scriptPath, deps = {}, args = []) {
  const spawnImpl = deps.spawnImpl == null ? childProcess.spawn : deps.spawnImpl;
  try {
    const child = spawnImpl(process.execPath, [scriptPath].concat(args), { detached: true, stdio: 'ignore', windowsHide: true });
    if (child == null) return false;
    child.unref();
    return true;
  } catch {
    return false;
  }
}
