import os from 'node:os';
import path from 'node:path';

// This plugin's own data root — deliberately NOT `~/.beezi`, and deliberately not overridable via
// `BEEZI_HOME`. The Claude Code plugin owns `~/.beezi` on the same machine and writes the same
// filenames there: `queue/`, `state/`, `billing.json`, `repo-map.json`, `credentials.json`. Sharing
// them means one agent's queued segments flushed under the other's identity, and whichever plugin
// captured a subscription plan last winning `billing.json` for both. Same reasoning as the
// `beezi-codex` keyring entry — one store per agent, no exceptions.
export function beeziCodexHome() {
  return process.env.BEEZI_CODEX_HOME ?? path.join(os.homedir(), '.beezi-codex');
}

export function queueDir() {
  return path.join(beeziCodexHome(), 'queue');
}

export function stateDir() {
  return path.join(beeziCodexHome(), 'state');
}

// Persisted known-repo-root map (dir→root resolution cache/seed). One JSON for the machine.
export function repoMapFile() {
  return path.join(beeziCodexHome(), 'repo-map.json');
}

export function credentialsFile() {
  return path.join(beeziCodexHome(), 'credentials.json');
}

export function billingConfigFile() {
  return path.join(beeziCodexHome(), 'billing.json');
}

// Codex's config root — `~/.codex`, relocatable via CODEX_HOME. Single source for the dirs
// the plugin reads out of Codex (session rollout transcripts, auth store).
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Codex writes one rollout transcript per session under a date-partitioned tree:
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
export function codexSessionsDir() {
  return path.join(codexHome(), 'sessions');
}

// The Codex auth store. Holds the ChatGPT tokens; the id_token carries the plan claim we read
// for subscription attribution (no secret leaves the machine — only the plan tier string).
export function codexAuthFile() {
  return path.join(codexHome(), 'auth.json');
}

// Codex's session index — one JSONL record per session { id, thread_name, updated_at }. The
// thread_name is the user-facing session title we surface in analytics.
export function codexSessionIndexFile() {
  return path.join(codexHome(), 'session_index.jsonl');
}

// Codex's user-level hook registry. Plugin-bundled hooks are not loaded by Codex (the
// `plugin_hooks` feature is `removed`), so Beezi's lifecycle hooks have to be installed here.
export function codexHooksFile() {
  return path.join(codexHome(), 'hooks.json');
}

// Where the installer writes its launcher scripts. Each is a single-token executable so the
// `command` field never depends on how Codex splits arguments or resolves `node` on PATH.
export function hookLauncherDir() {
  return path.join(beeziCodexHome(), 'hooks');
}
