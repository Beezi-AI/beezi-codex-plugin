---
name: analytics-hooks
description: Install, repair, remove, or check Beezi's Codex analytics hooks. Use when the user wants to start (or stop) reporting per-branch token analytics to Beezi, asks why their Beezi analytics are empty, or after a Beezi plugin upgrade.
---

# Beezi: analytics hooks

Codex does not load hooks bundled inside a plugin — its `plugin_hooks` feature is `removed`, so an
installed plugin contributes nothing to the hook engine. Beezi's lifecycle hooks are therefore
written into the user-level registry `~/.codex/hooks.json` by the script below, and **must then be
trusted once by the user**.

## Finding the script

This file is at `<plugin-root>/skills/analytics-hooks/SKILL.md`, so the script is at
`<plugin-root>/scripts/hooks.mjs`. Use the absolute path. Run exactly one command per request; do
not read or inspect any other files.

## Commands

| The user wants | Do |
| --- | --- |
| to know the current state, or asks why analytics are empty | call the **`beezi_status` tool** |
| to start reporting, or to repair a broken/stale install | `node "<plugin-root>/scripts/hooks.mjs" install` |
| to stop reporting | `node "<plugin-root>/scripts/hooks.mjs" uninstall` |

Prefer `beezi_status` for any read-only question: it reports the hook state *and* the link state,
and answering "why is nothing tracked?" needs both. `node "<plugin-root>/scripts/hooks.mjs" status`
gives the hook half only, and exists for terminal use.

If the request is ambiguous, check status first — it changes nothing.

## After installing: the trust step

`install` only writes the registry. **Codex will not run a hook it has not been shown**, so tell the
user, clearly and every time:

> Run `/hooks` in Codex, review the three Beezi entries, and trust them.

There is no non-interactive way to grant that trust — do not try to bypass it, and do not claim
analytics are working until the user confirms they have done it. Trust is recorded against each
hook's **hash**, so this has to be repeated after any change to the hooks, including a plugin
upgrade.

## Reading the status output

- **installed** — registry and launchers agree. If analytics still are not arriving, the likely
  cause is the missing trust step above, or that the machine is not linked (see the `me` and
  `login` skills).
- **absent** — nothing installed yet. Run `install`.
- **stale** — a plugin upgrade moved the scripts and the launchers still point at the old version.
  Run `install`, then re-trust via `/hooks`.
- **partial** — an incomplete install. Run `install`.

## Scope of what is written

`install` writes `~/.codex/hooks.json` and launcher scripts under `~/.beezi-codex/hooks/`. It **merges**:
any hooks the user configured themselves keep their place and content. `uninstall` removes only
Beezi's entries, and deletes the registry file only if Beezi's entries were the only thing in it.
Report this if the user is worried about their own hooks.

## Reporting without hooks

If the user does not want to install hooks, analytics can still be captured on demand — the `track`
skill checkpoints the current branch and needs no hooks at all.
