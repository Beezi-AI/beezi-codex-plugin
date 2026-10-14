---
name: login
description: Link this machine to Beezi (browser sign-in) and set up where the new account's analytics go. Use when the user wants to log in / sign in / connect to Beezi, add or switch Beezi accounts, or when a Beezi tool reports that the machine is not linked. For "am I linked?", the default account or refreshing the ChatGPT plan use the `settings` skill; to sign out use the `logout` skill.
---

# Beezi: login

## Finding the scripts

This file is at `<plugin-root>/skills/login/SKILL.md`, so every script below is at
`<plugin-root>/scripts/` — use the absolute path.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

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

## Logging in

Logging in is these steps, in order. Step 1 links an account; step 1w says where its analytics go
when it is in several workspaces; steps 2 and 3 record which ChatGPT plan pays for this machine;
step 4 asks about new workspaces and repos and folders with no rule, and then uploads the machine's past Codex sessions;
step 5 asks about the analytics default. **Do not stop after step 1** — a linked machine with no
plan reports its usage with no plan attached, which is the single most common thing users report as
"my analytics look wrong". **Step 4 comes last of the uploading steps and only after the plan is
settled**: settled means step 2 named a real plan or an API-key/third-party billing source, or the user answered step 3's question (or
explicitly dismissed it). Jumping to step 4 with the plan question still open is the other way
machines end up with no plan — the backfill output reads like a finished login, so nothing ever
comes back to ask.

**Asking.** A question below uses `request_user_input` only when that tool is listed this turn and
the question has 2–3 choices. Otherwise it is one plain sentence naming every choice — never a
numbered list or a bullet menu — that ends your reply. Ask one question at a time. When the answer
arrives, run that step's command and continue from the next step: never start over from step 1, and
never run a later step while a question is still open. A skipped question runs nothing.
If a workspace command fails, relay its error verbatim and stop; do not proceed as if a routing
choice was saved.

**Several Beezi accounts can be linked at once**, and every step after the first is about ONE of
them. Step 1 names which, on its last line, as `account=<key>` — an 8-character key. Carry that key
through steps 1w to 5 as `--account <key>`. Pass no `--tenant` anywhere: each step picks its
workspaces itself, and step 4 routes each past session by its own repo or folder. If step 1 printed
no such line, match its output against the outcome list below before doing anything else: two of
those outcomes mean the sign-in is still running, not that it failed.

### Step 1 — sign in

**Prefer the MCP tool.** If a `beezi_login` tool is available, call it — it runs the same browser
sign-in inside the already-running Beezi server, and the Beezi tools become available immediately
afterwards without restarting the session. Takes no arguments.

**Use this plugin's own server.** Each Beezi build has its own MCP server, and every one of them
offers a `beezi_login`, so with production and a variant installed together there are two. The
server key follows the plugin name in this skill's own name: `beezi:login` uses server `beezi`,
`beezi-staging:login` uses `beezi_staging`, `beezi-dev:login` `beezi_dev`, `beezi-local:login`
`beezi_local`. Call the `beezi_login` on that server and no other — the other one signs in to a
different environment. If this plugin's server offers no `beezi_login`, use the script below.

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

Report the result verbatim, then read it. There are four outcomes; only the first lets the rest of
this flow run, and each is named by a sentence the output actually carries:

- `account=<key>` on the last line — an account was linked, re-linked, or was already linked. Use
  that key for every step below.
- **`The sign-in is still running here`** — only the `beezi_login` tool prints this, and it is
  ordinary rather than exceptional: the tool answers after about 25 seconds, and a real browser
  sign-in routinely takes longer than that. **Nothing has failed.** Relay the text as given,
  including the URL it carries, and wait — do not call the tool again, do not offer to retry, and do
  not run the later steps yet. When the user says they have finished in the browser, call
  `beezi_status`; once it reports the machine linked, **get a key before continuing** — this path
  prints none, and step 4 refuses to run without one. Run
  `node "<plugin-root>/scripts/accounts.mjs" list`: every row carries its key in brackets. If more
  than one row is listed, ask the user which account they signed in as rather than guessing — the
  list marks the default and revoked rows, not which row is new. With the key in hand, continue from
  step 1w.
