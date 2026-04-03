import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { getVitaDir } from "../config/vita-home.js";

export interface TranscriptEntry {
  timestamp: string;
  role: "user" | "model" | "system" | "tool";
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a transcript entry to the session's JSONL log file.
 * Path: ~/.vita/sessions/<date>/<session-id>.jsonl
 */
export function appendTranscript(
  vitaName: string,
  sessionId: string,
  entry: TranscriptEntry
): void {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const dir = join(getVitaDir(vitaName), "sessions", date);

  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sessionId}.jsonl`);
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    }) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    logger.error(`[transcript] Failed to write transcript: ${err}`);
  }
}

/**
 * Create a new session ID based on timestamp.
 */
export function createSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const rand = Math.random().toString(36).substring(2, 6);
  return `${ts}-${rand}`;
}
