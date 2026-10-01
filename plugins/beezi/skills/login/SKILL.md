---
name: login
description: Link this machine to Beezi, or refresh the captured ChatGPT plan. Use when the user wants to log in / sign in / connect to Beezi, switch Beezi accounts, or when a Beezi tool reports that the machine is not linked. For "am I linked?" use the `me` skill; to sign out use the `logout` skill.
---

# Beezi: login

## Finding the scripts

This file is at `<plugin-root>/skills/login/SKILL.md`, so every script below is at
`<plugin-root>/scripts/` — use the absolute path.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

## Logging in

Logging in is five steps, in order. Step 1 links an account; steps 2 and 3 record which ChatGPT
plan pays for this machine; step 4 uploads the machine's past Codex sessions; step 5 asks about the
analytics default. **Do not stop after step 1** — a linked machine with no plan reports its usage
with no plan attached, which is the single most common thing users report as "my analytics look
wrong". **Step 4 comes last of the uploading steps and only after the plan is settled**: settled
means step 2 hit its stop list, or the user answered step 3's question (or explicitly dismissed
it). Jumping to step 4 with the plan question still open is the other way machines end up with no
plan — the backfill output reads like a finished login, so nothing ever comes back to ask.

**Several Beezi accounts can be linked at once**, and every step after the first is about ONE of
them. Step 1 names which, on its last line, as `account=<key>` — an 8-character key. Carry that key
through steps 2 to 5 as `--account <key>`. If step 1 printed no such line, match its output against
the outcome list below before doing anything else: two of those outcomes mean the sign-in is still
running, not that it failed.

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

**The browser decides which account signs in.** It signs in as whichever Beezi account it is
already signed in as; to add a different one the user signs out of Beezi in the browser first, or
uses a private window. The output says so before it opens, and names the accounts already linked.

Report the result verbatim, then read it. There are five outcomes; only the first lets the rest of
this flow run, and each is named by a sentence the output actually carries:

- `account=<key>` on the last line — an account was linked, re-linked, or was already linked. Use
  that key for every step below.
- **`The sign-in is still running here`** — only the `beezi_login` tool prints this, and it is
  ordinary rather than exceptional: the tool answers after about 25 seconds, and a real browser
  sign-in routinely takes longer than that. **Nothing has failed.** Relay the text as given,
  including the URL it carries, and wait — do not call the tool again, do not offer to retry, and do
  not run steps 2 to 5 yet. When the user says they have finished in the browser, call
  `beezi_status`; once it reports the machine linked, **get a key before continuing** — this path
  prints none, and step 4 refuses to run without one. Run the `accounts` skill's list: every row
  carries its key in brackets. If more than one row is listed, ask the user which account they
  signed in as rather than guessing — the list marks the default and revoked rows, not which row is
  new. With the key in hand, continue from step 2.
- **`A Beezi sign-in is already in progress`** — only the `beezi_login` tool prints this, and only
  while an earlier call of it is still waiting on the browser. It is a refusal to start a SECOND
  sign-in, not a failed one: the first is still live. Relay the text as given and wait, exactly as
  for the outcome above — do not call the tool again and do not run steps 2 to 5 yet. When the user
  says they have finished in the browser, pick the key up the same way, from the `accounts` skill's
  list.
- **`Workspace <name> is already linked as <email>`** — the sign-in was refused because that
  workspace already has a different account linked on this machine. Relay the message and stop; the
  rest of the flow has nothing to run against. Logging that account out first is the `logout` skill.
- **Anything else, with no `account=` line** — the sign-in failed. The script prints `✗ <reason>`;
  the tool prints `Beezi sign-in failed: <reason>`. The commonest cause is the plainest: the browser
  tab was never finished and the wait timed out. It can also be an unreachable server, a locked
  keyring, or a pending environment migration. **Relay that line verbatim and do not diagnose it** —
  in particular say nothing about workspaces, other accounts, or logging out. Offer to run step 1
  again. Do not run steps 2 to 5.

If the output ends with steps for installing analytics hooks, repeat them — logging in alone does
not start reporting analytics. The `analytics-hooks` skill covers that.

### Step 2 — capture the ChatGPT plan

