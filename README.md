# Beezi Codex plugins

Beezi's plugin marketplace for [OpenAI Codex](https://developers.openai.com/codex). This is the
Codex counterpart to `beezi-claude-plugins`

## Plugins

- **[beezi](./plugins/beezi)** — draft and create tickets on your board (Jira / Azure DevOps) or in
  Beezi, and report per-branch Codex session token analytics to every Beezi account linked on the
  machine.

## Install

```bash
codex plugin add beezi@beezi
```

The marketplace root is `.agents/plugins/marketplace.json`; the default personal marketplace
discovers it implicitly. Start a new Codex thread after installing.

Signing in needs nothing on the command line: the plugin's MCP server offers a `beezi_login` tool
while the machine is unlinked, so asking Codex for anything Beezi starts the browser sign-in.

Any number of Beezi accounts can be linked to one machine, and every linked account receives that
machine's analytics; the default decides which account the analytics tools read from. The `login`
skill adds an account, the `accounts` skill lists them and picks the default, and the `logout` skill
removes one — see
[Several Beezi accounts on one machine](./plugins/beezi/README.md#several-beezi-accounts-on-one-machine).

Analytics needs the lifecycle hooks in `~/.codex/hooks.json`, and **the plugin writes and repairs
them for you**. One step is genuinely yours: run `/hooks` inside Codex and trust **every** Beezi
entry it lists — an untrusted entry silently never runs.

See [plugins/beezi/README.md](./plugins/beezi/README.md#analytics-needs-the-hooks-installed-and-trusted)
for why the plugin has to install them, why that trust survives a plugin upgrade, and the known
caveats.

## Layout

```
.agents/plugins/marketplace.json   # marketplace entry → ./plugins/beezi
plugins/beezi/
  .codex-plugin/plugin.json        # manifest; its `mcpServers` key points at .mcp.json
  .mcp.json                        # MCP stdio server, declared by plugin.json
  skills/                          # one directory per skill; `ls plugins/beezi/skills` is the list
  lib/  scripts/                   # zero-dependency Node engine, on a Node 13.2 floor
  test/  tools/                    # the suite, and the hermetic sandbox + runtime gate it runs under
```

Run the suite with `npm test` from `plugins/beezi/` — it passes a mandatory
`--import ./tools/hermetic-env.mjs` that keeps tests off your real `~/.codex` and `~/.beezi-codex`.

Collector releases that add report fields are backend-first. The API uses a strict request
whitelist, so it must accept a new field before the plugin sends it; otherwise the complete session
report is rejected. Version 0.12 adds optional `project_instructions_status` while keeping the
source-aware instruction count in the established `claude_md_lines` field. Historical imports
also collect the current root instruction file and status; they do not reconstruct past contents.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