- **`A Beezi sign-in is already in progress`** — only the `beezi_login` tool prints this, and only
  while an earlier call of it is still waiting on the browser. It is a refusal to start a SECOND
  sign-in, not a failed one: the first is still live. Relay the text as given and wait, exactly as
  for the outcome above — do not call the tool again and do not run the later steps yet. When the
  user says they have finished in the browser, pick the key up the same way, from `accounts.mjs list`.
- **Anything else, with no `account=` line** — the sign-in failed. The script prints `✗ <reason>`;
  the tool prints `Beezi sign-in failed: <reason>`. The commonest cause is the plainest: the browser
  tab was never finished and the wait timed out. It can also be an unreachable server, a locked
  keyring, or a pending environment migration. **Relay that line verbatim and do not diagnose it** —
  in particular say nothing about workspaces, other accounts, or logging out. Offer to run step 1
  again. Do not run the later steps.

If the output ends with steps for installing analytics hooks, repeat them — logging in alone does
not start reporting analytics. The `analytics-hooks` skill covers that.

### Step 1w — where this account's analytics go

Run this after step 1 produced a key — a fresh link or an account that was already linked:

```
node "<plugin-root>/scripts/workspace.mjs" new-folders --account <key> --defer-upload
```

Its output is for you only. Its last line is
`new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>` for an account in several
workspaces, or `new-folders=n/a multi=no account=<key>` for one in a single workspace (or whose
workspaces are not known yet) — then say nothing about it and go to step 2. The lines before it
include one `W. <workspace> account=<key> tenant=<id> role=<role>` line per workspace.

Ask only when the last line contains both `multi=yes` and `set=no` (their order does not matter):
"Where should analytics go for repos and
folders with no rule yet?" with the choices "Ask me (recommended)" (described "Beezi asks once per
repo or folder, when a session starts there"), "Send to…" ("Pick the workspaces that get them") and
"Don't send" ("Nothing from a repo or folder with no rule is uploaded").

- "Ask me (recommended)" → run `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key> --defer-upload`
- "Don't send" → run `node "<plugin-root>/scripts/workspace.mjs" new-folders none --account <key> --defer-upload`
- "Send to…" → ask "Which workspaces should get analytics for repos and folders with no rule?", one
  choice per `W.` line — the workspace name (the text after `W. ` up to ` account=`), described by
  the line's `role=` value — several allowed: `request_user_input` only with at most 3 `W.` lines,
  the question followed by " Pick one, or name several under Other."; otherwise the plain sentence,
  each workspace as "<name> (<role>)", ending " — one or more?". Nothing chosen → run nothing.
  Otherwise run, with the chosen lines' `tenant=` values joined by commas:

  ```
  node "<plugin-root>/scripts/workspace.mjs" new-folders send <ids> --account <key> --defer-upload
  ```

Write the command's first line verbatim. A skipped question runs nothing (the next login asks again).

**Then this session's own folder.** A session that started before this account was linked was never
asked where its analytics go, and under Ask me they would wait. Only when the setting is now Ask me —
the last line said `new-folders=ask` and no `new-folders send` or `new-folders none` command
succeeded just now — run (its output is for you only):

```
node "<plugin-root>/scripts/workspace.mjs" rules --account <key>
```

Its `here:` line is `here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none>
kind=<repo|folder|outside> match=<…>` (no ` (<label>)` when `kind=outside`): `<short>` is the text
after `here: ` up to ` (` or ` →`, `<label>` the text in the parentheses (`here: none` → nothing
to ask). Only when it has `rule=none`, ask the workspace question about it — the one step 4a asks about a `P` line, without
the "(i of N) " prefix, with choices from this output's `W.` lines — then run, with `<ids>` = the
chosen `tenant=` values joined by commas, or `none` when the last choice was picked (it wins over the
others):

