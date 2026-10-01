import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFromBranch, sanitizeRemote, TASK_BRANCH_RE } from '../lib/git.mjs';

test('taskFromBranch — extracts task token from a task branch', () => {
  assert.equal(taskFromBranch('feature/task-abc-123'), 'task-abc-123');
  assert.equal(taskFromBranch('beezi/task-PROJ_9'), 'task-PROJ_9');
});

test('taskFromBranch — null when the branch does not fit', () => {
  assert.equal(taskFromBranch('main'), null);
  assert.equal(taskFromBranch('feature/no-task-here'), null);
  assert.equal(taskFromBranch('task-abc'), null); // needs a leading segment before task-
  assert.equal(taskFromBranch(''), null);
  assert.equal(taskFromBranch(undefined), null);
});

test('taskFromBranch — agrees with TASK_BRANCH_RE (checkpoint filter)', () => {
  for (const branch of ['x/task-1', 'main', 'feat/task-a_b-c', 'nope']) {
    assert.equal(Boolean(taskFromBranch(branch)), TASK_BRANCH_RE.test(branch));
  }
});

test('sanitizeRemote — strips credentials from the URL', () => {
  assert.equal(
    sanitizeRemote('https://user:tok@host/acme/repo.git'),
    'https://host/acme/repo.git',
  );
});

const REMOTE_CASES = [
  // unchanged today — must stay byte-identical
  ['https://user:tok@host/acme/repo.git', 'https://host/acme/repo.git'],
  ['https://TOKEN@github.com/o/r.git', 'https://github.com/o/r.git'],
  ['https://oauth2:glpat-xxx@gitlab.com/g/r.git', 'https://gitlab.com/g/r.git'],
  ['https://org@dev.azure.com/org/proj/_git/repo', 'https://dev.azure.com/org/proj/_git/repo'],
  ['https://u:p%40x@host/r', 'https://host/r'],
  ['ssh://git@host/o/r.git', 'ssh://host/o/r.git'],
  ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
  ['github.com:o/r.git', 'github.com:o/r.git'],
  ['https://Dev.Azure.com/Org/Proj/_git/Repo', 'https://Dev.Azure.com/Org/Proj/_git/Repo'],
  ['https://host:8443/r.git', 'https://host:8443/r.git'],
  // newly handled
  ['https://host/o/r.git?token=abc', 'https://host/o/r.git'],
  ['https://host/o/r.git?access_token=abc&x=1', 'https://host/o/r.git'],
  ['https://host/o/r.git#tok', 'https://host/o/r.git'],
  ['https://u:t@host/o/r.git?private_token=z', 'https://host/o/r.git'],
  ['C:/Users/me/src/repo', 'local:repo'],
  ['C:\\Users\\me\\src\\repo\\', 'local:repo'],
  ['/home/me/src/repo.git', 'local:repo.git'],
  ['../other', 'local:other'],
  ['file:///home/me/repo', 'local:repo'],
  ['\\\\server\\share\\repo', 'local:repo'],
];
test('sanitizeRemote — table', () => {
  for (const [input, want] of REMOTE_CASES) assert.equal(sanitizeRemote(input), want, input);
});
