import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { logger } from "../logger.js";
import { SCHEMA_SQL } from "./schema.js";
import { VectorStore } from "./vector.js";

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
  private vector: VectorStore | null = null;
  private vitaName: string;

  constructor(dbPath: string, vitaName: string, apiKey?: string) {
    this.vitaName = vitaName;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);

    if (apiKey) {
      this.vector = new VectorStore(apiKey, vitaName);
      logger.info(`[memory] Vector store initialized for ${vitaName}`);
    }
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

      // Sync to vector store
      if (this.vector) {
        const impValue = Math.min(0.9, Math.max(0.1, importance));
        this.vector.addMemory(id, content, {
          id,
          vitaName,
          category,
          timestamp: now,
          tags,
          importance: impValue
        }).catch(err => logger.error(`[memory] Vector sync failed: ${err.message}`));
      }

      logger.info(`[memory] Saved to ${category} for ${vitaName}: ${content.substring(0, 50)}...`);
      return { success: true, id };
    } catch (err: any) {
      logger.error(`[memory] writeMemory failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

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
    
    // Also try to index in vector store if available
    if (this.vector) {
        this.vector.addMemory(m.id, m.content, {
            id: m.id,
            vitaName: m.vitaName,
            category: m.category,
            timestamp: m.timestamp,
            tags: m.tags,
            importance: m.importance
        }).catch(() => {}); // Silent for bulk imports
    }
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  public readMemory(vitaName: string, category: string, query?: string): Memory[] {
    let rows: DbRow[];
    if (query) {
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

  public async searchMemory(vitaName: string, query: string, limit = 10): Promise<Memory[]> {
    // 1. Keyword/FTS search
    const ftsRows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts ON memories_fts.rowid = m.rowid
         WHERE m.vita_name = ? AND memories_fts MATCH ?
         ORDER BY m.importance DESC, m.last_accessed DESC
         LIMIT ?`
      )
      .all(vitaName, query, limit) as DbRow[];

    // 2. Semantic/Vector search
    let vectorResults: { id: string }[] = [];
    if (this.vector) {
      vectorResults = await this.vector.search(query, limit);
    }

    // 3. Merge results
    const combinedMap = new Map<string, DbRow>();
    
    // Add FTS results first
    for (const row of ftsRows) {
      combinedMap.set(row.id, row);
    }

    // Add vector results (fetch from DB if not already in set)
    if (vectorResults.length > 0) {
      const missingIds = vectorResults
        .map(v => v.id)
        .filter(id => !combinedMap.has(id));

      if (missingIds.length > 0) {
        const placeholders = missingIds.map(() => "?").join(",");
        const missingRows = this.db
          .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND vita_name = ?`)
          .all(...missingIds, vitaName) as DbRow[];
        
        for (const row of missingRows) {
          combinedMap.set(row.id, row);
        }
      }
    }

    const finalRows = Array.from(combinedMap.values());
    this.bumpAccess(finalRows);
    return finalRows.map(rowToMemory);
  }

  public getCoreMemories(vitaName: string): string[] {
    return this.getSessionContext(vitaName, 12).map((m) => m.content);
  }

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
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
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

    // Index summary in vector store
    if (this.vector) {
        this.vector.addMemory(summaryId, summaryText, {
            id: summaryId,
            vitaName,
            category: 'core',
            timestamp: now,
            tags: ['consolidated'],
            importance: 0.8
        }).catch(() => {});
    }

    logger.info(`[memory] Consolidated ${rows.length} ${category} memories into summary ${summaryId} for ${vitaName}`);
    return { summaryId, archivedCount: rows.length, newSummaryContent: summaryText };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  public deleteMemory(vitaName: string, id: string): boolean {
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE id = ? AND vita_name = ?`)
      .run(id, vitaName);
    
    if (changes > 0 && this.vector) {
      this.vector.deleteMemory(id).catch(err => 
        logger.error(`[memory] Failed to delete from vector store: ${err.message}`)
      );
    }
    return changes > 0;
  }
}
