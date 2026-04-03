import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { getMailboxPath, getSharedDir, getSharedUserProfilePath, getVitaConfigPath, getVitaDir, getVitaHome } from "./vita-home.js";
import { vitaConfigSchema, type VitaConfig } from "./vita-registry.js";

const sharedUserProfileSchema = z.object({
  profile: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const mailboxMessageSchema = z.object({
  id: z.string(),
  fromVita: z.string(),
  toVita: z.string(),
  subject: z.string().optional(),
  body: z.string(),
  status: z.enum(["unread", "read"]).default("unread"),
  createdAt: z.string(),
  readAt: z.string().optional(),
});

const mailboxFileSchema = z.object({
  messages: z.array(mailboxMessageSchema).default([]),
});

export type SharedUserProfile = z.infer<typeof sharedUserProfileSchema>;
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;
export type MailboxStatus = MailboxMessage["status"];

export interface SpawnCreateInput {
  name: string;
  displayName?: string;
  personality: string;
  sharedUserProfile?: string;
}

function ensureSharedDir(): void {
  mkdirSync(getSharedDir(), { recursive: true });
  if (!existsSync(getMailboxPath())) {
    writeFileSync(getMailboxPath(), JSON.stringify({ messages: [] }, null, 2) + "\n", "utf-8");
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function displayNameFor(name: string): string {
  return name
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function assertValidName(raw: string): string {
  const name = normalizeName(raw);
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error("VITA name must match ^[a-z][a-z0-9_-]*$");
  }
  return name;
}

function writeTextFileIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content.trim() + "\n", "utf-8");
  }
}

function buildSystemInstructions(displayName: string, personality: string): string {
  return [
    `You are ${displayName}, a voice-interactive VITA assistant for Mr Vailen.`,
    "Speak naturally, stay in-character, and avoid narration or theatrical stage directions.",
    `Personality:\n${personality.trim()}`,
  ].join("\n\n");
}

export function listLocalVitaNames(): string[] {
  mkdirSync(getVitaHome(), { recursive: true });
  return readdirSync(getVitaHome(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "shared")
    .map((entry) => entry.name)
    .filter((name) => existsSync(getVitaConfigPath(name)))
    .sort();
}

export function hasLocalVitas(): boolean {
  return listLocalVitaNames().length > 0;
}

export function createLocalVita(input: SpawnCreateInput): VitaConfig {
  mkdirSync(getVitaHome(), { recursive: true });
  ensureSharedDir();

  const name = assertValidName(input.name);
  const displayName = input.displayName?.trim() || displayNameFor(name);
  const dir = getVitaDir(name);
  const configPath = getVitaConfigPath(name);

  if (existsSync(configPath)) {
    throw new Error(`A local VITA named '${name}' already exists.`);
  }

  mkdirSync(dir, { recursive: true });

  const config = vitaConfigSchema.parse({
    name,
    displayName,
    personality: input.personality.trim(),
    systemInstructions: buildSystemInstructions(displayName, input.personality),
    voicePrompt: `Speak naturally and let your delivery reflect this personality: ${input.personality.trim()}`,
    voiceName: "Kore",
    liveModel: "gemini-3.1-flash-live-preview",
    textModel: "gemini-3-flash-preview",
    heartbeatModel: "ollama/gemma3:4b",
    heartbeatOllamaUrl: "http://localhost:11434",
    wakeWords: [`hey_${name}`],
    tools: [
      "read_memory",
      "write_memory",
      "search_memory",
      "consolidate_memories",
      "get_current_time",
      "deactivate_agent",
      "google_search",
      "system_run",
      "list_scripts",
      "run_script",
      "create_script_with_codex",
      "system_notify",
      "discord_notify",
      "discord_send_file",
      "system_list_nodes",
      "enable_vision",
      "enable_screenshare",
      "disable_vision",
      "ingest_knowledge",
      "schedule_task",
      "list_scheduled_tasks",
      "remove_scheduled_task",
      "media_play_pause",
      "media_next_track",
      "media_prev_track",
      "media_volume_up",
      "media_volume_down",
      "list_steam_games",
      "launch_steam_game",
      "list_vitas",
      "read_shared_profile",
      "send_vita_message",
      "read_vita_messages",
      "mark_vita_message_read",
    ],
    discordChannels: [],
    scheduledTasks: [],
  });

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeTextFileIfMissing(join(dir, "IDENTITY.md"), `# Identity\n\nName: ${displayName}`);
  writeTextFileIfMissing(join(dir, "SOUL.md"), input.personality.trim());
  writeTextFileIfMissing(join(dir, "USER.md"), input.sharedUserProfile?.trim() || "Shared user profile is managed globally.");
  writeTextFileIfMissing(join(dir, "HEARTBEAT.md"), `You are ${displayName}'s lightweight heartbeat model. Reply briefly and stay aligned with the active persona.`);
  writeTextFileIfMissing(join(dir, "MEMORY.md"), `# ${displayName} Memory\n\nPrivate memories for ${displayName} live in this folder.`);

  if (input.sharedUserProfile?.trim()) {
    upsertSharedUserProfile(input.sharedUserProfile.trim());
  }

  logger.info(`[spawn] Created local VITA '${name}'`);
  return config;
}

export function readSharedUserProfile(): SharedUserProfile | null {
  ensureSharedDir();
  const path = getSharedUserProfilePath();
  if (!existsSync(path)) {
    return null;
  }
  return sharedUserProfileSchema.parse(readJsonFile(path, {}));
}

export function upsertSharedUserProfile(profile: string): SharedUserProfile {
  ensureSharedDir();
  const existing = readSharedUserProfile();
  const now = new Date().toISOString();
  const next = sharedUserProfileSchema.parse({
    profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  writeFileSync(getSharedUserProfilePath(), JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export function listVitaSummaries(): Array<{ name: string; displayName: string }> {
  return listLocalVitaNames().map((name) => {
    const config = vitaConfigSchema.parse(readJsonFile(getVitaConfigPath(name), {}));
    return { name: config.name, displayName: config.displayName };
  });
}

export function formatVitaList(): string {
  const vitas = listVitaSummaries();
  if (!vitas.length) {
    return "No local VITAs found.";
  }
  return vitas.map((vita) => `- ${vita.displayName} (${vita.name})`).join("\n");
}

export function sendMailboxMessage(input: {
  fromVita: string;
  toVita: string;
  subject?: string;
  body: string;
}): MailboxMessage {
  ensureSharedDir();
  if (!listLocalVitaNames().includes(input.toVita)) {
    throw new Error(`Unknown recipient VITA '${input.toVita}'.`);
  }
  const mailbox = mailboxFileSchema.parse(readJsonFile(getMailboxPath(), { messages: [] }));
  const message = mailboxMessageSchema.parse({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fromVita: input.fromVita,
    toVita: input.toVita,
    subject: input.subject?.trim() || undefined,
    body: input.body.trim(),
    status: "unread",
    createdAt: new Date().toISOString(),
  });
  mailbox.messages.push(message);
  writeFileSync(getMailboxPath(), JSON.stringify(mailbox, null, 2) + "\n", "utf-8");
  return message;
}

export function readMailboxMessages(vitaName: string, status?: MailboxStatus): MailboxMessage[] {
  ensureSharedDir();
  const mailbox = mailboxFileSchema.parse(readJsonFile(getMailboxPath(), { messages: [] }));
  return mailbox.messages
    .filter((message) => message.toVita === vitaName)
    .filter((message) => (status ? message.status === status : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function markMailboxMessageRead(vitaName: string, messageId: string): MailboxMessage {
  ensureSharedDir();
  const mailbox = mailboxFileSchema.parse(readJsonFile(getMailboxPath(), { messages: [] }));
  const index = mailbox.messages.findIndex((message) => message.id === messageId && message.toVita === vitaName);
  if (index === -1) {
    throw new Error(`No mailbox message '${messageId}' for ${vitaName}.`);
  }
  const next = mailboxMessageSchema.parse({
    ...mailbox.messages[index],
    status: "read",
    readAt: mailbox.messages[index].readAt ?? new Date().toISOString(),
  });
  mailbox.messages[index] = next;
  writeFileSync(getMailboxPath(), JSON.stringify(mailbox, null, 2) + "\n", "utf-8");
  return next;
}

export function importExistingGraves(): VitaConfig {
  mkdirSync(getVitaHome(), { recursive: true });
  ensureSharedDir();
  const dir = getVitaDir("graves");
  mkdirSync(dir, { recursive: true });

  const configPath = getVitaConfigPath("graves");
  if (!existsSync(configPath)) {
    const config = vitaConfigSchema.parse({
      name: "graves",
      displayName: "Graves",
      personality: "Dry, British, technically sharp, quietly loyal to Mr Vailen.",
      systemInstructions: "",
      voicePrompt: "Use a heavy posh British accent at all times. Snappy delivery.",
      voiceName: "Algieba",
      liveModel: "gemini-3.1-flash-live-preview",
      textModel: "gemini-3-flash-preview",
      heartbeatModel: "ollama/gemma3:4b",
      heartbeatOllamaUrl: "http://localhost:11434",
      wakeWords: ["hey_graves"],
      tools: [
        "read_memory",
        "write_memory",
        "search_memory",
        "consolidate_memories",
        "get_current_time",
        "deactivate_agent",
        "google_search",
        "system_run",
        "list_scripts",
        "run_script",
        "create_script_with_codex",
        "system_notify",
        "discord_notify",
        "discord_send_file",
        "system_list_nodes",
        "enable_vision",
        "enable_screenshare",
        "disable_vision",
        "ingest_knowledge",
        "schedule_task",
        "list_scheduled_tasks",
        "remove_scheduled_task",
        "media_play_pause",
        "media_next_track",
        "media_prev_track",
        "media_volume_up",
        "media_volume_down",
        "list_steam_games",
        "launch_steam_game",
        "list_vitas",
        "read_shared_profile",
        "send_vita_message",
        "read_vita_messages",
        "mark_vita_message_read",
      ],
      discordChannels: [],
      scheduledTasks: [],
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  const repoRoot = resolve(process.cwd(), "..");
  const legacySoul = join(repoRoot, "Graves.txt");
  if (existsSync(legacySoul)) {
    copyFileSync(legacySoul, join(dir, "SOUL.md"));
  } else {
    writeTextFileIfMissing(join(dir, "SOUL.md"), "You are Graves, Mr Vailen's deadpan technical co-host.");
  }
  writeTextFileIfMissing(join(dir, "IDENTITY.md"), "# Graves\n\nLegacy profile imported into local Spawn storage.");
  writeTextFileIfMissing(join(dir, "HEARTBEAT.md"), "You are Graves's heartbeat model. Reply briefly and stay aligned with the active persona.");
  writeTextFileIfMissing(join(dir, "MEMORY.md"), "# Graves Memory\n\nLegacy Graves memory remains in this folder.");

  logger.info("[spawn] Imported Graves into local storage");
  return vitaConfigSchema.parse(readJsonFile(configPath, {}));
}
