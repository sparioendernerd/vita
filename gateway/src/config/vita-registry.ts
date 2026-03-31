import { z } from "zod";
import { readFileSync, readdirSync, watchFile, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logger.js";

export const vitaConfigSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  displayName: z.string(),
  personality: z.string().optional().default(""),
  systemInstructions: z.string().optional().default(""),
  voicePrompt: z.string(),
  voiceName: z.string(),
  liveModel: z.string().default("gemini-3.1-flash-live-preview"),
  textModel: z.string().default("gemini-2.5-flash"),
  heartbeatModel: z.string().default("ollama/gemma3"),
  heartbeatOllamaUrl: z.string().default("http://localhost:11434"),
  wakeWords: z.array(z.string()).default(["hey_vita"]),
  tools: z
    .array(z.string())
    .default(["read_memory", "write_memory", "search_memory", "get_current_time", "deactivate_agent", "google_search"]),
  discordChannels: z.array(z.string()).default([]),
  scheduledTasks: z
    .array(
      z.object({
        cron: z.string(),
        action: z.string(),
        description: z.string().optional(),
      })
    )
    .default([]),
});

export type VitaConfig = z.infer<typeof vitaConfigSchema>;

export class VitaRegistry {
  private vitas = new Map<string, VitaConfig>();
  private vitasDir: string;
  private watchedPaths = new Set<string>();

  constructor(vitasDir: string) {
    this.vitasDir = vitasDir;
  }

  load(): void {
    const files = readdirSync(this.vitasDir).filter((f) =>
      f.endsWith(".vita.json")
    );

    for (const file of files) {
      const filePath = join(this.vitasDir, file);
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        const config = vitaConfigSchema.parse(raw);
        
        // Load dynamically from ~/.vita/[name]
        const staticPath = join(homedir(), ".vita", config.name);
        if (existsSync(staticPath)) {
          const parts: string[] = [];
          const filesToLoad = ["IDENTITY.md", "SOUL.md", "USER.md", "HEARTBEAT.md", "MEMORY.md"];
          let loadedAny = false;
          for (const mdFile of filesToLoad) {
             const fp = join(staticPath, mdFile);
             if (existsSync(fp)) {
                 parts.push(readFileSync(fp, "utf-8"));
                 loadedAny = true;
             }
          }
          if (loadedAny) {
             const dynamicInstructions = parts.join("\n\n---\n\n");
             config.systemInstructions = config.systemInstructions 
                 ? `${config.systemInstructions}\n\n---\n\n${dynamicInstructions}`
                 : dynamicInstructions;
             logger.info(`Loaded dynamic context for ${config.name} from ${staticPath}`);
          }
        }

        this.vitas.set(config.name, config);
        logger.info(`Loaded VITA: ${config.displayName} (${config.name})`);
      } catch (err) {
        logger.error(`Failed to load VITA config ${file}: ${err}`);
      }
    }

    if (this.vitas.size === 0) {
      logger.warn("No VITA configs loaded");
    }
    
    // Ensure all loaded paths are tracked and watched if watchForChanges was already called
    this.setupWatchers();
  }

  get(name: string): VitaConfig | undefined {
    return this.vitas.get(name);
  }

  getFirst(): VitaConfig | undefined {
    return this.vitas.values().next().value;
  }

  getAll(): VitaConfig[] {
    return Array.from(this.vitas.values());
  }

  private setupWatchers(): void {
    // Only setup if watchForChanges was initiated
    if (!this.watchedPaths.has(this.vitasDir)) {
      return;
    }
    
    // Watch new config files
    const files = readdirSync(this.vitasDir).filter((f) =>
      f.endsWith(".vita.json")
    );
    for (const file of files) {
      const p = join(this.vitasDir, file);
      if (!this.watchedPaths.has(p)) {
        this.watchedPaths.add(p);
        watchFile(p, { interval: 2000 }, () => {
          logger.info(`VITA config changed: ${file}, reloading...`);
          this.load();
        });
      }
    }

    // Watch dynamic subdirectories per VITA
    for (const config of this.vitas.values()) {
        const staticPath = join(homedir(), ".vita", config.name);
        if (existsSync(staticPath)) {
            const filesToLoad = ["IDENTITY.md", "SOUL.md", "USER.md", "HEARTBEAT.md", "MEMORY.md"];
            for (const mdFile of filesToLoad) {
                const p = join(staticPath, mdFile);
                if (existsSync(p)) {
                    if (!this.watchedPaths.has(p)) {
                        this.watchedPaths.add(p);
                        watchFile(p, { interval: 2000 }, () => {
                            logger.info(`Dynamic VITA context changed: ${mdFile} for ${config.name}, reloading...`);
                            this.load();
                        });
                    }
                }
            }
        }
    }
  }

  watchForChanges(): void {
    if (!this.watchedPaths.has(this.vitasDir)) {
        this.watchedPaths.add(this.vitasDir);
        this.setupWatchers();
    }
  }
}
