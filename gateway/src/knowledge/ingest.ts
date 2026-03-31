import * as cheerio from "cheerio";
import { logger } from "../logger.js";

export interface IngestionResult {
  success: boolean;
  content?: string;
  source?: string;
  error?: string;
  title?: string;
}

/**
 * Ingests content from a URL or raw text.
 * Returns the extracted text and metadata.
 */
export async function ingestContent(url?: string, rawContent?: string): Promise<IngestionResult> {
  if (rawContent && !url) {
    return {
      success: true,
      content: rawContent,
      source: "raw-text",
      title: "Direct Ingestion",
    };
  }

  if (!url) {
    return { success: false, error: "No URL or content provided" };
  }

  try {
    logger.info(`[ingest] Fetching content from ${url}...`);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HTTP error: ${resp.status}`);
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Remove scripts, styles, etc.
    $("script, style, nav, footer, header, ads").remove();

    const title = $("title").text().trim() || url;
    
    // Simple text extraction — can be improved with something like @mozilla/readability
    const content = $("body").text()
      .replace(/\s\s+/g, " ")
      .trim();

    return {
      success: true,
      content,
      source: url,
      title,
    };
  } catch (err: any) {
    logger.error(`[ingest] Ingestion failed for ${url}: ${err.message}`);
    return { success: false, error: err.message };
  }
}
