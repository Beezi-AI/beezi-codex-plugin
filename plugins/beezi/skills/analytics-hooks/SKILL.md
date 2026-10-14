---
name: analytics-hooks
description: Install, repair, remove, or check Beezi's Codex analytics hooks. Use when the user wants to start (or stop) reporting per-branch token analytics to Beezi, asks why their Beezi analytics are empty, or after a Beezi plugin upgrade.
---

# Beezi: analytics hooks

Codex does not load hooks bundled inside a plugin (`plugin_hooks` is `removed`), so Beezi's
lifecycle hooks are written into the user-level registry `~/.codex/hooks.json` by the script below.
This file is at `<plugin-root>/skills/analytics-hooks/SKILL.md`, so the script is at
`<plugin-root>/scripts/hooks.mjs` — use the absolute path.

With several Beezi builds installed, call `beezi_status` on this plugin's own MCP server — the key follows this skill's plugin name (`beezi` → `beezi`, `beezi-staging` → `beezi_staging`); see "Use this plugin's own server" in the `login` skill.

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

**Never hand the user a hooks command to run.** Installing, repairing and clearing out entries left
by an old version are all things you do for them.

| The user wants | Do |
| --- | --- |
| to start reporting, or to repair anything | `node "<plugin-root>/scripts/hooks.mjs" install` |
| to know the current state, or asks why analytics are empty | call the **`beezi_status` tool** |
| to stop reporting | `node "<plugin-root>/scripts/hooks.mjs" uninstall` |

`install` is the answer to every broken state — **absent**, an **out-of-date launcher**, **partial**,
or a registry full of dead entries from a variant that is no longer installed. It removes this variant's old
entries and any Beezi entry whose script file is gone, then writes the current ones. It **changes
nothing when the install is already healthy**: Codex keys hook trust to each entry's hash, so a
pointless rewrite would revoke trust the user already granted. Use `install --force` only if they
ask for a rewrite. If `beezi_status` reports anything other than healthy, run `install` straight
away rather than reporting the problem back and waiting for permission.

Entries do not carry a plugin version: they run a launcher at a fixed path
(`~/.beezi-codex[-<env>]/hooks/beezi-hook.mjs`) which picks up the newest installed version itself,
so an upgrade needs no repair and no re-trust. `install` still refreshes that launcher's copy, and
the MCP server, the `login` skill and the `settings` skill's screen all do so on their own.

**The one step that is still theirs.** When an install or repair actually wrote something, say this
once:

> Run `/hooks` in Codex, review the Beezi entries, and trust them.

There is no non-interactive way to grant trust — do not try to bypass it, and do not claim analytics
are working until the user confirms. Trust is hash-keyed, so it must be repeated whenever an entry
actually changes — which an upgrade no longer does. One case remains: a machine whose entries still
carry an older version's script paths has them rewritten to the launcher form the first time this
version installs, and that rewrite does need trust granted once more. When `install` reports nothing
changed, existing trust is intact: do not send
them to `/hooks` for no reason, mention it only if analytics still are not arriving. Being linked is
the other half — the `beezi_status` tool (or the `settings` skill) says whether it is, and the
`login` skill links it.

There is one entry per lifecycle event: `SessionStart`, `PostToolUse`, `Stop`, `SubagentStart`,
`SubagentStop`. `install` and `status` both print the list back, so check `/hooks` against what the
script named rather than against a count. The two subagent hooks only record which agent ran and
when — a subagent's *usage* is billed by the parent session's checkpoint, so trusting only some
entries still reports subagent tokens and loses only the agent's name and its span on the timeline.

`install` writes `~/.codex/hooks.json` only, and **merges**: hooks the user configured themselves
and a working sibling variant's entries are left alone, and only dead ones are swept. `uninstall`
removes this variant's entries, deleting the file only if they were all it held. Report that if the
user is worried about their own hooks.

If the user does not want hooks at all, the `track` skill checkpoints the current branch on demand
and needs none.
