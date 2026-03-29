import Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { resolveDbPath } from '../utils/paths.js';

const log = createLogger('memory');

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: number;
}

export interface PagedChatMessages {
  items: ChatMessage[];
  total: number;
  offset: number;
  limit: number;
}

export interface CursorChatMessages {
  items: ChatMessage[];
  total: number;
  limit: number;
  hasMore: boolean;
  nextBeforeTimestamp: number | null;
}

export interface SummaryMessage {
  id: number;
  role: 'user' | 'model';
  content: string;
  summary: string;
  timestamp: number;
  impactLevel: number;
  tags: string[];
}

export interface MessageMetadata {
  summary?: string;
  impactLevel?: number;
  tags?: string[];
}

export interface Schedule {
  id: number;
  user_id: string;
  name: string;
  cron: string;
  prompt: string;
  created_at: number;
  is_active: boolean;
}

const SUMMARY_SEARCH_CONFIG = {
  tokenLimit: 8,
  candidateMultiplier: 4,
  minCandidatePool: 12,
  scoring: {
    exactSummaryMatch: 10,
    exactContentMatch: 4,
    tokenSummaryMatch: 4,
    tokenContentMatch: 1,
    tokenTagMatch: 5,
    impactLevelBonus: 2,
    recentWindowDays: 7,
    recentBonus: 2,
    warmWindowDays: 30,
    warmBonus: 1
  }
} as const;

export class MemoryManager {
  private db: Database.Database;

  constructor() {
    // 初始化資料庫，允許由環境變數指定路徑
    const dbPath = resolveDbPath();
    this.db = new Database(dbPath); // verbose: console.log 可選

    // 啟用 WAL 模式 (Write-Ahead Logging) 提升效能與並發性
    this.db.pragma('journal_mode = WAL');

    this.initTable();
  }

