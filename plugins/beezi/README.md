# Beezi plugin for Codex

A Codex plugin that (1) drafts and creates tickets on your board (Jira / Azure DevOps) or in Beezi
via the Beezi MCP server, and (2) hooks into Codex session lifecycle events (`SessionStart`,
`PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`) to report per-branch token-usage analytics
to every Beezi account linked on this machine.

This is the Codex port of the Claude Code `beezi` plugin. The auth, MCP stdio bridge, and reporting
engine are shared logic; the session-transcript parsing and subscription-plan capture are
reimplemented for Codex's formats.

## Install

The plugin is registered in this repo's `.agents/plugins/marketplace.json`. From the repo root:

```bash
codex plugin add beezi@beezi
```

Then start a **new** Codex thread so the plugin's skills and MCP server load.

### Signing in

Nothing to run by hand. Ask Codex for anything Beezi — the MCP server starts with every session and
serves two tools of its own: `beezi_login` (browser sign-in, after which the drafting tools appear
in the same session) and `beezi_status` (is this machine linked, as whom, against which API, and
are the analytics hooks installed).

Both are answered **inside the MCP server**, deliberately. That process is spawned by Codex and
inherits `BEEZI_API_URL` and the credential store; a script the model runs through the shell tool
may see neither, so the two could report opposite things about the same machine. Anything read-only
about the link should go through `beezi_status`.

Codex's own MCP OAuth is not used: it only covers streamable-HTTP servers, and it would put the
token in Codex's store while the analytics hooks read `~/.beezi-codex/credentials.json` — so the machine
would have to be linked twice.

