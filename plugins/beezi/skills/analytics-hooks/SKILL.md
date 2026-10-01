---
name: analytics-hooks
description: Install, repair, remove, or check Beezi's Codex analytics hooks. Use when the user wants to start (or stop) reporting per-branch token analytics to Beezi, asks why their Beezi analytics are empty, or after a Beezi plugin upgrade.
---

# Beezi: analytics hooks

Codex does not load hooks bundled inside a plugin (`plugin_hooks` is `removed`), so Beezi's
lifecycle hooks are written into the user-level registry `~/.codex/hooks.json` by the script below.
This file is at `<plugin-root>/skills/analytics-hooks/SKILL.md`, so the script is at
`<plugin-root>/scripts/hooks.mjs` — use the absolute path.

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
the MCP server, `login` and `me` all do so on their own.

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
the other half — see the `me` and `login` skills.

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