Run this after step 1 succeeded, **including when step 1 said the machine was already linked** (the
user's tier may have changed), and **including when step 1 used the `beezi_login` tool** — that tool
links the machine but never reads the plan.

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via login --account <key>
```

The plan itself is the MACHINE's — one Codex install, one subscription paying for it — so the
questions below do not change with the number of linked accounts. `--account` only says which
account's Beezi row to tell about it.

It asks Codex itself which account it is signed in as (a short-lived `codex app-server` child
process), and falls back to the plan label in `~/.codex/auth.json`. It may take a few seconds the
first time. No token is read and none leaves the machine — only the plan label, the account id and
the address. When a plan is captured the line ends with `via=app-server` or `via=auth-json`, naming
which one answered; the other outcomes below print their own message instead.
Report its one-line output verbatim, then decide:

**Stop here** — the plan is settled, say so and finish — when the output either

- names a real plan (`plan=free`, `plan=plus`, `plan=pro_5x`, `plan=pro_20x`, `plan=go`,
  `plan=team`, `plan=business`, `plan=enterprise`, `plan=edu`), or
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
print the list below as plain text, ask, and then **stop and wait for the user's reply** — end the
turn with the question as the last thing said. Do not guess a tier, do not run the capture command
in the same turn, and **do not run step 4 in the same turn either** — an unanswered question
followed by backfill output is how this step gets silently skipped. Both the capture and step 4
happen on the next turn, once the user has answered.

> How does this machine pay for Codex?
>
> 1. ChatGPT Free
> 2. ChatGPT Plus
> 3. ChatGPT Pro — $100/mo (5× Plus usage)
> 4. ChatGPT Pro — $200/mo (20× Plus usage)
> 5. ChatGPT Go
> 6. ChatGPT Team
> 7. ChatGPT Business
> 8. ChatGPT Enterprise
> 9. ChatGPT Edu
> 10. I use an OpenAI API key (no ChatGPT subscription)

The Free and API-key options matter. Without Free, a user on the free tier is forced to claim a paid
plan or answer nothing; without the API-key option, a machine paying per token gets pinned to a
subscription tier it does not have, and its spend is then reported under that plan.

**The two Pro rows are not a duplicate.** Since the 2026-04-09 split OpenAI sells two plans both
named "Pro" — $100/mo and $200/mo — so the price is the only thing that tells them apart, and it is
the number the user can check against their own billing page. Ask which one rather than assuming;
recording the wrong one doubles or halves every spend figure reported for this machine.

Map the answer through this table — no other values are valid:

| Answer                                 | value        |
| -------------------------------------- | ------------ |
| ChatGPT Free                           | `free`       |
| ChatGPT Plus                           | `plus`       |
| ChatGPT Pro — $100/mo (5× Plus usage)  | `pro_5x`     |
| ChatGPT Pro — $200/mo (20× Plus usage) | `pro_20x`    |
| ChatGPT Go                             | `go`         |
| ChatGPT Team                           | `team`       |
| ChatGPT Business                       | `business`   |
| ChatGPT Enterprise                     | `enterprise` |
| ChatGPT Edu                            | `edu`        |
| I use an API key                       | `api_key`    |

Then run exactly this, substituting only `<value>`:

```
node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user --account <key>
```

Report its one-line output. If the user dismisses the question or answers something not in the
table, skip the capture — the link itself already succeeded, say that and continue to step 4.

### Step 4 — upload past sessions

Run this only once the plan is settled (step 2 stopped, or step 3 was answered or dismissed) —
never while step 3's question is still waiting for a reply. With that condition met, it runs on
every login outcome: fresh links, accounts that were already linked, **and when step 1 used the
`beezi_login` MCP tool** — that tool links the account but never uploads history, so this step is
still yours to run.

```
node "<plugin-root>/scripts/backfill.mjs" --via login --account <key>
```

It is the one-time upload of this machine's past Codex sessions into Beezi and can take several
minutes; it prints progress lines as it goes. It covers the **last 30 days only** — older sessions
are out of scope for this import and for the `sync` skill alike, and no later run reaches them. Report its output verbatim — progress and final
summary, or the error line. It is safe on every login: already-uploaded sessions are skipped, and
if it says nothing new to upload, tell the user their history is up to date. If some sessions could
not be delivered, tell the user that running this login skill again later resumes the upload where
it left off. Never echo any token.

If it reports the one-time import **has already been used**, that is final for THAT account — the
import is once per Beezi account and tool and cannot be re-run. Do NOT retry, do NOT run the script
again with different flags, and refuse politely if the user asks you to bypass it; relay the
script's message (including the upgrade suggestion when it prints one) and stop. A different Beezi
account linked on this machine has its own untouched import, so this message is never a reason to
skip step 4 for an account that has just been linked.

Only when it reports the pull *finalized*, tell the user: the pull is one-time per Beezi account and
tool — if they have Codex history on other machines, they should sign in to Beezi there BEFORE it
finalizes; a finalized pull cannot be re-opened.

### Step 5 — offer to make this the analytics default

Only when step 1's output said the analytics skill still reads from a different account. Logging in
never switches the default by itself, because a second workspace signing in must not silently take
over the analytics the user was reading.

Ask once — "Make `<name>` (`<workspace>`) the account the analytics skill reads from?" — using the
name and workspace step 1 printed. On yes:

```
node "<plugin-root>/scripts/accounts.mjs" use <key>
```

Report its output in full — what analytics now read from, a note about starting a new Codex session
if the workspaces are on different plans, and the reminder that every linked account still receives
this machine's analytics. Relay whatever it prints rather than counting lines; the `accounts` skill
is the authority on its output. On no, say nothing further; the `accounts` skill can change it
later.

## Logging out

That is the `logout` skill. Do not run `logout.mjs` from here — signing out has its own outcomes to
relay, and it is not what someone asking to "switch accounts" usually wants: logging in again
re-links this machine without unlinking it first.

## Refreshing the captured plan

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via refresh
```

Re-reads the ChatGPT plan tier: it asks Codex itself first (a short-lived `codex app-server` child
process, which may take a few seconds), then falls back to `~/.codex/auth.json`. Only the plan
label, the account id and the address are read and stored — no token leaves the machine. Report its
one-line output verbatim.

If it cannot name a plan, do not stop there: fall through to **step 3** of the login flow above and
ask the user their tier. Telling them "your subscription info was not found" and leaving it is what
strands a machine with no plan indefinitely — and for an Enterprise or Edu account, whose tier is
often absent, asking is the only way it will ever be recorded.

**One case has a better fix than asking.** If Beezi reported that the user's *Codex sign-in expired*
on some date, the plan cannot be read because the stored ChatGPT token is stale — not because the
plan is unknowable. Tell them to sign in to Codex again (`codex login`); the plan is then picked up
automatically on their next session with nothing more to answer. Offer step 3 only as the fallback
if they would rather not, or if signing in again does not clear it.

Note that session start now captures the plan by itself whenever it can, so reaching this command at
all usually means neither Codex nor `auth.json` named one and the answer has to come from the user.

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
