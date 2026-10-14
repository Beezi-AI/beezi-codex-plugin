import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const IMPORT = "import { startHistoryWorker } from '../lib/history-trigger.mjs';";
const source = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const count = (text, fragment) => text.split(fragment).length - 1;

test('sync.mjs starts the history worker for every account it ran, after the run, never on --dry-run', () => {
  const text = source('scripts/sync.mjs');
  const start = 'if (!options.dryRun) for (const row of rows) await startHistoryWorker(row.key);';
  assert.ok(text.includes(IMPORT));
  assert.equal(count(text, start), 1);
  const run = text.indexOf('const rows = await syncRows(account, options, rest);');
  assert.ok(run !== -1 && run < text.indexOf(start));
  assert.ok(text.indexOf('async function main()') < run);
  assert.ok(text.indexOf(start) < text.indexOf('main().catch('));
});

test('backfill.mjs starts the history worker after both upload paths, before it exits', () => {
  const text = source('scripts/backfill.mjs');
  const call = 'await startAfterBackfill(key, options);';
  assert.ok(text.includes(IMPORT));
  assert.ok(text.includes('if (!options.dryRun) await startHistoryWorker(key);'));
  assert.equal(count(text, call), 2);
  const first = text.indexOf(call);
  const second = text.indexOf(call, first + call.length);
  assert.ok(text.lastIndexOf('const status = await backfillOne(options);', first) !== -1);
  assert.ok(first < text.indexOf('if (status !== 0) process.exitCode = 1;', first));
  assert.ok(text.indexOf('for (const tenantId of tenantIds) {') < second);
  assert.ok(second < text.lastIndexOf('if (status !== 0) process.exitCode = 1;'));
});
