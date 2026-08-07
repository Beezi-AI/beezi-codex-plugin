# Beezi plugin for Codex

A Codex plugin that (1) drafts and creates tickets on your board (Jira / Azure DevOps) or in Beezi
via the Beezi MCP server, and (2) hooks into Codex session lifecycle events (SessionStart,
PostToolUse, Stop) to report per-branch token-usage analytics to your Beezi workspace.

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

### Analytics needs the hooks installed and trusted

Codex loads a plugin's `skills/` and `.mcp.json`, but **not** its `hooks.json` — the
`plugin_hooks` feature is `removed`. Ask Codex to *"set up Beezi analytics"* (the
`analytics-hooks` skill), or run it yourself; `codex plugin list` prints the plugin root, call
it `$P`:

```bash
node "$P/scripts/hooks.mjs" install   # writes ~/.codex/hooks.json + launchers in ~/.beezi-codex/hooks
```

Then, inside Codex, run `/hooks` — review the three Beezi entries and trust them. Codex will not
run a hook it has not been shown, and trust is recorded against each hook's **hash**, so repeat both
steps after a plugin upgrade.

## Entry points

Codex has no per-plugin slash commands ([openai/codex#13893](https://github.com/openai/codex/issues/13893)),
so every flow is a skill: pick it from `/skills`, prefix a prompt with `$<name>`, or just
describe what you want and let the model select it.

| Skill | Covers |
| --- | --- |
| `beezi:create-ticket` | Draft and file a ticket on your board or in Beezi |
| `beezi:login` | Link / unlink this machine, refresh the captured plan |
| `beezi:me` | Is this machine linked, as whom, and are the hooks installed |
| `beezi:analytics-hooks` | Install, repair, remove, or check the analytics hooks |
| `beezi:track` | Checkpoint the current branch now, without hooks |

Two flows are MCP tools rather than skills, because they have to run in the server's process:
`beezi_login` and `beezi_status`. The skills prefer them and fall back to the scripts.

Each skill runs a script under `scripts/`; those stay directly runnable from a terminal —
`login.mjs`, `logout.mjs`, `me.mjs`, `hooks.mjs [install|uninstall|status]`, `track.mjs`,
`billing-capture.mjs --from-codex`.

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
- **Repo / branch attribution**: cwd is tracked per turn (`session_meta.cwd` seeds it,
  `turn_context.cwd` updates it, a shell tool's `arguments.workdir` refines it); the branch is
  resolved from the per-repo reflog timeline at each line's timestamp. Work with no resolvable
  `origin` — a directory that isn't a repo, or a repo without a remote — is still reported, under a
  synthetic `local:<folder>` remote. Only the folder name travels, never the path around it, and the
  `local:` prefix keeps it from ever canonicalizing onto a real remote server-side.
- **Operations** are categorized from `function_call` / `custom_tool_call` records. MCP calls
  surface as bare function names, but the matching `event_msg/mcp_tool_call_end` names the server
  (`payload.invocation.server`) and joins back by `call_id` — so `by_server` carries real names, and
  falls back to `unknown` only for rollouts predating that event. Repo searches run through the
  shell (`rg`, `grep`, `find`, `Select-String`, …) are bucketed as `search` rather than `shell`.
- **API errors** come from `event_msg/{type: "error"}`, whose `message` is either prose or a
  stringified upstream JSON body; both are parsed. Transient failures Codex retries itself
  (`server_overloaded`, 5xx) are dropped, and `turn_aborted{reason: "interrupted"}` is a user
  pressing Esc, not a failure. Reports that miss the hook budget are parked in session state and
  drained next checkpoint — the cursor advances either way, so an unreported error is otherwise
  unrecoverable.
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

The report payload and idempotency contract are unchanged from the Claude plugin, so the server
upserts are identical. Subagent segments scope the id by agent —
`segmentId = "<session_id>:<agent_id>:<fromLine>-<toLine>"` versus
`"<session_id>:<fromLine>-<toLine>"` for the main thread — because the server keys on
`segmentId::model` and two agents starting at their own fork boundaries otherwise collide.

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
5. What the user said at sign-in (`selfReported`), including an `api_key` answer for someone who
   bills pay-as-you-go and has no ChatGPT tier to name.
6. Otherwise **`unknown`**, reported honestly rather than guessed.

`billing.json`'s own `source` is never an input to the next resolution — it records the last one,
so a switch made outside our sight cannot keep asserting itself. Session start realigns it to the
resolved source without touching `capturedAt` (that timestamp tracks the *plan*, and bumping it
would hide a plan going stale).

The plan tier itself lives in the `id_token`'s `https://api.openai.com/auth` claim
(`chatgpt_plan_type`). We decode that JWT claim locally to capture `plus` / `pro_5x` / `pro_20x` /
`go` / `team` / `business` / `enterprise` / `edu` — **no token ever leaves the machine**, only the
plan-tier string. API-key billing carries no plan.

Codex's own tier names are folded onto those labels (`CODEX_PLAN_ALIASES` in `lib/billing.mjs`),
because the wire vocabulary is not the pricing vocabulary. The load-bearing case is the 2026-04-09
Pro split: the $200 tier kept the name `pro` and became 20×, and the new $100 5× tier ships as
`prolite`. Anything left unmapped normalizes to `unknown`, which never settles — so the
"refresh your plan" nudge would fire on every session with no way for the user to end it.

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
| `BEEZI_API_URL` | `https://beezi-api-staging.azurewebsites.net/api` | Beezi API base |
| `BEEZI_MCP_URL` | `<BEEZI_API_URL>/mcp` | MCP endpoint |
| `BEEZI_CODEX_HOME` | `~/.beezi-codex` | Queue / state / credentials |
| `CODEX_HOME` | `~/.codex` | Rollout transcripts, auth store |

Only these four are declared in `.mcp.json`, so only these reach the MCP server process. A
sandboxed shell command may not inherit `BEEZI_API_URL` when the server did — which is why every
link answer reports the `apiBase` it was computed against.

## Tests

Zero runtime dependencies. Run the suite:

```bash
node --test
```

## Notes / known caveats

Measured against Codex CLI 0.137.0 on Windows.

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
  and re-reporting after the move is harmless — the server dedups by `segmentId`. Existing hook
  launchers under `~/.beezi/hooks` are left in place; `hooks.mjs install` rewrites the registry to
  the new launchers (re-trust via `/hooks`), and the old files can be deleted by hand.
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
  under `codex exec`.
- **`SessionEnd` does not exist.** Codex documents it, but an entry for it is silently dropped from
  the registry (10 of 11 documented events register). The `Stop` hook already runs the same
  checkpoint, timeline included, at every turn end, so nothing is lost.
- **Plugin-root variable.** For hooks, Codex exports `PLUGIN_ROOT` and `PLUGIN_DATA`, plus
  `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` for compatibility. `CODEX_PLUGIN_ROOT` does not exist.
  The installer does not rely on any of them — it resolves the plugin from its own module path and
  bakes absolute paths into the launchers.
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
  failures (present in the Claude plugin) is omitted; rate-limit reporting still rides on the
  regular checkpoint path.
- **Server contract.** The identity routes are codex-scoped (`/me/codex/whoami`,
  `/me/codex/machine`). Analytics attribution requires the Beezi API to accept the Codex client
  (via those routes or the `X-Beezi-Agent` header). Ticketing works against the existing MCP
  endpoint regardless.
