---
name: track
description: Save Beezi analytics for the current git branch right now, without waiting for a lifecycle hook. Use when the user asks to track, checkpoint, sync, or push this session's token usage to Beezi, or wants analytics captured for work they just finished.
---

# Beezi: track this branch

Checkpoints the current session's token usage and attributes it to the current repository and
branch. This drives the same engine the lifecycle hooks use, so it works whether or not the hooks
are installed and trusted. Work outside a git repo is tracked too, under the folder's name.

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

## Running it

This file is at `<plugin-root>/skills/track/SKILL.md`, so the script is at
`<plugin-root>/scripts/track.mjs`. Run it from the repository the user is working in — the current
working directory is how it finds the repo, the branch, and this session's transcript:

```
node "<plugin-root>/scripts/track.mjs"
```

Report the output verbatim — the success line, or the error if the repo or branch does not qualify —
except the `pending=yes …` lines, which are for you only and never shown. Never echo a token.

## What the output means

When the command reports for more than one account it prints **one line per account**, each prefixed
with the account it belongs to and carrying its own `✓` or `✗` — one account can be saved while
another is rejected in the same run. Relay every line; the outcomes below describe one line each.

- **saved for `<label>`** — segments were queued and sent. The count is segments, not tokens. The
  label varies and does not change the outcome: it is the branch's task when there is one, otherwise
  the branch, otherwise the folder's name. A folder name means the work was outside any git repo, or
  in a repo with no `origin` remote — it is still tracked, attributed to a `local:<folder>` stand-in
  remote rather than skipped, and only the folder name is sent, never the path around it. Nothing to
  fix in any of those cases.
- **held, not sent: no workspace is chosen for this folder yet** (marked `⚠`) — the account is in
  several workspaces, this repo or folder has no rule, and its New folders setting is Ask me. Those
  analytics were not sent and nothing failed: they wait on disk for the answer, for up to 3 days. Relay the
  line, then ask the workspace question below. When some segments did go out (for example ones under
  a subfolder with its own rule), the same line starts with **saved for `<label>` (N segments)** and
  then says **the rest are held, not sent** — both are true: relay it as is and still ask.
- **nothing new to save** — everything up to this point was already reported. Not an error; do not
  re-run hoping for a different answer.
- **not linked** — nothing is linked on this machine; run the `login` skill first.
- **could not use the saved credentials for any linked Beezi account** — not the same thing.
  Accounts *are* linked here and not one of them could produce a working sign-in just now. Say so,
  and point at the `login` skill to sign in again; do not report the machine as unlinked.
- **could not read this machine's linked accounts** — the list of linked accounts could not be read
  at all, and the line carries the reason. Relay that reason verbatim and add nothing to it; the
  command has not established whether anything is linked, so neither have you.
- **could not reach the server — analytics will be retried automatically** — a network or API
  failure, not data loss. The work is queued on disk and the next checkpoint (or the next session's
  start-up flush) sends it. Say so; do not imply anything was dropped, and do not re-run to force it.
- **the server rejected this report** (or a specific rejection message in its place) — the only
  outcome worth escalating. The report reached Beezi and was refused. Report the message verbatim
  and stop; re-running will not change the answer.
- **could not find this session's transcript** — Codex writes one rollout per session under
  `~/.codex/sessions/`; a brand-new session with no activity yet has nothing to checkpoint.

## The workspace question (a `pending=yes` line)

Each `pending=yes account=<key> kind=<repo|folder|outside> match=<…>` line is one account whose
analytics for this folder are held. A session start asks this question when the hooks run; when they
are not trusted nothing else does, so ask it here — one account at a time. For each such line run
(its output is for you only):

```
node "<plugin-root>/scripts/workspace.mjs" rules --account <key>
```

Its lines include one `W. <workspace> account=<key> tenant=<id> role=<role>` per workspace and
`here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none> kind=<…> match=<…>` (no
` (<label>)` when `kind=outside`): `<short>` is the text after `here: ` up to ` (` or ` →`, `<label>`
the text in the parentheses. Only when the `here:` line has `rule=none`, ask:

| `kind=`   | Question                                                            | Last choice               |
| --------- | ------------------------------------------------------------------- | ------------------------- |
| `repo`    | "Where should analytics for <short> go?"                            | "Don't track this repo"   |
| `folder`  | "Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "Where should analytics for sessions outside a project folder go?"  | "Don't track these"       |

With more than one `pending=yes` line, add the account after the question: " (<who>)", `<who>` being
the text before `: ` on the output's first line. Choices: one per `W.` line — the workspace name (the
text after `W. ` up to ` account=`), described by the line's `role=` value (nothing when it is empty)
— then the last choice, described "Nothing from <short> is uploaded" ("Nothing from sessions outside
a project folder is uploaded" for `outside`). Several workspaces may be chosen.

- **`request_user_input`** only when that tool is listed this turn **and** there are at most 2 `W.`
  lines (3 choices): header "Beezi", the question followed by " Pick one, or name several under
  Other.", the labels exactly as above, none marked recommended.
- **Otherwise one plain sentence** that ends your reply, never a numbered list or a bullet menu: the
  question without its "?", a colon, each workspace as "<name> (<role>)" (just "<name>" with no
  role), then " — one or more — or <last choice, lower-case first letter>?". For example: "Where
  should analytics for acme-api go: Acme (Owner), Beta (User), Gamma (User) — one or more — or don't
  track this repo?"

When the answer arrives, run, with `<ids>` = the chosen workspaces' `tenant=` values joined by commas
(e.g. `t1,t2`), or `none` when the last choice was picked (it wins over the others):

```
node "<plugin-root>/scripts/workspace.mjs" rule add --current --account <key> <ids>
```

Show the user only its first line (a `✗` line too). The held analytics then go where the answer
says with the next checkpoint — the next `track` run, while the hooks are not trusted. A skipped or declined
question runs nothing and changes nothing: the analytics stay held, and the next `track` run asks
again.

## When to suggest the hooks instead

If the user is running this repeatedly, point them at the `analytics-hooks` skill: with hooks
installed and trusted, checkpoints happen automatically at every turn end and around git commits,
and this manual step stops being necessary.

## When to suggest `sync` instead

This skill only ever saves **the session it is run from**. History that is already missing — sessions
that ran while the hooks were untrusted, not installed, or offline — is the `sync` skill's
job, and is not a reason to re-run this one.
