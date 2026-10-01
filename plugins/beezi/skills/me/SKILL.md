---
name: me
description: Show which Beezi accounts are linked on this machine, which one the analytics tools read from, against which Beezi API, and whether the analytics hooks are installed. Use when the user asks "am I linked / signed in to Beezi", who they are linked as, which accounts are linked, or why their Beezi analytics look empty.
---

# Beezi: me

## Answering it

**Two surfaces, and they answer different questions — pick by what was asked.**

- **`beezi_status`** (the MCP tool, no arguments) answers for the **default account only**: whether
  it is linked, as whom, against which Beezi API, and whether the analytics hooks are installed.
  It runs in the process that actually holds the credentials, so prefer it for *"am I linked?"*.
- **`scripts/me.mjs`** lists **every** linked account. Use it whenever the question is about more
  than one account — "which accounts are linked", "am I still signed in to my other workspace",
  "which one are my analytics coming from" — because the tool cannot answer those.

This file is at `<plugin-root>/skills/me/SKILL.md`, so the script is at:

```
node "<plugin-root>/scripts/me.mjs"
```

The MCP server inherits `BEEZI_API_URL` and the credential store from Codex; a shell command may
not, so the two can disagree about the API. Both answers name the API they checked against — if
they differ, say so rather than picking one silently.

Report the output verbatim, and never echo a token or the contents of the credentials file.

## Reading the script's answer

**Nothing linked** — one line saying this machine is not linked to Beezi, plus the reporting line.
Run the `login` skill.

**One or more accounts linked** — a header giving the count and saying the analytics skill reads
from the default, the API address, then one **block per account**, then a single machine-level
reporting line.

### The account blocks

Each block is a numbered heading — `<name> <email> - <workspace> [<key>]` — with `(default —
analytics read from this one)` on **at most one** of them (no block carries it when no default is
set), and a second line that is one of:

- **`plan … · tracking … · history import …`** — the account is healthy. `tracking live` means it
  is reporting; `backfill_only` or `disabled` means its workspace has turned live reporting off,
  which is a Beezi-side setting and not something to fix here. `history import not finished` means
  the one-time upload of past sessions has not sealed yet — the `login` skill's upload step, or the
  `sync` skill, is what continues it.
- **`revoked — run the login skill and sign in as this account`** — that account's access was
  revoked. Logging in again re-links it; no need to log out first.
- **`expired, run the login skill and sign in as this account`** — its stored credentials are gone.
  Same fix.
- **`could not be checked just now`** — says nothing about the link itself; queued reports are
  retried automatically.

A heading reading `linked account (no name or email recorded)` is an account carried over from
before this plugin stored account details. Not an error.

If the header ends with a line saying **no default is set**, analytics have no account to read
from. Offer the `accounts` skill.

### The reporting line

One line, for the **whole machine**, not per account: whether analytics are actually being reported
right now. It exists because a machine can be linked and still be reporting nothing.

Hook state is folded into it. **installed** does not mean analytics are flowing — Codex also
requires the user to trust the hooks once via `/hooks`, and the line says so explicitly. That
combination — linked, hooks installed, still no data — is the platform's most common failure, and
the trust step is the fix. Hooks **not installed**, an **out-of-date** registration and an
**incomplete install** are all repaired by this command itself before it reports; what is left for
the user is the one-off re-trust, which the line names. A **refreshed launcher** needs no re-trust,
and the answer says so. The `analytics-hooks` skill covers the install/repair side.

If the reporting line is missing entirely, the hook registry could not be read. Not an error to
escalate — report the account blocks alone.

## What this answer does not cover

- **Switching which account analytics are read from** is the `accounts` skill. This one only
  reports; it changes no default.
- **Crash reporting** — a separate local setting, off by default and never implied by being linked.
  Send any question about crash reports, error reporting, diagnostics or telemetry to the
  `telemetry` skill rather than guessing: a link verdict is not a consent verdict.
