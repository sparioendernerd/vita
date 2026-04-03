import { z } from "zod";
import { readFileSync, readdirSync, watchFile, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "../logger.js";
import { getVitaConfigPath, getVitaDir, getVitaHome } from "./vita-home.js";
import { normalizeBlockedTools } from "../tools/catalog.js";

const scheduledTaskSchema = z.object({
  id: z.string().optional(),
  cron: z.string(),
  action: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

const discordConfigSchema = z.object({
  applicationId: z.string().optional(),
  defaultDmUserId: z.string().optional(),
  channels: z.array(z.string()).default([]),
}).default({});

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
  wakeWordSampleDir: z.string().optional().default("wakeword/refs"),
  blockedTools: z.array(z.string()).default([]),
  tools: z
    .array(z.string())
    .optional(),
  discord: discordConfigSchema,
  discordChannels: z.array(z.string()).default([]),
  scheduledTasks: z.array(scheduledTaskSchema).default([]),
});

export type VitaConfig = z.infer<typeof vitaConfigSchema>;
export type ScheduledTaskConfig = z.infer<typeof scheduledTaskSchema>;
type RegistryListener = () => void;

export class VitaRegistry {
  private vitas = new Map<string, VitaConfig>();
  private configPaths = new Map<string, string>();
  private vitasDir: string;
  private watchedPaths = new Set<string>();
  private listeners = new Set<RegistryListener>();

  constructor(vitasDir = getVitaHome()) {
    this.vitasDir = vitasDir;
  }

  load(): void {
    this.vitas.clear();
    this.configPaths.clear();

    const files = readdirSync(this.vitasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "shared")
      .map((entry) => getVitaConfigPath(entry.name))
      .filter((filePath) => existsSync(filePath));

    for (const filePath of files) {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        if (!Array.isArray(raw.blockedTools)) {
          raw.blockedTools = normalizeBlockedTools(raw);
        }
        const config = vitaConfigSchema.parse(raw);
        
        // Load dynamically from ~/.vita/[name]
        const staticPath = getVitaDir(config.name);
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
        this.configPaths.set(config.name, filePath);
        logger.info(`Loaded VITA: ${config.displayName} (${config.name})`);
      } catch (err) {
        logger.error(`Failed to load VITA config ${filePath}: ${err}`);
      }
    }

    if (this.vitas.size === 0) {
      logger.warn("No VITA configs loaded");
    }
    
    // Ensure all loaded paths are tracked and watched if watchForChanges was already called
    this.setupWatchers();
    this.emitChange();
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

  getConfigPath(name: string): string | undefined {
    return this.configPaths.get(name);
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.error(`VITA registry listener failed: ${err}`);
      }
    }
  }

  private setupWatchers(): void {
    // Only setup if watchForChanges was initiated
    if (!this.watchedPaths.has(this.vitasDir)) {
      return;
    }
    
    // Watch new config files
    const files = readdirSync(this.vitasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "shared")
      .map((entry) => getVitaConfigPath(entry.name))
      .filter((filePath) => existsSync(filePath));
    for (const p of files) {
      if (!this.watchedPaths.has(p)) {
        this.watchedPaths.add(p);
        watchFile(p, { interval: 2000 }, () => {
          logger.info(`VITA config changed: ${basename(p)}, reloading...`);
          this.load();
        });
      }
    }

    // Watch dynamic subdirectories per VITA
    for (const config of this.vitas.values()) {
        const staticPath = getVitaDir(config.name);
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