```
node "<plugin-root>/scripts/workspace.mjs" rule add --current --account <key> --defer-upload <ids>
```

and write its first line verbatim. Nothing chosen or a skipped question runs nothing. Then continue
to step 2.

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

**Skip step 3 and continue to step 4** — the plan is settled — when the output either

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
"anything not on the settled list" rather than matching a fixed list of failures — a machine whose
output you do not recognise is exactly the machine that needs asking.

### Step 3 — ask the user their tier

The tier question has ten choices, so it is always this one plain sentence — never a numbered
list. Ask it as the last thing in your reply and then **stop and wait for the user's reply**. Do not
guess a tier, do not run the capture command in the same turn, and **do not run step 4 in the same
turn either** — an unanswered question followed by backfill output is how this step gets silently
skipped. Both the capture and step 4 happen on the next turn, once the user has answered.

> How does this machine pay for Codex: ChatGPT Free, ChatGPT Plus, ChatGPT Pro — $100/mo (5× Plus
> usage), ChatGPT Pro — $200/mo (20× Plus usage), ChatGPT Go, ChatGPT Team, ChatGPT Business, ChatGPT
> Enterprise, ChatGPT Edu, or an OpenAI API key (no ChatGPT subscription)?

The Free and API-key options matter. Without Free, a user on the free tier is forced to claim a paid
plan or answer nothing; without the API-key option, a machine paying per token gets pinned to a
subscription tier it does not have, and its spend is then reported under that plan.

**The two Pro choices are not a duplicate.** Since the 2026-04-09 split OpenAI sells two plans both
named "Pro" — $100/mo and $200/mo — so the price is the only thing that tells them apart, and it is
the number the user can check against their own billing page. Ask which one rather than assuming;
recording the wrong one doubles or halves every spend figure reported for this machine.

Map the answer through this table — no other values are valid:

| Answer                                      | value        |
| ------------------------------------------- | ------------ |
| ChatGPT Free                                | `free`       |
| ChatGPT Plus                                | `plus`       |
| ChatGPT Pro — $100/mo (5× Plus usage)       | `pro_5x`     |
| ChatGPT Pro — $200/mo (20× Plus usage)      | `pro_20x`    |
| ChatGPT Go                                  | `go`         |
| ChatGPT Team                                | `team`       |
| ChatGPT Business                            | `business`   |
| ChatGPT Enterprise                          | `enterprise` |
| ChatGPT Edu                                 | `edu`        |
| An OpenAI API key (no ChatGPT subscription) | `api_key`    |

Then run exactly this, substituting only `<value>`:

```
node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user --account <key>
```

Report its one-line output. If the user dismisses the question or answers something not in the
table, skip the capture — the link itself already succeeded, say that and continue to step 4.

### Step 4 — upload past sessions

Run this only once the plan is settled (step 2 named a real plan or an API-key/third-party billing
source, or step 3 was answered or dismissed) —
never while step 3's question is still waiting for a reply. That holds for both parts, 4a and then
4b. With that condition met, it runs on every login outcome: fresh links, accounts that were already
linked, **and when step 1 used the `beezi_login` MCP tool** — that tool links the account but never
uploads history, so this step is still yours to run.

#### Step 4a — new workspaces, then repos and folders with no rule

**First, new workspaces.**

```
node "<plugin-root>/scripts/workspace.mjs" joined --account <key> --defer-upload
```

Its output is for you only. For an account that joined a workspace since it was last reviewed on this
machine, it lists every repo and folder with where its analytics go now. Its lines:

- `<email>: you joined <names> — <N> repos or folders to review account=<key> new=<ids>` — starts the
  block; `<names>` names the new workspaces;
- `W. <workspace> account=<key> tenant=<id> new=<yes|no> role=<role>` — one per workspace; `new=yes`
  is one just joined;
- `J<i>. <short> (<full label>), <k> sessions, now: <where> account=<key> kind=<repo|folder> match=<match> now=<ids|none|pending>`
  — one repo or folder (a `J` line). `<where>` is where its analytics go today: workspace names, `not
  tracked`, or `no rule yet`. `J<i>. outside a project, <k> sessions, now: <where> … kind=outside match=outside`
  is one too: sessions in the home folder, `/` or a temp folder;
