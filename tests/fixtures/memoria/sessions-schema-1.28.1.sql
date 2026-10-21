-- Memoria 1.28.1 sessions.db 中遷移工具會碰到的資料表、索引與 trigger。
-- 只有結構，不含資料；2026-10-21 由另一台部署的資料副本以 sqlite_master 匯出。
CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        timestamp DATETIME,
        event_type TEXT,
        content TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
CREATE TABLE memory_node_sources (
        node_id TEXT,
        session_id TEXT,
        created_at DATETIME,
        PRIMARY KEY (node_id, session_id),
        FOREIGN KEY (node_id) REFERENCES memory_nodes(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
CREATE TABLE memory_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        project TEXT,
        title TEXT,
        summary TEXT,
        level INTEGER,
        path_key TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        last_synced_at DATETIME, scope TEXT,
        FOREIGN KEY (parent_id) REFERENCES memory_nodes(id)
      );
CREATE VIRTUAL TABLE recall_fts USING fts5(
                kind UNINDEXED,
                ref_id UNINDEXED,
                session_id UNINDEXED,
                body,
                tokenize='trigram'
              );
CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        timestamp DATETIME,
        project TEXT,
        event_count INTEGER,
        summary TEXT
      , scope TEXT);
CREATE INDEX idx_events_event_type
      ON events(event_type);
CREATE INDEX idx_events_session_event_time
      ON events(session_id, event_type, timestamp);
CREATE INDEX idx_memory_node_sources_session
      ON memory_node_sources(session_id);
CREATE INDEX idx_memory_nodes_parent
      ON memory_nodes(parent_id);
CREATE INDEX idx_memory_nodes_project_level
      ON memory_nodes(project, level);
CREATE INDEX idx_memory_nodes_scope_level ON memory_nodes(scope, level);
CREATE INDEX idx_memory_nodes_updated
      ON memory_nodes(updated_at);
CREATE INDEX idx_sessions_project_timestamp
      ON sessions(project, timestamp);
CREATE INDEX idx_sessions_scope_timestamp ON sessions(scope, timestamp);
CREATE INDEX idx_sessions_timestamp
      ON sessions(timestamp);
CREATE TRIGGER trg_recall_fts_events_ad
              AFTER DELETE ON events BEGIN
                DELETE FROM recall_fts WHERE kind IN ('decision', 'skill') AND ref_id = old.id;
              END;
CREATE TRIGGER trg_recall_fts_events_ai
              AFTER INSERT ON events WHEN new.event_type IN ('DecisionMade', 'SkillLearned') BEGIN
                INSERT INTO recall_fts(kind, ref_id, session_id, body)
                VALUES (
                  CASE new.event_type WHEN 'DecisionMade' THEN 'decision' ELSE 'skill' END,
                  new.id, new.session_id, COALESCE(new.content, '')
                );
              END;
CREATE TRIGGER trg_recall_fts_events_au
              AFTER UPDATE ON events BEGIN
                DELETE FROM recall_fts WHERE kind IN ('decision', 'skill') AND ref_id = old.id;
                INSERT INTO recall_fts(kind, ref_id, session_id, body)
                SELECT CASE event_type WHEN 'DecisionMade' THEN 'decision' ELSE 'skill' END,
                       id, session_id, COALESCE(content, '')
                FROM events
                WHERE id = new.id AND event_type IN ('DecisionMade', 'SkillLearned');
              END;
CREATE TRIGGER trg_recall_fts_sessions_ad
              AFTER DELETE ON sessions BEGIN
                DELETE FROM recall_fts WHERE kind = 'session' AND ref_id = old.id;
              END;
CREATE TRIGGER trg_recall_fts_sessions_ai
              AFTER INSERT ON sessions BEGIN
                INSERT INTO recall_fts(kind, ref_id, session_id, body)
                VALUES ('session', new.id, new.id, COALESCE(new.summary, '') || ' ' || COALESCE(new.project, ''));
              END;
CREATE TRIGGER trg_recall_fts_sessions_au
              AFTER UPDATE ON sessions BEGIN
                DELETE FROM recall_fts WHERE kind = 'session' AND ref_id = old.id;
                INSERT INTO recall_fts(kind, ref_id, session_id, body)
                VALUES ('session', new.id, new.id, COALESCE(new.summary, '') || ' ' || COALESCE(new.project, ''));
              END;
