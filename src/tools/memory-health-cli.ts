#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  collectMemoryHealthReport,
  formatMemoryHealthMarkdown
} from '../services/memory-health.js';

dotenv.config();

const program = new Command();

program
  .name('memory-health')
  .description('Show memory archive and backfill health')
  .version('0.1.0');

program.option('--json', 'Output JSON').action((options) => {
  const report = collectMemoryHealthReport();
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatMemoryHealthMarkdown(report));
});

program.parse();
