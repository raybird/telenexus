#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  getMemoryBackfillDefaults,
  runMemoryBackfill,
  runMemoryBackfillDryRun
} from '../services/memory-backfill.js';

dotenv.config();

const defaults = getMemoryBackfillDefaults();
const program = new Command();

program
  .name('memory-backfill')
  .description('sessions.db -> memory.db backfill worker')
  .version('0.1.0');

program
  .command('once')
  .description('Run one backfill scan from sessions.db')
  .option('--batch-size <number>', 'Max sessions to scan', String(defaults.batchSize))
  .option('--max-candidates <number>', 'Max candidates to emit', String(defaults.maxCandidates))
  .option('--no-from-checkpoint', 'Ignore saved checkpoint and scan from oldest session')
  .option('--save-checkpoint', 'Persist checkpoint after scan')
  .option('--write', 'Write candidates into memory.db')
  .option('--json', 'Output JSON report')
  .action((options) => {
    const sharedOptions = {
      batchSize: Number.parseInt(options.batchSize, 10),
      maxCandidates: Number.parseInt(options.maxCandidates, 10),
      fromCheckpoint: options.fromCheckpoint,
      saveCheckpoint: options.saveCheckpoint === true
    };
    const report = options.write
      ? runMemoryBackfill({ ...sharedOptions, write: true })
      : runMemoryBackfillDryRun(sharedOptions);

    if (options.write && defaults.enabled === false) {
      console.warn(
        'WARNING: MEMORY_BACKFILL_ENABLED=false; CLI --write explicitly forced one write run.'
      );
    }
    if (options.write && defaults.dryRun) {
      console.warn(
        'WARNING: MEMORY_BACKFILL_DRY_RUN=true; CLI --write overrides dry-run for this run.'
      );
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`## Memory Backfill ${report.mode === 'write' ? 'Write Run' : 'Dry Run'}`);
    console.log(`- scannedSessions: ${report.scannedSessions}`);
    console.log(`- candidates: ${report.candidates.length}`);
    console.log(`- duplicateEstimate: ${report.duplicateEstimate}`);
    console.log(`- written: ${report.written}`);
    console.log(`- duplicatesSkipped: ${report.duplicatesSkipped}`);
    console.log(
      `- checkpointBefore: ${report.checkpointBefore?.lastProcessedTimestamp || '(none)'}`
    );
    console.log(`- checkpointAfter: ${report.checkpointAfter?.lastProcessedTimestamp || '(none)'}`);
    console.log(`- checkpointSaved: ${String(options.saveCheckpoint === true)}`);
    console.log('');

    if (report.candidates.length === 0) {
      console.log('(no candidates)');
      return;
    }

    for (const candidate of report.candidates) {
      console.log(`- [${candidate.type}] ${candidate.summary}`);
      console.log(
        `  entity=${candidate.entityName} session=${candidate.sessionId} user=${candidate.sourceUserId || '(unknown)'} confidence=${candidate.confidence}`
      );
      console.log(
        `  tags=${candidate.tags.join(', ') || '(none)'} signals=${candidate.signals.join(', ')}`
      );
    }
  });

program.parse();
