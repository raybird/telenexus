import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryBackfillReport } from '../src/services/memory-backfill.js';
import { MemoryBackfillWorker } from '../src/services/memory-backfill-worker.js';

function makeReport(): MemoryBackfillReport {
  return {
    ok: true,
    mode: 'dry-run',
    archiveDbPath: '/tmp/archive.db',
    retrievalDbPath: '/tmp/retrieval.db',
    checkpointPath: '/tmp/checkpoint.json',
    checkpointBefore: null,
    checkpointAfter: null,
    scannedSessions: 1,
    candidates: [],
    duplicateEstimate: 0,
    written: 0,
    duplicatesSkipped: 0,
    writeAttempted: false
  };
}

test('MemoryBackfillWorker skips run when no new archive sessions exist', async () => {
  let runCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    hasPendingArchiveSessions: () => false,
    runBackfill: async () => {
      runCount += 1;
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  assert.equal(runCount, 0);
});

test('MemoryBackfillWorker runs backfill and calls onAfterRun when work exists', async () => {
  let runCount = 0;
  let afterRunCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    hasPendingArchiveSessions: () => true,
    onAfterRun: () => {
      afterRunCount += 1;
    },
    runBackfill: async () => {
      runCount += 1;
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  assert.equal(runCount, 1);
  assert.equal(afterRunCount, 1);
});

test('MemoryBackfillWorker releases inFlight after timeout-like failure', async () => {
  let runCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    hasPendingArchiveSessions: () => true,
    runBackfill: async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error('memory backfill timeout after 10ms');
      }
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  await worker.runOnce('manual');
  assert.equal(runCount, 2);
});