- `J<i>-command=<command>` — right after its `J` line: the command that adds one workspace to it,
  ending in a literal `<tenant>`. It is not a `J` line;
- `add-all-command=<command>` — adds the new workspaces to every listed repo and folder that already
  sends somewhere;
- `done-command=<command>` — records that the new workspaces were reviewed, and keeps every repo and folder
  the user did not pick sending where it sends now;
- `joined=<total>` — the number of `J` lines, always last.

`joined=0` → nothing to ask; go to "Then, repos and folders with no rule" below.

More than 4 `J` lines → first ask "You joined <names>. Where should analytics for these <N> repos and
folders go? Their past sessions will be sent there too." (`<N>` = the number of `J` lines)
with the choices "Add <names> to all <N>" (described "Repos you don't track, and ones with no rule
yet, stay as they are"), "Choose repos" ("Pick which repos and folders go to each new workspace") and
"Leave them as they are" ("Nothing changes, and you're not asked about <names> again").

- "Add <names> to all <N>" → run the `add-all-command=` text EXACTLY ONCE.
- "Choose repos" → the per-workspace repo picks below.
- "Leave them as they are" → run the `done-command=` text EXACTLY ONCE.
- A skipped question → nothing; the next login or the `sync` skill asks again.

4 or fewer `J` lines → the per-workspace repo picks.

**The per-workspace repo picks** — one question per `new=yes` `W.` line (a workspace just joined), in
turn. Each question offers the `J` lines as its choices and asks which repos and folders
should also send analytics to that one workspace. `<short>` is the `J` line's text after `J<i>. ` up to
` (` or `,`, and `<where>` the text after `now: ` up to ` account=`. The question:

"Which repos and folders should also send analytics to <workspace>? Their past sessions will be sent
there too." — `<workspace>` is the `new=yes` line's name (the text after `W. ` up to ` account=`).

Choices: one per `J` line — its `<short>`, described by its `<where>` ("Now: <where>", e.g. "Now:
Acme" or "Now: no rule yet"). Several repos and folders may be chosen.

- `request_user_input` only with at most 2 `J` lines and at most 3 `new=yes` `W.` lines (so at most 3
  choices and 3 questions): header "Beezi", the question with " Pick one, or name several under Other."
  put before its last sentence, a last choice "None of these" (described "This workspace gets none of
  them"), the labels exactly as above.
- Otherwise the plain sentence: the question up to "<workspace>" (without the sentence after it), a
  colon, the `J` lines as a numbered list "1) <short> (Now: <where>), 2) …", then " — reply with the
  numbers to send, or none —" and " Their past sessions will be sent there too.". For example: "Which
  repos and folders should also send analytics to NewCo: 1) acme-api (Now: Acme), 2) notes (Now: no
  rule yet) — reply with the numbers to send, or none — Their past sessions will be sent there too."

For each repo and folder the user picked for a workspace, run its `J<i>-command=` text EXACTLY ONCE,
changing nothing except the final `<tenant>`: that workspace's `tenant=` value (its `W.` line's
`tenant=`, e.g. `t2`). Map each answered position to the `J` line it listed, then run that line's
own `J<i>-command=` (J numbers are global across accounts and need not start at 1); never rebuild the
command or re-quote its path yourself. A repo the
user did not pick for a workspace runs nothing for that workspace. After the last `new=yes` workspace's
question has been answered (not skipped or dismissed), run the `done-command=` text EXACTLY ONCE;
otherwise run no `done-command`, and the next login or sync asks again.

Write each command's first line verbatim.

**Then, repos and folders with no rule.**

```
node "<plugin-root>/scripts/workspace.mjs" routes --account <key> --defer-upload
```

Its output is for you only, except the one line named below. It lists repos and folders whose past
sessions have no rule yet — only for an account in several workspaces whose New folders setting is
Ask me. Its lines:

