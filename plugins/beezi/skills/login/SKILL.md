---
name: login
description: Link this machine to Beezi, unlink it, or refresh the captured ChatGPT plan. Use when the user wants to log in / sign in / connect to Beezi, log out, or when a Beezi tool reports that the machine is not linked. For "am I linked?" use the `me` skill instead.
---

# Beezi: login

## Finding the scripts

Every command below runs a script under the plugin's `scripts/` directory. That directory is two
levels above this `SKILL.md` — this file is at `<plugin-root>/skills/login/SKILL.md`, so the
scripts are at `<plugin-root>/scripts/`. Use the absolute path; `codex plugin list` also prints the
plugin root for `beezi` if you need to confirm it.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

## Logging in

**Prefer the MCP tool.** If a `beezi_login` tool is available, call it — it runs the same browser
sign-in inside the already-running Beezi server, and the Beezi tools become available immediately
afterwards without restarting the session. Takes no arguments.

If that tool is not available, run:

```
node "<plugin-root>/scripts/login.mjs"
```

Either way a browser window opens for the user to sign in with their Beezi account. If the browser
does not open, the output contains the URL — pass it to the user verbatim. The flow blocks until
they finish or it times out; say so rather than assuming it failed.

Report the result verbatim. If the output ends with steps for installing analytics hooks, repeat
them — logging in alone does not start reporting analytics. The `analytics-hooks` skill covers that.

## Logging out

```
node "<plugin-root>/scripts/logout.mjs"
```

Unlinks this machine. Confirm with the user first — it is not what someone asking to "switch
accounts" usually wants; logging in again re-links without needing this.

## Refreshing the captured plan

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via refresh
```

Re-reads the ChatGPT plan tier from `~/.codex/auth.json`. Only the plan label is read and stored —
no token leaves the machine. Report its one-line output verbatim; if it says nothing was captured,
tell the user their ChatGPT subscription info was not found.

## Checking the link

That is the `me` skill. It answers through the `beezi_status` tool, which runs in the process that
actually holds the credentials — do not answer "am I linked?" from a script here.

## When something fails

**"not linked" persists after logging in.** The credentials are stored per machine in the OS
keyring, falling back to `~/.beezi-codex/credentials.json` (or `$BEEZI_CODEX_HOME`). If the user is
running Codex with a different `BEEZI_CODEX_HOME`, they are two different machines as far as Beezi
is concerned. `~/.beezi` is the Claude Code plugin's directory and is never read by this plugin —
a link there does not carry over.

**The browser never opens.** Not fatal — the output carries the authorize URL. Give it to the user.

**Network or server errors.** Report them as given. Do not retry a login in a loop; each attempt
opens another browser window.
