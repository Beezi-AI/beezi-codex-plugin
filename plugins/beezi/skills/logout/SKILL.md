---
name: logout
description: Log one Beezi account, or every one, out of this machine. Use when the user wants to log out of Beezi, unlink or disconnect this machine, remove one of several linked Beezi accounts, or remove the stored Beezi credentials. To sign in or add an account use the `login` skill; to check what is linked use the `settings` skill; to change which account analytics are read from use the `settings` skill (Account → Default account).
---

# Beezi: logout

## Confirm first

Unlinking is rarely what someone asking to **switch accounts** wants. Two different things get
called "switching":

- *"I want my analytics to come from my other workspace."* That is the `settings` skill (Account → Default account) — both
  accounts stay linked and nothing is unlinked.
- *"I want to sign in as someone else."* That is the `login` skill — logging in again links the new
  account alongside the old one, with no logout needed.

Ask before running anything unless the user clearly asked to sign out, disconnect, or remove an
account.

## Running it

This file is at `<plugin-root>/skills/logout/SKILL.md`, so the script is at
`<plugin-root>/scripts/logout.mjs` — use the absolute path. There is no MCP logout tool;
`beezi_login` and `beezi_status` are the only two the server holds. With several Beezi builds installed, call the tool on this plugin's own MCP server — the key follows this skill's plugin name (`beezi` → `beezi`, `beezi-staging` → `beezi_staging`); see "Use this plugin's own server" in the `login` skill.

**Check this session first.** Before the first Beezi script in this session, run
`node "<plugin-root>/scripts/preflight.mjs"` as it is, inside the sandbox and not escalated: it only
reads this Codex session's own log, and it is the one script that needs nothing the sandbox blocks.
Its `preflight=` line is for you only. On `preflight=blocked` it first prints lines starting `✗`:
show them verbatim and run no other Beezi script, because this session cannot let them out of the
sandbox and those lines tell the user how to change that. A blocked answer holds only until then:
the user may switch with `/permissions`, so run the preflight again before the next Beezi script. On
`preflight=unknown`, judge from your own permissions instructions: an approval policy of `never`
under a sandbox is the same answer, so tell the user to restart Codex with
`codex --sandbox workspace-write --ask-for-approval on-request` (or, only on a machine they trust,
`codex --dangerously-bypass-approvals-and-sandbox`) and run no Beezi script. Otherwise carry on.

**Run every other script outside the sandbox.** Every other `node "<plugin-root>/scripts/…"` command
in this skill reads Beezi's sign-in from the system credential store (Windows Credential Manager, the
macOS keychain), reads and writes Beezi's data under the user's home folder, outside the
workspace, and most of them call the Beezi server. The Codex sandbox blocks all three, so a
sandboxed run fails, or can report a wrong answer such as "no account linked". Run each of them
with escalated permissions from the first attempt, never in the sandbox first: set
`sandbox_permissions` to `"require_escalated"` (or use whatever escalation your shell tool offers)
with a one-sentence `justification` saying what the command does, so the user can approve it.
When this session has no sandbox (full access), run the commands as they are. If the user declines
the approval, run nothing further from this skill and say the step needs their approval. A command
that ran in the sandbox and prints a line naming it is run once more, escalated; one that already
ran escalated and still fails is not retried: show its line and stop.

**Several accounts can be linked at once, so always see what is there first:**

```
node "<plugin-root>/scripts/logout.mjs" --list
```

`--list` resolves no token and makes no request. It prints the same numbered list the `settings`
skill (Account → Default account) does.

Report every output verbatim, and never echo a token or the contents of the credentials file.

## Then choose, by how many are linked

- **Zero.** Nothing to do; say so and stop.
- **Exactly one.** Run the bare command — it logs that one account out.

  ```
  node "<plugin-root>/scripts/logout.mjs"
  ```

- **Two or more.** Ask whether the user means **one** of them or **all** of them; never guess.

  ```
  node "<plugin-root>/scripts/logout.mjs" --account <n>
  node "<plugin-root>/scripts/logout.mjs" --all
  ```

  `<n>` is the position from the list. The account's key or email works too.

**If the account being logged out is the current default and other accounts remain**, ask which of
the remaining accounts should become the one analytics are read from, and pass it:

```
node "<plugin-root>/scripts/logout.mjs" --account <n> --next-default <m>
```

Both numbers are positions in the list **as it was just printed**. Ask when the user is likely to
care which account analytics are read from — with three or more linked, that is most of the time.
Without `--next-default` the command settles it and says what it settled on; read that line rather
than predicting it.

`--all` cannot be combined with `--account` or `--next-default` — it leaves no account to be the
default.

## Reading the answer

**Relay every line the command prints, verbatim, and add nothing.**

That is the whole instruction. Do not explain what an outcome means, do not say what it implies
about the portal, the credentials or the network, and do not tell the user what to do next beyond
what the output itself tells them.

The command decides how much it can honestly claim and says exactly that much, including whatever
remedy it offers — `If this account is still listed in the portal's Connections tab, remove it
there.` and `Run the command again to finish.` are its own words, not yours to add or withhold.
Anything added here would be a guess about a state the command looked at and declined to assert,
and a guess that contradicts the output is worse than no explanation at all.

So: print the output, then stop. If the user asks what it means, answer from the lines in front of
you — not from a rule about what usually happens.

Two things are still yours to do, because they are not interpretation:

- **Offer the follow-up skill the output names.** If a line mentions the analytics default, the
  `settings` skill (Account → Default account) changes it; if a line says to sign in again, that is the `login` skill.
- **Never retry in a loop, and never delete a credentials file by hand.** If the command refuses —
  a `✗` line, or the environment guard's refusal, which carries no `✗` and is usually several
  lines — relay it and stop.

## After logging out

The MCP server keeps running with the tool list it already advertised, so the `beezi` tools may
still be listed in the current session — calls to them now fail with a credentials-rejected error.
`beezi_login` still works: signing in again from the same session re-links the machine, no new
Codex thread needed.

Logging out does not remove the analytics hooks from `~/.codex/hooks.json`. They stay installed and
do nothing while no account is linked — every checkpoint stops at the missing token, so sessions
run while signed out are not captured at all, not merely held back. If the user wants the hooks
gone too, that is the `analytics-hooks` skill.

Whatever was already queued under `~/.beezi-codex` for an account that is still linked is left
alone; logging back in drains it on the next checkpoint. The plugin does prune queued items older
than 14 days, so a long time signed out loses them.

## What this does not do

- It does not touch anything that belongs to the **machine** rather than to an account: the
  captured ChatGPT plan, the crash-reporting choice, the repo map and the session bookkeeping all
  survive a logout, including `--all`. Resetting the crash-reporting choice in particular would
  discard a consent decision the user made deliberately.
- It does not delete anything already reported to Beezi. That is an account matter for the portal.
- It does not turn crash reporting on or off — that is a separate, local setting. See the
  `settings` skill (Crash reports).
- It does not change which account analytics are read from, beyond `--next-default` above. That is
  the `settings` skill (Account → Default account).
- `~/.beezi` is the Claude Code plugin's directory and is never touched by this plugin. Logging out
  here does not sign the user out of Claude Code's Beezi plugin.
