---
name: track
description: Save Beezi analytics for the current git branch right now, without waiting for a lifecycle hook. Use when the user asks to track, checkpoint, sync, or push this session's token usage to Beezi, or wants analytics captured for work they just finished.
---

# Beezi: track this branch

Checkpoints the current session's token usage and attributes it to the current repository and
branch. This drives the same engine the lifecycle hooks use, so it works whether or not the hooks
are installed and trusted. Work outside a git repo is tracked too, under the folder's name.

## Running it

This file is at `<plugin-root>/skills/track/SKILL.md`, so the script is at
`<plugin-root>/scripts/track.mjs`. Run it from the repository the user is working in — the current
working directory is how it finds the repo, the branch, and this session's transcript:

```
node "<plugin-root>/scripts/track.mjs"
```

Do not read, open, or inspect any other files. Report the output verbatim — the success line, or
the error if the repo or branch does not qualify. Never echo a token.

## What the output means

- **saved** — segments were queued and sent. The count is segments, not tokens.
- **nothing new to save** — everything up to this point was already reported. Not an error; do not
  re-run hoping for a different answer.
- **saved for `<folder name>`** — the work was outside any git repo, or in a repo with no `origin`
  remote. It is still tracked, attributed to a `local:<folder>` stand-in remote rather than skipped;
  only the folder name is sent, never the path around it. Nothing to fix.
- **not linked** — run the `login` skill first.
- **could not find this session's transcript** — Codex writes one rollout per session under
  `~/.codex/sessions/`; a brand-new session with no activity yet has nothing to checkpoint.

## When to suggest the hooks instead

If the user is running this repeatedly, point them at the `analytics-hooks` skill: with hooks
installed and trusted, checkpoints happen automatically at every turn end and around git commits,
and this manual step stops being necessary.
