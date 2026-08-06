---
name: me
description: Show this machine's Beezi link status — whether it is linked, to which account, against which Beezi API, and whether the analytics hooks are installed. Use when the user asks "am I linked / signed in to Beezi", who they are linked as, or why their Beezi analytics look empty.
---

# Beezi: me

Read-only. Changes nothing, so it is safe to run whenever the request is ambiguous.

## Answering it

**Use the `beezi_status` tool.** It takes no arguments and reports whether the machine is linked, to
which account, which Beezi API it checked against, and whether the analytics hooks are installed —
all from the process that actually holds the credentials.

Do **not** answer this from a script if the tool is available. The MCP server inherits
`BEEZI_API_URL` and the credential store from Codex; a shell command may not, so the two can
disagree — a script reporting "not linked" while the server reports "linked as …" means exactly
that, not that the link is broken. If they disagree, trust the tool and say the script ran with a
different environment.

If the tool is not available, this file is at `<plugin-root>/skills/me/SKILL.md`, so the fallback
script is:

```
node "<plugin-root>/scripts/me.mjs"
```

Report the output verbatim. Do not read, open, or inspect any other files, and never echo a token
or the contents of the credentials file.

## Reading the answer

- **linked** — the machine is linked and the account is named. If analytics are still empty, the
  hooks are the other half: see the `analytics-hooks` skill.
- **not linked** — run the `login` skill.
- **revoked** — the link was revoked from the Beezi portal. Logging in again re-links it; no need to
  log out first.
- **could not reach Beezi** — says nothing about the link itself. The credentials may be fine and
  the hooks may be reporting from a process that can see the API; queued reports are retried
  automatically. Check the connection, or `BEEZI_API_URL` if the address in the answer is wrong.

Hook state comes back in the same answer. **installed** does not mean analytics are flowing — Codex
also requires the user to trust the hooks once via `/hooks`. The `analytics-hooks` skill covers that
step and the `stale` / `partial` states.
