import test from 'node:test';
import assert from 'node:assert/strict';
import { keepCurrentRules } from '../lib/workspace-rules.mjs';

const R1 = { kind: 'repo', match: 'github.com/acme/r1', label: 'github.com/acme/r1', sessions: 2 };
const R2 = { kind: 'repo', match: 'github.com/acme/r2', label: 'github.com/acme/r2', sessions: 1 };

function row(tenantIds, over = {}) {
  return { key: 'abcdef01', tenants: tenantIds.map((id) => ({ id, name: id })), ...over };
}

test('Ask me, one old workspace X: rule-less places are kept on [X]', () => {
  assert.deepEqual(keepCurrentRules(row(['X', 'T']), [R1, R2], ['T']), [
    { kind: 'repo', match: R1.match, label: R1.label, tenantIds: ['X'] },
    { kind: 'repo', match: R2.match, label: R2.label, tenantIds: ['X'] },
  ]);
});

test('a place that already has a stored rule is skipped', () => {
  const r = row(['X', 'T'], { workspaceRules: [{ kind: 'repo', match: R1.match, tenantIds: ['T'] }] });
  assert.deepEqual(keepCurrentRules(r, [R1, R2], ['T']).map((k) => k.match), [R2.match]);
});

test('a stored rule naming only departed workspaces counts as absent', () => {
  const r = row(['X', 'T'], { workspaceRules: [{ kind: 'repo', match: R1.match, tenantIds: ['GONE'] }, { kind: 'repo', match: R2.match, tenantIds: [] }] });
  assert.deepEqual(keepCurrentRules(r, [R1, R2], ['T']), [
    { kind: 'repo', match: R1.match, label: R1.label, tenantIds: ['X'] },
  ]);
});

test('New folders = send writes nothing', () => {
  const r = row(['X', 'T'], { newFolders: { mode: 'send', tenantIds: ['X'] } });
  assert.deepEqual(keepCurrentRules(r, [R1, R2], ['T']), []);
});

test('two old workspaces X,Y leave rule-less places pending: nothing written', () => {
  assert.deepEqual(keepCurrentRules(row(['X', 'Y', 'T']), [R1, R2], ['T']), []);
});
