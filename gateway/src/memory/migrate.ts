import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { MemoryStore } from "./store.js";
import { getVitaDir } from "../config/vita-home.js";

interface LegacyMemory {
  id: string;
  category: string;
  content: string;
  tags: string[];
  timestamp: number;
}

type LegacyMemoryStoreData = Record<string, LegacyMemory[]>;

export function migrateIfNeeded(vitaName: string, store: MemoryStore): void {
  const dir = getVitaDir(vitaName);
  const jsonPath = join(dir, "memories.json");
  const doneFlagPath = join(dir, ".migrated_v2");

  if (!existsSync(jsonPath) || existsSync(doneFlagPath)) return;

  logger.info(`[migrate] Migrating memories.json -> memories.db for ${vitaName}`);

  let raw: LegacyMemoryStoreData;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (err) {
    logger.error(`[migrate] Failed to read memories.json for ${vitaName}: ${err}`);
    return;
  }

  let count = 0;
  for (const [category, memories] of Object.entries(raw)) {
    for (const m of memories) {
      store.importLegacy({
        id: m.id,
        vitaName,
        category,
        content: m.content,
        tags: m.tags ?? [],
        timestamp: m.timestamp,
        importance: category === "core" ? 0.8 : 0.5,
        accessCount: 0,
        lastAccessed: m.timestamp,
        isSummary: false,
        sourceIds: [],
      });
      count++;
    }
  }

  writeFileSync(doneFlagPath, new Date().toISOString(), "utf-8");
  logger.info(`[migrate] Migration complete for ${vitaName}: ${count} memories imported (memories.json preserved)`);
}
