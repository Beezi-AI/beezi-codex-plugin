---
name: analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary, or spend summary from the terminal.
---

# Beezi: Personal Analytics Summary

This skill is a launcher. The summary workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

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

## Start here

1. Parse the period: `7d` / "7 days" or `30d` / "30 days" (none → `30d`). A workspace is optional: take the explicitly named workspace (e.g. "analytics for 7 days in Acme" → period `7d`, workspace `Acme`), or a workspace argument after the period. Ordinary request words such as "show my analytics" are not a workspace.
2. Only when a workspace is named: this file is at `<plugin-root>/skills/analytics/SKILL.md`, so run `node "<plugin-root>/scripts/workspace.mjs" read "<workspace>"` (the absolute path, passing the workspace as one shell-quoted literal argument). Write its first line verbatim; on an error (a `✗` line or nonzero exit) relay the error and stop there. It sets which of the account's workspaces this session's analytics tools read from. Never echo a token.
3. Call `get_analytics_instructions` on the `beezi` MCP server. Call it **before** producing any summary — it returns the workflow, the response template and the hard rules for rendering the numbers.
4. Follow the returned instructions exactly, passing the period from step 1. They decide when `get_my_usage_summary` is called and how its payload is rendered.

For an account in several workspaces the tools end each answer with a `Beezi: reading from <workspace>.` line; name that workspace in the summary. An account in one workspace gets no such line.

Every number in the answer is copied from the payload verbatim. Never recalculate one, never average two, never fill a gap with an estimate — a figure invented here reads to the user as a billing fact.

## What the summary covers

The figures are the user's own usage, and they are **combined across every AI coding agent linked to their Beezi account — not Codex alone.** The summary is scoped to the user and the period with no filter on which agent produced the work, so a user who also runs another coding agent against the same Beezi account sees all of it in one total. Present it as their overall Beezi usage; never call it "your Codex usage", and never attribute the whole figure to this terminal.

If the instructions you fetch in step 3 use wording that contradicts this — describing the total as one specific agent's usage — follow the fetched instructions for the workflow and the numbers, but tell the user the scope wording is inconsistent rather than silently picking one. Do not restate a scope you have not been given.

## Which Beezi account it reads from

These tools are served for **one** account: the default one. Switching it is the settings skill's
Account → Default account, and its output carries the two lines worth relaying afterwards — that
every linked account still receives this machine's analytics and the default only decides which one
is read, and:

> If the two workspaces are on different plans, start a new Codex session for the tools to match.

So if the tool list looks wrong after a switch, start a new Codex session rather than retrying in
this one.

## Tool map

Listed so you know what exists. The instructions you fetch decide when each is called — don't invent a sequence from this table.

With several Beezi builds installed, call every tool below on this plugin's own MCP server — the key follows this skill's plugin name (`beezi` → `beezi`, `beezi-staging` → `beezi_staging`); see "Use this plugin's own server" in the `login` skill. Another build's server reads another environment's analytics.

| Tool | Purpose |
| --- | --- |
| `get_analytics_instructions` | The summary workflow, template and rendering rules. Call first. |
| `get_my_usage_summary` | The user's own usage for the chosen period. Always self-scoped. |
| `beezi_status` | Whether this machine is linked and whether analytics are actually being reported |

## When something fails

Stop and tell the user. Do not retry blindly, and **do not fall back to computing a summary yourself** — there is no local source for these numbers, and a plausible-looking invented one is worse than no answer.

**Only `beezi_login` and `beezi_status` are available.** Those two are served by the plugin itself and are always listed, so seeing them *alone* means the server had no account to read analytics from — which is not the same as "nothing is linked". Run `node "<plugin-root>/scripts/accounts.mjs" list` first: it names every linked account and marks the default, or says there is none, and that is what decides the fix. When nothing is linked, call `beezi_login` and retry in the same session — the server picks up the new credentials without a restart and re-advertises its tools. When accounts are listed but no default is marked, choose one with the settings skill (Account → Default account). When a default *is* marked and the tools are still not served, call `beezi_status` and relay its answer: with a default set it reports on that account, and it is also what tells you Beezi is mid-recovery on this machine — which serves the same two tools and is not a credentials problem at all.

**No `beezi` tools at all, not even `beezi_login`.** The MCP server isn't connected: ask the user to confirm `codex plugin list` shows `beezi` and to start a new Codex thread.

**Still only those two after signing in, or `get_analytics_instructions` is missing on a linked machine.** Personal analytics are not enabled for this Beezi deployment; only their Beezi admin can turn it on.

**Authentication error.** Reply exactly: `Sign in to Beezi first.`

**Anything else.** Report the message, plus the `correlationId` if the result carries one, and stop.