  private initTable() {
    // 建立 messages 表格
    const stmt = this.db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'model')),
        content TEXT NOT NULL,
        summary TEXT,
        impact_level INTEGER NOT NULL DEFAULT 1,
        tags TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    stmt.run();

    this.ensureMessageSchema();

    // 建立索引加速查詢
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_user_timestamp ON messages(user_id, timestamp)`)
      .run();
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_messages_user_impact_timestamp ON messages(user_id, impact_level, timestamp)`
      )
      .run();

    // 建立 FTS5 虛擬表格 (全文檢索)
    this.db
      .prepare(
        `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        user_id,
        role,
        content,
        timestamp
      )
    `
      )
      .run();

    // 建立 schedules 表格
    const scheduleStmt = this.db.prepare(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1))
      )
    `);
    scheduleStmt.run();

    // 排程查詢索引
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(is_active)`)
      .run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id)`).run();
  }

  private ensureMessageSchema(): void {
    const columns = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    const hasImpactLevel = columns.some((column) => column.name === 'impact_level');
    const hasTags = columns.some((column) => column.name === 'tags');

    if (!hasImpactLevel) {
      this.db
        .prepare(`ALTER TABLE messages ADD COLUMN impact_level INTEGER NOT NULL DEFAULT 1`)
        .run();
    }

    if (!hasTags) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN tags TEXT`).run();
    }
  }

  private normalizeImpactLevel(value?: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(1, Math.min(3, Math.floor(value as number)));
  }

  private normalizeTags(tags?: string[]): string[] {
    if (!Array.isArray(tags) || tags.length === 0) {
      return [];
    }

    const normalized: string[] = [];
    for (const tag of tags) {
      const cleaned = String(tag || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-');
      if (!cleaned || normalized.includes(cleaned)) {
        continue;
      }
      normalized.push(cleaned);
    }
    return normalized;
  }

  private parseTags(raw: string | null | undefined): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return this.normalizeTags(parsed as string[]);
      }
    } catch {
      // ignore malformed legacy tag payloads
    }
    return [];
  }

  private toSummaryMessage(row: {
    id: number;
    role: string;
    content: string;
    summary: string;
    impact_level: number;
    tags: string | null;
    timestamp: number;
  }): SummaryMessage {
    return {
      id: row.id,
      role: row.role as 'user' | 'model',
      content: row.content,
      summary: row.summary,
      impactLevel: this.normalizeImpactLevel(row.impact_level),
      tags: this.parseTags(row.tags),
      timestamp: row.timestamp
    };
  }

  private tokenizeSummarySearchQuery(query: string): string[] {
    const parts = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    return Array.from(new Set(parts)).slice(0, SUMMARY_SEARCH_CONFIG.tokenLimit);
  }

  private scoreSummarySearchResult(item: SummaryMessage, query: string, tokens: string[]): number {
    const scoring = SUMMARY_SEARCH_CONFIG.scoring;
    const loweredQuery = query.toLowerCase();
    const summary = item.summary.toLowerCase();
    const content = item.content.toLowerCase();
    const tags = new Set(item.tags.map((tag) => tag.toLowerCase()));
    let score = 0;

    if (summary.includes(loweredQuery)) score += scoring.exactSummaryMatch;
    if (content.includes(loweredQuery)) score += scoring.exactContentMatch;

    for (const token of tokens) {
      if (summary.includes(token)) score += scoring.tokenSummaryMatch;
      if (content.includes(token)) score += scoring.tokenContentMatch;
      if (tags.has(token)) score += scoring.tokenTagMatch;
    }

    score += Math.max(0, item.impactLevel - 1) * scoring.impactLevelBonus;

    const ageDays = Math.max(0, Date.now() - item.timestamp) / (1000 * 60 * 60 * 24);
    if (ageDays <= scoring.recentWindowDays) score += scoring.recentBonus;
    else if (ageDays <= scoring.warmWindowDays) score += scoring.warmBonus;

    return score;
  }

  /**
   * 新增訊息到資料庫
   */
  addMessage(
    userId: string,
    role: 'user' | 'model',
    content: string,
    metadata?: string | MessageMetadata
  ): number {
    const timestamp = Date.now();
    const summary = typeof metadata === 'string' ? metadata : metadata?.summary;
    const impactLevel = this.normalizeImpactLevel(
      typeof metadata === 'string' ? undefined : metadata?.impactLevel
    );
    const tags = this.normalizeTags(typeof metadata === 'string' ? undefined : metadata?.tags);
    const stmt = this.db.prepare(`
      INSERT INTO messages (user_id, role, content, summary, impact_level, tags, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      userId,
      role,
      content,
      summary || null,
      impactLevel,
      tags.length > 0 ? JSON.stringify(tags) : null,
      timestamp
    );

    // 同步到 FTS5 表格
    const ftsStmt = this.db.prepare(`
      INSERT INTO messages_fts (rowid, user_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    ftsStmt.run(result.lastInsertRowid, userId, role, content, timestamp);
    return timestamp;
  }

  updateMessageMetadata(
    userId: string,
    role: 'user' | 'model',
    timestamp: number,
    metadata: MessageMetadata
  ): void {
    const summary = metadata.summary?.trim();
    const impactLevel = this.normalizeImpactLevel(metadata.impactLevel);
    const tags = this.normalizeTags(metadata.tags);
    const stmt = this.db.prepare(`
      UPDATE messages
      SET summary = COALESCE(?, summary), impact_level = ?, tags = ?
      WHERE user_id = ? AND role = ? AND timestamp = ?
    `);
    stmt.run(
      summary || null,
      impactLevel,
      tags.length > 0 ? JSON.stringify(tags) : null,
      userId,
      role,
      timestamp
    );
  }

  updateMessageMetadataById(id: number, metadata: MessageMetadata): void {
    const summary = metadata.summary?.trim();
    const impactLevel = this.normalizeImpactLevel(metadata.impactLevel);
    const tags = this.normalizeTags(metadata.tags);
    const stmt = this.db.prepare(`
      UPDATE messages
      SET summary = COALESCE(?, summary), impact_level = ?, tags = ?
      WHERE id = ?
    `);
    stmt.run(summary || null, impactLevel, tags.length > 0 ? JSON.stringify(tags) : null, id);
  }

  /**
   * 跳脫 FTS5 查詢，防止語法注入（OR、NOT、* 等）
   */
  private escapeFts5Query(raw: string): string {
    const sanitized = raw.replace(/"/g, '');
    return `"${sanitized}"`;
  }

  /**
   * 使用 FTS5 全文檢索搜尋對話
   */
  search(userId: string, query: string, limit: number = 10): ChatMessage[] {
    const escapedQuery = this.escapeFts5Query(query);
    const stmt = this.db.prepare(`
      SELECT m.role, m.content, m.timestamp
      FROM messages_fts f
      INNER JOIN messages m ON f.rowid = m.id
      WHERE f.user_id = ? AND f.content MATCH ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(userId, escapedQuery, limit) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      role: row.role as 'user' | 'model',
      content: row.content,
      timestamp: row.timestamp
    }));
  }

  /**
   * 取得最近 N 則對話
   */
  getRecentMessages(userId: string, limit: number = 20): ChatMessage[] {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(userId, safeLimit) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      role: row.role as 'user' | 'model',
      content: row.content,
      timestamp: row.timestamp
    }));
  }

  getRecentConversation(userId: string, limit: number = 10): ChatMessage[] {
    const safeLimit = Math.max(1, Math.min(50, limit));
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(userId, safeLimit) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows
      .map((row) => ({
        role: row.role as 'user' | 'model',
        content: row.content,
        timestamp: row.timestamp
      }))
      .reverse();
  }

  getRecentSummaries(
    userId: string,
    limit: number = 10,
    minImpactLevel: number = 1
  ): SummaryMessage[] {
    const safeLimit = Math.max(1, Math.min(50, limit));
    const safeImpactLevel = this.normalizeImpactLevel(minImpactLevel);
    const stmt = this.db.prepare(`
      SELECT id, role, content, summary, impact_level, tags, timestamp
      FROM messages
      WHERE user_id = ?
        AND summary IS NOT NULL
        AND TRIM(summary) != ''
        AND impact_level >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(userId, safeImpactLevel, safeLimit) as Array<{
      id: number;
      role: string;
      content: string;
      summary: string;
      impact_level: number;
      tags: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'model',
      content: row.content,
      summary: row.summary,
      impactLevel: this.normalizeImpactLevel(row.impact_level),
      tags: this.parseTags(row.tags),
      timestamp: row.timestamp
    }));
  }

  searchSummaries(
    userId: string,
    query: string,
    limit: number = 5,
    minImpactLevel: number = 1
  ): SummaryMessage[] {
    const trimmed = query.trim();
    if (!trimmed) {
      log.debug('summary-search.skipped', { reason: 'empty_query', userId });
      return [];
    }

    const safeLimit = Math.max(1, Math.min(20, limit));
    const safeImpactLevel = this.normalizeImpactLevel(minImpactLevel);
    const tokens = this.tokenizeSummarySearchQuery(trimmed);
    const escapedQuery = this.escapeFts5Query(trimmed);
    const fetchLimit = Math.max(
      safeLimit * SUMMARY_SEARCH_CONFIG.candidateMultiplier,
      SUMMARY_SEARCH_CONFIG.minCandidatePool
    );
    const ftsStmt = this.db.prepare(`
      SELECT m.id, m.role, m.content, m.summary, m.impact_level, m.tags, m.timestamp
      FROM messages_fts f
      INNER JOIN messages m ON f.rowid = m.id
      WHERE f.user_id = ?
        AND f.content MATCH ?
        AND m.summary IS NOT NULL
        AND TRIM(m.summary) != ''
        AND m.impact_level >= ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);

    const likeClauses = ['LOWER(summary) LIKE ?'];
    const likeParams: Array<string | number> = [`%${trimmed.toLowerCase()}%`];
    for (const token of tokens) {
      likeClauses.push('LOWER(summary) LIKE ?');
      likeParams.push(`%${token}%`);
      likeClauses.push("LOWER(COALESCE(tags, '')) LIKE ?");
      likeParams.push(`%${token}%`);
    }

    const summaryStmt = this.db.prepare(`
      SELECT id, role, content, summary, impact_level, tags, timestamp
      FROM messages
      WHERE user_id = ?
        AND summary IS NOT NULL
        AND TRIM(summary) != ''
        AND impact_level >= ?
        AND (${likeClauses.join(' OR ')})
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const ftsRows = ftsStmt.all(userId, escapedQuery, safeImpactLevel, fetchLimit) as Array<{
      id: number;
      role: string;
      content: string;
      summary: string;
      impact_level: number;
      tags: string | null;
      timestamp: number;
    }>;

    const summaryRows = summaryStmt.all(
      userId,
      safeImpactLevel,
      ...likeParams,
      fetchLimit
    ) as Array<{
      id: number;
      role: string;
      content: string;
      summary: string;
      impact_level: number;
      tags: string | null;
      timestamp: number;
    }>;

    const merged = new Map<number, SummaryMessage>();
    for (const row of [...summaryRows, ...ftsRows]) {
      merged.set(row.id, this.toSummaryMessage(row));
    }

    const results = [...merged.values()]
      .sort((a, b) => {
        const scoreDiff =
          this.scoreSummarySearchResult(b, trimmed, tokens) -
          this.scoreSummarySearchResult(a, trimmed, tokens);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return b.timestamp - a.timestamp;
      })
      .slice(0, safeLimit);

    log.debug('summary-search.completed', {
      userId,
      query: trimmed,
      limit: safeLimit,
      minImpactLevel: safeImpactLevel,
      tokenCount: tokens.length,
      ftsCandidates: ftsRows.length,
      summaryCandidates: summaryRows.length,
      results: results.length
    });

    return results;
  }

  listSummaryMessages(
    userId: string,
    limit: number = 20,
    minImpactLevel: number = 1
  ): SummaryMessage[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const safeImpactLevel = this.normalizeImpactLevel(minImpactLevel);
    const stmt = this.db.prepare(`
      SELECT id, role, content, summary, impact_level, tags, timestamp
      FROM messages
      WHERE user_id = ?
        AND summary IS NOT NULL
        AND TRIM(summary) != ''
        AND impact_level >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(userId, safeImpactLevel, safeLimit) as Array<{
      id: number;
      role: string;
      content: string;
      summary: string;
      impact_level: number;
      tags: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'model',
      content: row.content,
      summary: row.summary,
      impactLevel: this.normalizeImpactLevel(row.impact_level),
      tags: this.parseTags(row.tags),
      timestamp: row.timestamp
    }));
  }

  /**
   * 取得分頁對話歷史（最新在前）
   */
  getMessagesPage(userId: string, offset: number = 0, limit: number = 20): PagedChatMessages {
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(1, Math.min(200, limit));

    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM messages
      WHERE user_id = ?
    `);
    const countRow = countStmt.get(userId) as { count: number } | undefined;
    const total = countRow?.count || 0;

    const pageStmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    const rows = pageStmt.all(userId, safeLimit, safeOffset) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    const items = rows.map((row) => ({
      role: row.role as 'user' | 'model',
      content: row.content,
      timestamp: row.timestamp
    }));

    return {
      items,
      total,
      offset: safeOffset,
      limit: safeLimit
    };
  }

  /**
   * 以時間游標載入更舊訊息（timestamp < beforeTimestamp）。
   */
  getMessagesBefore(
    userId: string,
    beforeTimestamp: number,
    limit: number = 20
  ): CursorChatMessages {
    const safeBefore = Math.max(1, Math.floor(beforeTimestamp));
    const safeLimit = Math.max(1, Math.min(200, limit));

    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM messages
      WHERE user_id = ?
    `);
    const countRow = countStmt.get(userId) as { count: number } | undefined;
    const total = countRow?.count || 0;

    const pageStmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE user_id = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = pageStmt.all(userId, safeBefore, safeLimit + 1) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    const hasMore = rows.length > safeLimit;
    const sliced = hasMore ? rows.slice(0, safeLimit) : rows;
    const items = sliced.map((row) => ({
      role: row.role as 'user' | 'model',
      content: row.content,
      timestamp: row.timestamp
    }));

    const nextBeforeTimestamp =
      items.length > 0 ? Math.min(...items.map((item) => Number(item.timestamp || 0))) : null;

    return {
      items,
      total,
      limit: safeLimit,
      hasMore,
      nextBeforeTimestamp
    };
  }

  /**
   * 清除特定使用者的記憶
   */
  clear(userId: string): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE user_id = ?');
    stmt.run(userId);

    // 同步清除 FTS5
    const ftsStmt = this.db.prepare('DELETE FROM messages_fts WHERE user_id = ?');
    ftsStmt.run(userId);
  }

  /**
   * 新增排程任務
   */
  addSchedule(userId: string, name: string, cron: string, prompt: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO schedules (user_id, name, cron, prompt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, name, cron, prompt, Date.now());
    return result.lastInsertRowid as number;
  }

  /**
   * 取得所有啟用中的排程
   */
  getActiveSchedules(): Schedule[] {
    const stmt = this.db.prepare(`
      SELECT id, user_id, name, cron, prompt, created_at, is_active
      FROM schedules
      WHERE is_active = 1
    `);
    const rows = stmt.all() as Array<{
      id: number;
      user_id: string;
      name: string;
      cron: string;
      prompt: string;
      created_at: number;
      is_active: number;
    }>;

    return rows.map((row) => ({
      ...row,
      is_active: row.is_active === 1
    }));
  }

  /**
   * 取得特定使用者的所有排程
   */
  getUserSchedules(userId: string): Schedule[] {
    const stmt = this.db.prepare(`
      SELECT id, user_id, name, cron, prompt, created_at, is_active
      FROM schedules
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(userId) as Array<{
      id: number;
      user_id: string;
      name: string;
      cron: string;
      prompt: string;
      created_at: number;
      is_active: number;
    }>;

    return rows.map((row) => ({
      ...row,
      is_active: row.is_active === 1
    }));
  }

  /**
   * 刪除排程
   */
  removeSchedule(id: number): void {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
    stmt.run(id);
  }

  /**
   * 取得單一排程
   */
  getScheduleById(id: number): Schedule | null {
    const stmt = this.db.prepare(`
      SELECT id, user_id, name, cron, prompt, created_at, is_active
      FROM schedules
      WHERE id = ?
      LIMIT 1
    `);
    const row = stmt.get(id) as
      | {
          id: number;
          user_id: string;
          name: string;
          cron: string;
          prompt: string;
          created_at: number;
          is_active: number;
        }
      | undefined;
    if (!row) return null;
    return {
      ...row,
      is_active: row.is_active === 1
    };
  }

  /**
   * 更新排程內容
   */
  updateSchedule(id: number, name: string, cron: string, prompt: string): void {
    const stmt = this.db.prepare(`
      UPDATE schedules
      SET name = ?, cron = ?, prompt = ?
      WHERE id = ?
    `);
    stmt.run(name, cron, prompt, id);
  }

  /**
   * 切換排程的啟用狀態
   */
  toggleSchedule(id: number, isActive: boolean): void {
    const stmt = this.db.prepare('UPDATE schedules SET is_active = ? WHERE id = ?');
    stmt.run(isActive ? 1 : 0, id);
  }

  /**
   * 取得使用者最後一次對話的時間戳
   * @param userId 使用者 ID
   * @returns 最後對話的 timestamp，若無紀錄則返回 null
   */
  getLastMessageTime(userId: string): number | null {
    const stmt = this.db.prepare(`
      SELECT MAX(timestamp) as lastTime
      FROM messages
      WHERE user_id = ?
    `);
    const row = stmt.get(userId) as { lastTime: number | null } | undefined;
    return row?.lastTime || null;
  }

  /**
   * 取得指定時間範圍內的對話歷史 (供追蹤系統使用)
   * @param userId 使用者 ID
   * @param hours 往前查詢的小時數
   */
  getExtendedHistory(userId: string, hours: number = 24): ChatMessage[] {
    const safeHours = Math.max(1, Math.min(168, hours));
    const cutoffTime = Date.now() - safeHours * 60 * 60 * 1000;
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE user_id = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(userId, cutoffTime) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      role: row.role as 'user' | 'model',
      content: row.content,
      timestamp: row.timestamp
    }));
  }

  /**
   * 取得記憶統計資訊
   */
  getStats(userId: string): { totalMessages: number; lastActive: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count, MAX(timestamp) as last_active
      FROM messages
      WHERE user_id = ?
    `);
    const result = stmt.get(userId) as { count: number; last_active: number };
    return {
      totalMessages: result.count || 0,
      lastActive: result.last_active || 0
    };
  }

  /**
   * 刪除最近的 N 則對話
   */
  deleteRecentMessages(userId: string, count: number): number {
    // 1. 找出要刪除的 ID
    const selectStmt = this.db.prepare(`
      SELECT id FROM messages
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = selectStmt.all(userId, count) as { id: number }[];

    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // 2. 刪除 messages
    const deleteStmt = this.db.prepare(`
      DELETE FROM messages WHERE id IN (${placeholders})
    `);
    deleteStmt.run(...ids);

    // 3. 刪除 FTS5
    const deleteFtsStmt = this.db.prepare(`
      DELETE FROM messages_fts WHERE rowid IN (${placeholders})
    `);
    deleteFtsStmt.run(...ids);

    return ids.length;
  }
}
