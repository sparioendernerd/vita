import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { logger } from "../logger.js";
import { SCHEMA_SQL } from "./schema.js";

export interface Memory {
  id: string;
  category: string;
  content: string;
  tags: string[];
  timestamp: number;
  importance: number;
  accessCount: number;
  lastAccessed: number;
  isSummary: boolean;
  sourceIds: string[];
}

export interface SessionContextMemory {
  content: string;
  importance: number;
  category: string;
}

export interface ConsolidationResult {
  summaryId: string;
  archivedCount: number;
  newSummaryContent: string;
}

interface DbRow {
  id: string;
  vita_name: string;
  category: string;
  content: string;
  tags: string;
  timestamp: number;
  importance: number;
  access_count: number;
  last_accessed: number;
  is_summary: number;
  source_ids: string;
}

function rowToMemory(row: DbRow): Memory {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    tags: JSON.parse(row.tags),
    timestamp: row.timestamp,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    isSummary: row.is_summary === 1,
    sourceIds: JSON.parse(row.source_ids),
  };
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  public writeMemory(
    vitaName: string,
    category: string,
    content: string,
    tags: string[] = [],
    importance = 0.5
  ): { success: boolean; id?: string; error?: string } {
    const id = uuid();
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO memories (id, vita_name, category, content, tags, timestamp, importance, access_count, last_accessed, is_summary, source_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, '[]')`
        )
        .run(id, vitaName, category, content, JSON.stringify(tags), now, Math.min(0.9, Math.max(0.1, importance)), now);
      logger.info(`[memory] Saved to ${category} for ${vitaName}: ${content.substring(0, 50)}...`);
      return { success: true, id };
    } catch (err: any) {
      logger.error(`[memory] writeMemory failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // Used by migration — inserts with explicit ID and no access bump
  public importLegacy(m: {
    id: string;
    vitaName: string;
    category: string;
    content: string;
    tags: string[];
    timestamp: number;
    importance: number;
    accessCount: number;
    lastAccessed: number;
    isSummary: boolean;
    sourceIds: string[];
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memories (id, vita_name, category, content, tags, timestamp, importance, access_count, last_accessed, is_summary, source_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.vitaName,
        m.category,
        m.content,
        JSON.stringify(m.tags),
        m.timestamp,
        m.importance,
        m.accessCount,
        m.lastAccessed,
        m.isSummary ? 1 : 0,
        JSON.stringify(m.sourceIds)
      );
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  public readMemory(vitaName: string, category: string, query?: string): Memory[] {
    let rows: DbRow[];
    if (query) {
      // FTS5 search scoped to the category
      rows = this.db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts ON memories_fts.rowid = m.rowid
           WHERE m.vita_name = ? AND m.category = ?
             AND memories_fts MATCH ?
           ORDER BY m.importance DESC`
        )
        .all(vitaName, category, query) as DbRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM memories WHERE vita_name = ? AND category = ? ORDER BY importance DESC`)
        .all(vitaName, category) as DbRow[];
    }
    this.bumpAccess(rows);
    return rows.map(rowToMemory);
  }

  public searchMemory(vitaName: string, query: string, limit = 10): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts ON memories_fts.rowid = m.rowid
         WHERE m.vita_name = ? AND memories_fts MATCH ?
         ORDER BY m.importance DESC, m.last_accessed DESC
         LIMIT ?`
      )
      .all(vitaName, query, limit) as DbRow[];
    this.bumpAccess(rows);
    return rows.map(rowToMemory);
  }

  // Backward-compat: returns top-importance core memories as strings
  public getCoreMemories(vitaName: string): string[] {
    return this.getSessionContext(vitaName, 12).map((m) => m.content);
  }

  // Smart session-start loading: top-N across all categories by composite score
  public getSessionContext(vitaName: string, topN = 12): SessionContextMemory[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT content, importance, category,
           (importance
            + CASE WHEN (? - last_accessed) < 86400000   THEN 0.3
                   WHEN (? - last_accessed) < 604800000  THEN 0.15
                   ELSE 0.0 END
            + min(0.2, access_count * 0.02)
           ) AS score
         FROM memories
         WHERE vita_name = ?
         ORDER BY score DESC
         LIMIT ?`
      )
      .all(now, now, vitaName, topN) as (SessionContextMemory & { score: number })[];
    return rows.map(({ content, importance, category }) => ({ content, importance, category }));
  }

  // ── Importance / Decay ─────────────────────────────────────────────────────

  private bumpAccess(rows: DbRow[]): void {
    if (rows.length === 0) return;
    const now = Date.now();
    const bump = this.db.prepare(
      `UPDATE memories
       SET access_count = access_count + 1,
           last_accessed = ?,
           importance = min(1.0, importance + 0.05)
       WHERE id = ?`
    );
    const bumpAll = this.db.transaction((rs: DbRow[]) => {
      for (const r of rs) bump.run(now, r.id);
    });
    bumpAll(rows);
  }

  public applyImportanceDecay(vitaName: string): void {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days
    const { changes } = this.db
      .prepare(
        `UPDATE memories
         SET importance = max(0.05, importance * 0.92)
         WHERE vita_name = ?
           AND category != 'core'
           AND is_summary = 0
           AND last_accessed < ?`
      )
      .run(vitaName, cutoff);
    if (changes > 0) logger.info(`[memory] Decayed importance on ${changes} old memories for ${vitaName}`);
  }

  // ── Consolidation ──────────────────────────────────────────────────────────

  public async consolidateMemories(
    vitaName: string,
    textModelFn: (prompt: string) => Promise<string>,
    options: {
      category?: string;
      olderThanDays?: number;
      minBatchSize?: number;
    } = {}
  ): Promise<ConsolidationResult | null> {
    const { category = "conversations", olderThanDays = 7, minBatchSize = 5 } = options;
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE vita_name = ? AND category = ? AND is_summary = 0 AND timestamp < ?
         ORDER BY timestamp ASC
         LIMIT 50`
      )
      .all(vitaName, category, cutoff) as DbRow[];

    if (rows.length < minBatchSize) {
      logger.info(`[memory] Consolidation skipped: only ${rows.length} memories in ${category} (need ${minBatchSize})`);
      return null;
    }

    const memoryLines = rows
      .map((r) => `[${new Date(r.timestamp).toISOString()}] ${r.content}`)
      .join("\n");

    const prompt =
      `You are a memory consolidation system for a personal voice assistant.\n` +
      `Below are ${rows.length} episodic memories from past conversations.\n` +
      `Distill them into a concise set of factual bullet points (max 5) that capture the most important, durable information.\n` +
      `Omit transient details. Output only the bullet points, one per line, starting each with "- ".\n\n` +
      `MEMORIES:\n${memoryLines}`;

    let summaryText: string;
    try {
      summaryText = await textModelFn(prompt);
    } catch (err: any) {
      logger.error(`[memory] Consolidation LLM call failed: ${err.message}`);
      throw err;
    }

    summaryText = summaryText.trim();
    const summaryId = uuid();
    const sourceIds = rows.map((r) => r.id);
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO memories (id, vita_name, category, content, tags, timestamp, importance, access_count, last_accessed, is_summary, source_ids)
       VALUES (?, ?, 'core', ?, '["consolidated"]', ?, 0.8, 0, ?, 1, ?)`
    );

    const demote = this.db.prepare(
      `UPDATE memories SET importance = 0.05 WHERE id = ?`
    );

    this.db.transaction(() => {
      insert.run(summaryId, vitaName, summaryText, now, now, JSON.stringify(sourceIds));
      for (const id of sourceIds) demote.run(id);
    })();

    logger.info(`[memory] Consolidated ${rows.length} ${category} memories into summary ${summaryId} for ${vitaName}`);
    return { summaryId, archivedCount: rows.length, newSummaryContent: summaryText };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  public deleteMemory(vitaName: string, id: string): boolean {
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE id = ? AND vita_name = ?`)
      .run(id, vitaName);
    return changes > 0;
  }
}
