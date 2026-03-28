import test from 'node:test';
import assert from 'node:assert/strict';
import { inferSummaryMetadata } from '../src/core/summary-metadata.js';

test('inferSummaryMetadata marks release SOP as critical with release tag', () => {
  const result = inferSummaryMetadata(
    '使用 npm run release:patch -- -m <commit message> 並 git push tags',
    'Release SOP and workflow'
  );

  assert.equal(result.impactLevel, 3);
  assert.ok(result.tags?.includes('release'));
});

test('inferSummaryMetadata marks chat history cursor fix as important web memory', () => {
  const result = inferSummaryMetadata(
    'chat history 改成 cursor-based loading 與 incremental prepend',
    'Web history stabilization'
  );

  assert.equal(result.impactLevel, 2);
  assert.ok(result.tags?.includes('web'));
});

test('inferSummaryMetadata keeps generic content at impact level 1', () => {
  const result = inferSummaryMetadata('今天只是一般進度紀錄', 'Daily note');

  assert.equal(result.impactLevel, 1);
  assert.deepEqual(result.tags, []);
});
