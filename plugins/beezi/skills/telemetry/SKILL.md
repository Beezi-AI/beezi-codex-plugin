---
name: telemetry
description: Turn Beezi plugin crash reporting on or off for this machine, or check the current setting. Use when the user asks about crash reports, error reporting, diagnostics or telemetry for the Beezi plugin, wants to opt in or opt out, or asks what Beezi sends when it breaks.
---

# Beezi: crash reporting

Crash reporting is **off by default** and stays off until the user says otherwise. It covers
failures *inside the Beezi plugin itself* — every Beezi hook swallows its own errors, so when the
plugin breaks, nothing anywhere records it. It has nothing to do with the session analytics the
plugin is for: those are unaffected by this setting, in either direction.

This works on a machine that is **not linked**. Consent to crash reporting must never require
signing in first, so do not send the user through the `login` skill to answer it.

## Running it

This file is at `<plugin-root>/skills/telemetry/SKILL.md`, so the script sits beside it at
`<plugin-root>/skills/telemetry/telemetry.mjs`:

```
node "<plugin-root>/skills/telemetry/telemetry.mjs"
```

That reports the current setting and never changes the answer. (The very first time, it also
records that the question was *put* — which is not an answer, and is what stops the user being
asked the same thing every session.) To change the answer, pass exactly one argument:

```
node "<plugin-root>/skills/telemetry/telemetry.mjs" on
node "<plugin-root>/skills/telemetry/telemetry.mjs" off
```

Report the output verbatim, and never edit the stored answer by hand.

**Only run `on` or `off` when the user has actually said which one they want.** A request to
"check", "show", or "what is this" is the no-argument form. Consent is the user's to give: never
infer it from enthusiasm, never turn it on as a favour because it would help debugging, and never
turn it off pre-emptively either — the no-argument form is always the safe answer to an ambiguous
question.

## What the output means

- **is OFF — the default. This machine has not been asked before** — the user is being asked the
  question for the first time. Relay the whole message; it contains the question and what a report
  contains. Then stop and let them answer. Merely showing it is recorded as *asked*, which is not
  consent — it stays off, nothing is recorded, and they will not be asked again.
- **is OFF — the default. You were asked on `<date>` and have not answered** — the question was
  already put and never answered. That is a complete, valid state: it is off, nothing has been
  recorded and nothing sent. Do not re-ask; say what the setting is and offer both directions once.
- **is OFF — you turned it off on `<date>`** — a deliberate no. Do not re-offer it. Answer what the
  setting is if asked, and leave it there.
- **is ON (turned on `<date>`)** — reporting. Mention that `off` also deletes whatever is still held
  on the machine.
- **is now ON** / **is now OFF** — the change was saved.
- **Could not save the choice** — the answer did not reach disk. On the `on` path nothing changed
  and the machine is still off. On the `off` path everything held locally was deleted anyway, but
  the machine may still be on, so this one is worth escalating: the Beezi home directory is not
  writable.

## What is collected, if the user asks

**The command's own output is the answer — relay it rather than composing one from memory, and do
not read the plugin's source.** The no-argument form prints the full list whenever it puts the
question for the first time, and whenever reporting is already ON.

In the two states that do not print it — turned off, or asked and never answered — say only this: a
report is structured fields only, and it cannot carry code, prompts, file contents, paths outside
the plugin, repository or branch names, error messages, stack text or credentials. That is not a
filter that strips them; the record has no field that could hold them.

## The default, and what "never answering" means

If the user never answers, the setting stays **off**: nothing is recorded, nothing is queued, and
nothing is sent. The gate is checked before a report is even composed, so a later `on` reports only
what happens *after* it — turning it on never ships anything gathered beforehand.

Turning it **off** deletes every report still held on the machine, so a period of reporting cannot
be re-opened later.

The answer is stored on this machine only, at the root of the Beezi home directory, and is not part
of the session data the plugin uploads.