Signing in a second time adds a second account rather than replacing the first — see
[Several Beezi accounts on one machine](#several-beezi-accounts-on-one-machine).

### Analytics needs the hooks installed and trusted

Codex loads a plugin's `skills/` and `.mcp.json`, but **not** its `hooks.json` — the
`plugin_hooks` feature is `removed`. The plugin therefore writes the entries into
`~/.codex/hooks.json` itself, and **installs and repairs them without being asked**:

- `beezi_login` / the `login` skill installs them once the machine is linked;
- the plugin's MCP server — spawned every session, and the only Beezi code that still runs when the
  hooks are broken — repairs them on the session's first message;
- the `me` skill repairs them before it reports.

A healthy install is never rewritten. That is deliberate rather than an optimisation: Codex keys
hook trust to each entry's **hash**, so rewriting an entry would revoke trust you had already
granted.

The entries do not name a plugin version. Each one runs a small launcher the installer keeps at a
fixed path — `~/.beezi-codex/hooks/beezi-hook.mjs`, or `~/.beezi-codex-<env>/hooks/beezi-hook.mjs`
on a `dev` / `staging` / `local` variant — and passes it the name of the lifecycle script to run:

```
node "C:\Users\me\.beezi-codex\hooks\beezi-hook.mjs" session-start.mjs
```

The launcher then finds the newest plugin version installed under
`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and runs that version's script. An
upgrade refreshes the launcher's own bytes; the registry entry is untouched, so its hash — and your
trust — is too. `node` is taken from your `PATH` for the same reason, so a Node upgrade does not
move it either.

You can still drive it by hand — ask Codex to *"set up Beezi analytics"* (the `analytics-hooks`
skill), or run it yourself; `codex plugin list` prints the plugin root, call it `$P`:

```bash
node "$P/scripts/hooks.mjs" install   # a no-op when the install is already current; --force rewrites anyway
node "$P/scripts/hooks.mjs" status    # read-only
```

`status` also prints where the launcher lives, whether its copy is current, and which installed
plugin version it currently resolves to.

Then, inside Codex, run `/hooks` — review the Beezi entries and trust **all** of them. This is the
one step that cannot be automated: Codex has no non-interactive way to grant trust. There is one
entry per lifecycle event Beezi registers, and `install` and `status` both print that list back, so
trust what they named rather than a number from this page. You do this **once** — a plugin upgrade
does not send you back here.

Two things still cost a re-trust, both one-off. A machine carrying the old version-path entries has
them rewritten to the launcher form on its first session after this release: that one upgrade needs
trust granted again, and no upgrade after it does. And setting or changing `BEEZI_CODEX_HOME` moves
the launcher, which changes the entries.

Leaving any entry untrusted fails silently — an untrusted hook simply does not run, and nothing
reports it. Skipping `SubagentStart` / `SubagentStop`, for example, still bills subagent tokens (the
parent's checkpoint does that) but loses every spawned agent's name and its span on the timeline.

## Several Beezi accounts on one machine

Any number of Beezi accounts can be linked at once, and **every linked account receives this
machine's analytics.** Reporting fans out over every account that can currently produce a token —
the same list session start, every checkpoint, the rollout watcher and the `track` skill each loop
over (`linkedSessions` in `lib/accounts.mjs`). The **default** is the account the analytics tools
read from: the MCP server resolves it per request, so a switch made in a shell reaches a session
that is already running. Switching it therefore changes what you read rather than what is reported,
and unlinks nothing.

**To add one**, run the `login` skill again. The browser signs in as whichever Beezi account it is
already signed in as, so to link a different one, sign out of Beezi in the browser first or use a
private window. When accounts are already linked, the command-line sign-in prints that and lists
them before it opens the browser. Logging in never switches the default away from what you read;
the `accounts` skill is what changes it.

**To switch the default**, the `accounts` skill. It lists every linked account, marks the default
and any revoked row, and `use <n>` picks the account analytics read from.

**To remove one**, the `logout` skill. It logs out one named account, or every account at once, and
reports the outcome for each.

**Each account has its own one-time history import.** The import is spent once per Beezi account and
tool, so the `login` skill runs it for the account it has just linked, and the script refuses to run
without being told which account it is for. An account linked later pulls its own history; an import
already spent by one account says nothing about another's.

**Two users of one Beezi workspace cannot both link the same machine — once your Beezi server names
the workspace at sign-in.** A sign-in whose workspace is already linked as somebody else is then
refused, with the reason: `Workspace <name> is already linked as <email>. Log that account out first
to link <your email>.` Nothing is stored on that path — no credentials, no index row, no account
directory. The reason is the fan-out above: both accounts would receive this machine's analytics,
and one workspace would count the same sessions twice. A server that does not return the workspace
on sign-in gives the check nothing to compare, so against one of those the second account links like
any other.

An account linked before this layout existed reads as `linked account (no name or email recorded)`
in the `accounts` and `me` lists: no name, email or workspace was recorded for it when it was
carried over, and those lists show what they have. The next session start that reaches Beezi as that
account, and a sign-in as it, both record what the server answers with.

## Updating

The plugin checks whether it is out of date, but never updates itself. At session start it compares
its own version — the one in its `.codex-plugin/plugin.json` — against the `version` in the
`.codex-plugin/plugin.json` published at the manifest URL this build was stamped with. That URL is
baked in per build (`env.json`'s `updateManifestUrl`), so a variant only ever measures itself against
its own channel; a manifest naming a different plugin is ignored rather than treated as an update.
The check rides the `SessionStart` hook, so it only ever fires on a machine whose hooks are
[installed and trusted](#analytics-needs-the-hooks-installed-and-trusted) — leave that entry
untrusted and the update notice never appears, with nothing to say so.

The check runs **at most once an hour** and gives up after 1.5 s. An offline machine, a build with no
manifest URL, and a manifest that cannot be parsed are all silent — the check never fails a hook and
never nags about itself. Between checks a known-behind result is answered from the remembered
reading, so upgrading clears the notice immediately rather than an hour later.

When a newer version is published it prints one line:

> Beezi: version `<latest>` is published; this machine runs `<current>`. Run
> `codex plugin marketplace upgrade`, then start a new Codex thread to apply it. (Installed from a
> local clone? Pull it instead: `marketplace upgrade` only refreshes Git marketplaces.)

Three things about that command are deliberate:

- **There is no `codex plugin update`.** `codex plugin` offers `add | list | marketplace | remove`,
  and refreshing the marketplace is the whole upgrade — Codex picks the newer build up from the
  refreshed snapshot, so there is nothing to re-add afterwards.
- **No marketplace name is passed.** `codex plugin marketplace upgrade beezi` fails with
  "marketplace `beezi` is not configured as a Git marketplace" whenever the marketplace is in the
  plugin cache but absent from `config.toml` — the state a clone install leaves behind. The bare form
  upgrades every configured Git marketplace and cannot hit that.
- **A new Codex thread is required.** Skills and the MCP server are loaded once per thread, so the
  running session keeps the old build until it is restarted.

**The hooks do not need re-trusting.** The registry entries name a fixed launcher rather than a
plugin version, so an upgrade rewrites the launcher's bytes and leaves each entry — and its hash —
exactly as trusted. The one exception is the upgrade *to* this release: a machine whose entries
still carry an older version's script paths has them rewritten to the launcher form on its first
session afterwards, so that upgrade — and only that one — asks for trust again in `/hooks`. See
"Analytics needs the hooks installed and trusted" above.

## Entry points

Codex has no per-plugin slash commands ([openai/codex#13893](https://github.com/openai/codex/issues/13893)),
so every flow is a skill: pick it from `/skills`, prefix a prompt with `$<name>`, or just
describe what you want and let the model select it.

The prefix is the installed plugin's name, so a variant build namespaces these
automatically: `beezi:login` on the public build is `beezi-staging:login` on the staging
variant. The table names the skills; `ls plugins/beezi/skills` is the authority on which
exist.

| Skill | Covers |
| --- | --- |
| `login` | Link a Beezi account to this machine, refresh the captured plan |
| `accounts` | List the linked accounts and pick which one analytics are read from |
| `logout` | Log one account, or every one, out and drop its stored credentials |
| `me` | Which accounts are linked, as whom, and are the hooks installed |
| `analytics-hooks` | Install, repair, remove, or check the analytics hooks (never asks you to run the command yourself) |
| `track` | Checkpoint the current branch now, without hooks |
| `analytics` | Your own spend and session summary, for 7 or 30 days |
| `sync` | Repair history a machine missed while its hooks were untrusted |
| `telemetry` | Turn crash reporting on or off, and see what it would send |

Two flows are MCP tools rather than skills, because they have to run in the server's process:
`beezi_login` and `beezi_status`. The skills prefer them and fall back to the scripts.

Each skill runs a script under `scripts/`; those stay directly runnable from a terminal —
`login.mjs`, `accounts.mjs [list|use <account>]`, `logout.mjs [--list|--account <a>|--all]`,
`me.mjs`, `hooks.mjs [install|uninstall|status]`, `track.mjs`, `billing-capture.mjs --from-codex`.

## How analytics work

Codex writes one rollout transcript per session at
`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl`. Each line is
`{ timestamp, type, payload }` with types `session_meta`, `turn_context`, `response_item`, and
`event_msg`.

- **Tokens** come from `event_msg` records of `payload.type: "token_count"`. Codex reports the
  *cumulative* `total_token_usage` (monotonic), so the delta engine bills each segment the
  increment between consecutive token-count events. Verified invariants (universal across real
  rollouts): `total = input + output`, `cached_input ⊆ input`, `reasoning_output ⊆ output`. Mapped
  as `token_input = Δ(input − cached)`, `token_cache_read = Δ(cached)`, `token_output = Δ(output)`.
- **Usage limits** come from `payload.rate_limits` on the same `token_count` records. Windows are
  identified by `window_minutes` (300 → five-hour, 10080 → seven-day), never by the `primary` /
  `secondary` slot they arrive in: across 10 338 local observations, 2 775 carried the *weekly*
  window in the `primary` slot and 315 carried a 30-day window there, so reading the slot as the
  role mislabels 30% of readings. Observations are debounced to the moves worth keeping (a
  5-point change, a window rollover, crossing the 99% exhaustion line in either direction — Codex
  reports an exhausted window as 99 as often as 100 — or a 15-minute floor), queued to
  `~/.beezi-codex/usage-observations.json`, and drained to `/me/codex/usage` at turn end. Each row
  is stamped with the *record's* timestamp rather than wall-clock now, so re-scanning a rollout
  reproduces it exactly and the server's `(account, fetched_at)` key collapses the replay for
  the same account. Uploads include `account_uuid` and `account_email` from the local Beezi
  `billing.json` (`accountId` and `email`), falling back to Codex auth identity when needed.
  This also enriches queued readings without identifiers; any identity already on a row is
  preserved. For unidentified historical readings, these identifiers describe the account
  configured at upload time.
- **Repo / branch attribution**: cwd is tracked per turn (`session_meta.cwd` seeds it,
  `turn_context.cwd` updates it, a shell tool's `arguments.workdir` refines it); the branch is
  resolved from the per-repo reflog timeline at each line's timestamp. Work with no resolvable
  `origin` — a directory that isn't a repo, or a repo without a remote — is still reported, under a
  synthetic `local:<folder>` remote. Only the folder name travels, never the path around it, and the
  `local:` prefix keeps it from ever canonicalizing onto a real remote server-side. An `origin` that
  is itself a local path (`C:/…`, `/…`, `file:`, a UNC share) is reported the same way. Real remotes
  lose any userinfo, query string and fragment, so a token in any of them never leaves the machine.
- **Project instructions** are observed independently for every segment's repository root. Codex
  selects a non-empty root `AGENTS.override.md` first, then `AGENTS.md`; an empty file remains a real
  zero-line result when there is no non-empty candidate. Reports carry
  `project_instructions_status` as `present`, `missing`, or `unknown`. The established
  `claude_md_lines` field remains for compatibility and, on Codex reports, contains the line count
  of that selected AGENTS source only when status is `present`. File contents and filesystem paths
  are never sent. Historical imports collect the current root file and status in the same way as
  live reports. These describe the repository at collection time, not its historical contents.
  Already queued reports retain the values captured when they were created.
- **Operations** are categorized from `function_call` / `custom_tool_call` records. MCP calls
  surface as bare function names, but the matching `event_msg/mcp_tool_call_end` names the server
  (`payload.invocation.server`) and joins back by `call_id` — so `by_server` carries real names, and
  falls back to `unknown` only for rollouts predating that event. Repo searches run through the
  shell (`rg`, `grep`, `find`, `Select-String`, …) are bucketed as `search` rather than `shell`.
  Codex has no Skill tool, so `skill.by_skill` has two sources: a `$name` injection (a user message
  starting `<skill><name>X</name>`, estimated at its body bytes / 4) and a shell call that reads
  `SKILL.md` files with a plain read command. A call that only reads skills moves its tokens from
  `shell` to `skill`, split across the skills it read; one chained to other work (the usual shape of
  an automatic run: `rg --files …; Get-Content …/SKILL.md; …`) records each skill use at 0 tokens
  and keeps its category. Listing or searching skill folders is not a use. A skill under a
  plugin's versioned cache directory is named `<plugin>:<skill>`, as Codex names it.
- **Planning** is Codex plan mode (`collaboration_mode` / `collaboration_mode_kind` = `plan`, and
  `Plan` items) **or** a planning skill (name matching plan/spec/brainstorm, not execute/implement):
  the skill use opens a cycle, the last plan-document `.md` write makes it `plan_ready`, and the
  first other edit closes it — the same rule the Claude plugin uses. `update_plan` counts only inside
  plan mode; in default mode it is a todo list.
- **API errors** come from `event_msg/{type: "error"}`, whose `message` is either prose or a
  stringified upstream JSON body; both are parsed. Transient failures Codex retries itself
  (`server_overloaded`, 5xx) are dropped, and `turn_aborted{reason: "interrupted"}` is a user
  pressing Esc, not a failure. Reports that miss the hook budget are parked in session state and
  drained next checkpoint — the cursor advances either way, so an unreported error is otherwise
  unrecoverable. A `usage_limit_exceeded` error also carries `resetsAt`, taken from the last
  codex-bucket `token_count` before it (`resets_at`, unix seconds, of its most-used window), because
  the prose ("try again at 6:25 PM") names no zone. A portal that predates the field answers 400;
  the report is then re-sent once without it.
- **Code changes** are parsed from `apply_patch` tool inputs.
- **Session title** is read from `~/.codex/session_index.jsonl` (`thread_name`), falling back to the
  first genuine user prompt in the rollout. That index is originator-gated — Codex Desktop and the
  VSCode extensions populate it, the plain CLI almost never does — so the fallback carries most
  sessions in practice. It skips Codex's injected preambles (`<environment_context>`,
  `<user_instructions>`, AGENTS.md, the summarizer priming message), unwraps the IDE extensions'
  "Context from my IDE setup / My request for Codex" envelope down to the human's own text, and
  refuses anything that still looks machine-generated or contains an absolute home path. A session
  with no human prompt in it reports no name rather than a wrong one.
- **Subagents are billed to their parent session.** Codex writes each one to its own top-level
  rollout (`thread_source: "subagent"`), which the parent's checkpoint finds via the child's
  `parent_thread_id` and via the records the `SubagentStart`/`SubagentStop` hooks leave in
  `~/.beezi-codex/state/<sessionId>.agents/`. Segments carry `is_subagent`, `agent_id`, `agent_type`,
  `agent_name` and `spawn_depth`.
  - A forked rollout replays part of the parent's history — including its `token_count` records —
    before the agent does any work of its own, and the agent's cumulative counter then continues from
    the parent's total rather than restarting. Billing from line 0 double-counts (+15.4% measured on
    a local three-agent fan-out), so the replayed prefix is delimited by its timestamp burst and the
    delta window starts after it. A fork whose prefix cannot be delimited is skipped entirely rather
    than billed from zero.
  - `duration_sec` is a **union** of wall-clock intervals, not a sum: the parent blocks in
    `wait_agent` while its agents run, so they describe the same seconds. Summing them turned 431s of
    real time into 1117s.

The report fields and idempotency contract are shared with the Claude plugin, so the server upserts
are identical. Subagent segments scope the id by agent —
`segmentId = "<session_id>:<agent_id>:<fromLine>-<toLine>"` versus
`"<session_id>:<fromLine>-<toLine>"` for the main thread — because the server keys on
`segmentId::model` and two agents starting at their own fork boundaries otherwise collide.

The API must be deployed before a collector release that sends `project_instructions_status`.
Session-report DTOs reject unknown keys, so an older API rejects the whole payload rather than
ignoring the new field.

## Billing source and plan capture

How the machine pays is resolved in exactly one place — `resolveSource` in `lib/billing-config.mjs`
— shared by the session-start hook and every checkpoint, so the two can never disagree. In
precedence order:

1. `OPENAI_API_KEY` in the environment — what the process will actually use.
2. A quota error recorded in the last 24h → api-key billing.
3. A usage-limit error recorded in the last 24h → subscription billing. (Only a ChatGPT plan has a
   window to exhaust; only a prepaid balance can run out. Both outrank the file below, because a
   stale login lingers on disk but an error that fired cannot lie.)
4. `~/.codex/auth.json`: `auth_mode` first (the field Codex itself uses to pick a credential), then
   the mere presence of a stored key. **Presence only — no key or token is ever read or returned.**
5. What **Codex itself** last said, recorded in `billing.json` as `authType` by the `codex
   app-server` probe below. Observed rather than claimed, so it outranks a self-report — but it is a
   recording and `auth.json` is live, so anything that file says outranks it. Without this step the
   probe is pointless on the machine it exists for: with credentials in the OS keychain there is no
   `auth.json`, steps 1-4 all decline, and a captured plan would be overwritten back to `unknown` on
   the next session.
6. What the user said at sign-in (`selfReported`), including an `api_key` answer for someone who
   bills pay-as-you-go and has no ChatGPT tier to name.
7. Otherwise **`unknown`**, reported honestly rather than guessed.

`billing.json`'s own `source` is never an input to the next resolution — it records the last one,
so a switch made outside our sight cannot keep asserting itself. Session start realigns it to the
resolved source without touching `capturedAt` (that timestamp tracks the *plan*, and bumping it
would hide a plan going stale).

### The plan and account id: three tiers

The plan tier and the ChatGPT account id are resolved in three tiers, in order. Only the plan label
and the account id are ever captured — **no token ever leaves the machine**, and none is read.

1. **`codex app-server`** (`lib/codex-app-server.mjs`) — ask Codex itself. A short-lived child
   process speaking line-delimited JSON-RPC on stdin/stdout: `initialize`, the `initialized`
   notification, then `account/read` (`{ account: { type, email, planType } }`) and
   `account/rateLimits/read`. Both calls are made because **`account/read` carries no account id** —
   measured against codex-cli 0.154.0; only the rate-limit answer does. Neither starts a
   conversation or a model turn.

   This tier exists because auth.json is not where every machine's credentials live: Codex may hold
   them in the OS keychain or only in its own memory, and such a machine has no plan in auth.json at
   all. It is live, so it cannot go stale in place the way tier 2 does. The command is documented as
   experimental, which is why tier 2 is kept rather than replaced.

   It runs **only** behind `shouldProbeAccount()` at session start — weekly for a machine whose
   plan has gone stale, and weekly for one the ladder still calls `unknown`, never for an api-key or
   third-party machine, never over a self-reported plan — and on `billing-capture.mjs --from-codex`.
   Nothing on the checkpoint hot path spawns it. Measured cost
   on Windows: 2929ms cold, ~1050ms warm; bounded at 5s inside the hook and 6s otherwise, and a
   machine with no `codex` on its PATH falls through immediately.

2. **`~/.codex/auth.json`** — the `id_token`'s `https://api.openai.com/auth` claim
   (`chatgpt_plan_type`), decoded locally without signature verification, for `free` / `plus` /
   `pro_5x` / `pro_20x` / `go` / `team` / `business` / `enterprise` / `edu`.

   This tier is a **snapshot that rots in place**: measured on a real machine, an `id_token` that
   expired three days earlier still asserted `chatgpt_plan_type: "free"` with a subscription window
   six weeks past. So an expired claim keeps its *expiry* and drops its *label* — it records
   `plan: 'unknown'`, which leaves the config stale and brings the next session start back to it.
   **That rule applies to this tier only.** A tier-1 reading is live and carries no expiry; applying
   the rule to it would downgrade a correct plan to `unknown` and re-nudge the user forever.

3. **The user's own answer** — `/beezi:login` step 3, recorded as `selfReported`, which nothing
   automatic overwrites. Reached only when neither tier above named a plan.

The account id and email are persisted into `billing.json` alongside the plan, and read back from
there first (`lib/chatgpt-identity.mjs`, and the account check-in). Without that the id would exist
only for the one session that happened to run the probe. API-key billing carries no plan.

Codex's own tier names are folded onto those labels (`CODEX_PLAN_ALIASES` in `lib/billing.mjs`),
because the wire vocabulary is not the pricing vocabulary. The load-bearing case is the 2026-04-09
Pro split: the $200 tier kept the name `pro` and became 20×, and the new $100 5× tier ships as
`prolite`. Anything left unmapped normalizes to `unknown`, which never settles — so the
"refresh your plan" nudge would fire on every session with no way for the user to end it.

Both history paths — the login skill's one-time import and the repeatable `sync` — reach back
**30 days** and no further. A rollout older than that is skipped with a visible count and is never
picked up by a later run; the window is shared deliberately, so a session cannot be in scope for
one command and out of scope for the other.

New or unfinished historical backfills register and snapshot the current ChatGPT account before
upload, then attach its `account_uuid` to every imported report, including subagent reports. This
attributes history to the account active during the import; it does not reconstruct the plan or
account that was active when each session ran. If no subscription account ID is available, the
reports are sent without one.

**Known limitation:** Codex's third-party providers are configured in `~/.codex/config.toml`
(`model_provider` / `env_key`), invisible to the environment. Parsing it would need a TOML
dependency and this plugin ships none, so `third_party` is only reachable via a self-report, and a
machine on a custom provider with a leftover ChatGPT login resolves as `subscription`.

## Client identity

Every request carries an `X-Beezi-Agent: codex` header, and this machine's OAuth client registers as
`Beezi Codex plugin — <hostname>`, so the Beezi API attributes Codex machines and analytics
distinctly from the Claude Code plugin.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BEEZI_API_URL` | `https://beezi-api-prod.azurewebsites.net/api` | Beezi API base |
| `BEEZI_MCP_URL` | `<BEEZI_API_URL>/mcp` | MCP endpoint |
| `BEEZI_ENV` | unset (production) | `dev`/`staging`/`local` selects the namespace: data root, keyring entry, hook owner |
| `BEEZI_CODEX_HOME` | `~/.beezi-codex` | Queue / state / credentials, and the hook launcher |
| `CODEX_HOME` | `~/.codex` | Rollout transcripts, auth store |
| `BEEZI_CODEX_WATCHER` | unset (on) | Rollout watcher in the MCP server; `0`/`false`/`no`/`off`/`disabled` turns it off |
| `BEEZI_CODEX_APP_SERVER` | unset (on) | `0`/`false`/`off`/`no` skips the `codex app-server` plan probe entirely |
| `BEEZI_CODEX_CLI` | `codex` | Path to the Codex CLI, for a machine where it is not on the hook process's PATH |
| `OPENAI_API_KEY` | unset | Not ours — read only as billing evidence: an exported key means the machine bills per token |
| `BEEZI_DEBUG` | unset | Any value makes the CLI scripts print the raw error text instead of the friendly one |

Every row above except `BEEZI_DEBUG` is declared in `.mcp.json`'s `env_vars`, which is an
allowlist: only what is named there reaches the MCP server process. `BEEZI_DEBUG` is deliberately
left out — it only steers what the CLI scripts print, and the MCP server's stdout belongs to
JSON-RPC. Anything that steers billing or the endpoint has to be on the list, or the server and the
hooks answer the same question differently and neither reports it. A sandboxed shell command may
not inherit `BEEZI_API_URL` when the server did — which is why every link answer reports the
`apiBase` it was computed against.

The rollout watcher covers analytics events that cannot depend on a lifecycle hook, including a
usage-limit failure for which Codex does not fire `Stop`. The MCP server periodically reads the
rollouts Codex has already written and checkpoints what is new. It is on by default;
`BEEZI_CODEX_WATCHER=0` (or another explicit false value above) disables it and loads none of the
watcher's code at all — the gate sits before the import.

## The production cutover

**This release reports to the production Beezi API.** Every earlier build defaulted to a staging
API — that was drift, not intent: the public plugin, mirrored to the public GitHub repo, pointed
customers at a staging environment.

If this machine has analytics from an earlier build, the first Beezi command after the upgrade
moves them rather than uploading them. The old data root is copied to `~/.beezi-codex-staging`,
where the staging variant (`beezi-staging`) reads it, and production starts from empty. Nothing is
sent anywhere during the move, and nothing is deleted from the original until the copy has been
verified file by file.

Why it is not simply left in place: the cursors in it are line offsets into transcripts whose
earlier lines were already delivered to a staging tenant, and the queue holds segments captured
under a staging sign-in. Uploading either under a production account bills one tenant for
another's work.

Your previous sign-in moves with the data and is cleared from the production namespace, so
`beezi:login` is the first step after the upgrade.

Three cases stop and ask rather than guessing — a data root that was already pointed at production
by hand, one whose API cannot be established from its stored credentials, and a machine that
already runs the staging variant. In all three nothing is uploaded until it is resolved:

```bash
node scripts/migrate-env.mjs              # what this root is bound to, and any migration
node scripts/migrate-env.mjs --preserve   # move the old data aside, start production fresh
node scripts/migrate-env.mjs --adopt      # the old data IS production data; bind it in place
node scripts/migrate-env.mjs --rollback   # undo a completed migration
```

## Tests

Zero runtime dependencies. Run the suite from this directory:

```bash
npm test
```

The `--import ./tools/hermetic-env.mjs` that `npm test` passes is mandatory, not a convenience:
it redirects every root the plugin can resolve into a per-process sandbox, scrubs the env vars that
steer billing and endpoint choice, and fails the process if a test escapes to the real home. A test
file run bare reads your own `~/.codex` and `~/.beezi-codex`, so a single file goes:

```bash
node --test --import ./tools/hermetic-env.mjs test/credentials.test.mjs
```

Two gates run before any commit that touches `lib/` or `scripts/`, because both must keep parsing
and running on the Node 13.2 floor:

```bash
node --test --import ./tools/hermetic-env.mjs test/compat-syntax.test.mjs  # the banned-syntax scan
node tools/verify-minimum-runtime.cjs                                      # parses and imports every module
```

## Notes / known caveats

Measured against Codex CLI 0.153+ / 0.154.0 on Windows.

- **Plugin-bundled hooks do not load.** `codex features list` reports `plugin_hooks` as `removed`,
  and an installed plugin contributes nothing to the engine's hook registry. Hence `hooks.mjs
  install` — see above.
- **Plugin slash commands do not load either.** Confirmed in a real session: a `commands/` directory
  produces nothing. There is no `commands/list` RPC, no feature flag, and no bundled Codex plugin
  ships one. That directory has been removed; every flow is a skill.
- **The MCP server must survive an unlinked machine.** Codex spawns it eagerly at the start of every
  session, so failing the `initialize` handshake takes the plugin — skills included — down with it
  and shows the user "MCP client for `beezi` failed to start". Unlinked, the bridge answers
  `initialize` locally and serves `beezi_login` + `beezi_status`; everything else reports the
  missing link.
- **Link state is answered in one place.** `lib/link-status.mjs` is the only definition of "linked",
  and every answer carries the API base it was computed against. Before that, the sign-in tool asked
  the raw credentials while the status script asked the refresh-aware accessor, in processes with
  different environments — so they could report opposite things about the same machine within the
  same minute.
- **The data root is `~/.beezi-codex`, not `~/.beezi`.** `~/.beezi` belongs to the Claude Code
  plugin, which writes the same filenames there — `queue/`, `state/`, `billing.json`,
  `repo-map.json`, `credentials.json`. Shared, one agent's queued segments could be flushed under
  the other's identity, and whichever plugin captured a subscription plan last would win
  `billing.json` for both. `BEEZI_HOME` is deliberately **not** honoured either: it is the one knob
  that would point both agents back at a single directory. Use `BEEZI_CODEX_HOME`. Nothing is
  migrated out of `~/.beezi` — copying it in is precisely the mixing this avoids. The credentials
  live in the OS keyring under `beezi-codex`, so a linked machine stays linked; only machines
  falling back to the file store log in again. Anything still queued under `~/.beezi` is not sent,
  and re-reporting after the move is harmless — the server dedups by `segmentId`. The hook launcher
  lives in this root too, at `hooks/beezi-hook.mjs`, so `BEEZI_CODEX_HOME` moves it and the registry
  entries that name it — costing one re-trust when you change it. The per-event `beezi-<script>`
  shims a much older version wrote into that same directory are gone: the next install deletes them
  along with the registry entries that pointed at them. Entries left behind by a variant that is no
  longer on disk are swept at the same time, whichever variant wrote them — a dead entry fails its
  spawn on every session, so it belongs to no working install.
- **The keyring entry was renamed — sign in once more.** This plugin now owns the OS keyring entry
  `beezi-codex`; it previously shared `beezi-analytics` with the Claude Code plugin, where the two
  fought over refreshed tokens and over logout. A machine linked before the rename reads as *not
  linked* and has to sign in again — once. The old entry is deliberately **not** read or deleted:
  on a machine that also runs the Claude Code plugin it is that plugin's live credential, and
  touching it would restore the collision the rename exists to end. Remove it by hand
  (Credential Manager / Keychain Access / `secret-tool clear service beezi-analytics account token`)
  only if you do not use Beezi from Claude Code.
- **Hooks require one-time trust.** Installed hooks register as `enabled: true` but
  `trustStatus: "untrusted"`, and untrusted hooks do not execute. There is no non-interactive way
  to grant trust; `--dangerously-bypass-hook-trust` prints its warning but did not make hooks run
  under `codex exec`. "One-time" is what the design guarantees rather than an observation: an
  upgrade changes only the launcher file the entries point at, so the entry bytes Codex hashes are
  unchanged and there is nothing for it to distrust.
- **`SessionEnd` is not registered.** It is out of scope for this release, and the reason is
  `Stop`: that hook already runs the same checkpoint, timeline included, at every turn end, so a
  `SessionEnd` entry would cost you one more hook to review and trust for work already done.
  Whether Codex registers `SessionEnd` at all on current builds is **unmeasured** — it was measured
  as silently dropped from the registry on 2026-07-27 (10 of 11 documented events registered) and
  nobody has re-run that check since, so treat both "it works now" and "it still does not exist" as
  unverified. Either way it could not cover a `SIGKILL`, which is the case a last-chance flush would
  have to survive.
  What that costs, stated honestly: on a mid-turn kill, segments already queued on disk survive and
  are retried by the next session's start-up flush (the queue is machine-wide, not per-project), but
  whatever happened since the last checkpoint is not delivered by the hooks alone — it waits for a
  later checkpoint of that session, or for the `track` skill.
- **Plugin-root variable.** For hooks, Codex exports `PLUGIN_ROOT` and `PLUGIN_DATA`, plus
  `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` for compatibility. The installer does not rely on any
  of them — it writes the launcher's quoted absolute path plus the lifecycle script's bare name into
  the registry entry's `command`, and the launcher resolves the plugin itself, from the Codex plugin
  cache. That holds even for an install run out of a source checkout: the entry it writes still
  resolves to the cached build, which is why the dev flow copies changed files into the installed
  variant rather than pointing hooks at the checkout.
- **Codex's native MCP OAuth is not usable here.** `codex mcp login` and the `AuthRequired`
  handshake only apply to `streamable_http` servers; a stdio server reports
  `authStatus: "unsupported"`. Switching transports would authenticate drafting into Codex's own
  token store while the hooks kept reading `~/.beezi-codex/credentials.json`, so the machine would need
  linking twice. The `beezi_login` tool keeps one credential store for both.
- **`PostToolUse` matches every tool.** Codex's shell tool is named `shell_command` on the legacy
  surface and `exec` under unified exec, and the name a hook actually reports has not been measured
  from a real payload. `checkpoint.mjs` exits immediately unless the payload carries a git
  checkpoint command, so a broad matcher costs a short-lived process; guessing the name would fail
  silently instead.
- **StopFailure.** Codex has no `StopFailure` lifecycle event, so session-error reporting on hard
  failures (present in the Claude plugin) is omitted. Rate-limit *errors* still ride the regular
  checkpoint path as session errors; quota *utilization* is a separate capture (see above).
- **The 30-day window is not reported.** A free plan reports a 43 200-minute window that the wire
  contract has no column for, so those observations are skipped rather than mislabelled as either
  of the two windows it does have.
- **Server contract.** The identity routes are codex-scoped (`/me/codex/whoami`,
  `/me/codex/machine`). Analytics attribution requires the Beezi API to accept the Codex client
  (via those routes or the `X-Beezi-Agent` header). Ticketing works against the existing MCP
  endpoint regardless.
