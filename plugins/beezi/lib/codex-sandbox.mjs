// Is this process one of the model's shell commands, running inside Codex's sandbox?
//
// Hooks and the MCP server are spawned by Codex itself and run unsandboxed; a skill's
// `node scripts/<x>.mjs` is spawned by the model and is sandboxed unless the user approved an
// escalation. Codex marks a sandboxed child with CODEX_SANDBOX ('seatbelt' on macOS) and, when the
// sandbox has no network, CODEX_SANDBOX_NETWORK_DISABLED=1.
//
// It matters for the credential store: macOS Seatbelt's base profile has no
// com.apple.SecurityServer lookup (only the network profile adds it), so `security
// find-generic-password` comes back empty — byte-identical to a locked keychain. The OS store is
// fine; the command just has to run outside the sandbox. Sandbox and network settings can differ
// per project, the likely reason the same command works in one directory and not another.
//
// Windows is the same failure by a different route. Codex's Windows sandbox runs the command as a
// separate local account — CodexSandboxOffline, or CodexSandboxOnline when the sandbox has network
// (both names measured in rollouts, 2026-10-08). Credential Manager is per-user, so that account
// sees an empty vault where the user's Beezi sign-in is. Codex does NOT set CODEX_SANDBOX there; it
// sets CODEX_SANDBOX_NETWORK_DISABLED=1 only when the sandbox has no network, while USERPROFILE and
// os.homedir() stay the real user's (measured, `codex exec` 0.160, 2026-10-08). So the account name
// is checked on its own: os.userInfo() asks the OS for the process token's user, which a child
// cannot inherit wrongly the way it inherits USERNAME.
import os from 'os';

const WINDOWS_SANDBOX_USER = /^CodexSandbox(Offline|Online)$/i;

function osUsername() {
  try { return os.userInfo().username; } catch { return ''; }
}

export function inCodexSandbox(env = process.env, username = osUsername()) {
  if (env && ((typeof env.CODEX_SANDBOX === 'string' && env.CODEX_SANDBOX !== '')
    || env.CODEX_SANDBOX_NETWORK_DISABLED === '1')) return true;
  return WINDOWS_SANDBOX_USER.test(String(username || ''));
}

// Worded for the model as much as for the user: "sandbox" and "run it again with escalated
// permissions" are what the skills and the workspace prompt tell it to retry on.
export const SANDBOXED_CREDENTIAL_STORE_MESSAGE = 'Beezi: this command ran inside the Codex sandbox, which can'
  + ' block access to the system credential store (Windows Credential Manager, the macOS keychain), so'
  + ' Beezi could not read its saved sign-in. Nothing was changed. Run it again with escalated'
  + ' permissions so the user can approve it.';

// The same retry, for a sandboxed command that lost the network or a file outside the workspace:
// without it the model reads "check your internet connection" and tells the user their network is
// down. No "nothing was changed" here — a write can fail after an earlier one landed. Whether Codex
// still sets CODEX_SANDBOX_NETWORK_DISABLED on an approved escalated child is unmeasured, so a real
// outage may land here too; the last sentence keeps that from becoming an approval loop.
export const SANDBOXED_COMMAND_MESSAGE = 'Beezi: this command ran inside the Codex sandbox, which blocks'
  + ' the network and files outside the workspace, so Beezi could not reach its server or its data'
  + ' under your home folder. Run it again with escalated permissions so the user can approve it. If it'
  + ' already ran with escalated permissions, the sandbox is not the cause: do not retry it.';
