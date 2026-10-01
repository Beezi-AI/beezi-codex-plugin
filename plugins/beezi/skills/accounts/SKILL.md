---
name: accounts
description: List the Beezi accounts linked on this machine and pick which one the analytics tools read from. Use when the user asks which Beezi accounts are linked, wants to switch which workspace their analytics come from, or mentions having two Beezi accounts. To add an account use the `login` skill; to remove one use the `logout` skill.
---

# Beezi: accounts

Several Beezi accounts can be linked on one machine at once. **Every linked account receives this
machine's analytics** — the *default* only decides which account the analytics tools read from.
Say that plainly whenever the user sounds like they think switching the default redirects their
reporting. It does not.

## Finding the script

This file is at `<plugin-root>/skills/accounts/SKILL.md`, so the script is at
`<plugin-root>/scripts/accounts.mjs` — use the absolute path. There is no MCP accounts tool;
`beezi_login` and `beezi_status` are the only two the server holds.

## Always start by listing

```
node "<plugin-root>/scripts/accounts.mjs" list
```

It resolves no token and makes no request. Report its output verbatim and never echo a token or the
contents of the credentials file.

## Reading the answer

Every shape the command can print is below, and there is no other. If the data root has just been
migrated the command prints a migration notice first — a short block of several lines, not one
line — and then continues normally; if the migration cannot proceed it refuses instead, which is
the last entry here.

- **`No Beezi accounts are linked on this machine.`** — nothing to choose between. Point the user at
  the `login` skill and stop.
- **A header ending `… linked. The default is the account the analytics skill reads from.`, followed
  by a numbered row per account** — each row is `<n>. <name> <email> - <workspace> [<key>]`, with
  `(default)` and/or `(revoked)` after it. A row reading `linked account (no name or email
  recorded)` is an account carried over from before this plugin stored account details, and is not
  an error. A `(revoked)` row cannot report — the `login` skill re-links it. If the header block
  ends with a line saying **no default is set**, analytics have nothing to read from until one is
  picked; ask for one.
- **`Analytics now read from …`** — printed by `use` (below), never by `list`.
- **`Usage: accounts.mjs [list|use <account>]`** — the command was neither `list` nor `use`. A
  mistake in the command, not a state of the machine; re-run it correctly.
- **A line beginning `✗`, or any other refusal to proceed** — the command failed and changed
  nothing. The commonest `✗` is a reference that matches no linked account; it can also be an
  unreadable `accounts.json` or another Beezi process holding the index. **The environment guard's
  refusals carry no `✗` and are often several lines** — for example one saying more than one
  account is linked and that all but one must be logged out before the production switch can
  proceed. Treat any output that is neither a list nor a `use` result as a refusal: relay it
  verbatim, do not diagnose it, and do not edit `accounts.json` by hand.

## Then decide, by how many are linked

- **Zero.** The `login` skill. Do not run `use`.
- **Exactly one.** Say that it is the only linked account and is already the default — unless its
  row is marked `(revoked)`, in which case the header ends with the no-default line instead and the
  `login` skill is what re-links it. **Do not ask which one to use** — there is no choice to offer.
- **Two or more.** Report them and ask which one the analytics tools should read from, naming each
  by name and workspace. Ask once; if the user does not care, leave the default alone.

## Switching the default

Only after the user has chosen:

```
node "<plugin-root>/scripts/accounts.mjs" use <n>
```

`<n>` is the position from the list just printed. The account's key or email works too, and is
safer if anything might have changed the list in between.

It prints `Analytics now read from …`, a note that a new Codex session is needed for the tool list
to match if the two workspaces are on different plans, and the reminder that every linked account
still receives this machine's analytics. Relay all of them.

If the account chosen was marked `(revoked)` in the list, a further line says its
`access was revoked, so it cannot report` until the user signs in as it again. Nothing stops a
revoked account being made the default, so relay that line and offer the `login` skill.

## What this skill does not do

- **Adding an account** is the `login` skill. Logging in never switches the default — that is what
  this skill is for.
- **Removing an account** is the `logout` skill. Nothing here unlinks anything: `use` only changes
  which account is read from, and every account stays linked and keeps reporting.
- Changing the default does not move any analytics that have already been reported, and does not
  change what any account was billed.
