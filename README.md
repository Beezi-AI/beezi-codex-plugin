# Beezi Codex plugins

Beezi's plugin marketplace for [OpenAI Codex](https://developers.openai.com/codex). This is the
Codex counterpart to `beezi-claude-plugins`

## Plugins

- **[beezi](./plugins/beezi)** — draft and create tickets on your board (Jira / Azure DevOps) or in
  Beezi, and report per-branch Codex session token analytics to your Beezi workspace.

## Install

```bash
codex plugin add beezi@beezi
```

The marketplace root is `.agents/plugins/marketplace.json`; the default personal marketplace
discovers it implicitly. Start a new Codex thread after installing.

Signing in needs nothing on the command line: the plugin's MCP server offers a `beezi_login` tool
while the machine is unlinked, so asking Codex for anything Beezi starts the browser sign-in.

Analytics needs one more step, because Codex does not load hooks bundled in a plugin. Ask Codex to
set up Beezi analytics, or run it yourself — `codex plugin list` prints the plugin root, call it
`$P`:

```bash
node "$P/scripts/hooks.mjs" install
```

Then run `/hooks` inside Codex and trust the three Beezi entries.

See [plugins/beezi/README.md](./plugins/beezi/README.md) for details and known caveats.

## Layout

```
.agents/plugins/marketplace.json   # marketplace entry → ./plugins/beezi
plugins/beezi/
  .codex-plugin/plugin.json        # manifest
  .mcp.json                        # MCP stdio server (auto-discovered)
  skills/                          # create-ticket, login, me, analytics-hooks, track
  lib/  scripts/  test/            # zero-dependency Node engine + node --test suite
```
