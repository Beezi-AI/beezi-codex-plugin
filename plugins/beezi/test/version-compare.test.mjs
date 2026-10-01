import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewer } from '../lib/version-compare.mjs';

// Moved out of test/update-check.test.mjs alongside the module itself. The comparison is the part
// of the stale-version check (G-8-4) that has nothing to do with fetching, caching or copy, and it
// is the part a wrong answer makes loudest: it either nags a user who is up to date, or stays
// silent for one who is six months behind.

test('compare — plain releases order numerically, not lexically', () => {
  assert.equal(compareVersions('0.7.0', '0.7.1'), -1);
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '10 > 9, which a string compare gets wrong');
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('compare — a prerelease build is BEHIND the plain release of the same core', () => {
  // The internal publishes are 0.7.0-staging.<buildId>; the public build is 0.7.0.
  assert.equal(compareVersions('0.7.0-staging.4821', '0.7.0'), -1);
  assert.equal(compareVersions('0.7.0', '0.7.0-staging.4821'), 1);
});

test('compare — two internal builds order by build NUMBER, so .10 beats .9', () => {
  assert.equal(compareVersions('0.7.0-staging.9', '0.7.0-staging.10'), -1);
  assert.equal(compareVersions('0.7.0-staging.4821', '0.7.0-staging.4102'), 1);
  assert.equal(compareVersions('0.7.0-staging.7', '0.7.0-staging.7'), 0);
});

test('compare — a core bump outranks any prerelease on the older core', () => {
  assert.equal(compareVersions('0.7.0-staging.99999', '0.8.0-staging.1'), -1);
});

test('compare — build metadata never changes the order', () => {
  assert.equal(compareVersions('0.7.0+abc', '0.7.0'), 0);
  assert.equal(compareVersions('0.7.0+abc', '0.7.1'), -1);
});

test('compare — anything unparseable answers null rather than a guess', () => {
  assert.equal(compareVersions('0.7', '0.7.0'), null);
  assert.equal(compareVersions('latest', '0.7.0'), null);
  assert.equal(compareVersions(null, '0.7.0'), null);
  assert.equal(compareVersions('0.7.0', undefined), null);
});

test('isNewer — fails CLOSED, so a malformed version can never produce a nag', () => {
  assert.equal(isNewer('0.8.0', '0.7.0'), true);
  assert.equal(isNewer('0.7.0', '0.7.0'), false);
  assert.equal(isNewer('0.7.0', '0.8.0'), false);
  assert.equal(isNewer('latest', '0.7.0'), false, 'uncomparable is not newer');
  assert.equal(isNewer('0.8.0', 'not-a-version'), false);
});
