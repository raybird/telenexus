import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReadmeVersionBadge,
  isAllowedReleaseBranch,
  parseArgs,
  updateReadmeVersionBadge,
  validateReadmeVersionBadge
} from '../scripts/release-workflow.mjs';

test('parseArgs supports bump, message, and dry-run', () => {
  const parsed = parseArgs(['minor', '--dry-run', '-m', 'feat: release prep']);

  assert.equal(parsed.bump, 'minor');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.message, 'feat: release prep');
});

test('isAllowedReleaseBranch accepts main and release branches', () => {
  assert.equal(isAllowedReleaseBranch('main'), true);
  assert.equal(isAllowedReleaseBranch('release/v2'), true);
  assert.equal(isAllowedReleaseBranch('feature/test'), false);
});

test('validateReadmeVersionBadge checks package version alignment', () => {
  const readme = '<img alt="version" src="https://img.shields.io/badge/version-v2.6.25-1f6feb">';

  assert.equal(extractReadmeVersionBadge(readme), '2.6.25');
  assert.deepEqual(validateReadmeVersionBadge(readme, '2.6.25'), { ok: true });
  assert.deepEqual(validateReadmeVersionBadge(readme, '2.6.26'), {
    ok: false,
    reason: 'README version badge (2.6.25) does not match package.json version (2.6.26).'
  });
});

test('updateReadmeVersionBadge rewrites badge version in place', () => {
  const readme = '<img alt="version" src="https://img.shields.io/badge/version-v2.6.28-1f6feb">';
  const updated = updateReadmeVersionBadge(readme, '2.6.29');

  assert.equal(
    updated,
    '<img alt="version" src="https://img.shields.io/badge/version-v2.6.29-1f6feb">'
  );
});

test('updateReadmeVersionBadge returns null when badge is missing', () => {
  assert.equal(updateReadmeVersionBadge('no badge here', '2.6.29'), null);
});
