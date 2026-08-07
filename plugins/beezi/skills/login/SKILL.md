---
name: login
description: Link this machine to Beezi, unlink it, or refresh the captured ChatGPT plan. Use when the user wants to log in / sign in / connect to Beezi, log out, or when a Beezi tool reports that the machine is not linked. For "am I linked?" use the `me` skill instead.
---

# Beezi: login

## Finding the scripts

Every command below runs a script under the plugin's `scripts/` directory. That directory is two
levels above this `SKILL.md` — this file is at `<plugin-root>/skills/login/SKILL.md`, so the
scripts are at `<plugin-root>/scripts/`. Use the absolute path; `codex plugin list` also prints the
plugin root for `beezi` if you need to confirm it.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

## Logging in

Logging in is three steps. Step 1 links the machine; steps 2 and 3 record which ChatGPT plan pays
for it. **Do not stop after step 1** — a linked machine with no plan reports its usage with no plan
attached, which is the single most common thing users report as "my analytics look wrong".

### Step 1 — sign in

**Prefer the MCP tool.** If a `beezi_login` tool is available, call it — it runs the same browser
sign-in inside the already-running Beezi server, and the Beezi tools become available immediately
afterwards without restarting the session. Takes no arguments.

If that tool is not available, run:

```
node "<plugin-root>/scripts/login.mjs"
```

Either way a browser window opens for the user to sign in with their Beezi account. If the browser
does not open, the output contains the URL — pass it to the user verbatim. The flow blocks until
they finish or it times out; say so rather than assuming it failed.

Report the result verbatim. If the output ends with steps for installing analytics hooks, repeat
them — logging in alone does not start reporting analytics. The `analytics-hooks` skill covers that.

### Step 2 — capture the ChatGPT plan

Run this after step 1 succeeded, **including when step 1 said the machine was already linked** (the
user's tier may have changed), and **including when step 1 used the `beezi_login` tool** — that tool
links the machine but never reads the plan.

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via login
```

It reads only the plan label from `~/.codex/auth.json`. No token is read and none leaves the machine.
Report its one-line output verbatim, then decide:

**Stop here** — the plan is settled, say so and finish — when the output either

- names a real plan (`plan=plus`, `plan=pro`, `plan=go`, `plan=team`, `plan=business`,
  `plan=enterprise`, `plan=edu`), or
- shows `source=openai_api_key` or `source=third_party`. Those machines do not bill a ChatGPT
  subscription, so a tier question does not apply to them.

**If it says the Codex sign-in expired**, that has a cheaper fix than step 3: the stored ChatGPT
token is stale, not the plan unknowable. Tell the user to run `codex login` again — the plan is then
picked up automatically on their next session. Offer step 3 only if they would rather not, or if
signing in again does not clear it.

**Otherwise go to step 3.** That covers every other output, including `nothing captured`,
`keeping the self-reported plan`, `plan=unknown`, `plan=n/a`, and `source=unknown`. Treat this as
"anything not on the stop list" rather than matching a fixed list of failures — a machine whose
output you do not recognise is exactly the machine that needs asking.

### Step 3 — ask the user their tier

If an `AskUserQuestion` tool is available, use it. **Codex normally has no such tool.** In that case
print the list below as plain text, ask, and then **stop and wait for the user's reply**. Do not
guess a tier, and do not run the capture command in the same turn — run it on the next turn, once
they have answered.

> How does this machine pay for Codex?
>
> 1. ChatGPT Plus
> 2. ChatGPT Pro
> 3. ChatGPT Go
> 4. ChatGPT Team
> 5. ChatGPT Business
> 6. ChatGPT Enterprise
> 7. ChatGPT Edu
> 8. I use an OpenAI API key (no ChatGPT subscription)

Option 8 matters. Without it, a machine paying per token gets pinned to a subscription tier it does
not have, and its spend is then reported under that plan.

Map the answer through this table — no other values are valid:

| Answer               | value        |
| -------------------- | ------------ |
| ChatGPT Plus         | `plus`       |
| ChatGPT Pro          | `pro`        |
| ChatGPT Go           | `go`         |
| ChatGPT Team         | `team`       |
| ChatGPT Business     | `business`   |
| ChatGPT Enterprise   | `enterprise` |
| ChatGPT Edu          | `edu`        |
| I use an API key     | `api_key`    |

Then run exactly this, substituting only `<value>`:

```
node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user
```

Report its one-line output. If the user dismisses the question or answers something not in the
table, skip the capture — the link itself already succeeded, so say that and stop.

## Logging out

```
node "<plugin-root>/scripts/logout.mjs"
```

Unlinks this machine. Confirm with the user first — it is not what someone asking to "switch
accounts" usually wants; logging in again re-links without needing this.

## Refreshing the captured plan

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via refresh
```

Re-reads the ChatGPT plan tier from `~/.codex/auth.json`. Only the plan label is read and stored —
no token leaves the machine. Report its one-line output verbatim.

If it cannot name a plan, do not stop there: fall through to **step 3** of the login flow above and
ask the user their tier. Telling them "your subscription info was not found" and leaving it is what
strands a machine with no plan indefinitely — and for an Enterprise or Edu account, whose tier is
often absent from `auth.json`, asking is the only way it will ever be recorded.

**One case has a better fix than asking.** If Beezi reported that the user's *Codex sign-in expired*
on some date, the plan cannot be read because the stored ChatGPT token is stale — not because the
plan is unknowable. Tell them to sign in to Codex again (`codex login`); the plan is then picked up
automatically on their next session with nothing more to answer. Offer step 3 only as the fallback
if they would rather not, or if signing in again does not clear it.

Note that session start now captures the plan by itself whenever it can, so reaching this command at
all usually means `auth.json` does not name one and the answer has to come from the user.

## Checking the link

That is the `me` skill. It answers through the `beezi_status` tool, which runs in the process that
actually holds the credentials — do not answer "am I linked?" from a script here.

## When something fails

**"not linked" persists after logging in.** The credentials are stored per machine in the OS
keyring, falling back to `~/.beezi-codex/credentials.json` (or `$BEEZI_CODEX_HOME`). If the user is
running Codex with a different `BEEZI_CODEX_HOME`, they are two different machines as far as Beezi
is concerned. `~/.beezi` is the Claude Code plugin's directory and is never read by this plugin —
a link there does not carry over.

**The browser never opens.** Not fatal — the output carries the authorize URL. Give it to the user.

**Network or server errors.** Report them as given. Do not retry a login in a loop; each attempt
opens another browser window.
