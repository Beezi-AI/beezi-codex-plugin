import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// `.mcp.json`'s `env_vars` is an ALLOWLIST: Codex forwards only the variables named there into the
// stdio server it spawns. A variable a hook reads and the bridge does not receive is not an error
// anywhere — it is a split brain, where the two halves of the plugin answer the same question
// differently and neither reports it.
//
// OPENAI_API_KEY is the case that made this file exist. lib/billing.mjs reads it, resolveSource in
// lib/billing-config.mjs calls that, and billing-config is on the bridge's STATIC import graph —
// so before it was forwarded, an api-key machine billed as `openai_api_key` from a hook and as
// something else from the MCP server.

const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// Every entry the allowlist must carry. Adding one here without adding it to `.mcp.json` fails,
// and so does dropping one from `.mcp.json` — removing a variable from the server's environment
// changes behaviour silently, so it has to be a deliberate edit in two places.
const REQUIRED = Object.freeze([
  'BEEZI_API_URL',
  'BEEZI_MCP_URL',
  'BEEZI_ENV',
  'BEEZI_CODEX_HOME',
  'CODEX_HOME',
  'BEEZI_CODEX_WATCHER',
  'BEEZI_CODEX_APP_SERVER',
  'BEEZI_CODEX_CLI',
  'OPENAI_API_KEY',
]);

test('.mcp.json forwards every variable the MCP server needs to agree with the hooks', () => {
  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf-8'));
  const declared = config.mcpServers.beezi.env_vars;
  assert.ok(Array.isArray(declared), '.mcp.json must declare an env_vars allowlist');
  for (const name of REQUIRED) {
    assert.ok(declared.indexOf(name) !== -1, `${name} must be forwarded to the MCP server`);
  }
});

test('OPENAI_API_KEY is forwarded because the billing resolver is on the bridge\'s import graph', () => {
  // Pins the reason, not just the entry: if billing-config ever leaves the bridge's static graph
  // the allowlist entry can go too, and this says so out loud rather than leaving a mystery.
  const graph = new Set();
  (function walk(file) {
    if (graph.has(file)) return;
    graph.add(file);
    const source = fs.readFileSync(file, 'utf-8');
    const pattern = /from\s+'(\.[^']+)'/g;
    let match = pattern.exec(source);
    while (match) {
      walk(path.resolve(path.dirname(file), match[1]));
      match = pattern.exec(source);
    }
  }(path.join(PLUGIN_ROOT, 'lib', 'mcp-bridge.mjs')));

  const onGraph = (name) => [...graph].some((f) => path.basename(f) === name);
  assert.ok(onGraph('billing-config.mjs'), 'billing-config.mjs must be on the bridge import graph');
  assert.ok(onGraph('billing.mjs'), 'billing.mjs must be on the bridge import graph');

  const billing = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'billing.mjs'), 'utf-8');
  assert.match(billing, /env\.OPENAI_API_KEY/, 'lib/billing.mjs must still be the reader');
});