- `<email>: <N> repos or folders have past sessions with no rule (<M> sessions) account=<key>`;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace;
- `P<i>. <short> (<full label>), <k> sessions account=<key> kind=<repo|folder> match=<match>` — one
  repo or folder (a `P` line). `P<i>. outside a project, <k> sessions account=<key> kind=outside match=outside`
  is one too: every past session in the home folder, `/` or a temp folder;
- `P<i>-command=<command>` — right after its `P` line: the rule command for it, ending in a literal
  `<tenants>`. It is not a `P` line;
- `all-command=<command>` — the command that gives all of the account's `P` lines the same
  workspaces, ending in a literal `<tenants>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or `1 other past session has
  no recorded folder and is not sent.`) — write this line verbatim, once; there is nothing to ask
  about it;
- `routes=<total>` — the number of `P` lines, always last.

`routes=0` → nothing to ask; go to step 4b.

More than 4 `P` lines → first ask "Where should analytics for these <N> repos and folders go?"
(`<N>` = the number of `P` lines) with the choices "Send all <N> to the same workspaces…" (described
"Pick the workspaces once for all of them"), "Choose per repo" ("One question per repo or folder")
and "Skip" ("Nothing from them is sent this time; you're asked again next time").

- "Send all <N> to the same workspaces…" → ask "Which workspaces should get analytics for these <N>
  repos and folders?", one choice per `W.` line (named and described as below), several allowed —
  `request_user_input` only with at most 3 `W.` lines, the question followed by " Pick one, or name
  several under Other."; otherwise the plain sentence ending " — one or more?". Nothing chosen → run
  nothing. Otherwise run the `all-command=` text EXACTLY ONCE, changing nothing except the final
  `<tenants>`, which becomes the chosen `tenant=` values joined by commas.
- "Choose per repo" → the per-repo questions below.
- "Skip" or a skipped question → nothing more; go to step 4b.

4 or fewer `P` lines → the per-repo questions.

**The per-repo questions** — one question per `P` line, in turn, numbered across the `P` lines (`i`
from 1, `N` = their number). `<short>` is the `P` line's text after `P<i>. ` up to ` (` or `,`, and
`<label>` the text in the parentheses after it. The question and its last choice follow the line's
`kind=`:

| `kind=`   | Question                                                                     | Last choice               |
| --------- | ---------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "(i of N) Where should analytics for <short> go?"                            | "Don't track this repo"   |
| `folder`  | "(i of N) Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "(i of N) Where should analytics for sessions outside a project folder go?"  | "Don't track these"       |

Choices: one per `W.` line — the workspace name (the text after `W. ` up to ` account=`), described
by the line's `role=` value (nothing when it is empty) — then the last choice, described "Nothing
from <short> is uploaded" ("Nothing from sessions outside a project folder is uploaded" for
`outside`). Several workspaces may be chosen.

- `request_user_input` only with at most 2 `W.` lines (3 choices): header "Beezi", the question
  followed by " Pick one, or name several under Other.", the labels exactly as above.
- Otherwise the plain sentence: the question without its "?", a colon, each workspace as
  "<name> (<role>)" (just "<name>" with no role), then " — one or more — or <last choice, lower-case
  first letter>?". For example: "(1 of 2) Where should analytics for acme-api go: Acme (Owner), Beta
  (User), Gamma (User) — one or more — or don't track this repo?"

Then, for each answered `P` line, run its `P<i>-command=` text EXACTLY ONCE, changing nothing except
the final `<tenants>`: the chosen `tenant=` values joined by commas (e.g. `t1,t2`), or `none` when
the last choice was picked (it wins over the others). Never rebuild the command or re-quote its path
yourself. A `P` line with nothing chosen, or a skipped question, runs nothing: its sessions are not
sent this time, and the next login or the `sync` skill asks again.

Write each command's first line verbatim.

#### Step 4b — the one-time upload

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
script's message (including the upgrade suggestion when it prints one), then continue to step 5
without retrying the import. A different Beezi
account linked on this machine has its own untouched import, so this message is never a reason to
skip step 4 for an account that has just been linked.

Only when it reports the pull *finalized*, tell the user: the pull is one-time per Beezi account and
tool — if they have Codex history on other machines, they should sign in to Beezi there BEFORE it
finalizes; a finalized pull cannot be re-opened.

For an account in several workspaces the output has a few more lines; relay each verbatim:

- **`Beezi (<account>): <R> past sessions follow your rules; …`** — where that account's past
  sessions go: by their rules, then by the New folders setting. "… not sent this time" is expected
  after a skipped step 4a question: the next login or the `sync` skill asks again, and the settings
  skill's Rules adds a rule from inside that repo or folder. When it is the only line, the run
  succeeded with nothing to send.
- **`— <account> · <workspace> —`** — a heading: the upload runs once per workspace those sessions go
  to, and the lines below it are that workspace's outcome. Report each under its own heading; one
  workspace's failure does not stop the others.
- **`Your one-time history upload stays open until those repos and folders have a rule — run the
  login skill or the sync skill to choose.`** — not a failure: the upload is not finalized while
  some repos or folders still wait for a rule, so their history is not lost.
- **`this account belongs to several workspaces and none was picked for this run`** — nothing was
  uploaded; say where analytics go is checked in the settings skill (Rules and New folders), then
  this login skill runs the upload again.
- **`Nothing on this machine goes to this workspace yet, so its one-time history upload stays open.`**
  — not a failure: no past session on this machine goes to that workspace, so its one-time upload
  stays open for this machine's later sessions and for other machines. Nothing was lost.
- **`could not check this workspace with Beezi (…), so nothing was uploaded to it`** — that
  workspace's one-time upload did not run, because Beezi could not confirm which of its sessions
  were already tracked live. The other workspaces under their own headings are unaffected; running
  this login skill again retries it.
- **`… to this workspace you joined`**, **`this workspace already has this machine's history`**,
  **`Some history did not reach this workspace this time…`** — the upload for a workspace joined after
  this machine was linked: it resumes from what that workspace already has, like the `sync` skill.
  Relay it; when it says some history did not arrive, offer to run the `sync` skill.

### Step 5 — offer to make this the analytics default

Only when step 1's output said the analytics skill still reads from a different account. Logging in
never switches the default by itself, because a second workspace signing in must not silently take
over the analytics the user was reading.

Ask once — "Make `<name>` (`<workspace>`) the account the analytics skill reads from?" — using the
name and workspace step 1 printed. Offer "Yes" ("Read analytics from this account") and "No"
("Keep the current default"); omit the workspace parentheses when none was printed. On yes:

```
node "<plugin-root>/scripts/accounts.mjs" use <key>
```

Report its output in full — what analytics now read from, a note about starting a new Codex session
if the workspaces are on different plans, and the reminder that every linked account still receives
this machine's analytics. Relay whatever it prints rather than counting lines. On no, say the
default is unchanged; the settings skill (Account → Default account) can change it later.

## Logging out

That is the `logout` skill. Do not run `logout.mjs` from here — signing out has its own outcomes to
relay, and it is not what someone asking to "switch accounts" usually wants: logging in again
re-links this machine without unlinking it first.

## Refreshing the captured plan, checking the link

Both are the `settings` skill: refreshing the ChatGPT plan is its Account section, and "am I
linked?" its screen (the `beezi_status` tool also answers). Do not run them from here.

## When something fails

**"not linked" persists after logging in.** The credentials are stored per machine in the OS
keyring, falling back to `~/.beezi-codex/credentials.json` (or `$BEEZI_CODEX_HOME`). If the user is
running Codex with a different `BEEZI_CODEX_HOME`, they are two different machines as far as Beezi
is concerned. `~/.beezi` is the Claude Code plugin's directory and is never read by this plugin —
a link there does not carry over.

**The browser never opens.** Not fatal — the output carries the authorize URL. Give it to the user.

**Network or server errors.** Report them as given. Do not retry a login in a loop; each attempt
opens another browser window.
