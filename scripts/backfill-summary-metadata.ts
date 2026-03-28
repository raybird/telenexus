import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'node:path';
import { inferSummaryMetadata } from '../src/core/summary-metadata.js';

dotenv.config();

function resolveDbPath() {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'moltbot.db');
  }

  return path.resolve(process.cwd(), 'moltbot.db');
}

function parseArgs(argv: string[]) {
  const options = {
    dryRun: false,
    force: false,
    userId: '',
    limit: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--user') {
      options.userId = (argv[index + 1] || '').trim();
      index += 1;
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      options.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      index += 1;
    }
  }

  return options;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(resolveDbPath());

  const clauses = ['summary IS NOT NULL', "TRIM(summary) != ''"];
  const params: Array<string | number> = [];
  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (!options.force) {
    clauses.push("(impact_level = 1 OR tags IS NULL OR TRIM(tags) = '')");
  }

  let sql = `
    SELECT id, user_id, role, content, summary, impact_level, tags, timestamp
    FROM messages
    WHERE ${clauses.join(' AND ')}
    ORDER BY timestamp ASC
  `;
  if (options.limit > 0) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    content: string;
    summary: string;
    impact_level: number;
    tags: string | null;
  }>;
  const updateStmt = db.prepare(`
    UPDATE messages
    SET impact_level = ?, tags = ?
    WHERE id = ?
  `);

  let scanned = 0;
  let changed = 0;
  let impact2 = 0;
  let impact3 = 0;
  const tagCounts = new Map<string, number>();

  const tx = db.transaction((items: typeof rows) => {
    for (const row of items) {
      scanned += 1;
      const next = inferSummaryMetadata(row.content, row.summary);
      const currentTags = parseTags(row.tags);
      const normalizedTags = next.tags || [];
      const sameImpact = Number(row.impact_level || 1) === next.impactLevel;
      const sameTagSet = sameTags(currentTags, normalizedTags);
      if (sameImpact && sameTagSet) {
        continue;
      }

      changed += 1;
      if (next.impactLevel === 2) impact2 += 1;
      if (next.impactLevel === 3) impact3 += 1;
      for (const tag of normalizedTags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }

      if (!options.dryRun) {
        updateStmt.run(
          next.impactLevel,
          normalizedTags.length > 0 ? JSON.stringify(normalizedTags) : null,
          row.id
        );
      }
    }
  });

  tx(rows);

  const tagSummary = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => `${tag}:${count}`)
    .join(', ');

  console.log(`DB: ${resolveDbPath()}`);
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'write'}`);
  console.log(`Scanned: ${scanned}`);
  console.log(`Changed: ${changed}`);
  console.log(`Impact=2: ${impact2}`);
  console.log(`Impact=3: ${impact3}`);
  console.log(`Top tags: ${tagSummary || '(none)'}`);
}

main();
