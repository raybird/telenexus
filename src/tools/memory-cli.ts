#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import { MemoryManager } from '../core/memory.js';

dotenv.config({ quiet: true });

const program = new Command();

program.name('memory-cli').description('CLI tool for managing Moltbot AI memory').version('2.2.0');

function parseImpactLevel(value: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) {
    console.error('❌ impact level must be 1, 2, or 3.');
    process.exit(1);
  }
  return parsed;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Helper to get User ID
function getUserId(options: { user?: string }): string {
  const userId = options.user || process.env.ALLOWED_USER_ID;
  if (!userId) {
    console.error('❌ Error: User ID is required. Set ALLOWED_USER_ID or use --user flag.');
    process.exit(1);
  }
  return userId;
}

// 1. Search Command
program
  .command('search')
  .description('Search chat history by keyword')
  .argument('<query>', 'Keyword to search for')
  .option('-u, --user <userId>', 'User ID')
  .option('-l, --limit <number>', 'Max results', '5')
  .action((query, options) => {
    try {
      const userId = getUserId(options);
      const memory = new MemoryManager();
      const limit = parseInt(options.limit, 10);

      console.log(`🔍 Searching memory for: "${query}"...`);
      const results = memory.search(userId, query, limit);

      if (results.length === 0) {
        console.log('📭 No matching records found.');
        return;
      }

      console.log(`✅ Found ${results.length} results:\n`);
      results.forEach((msg, idx) => {
        const date = new Date(msg.timestamp).toLocaleString('zh-TW');
        const role = msg.role === 'user' ? 'User' : 'AI';
        const preview =
          msg.content.length > 150 ? msg.content.substring(0, 150) + '...' : msg.content;

        console.log(`${idx + 1}. [${date}] ${role}: ${preview}`);
        console.log('---');
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Search failed:', message);
      process.exit(1);
    }
  });

// 2. Stats Command
program
  .command('stats')
  .description('Show memory usage statistics')
  .option('-u, --user <userId>', 'User ID')
  .action((options) => {
    try {
      const userId = getUserId(options);
      const memory = new MemoryManager();
      const stats = memory.getStats(userId);

      console.log('📊 Memory Statistics:');
      console.log(`   User ID: ${userId}`);
      console.log(`   Total Messages: ${stats.totalMessages}`);
      console.log(
        `   Last Active: ${stats.lastActive ? new Date(stats.lastActive).toLocaleString('zh-TW') : 'Never'}`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to get stats:', message);
      process.exit(1);
    }
  });

// 3. Summaries Command
program
  .command('summaries')
  .description('List recent summarized memories with impact metadata')
  .option('-u, --user <userId>', 'User ID')
  .option('-l, --limit <number>', 'Max results', '10')
  .option('-i, --impact <number>', 'Minimum impact level', '1')
  .action((options) => {
    try {
      const userId = getUserId(options);
      const memory = new MemoryManager();
      const limit = parseInt(options.limit, 10);
      const minImpact = parseImpactLevel(options.impact);
      const results = memory.listSummaryMessages(userId, limit, minImpact);

      if (results.length === 0) {
        console.log('📭 No summarized memories found.');
        return;
      }

      console.log(`🧠 Found ${results.length} summarized memories:\n`);
      results.forEach((msg) => {
        const date = new Date(msg.timestamp).toLocaleString('zh-TW');
        const role = msg.role === 'user' ? 'User' : 'AI';
        const summary = msg.summary.length > 220 ? msg.summary.slice(0, 220) + '...' : msg.summary;
        const tags = msg.tags.length > 0 ? msg.tags.join(', ') : '-';

        console.log(`#${msg.id} [impact=${msg.impactLevel}] [${role}] ${date}`);
        console.log(`tags: ${tags}`);
        console.log(summary);
        console.log('---');
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to list summaries:', message);
      process.exit(1);
    }
  });

// 4. Tag Command
program
  .command('tag')
  .description('Update impact level and tags for a summarized memory by message ID')
  .argument('<id>', 'Message ID')
  .requiredOption('-i, --impact <number>', 'Impact level (1-3)')
  .option('-t, --tags <tags>', 'Comma-separated tags, e.g. gemini,runner,release')
  .option('-s, --summary <summary>', 'Override summary text')
  .action((id, options) => {
    try {
      const messageId = parseInt(id, 10);
      if (!Number.isFinite(messageId) || messageId <= 0) {
        console.error('❌ Invalid message ID.');
        process.exit(1);
      }

      const memory = new MemoryManager();
      const impactLevel = parseImpactLevel(options.impact);
      const tags = parseTags(options.tags);
      memory.updateMessageMetadataById(messageId, {
        impactLevel,
        tags,
        ...(options.summary ? { summary: options.summary } : {})
      });

      console.log(`✅ Updated message #${messageId}`);
      console.log(`   impact: ${impactLevel}`);
      console.log(`   tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`);
      if (options.summary) {
        console.log('   summary: overridden');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to update metadata:', message);
      process.exit(1);
    }
  });

// 5. Forget Command
program
  .command('forget')
  .description('Forget the most recent messages')
  .argument('<count>', 'Number of messages to forget (e.g. 2)')
  .option('-u, --user <userId>', 'User ID')
  .action((countStr, options) => {
    try {
      const userId = getUserId(options);
      const count = parseInt(countStr, 10);

      if (isNaN(count) || count <= 0) {
        console.error('❌ Invalid count number.');
        process.exit(1);
      }

      const memory = new MemoryManager();
      const deleted = memory.deleteRecentMessages(userId, count);

      console.log(`🗑️  Forgot ${deleted} recent message(s).`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to forget messages:', message);
      process.exit(1);
    }
  });

// 6. Clear Command
program
  .command('clear')
  .description('Clear ALL memory for the user (Irreversible)')
  .option('-u, --user <userId>', 'User ID')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    try {
      const userId = getUserId(options);

      if (!options.force) {
        console.warn('⚠️  Warning: This will delete ALL chat history for this user.');
        console.warn('   Use --force to confirm.');
        return;
      }

      const memory = new MemoryManager();
      memory.clear(userId);

      console.log(`💥 All memory cleared for user: ${userId}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to clear memory:', message);
      process.exit(1);
    }
  });

program.parse();
