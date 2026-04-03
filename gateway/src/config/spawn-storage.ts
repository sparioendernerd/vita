import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { GLOBAL_TOOL_NAMES, normalizeBlockedTools } from "../tools/catalog.js";
import {
  getMailboxPath,
  getSharedDir,
  getSharedSchedulePath,
  getSharedUserProfilePath,
  getVitaConfigPath,
  getVitaDir,
  getVitaHome,
  getVitaSecretsPath,
} from "./vita-home.js";
import { vitaConfigSchema, type VitaConfig } from "./vita-registry.js";

const GEMINI_PREBUILT_VOICES = [
  "Kore",
  "Algieba",
  "Aoede",
  "Charon",
  "Fenrir",
] as const;

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

const vitaSecretsSchema = z.object({
  discordBotToken: z.string().optional(),
});

const sharedScheduleTaskSchema = z.object({
  id: z.string(),
  vitaName: z.string(),
  cron: z.string(),
  action: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

const sharedScheduleFileSchema = z.object({
  tasks: z.array(sharedScheduleTaskSchema).default([]),
  migratedLegacySchedules: z.boolean().default(false),
});

export type SharedUserProfile = z.infer<typeof sharedUserProfileSchema>;
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;
export type MailboxStatus = MailboxMessage["status"];
export type VitaSecrets = z.infer<typeof vitaSecretsSchema>;
export type SharedScheduleTask = z.infer<typeof sharedScheduleTaskSchema>;

export interface SpawnCreateInput {
  name: string;
  displayName?: string;
  personality: string;
  sharedUserProfile?: string;
  voiceName: string;
  voicePrompt: string;
  wakeWord: string;
  blockedTools?: string[];
  discord?: {
    applicationId?: string;
    defaultDmUserId?: string;
    channels?: string[];
    botToken?: string;
  };
}

export interface DiscordPromptSummary {
  applicationId?: string;
  defaultDmUserId?: string;
  channels: string[];
  hasBotToken: boolean;
}

function ensureSharedDir(): void {
  mkdirSync(getSharedDir(), { recursive: true });
  if (!existsSync(getMailboxPath())) {
    writeFileSync(getMailboxPath(), JSON.stringify({ messages: [] }, null, 2) + "\n", "utf-8");
  }
  if (!existsSync(getSharedSchedulePath())) {
    writeFileSync(getSharedSchedulePath(), JSON.stringify({ tasks: [], migratedLegacySchedules: false }, null, 2) + "\n", "utf-8");
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

function writeTextFile(path: string, content: string): void {
  writeFileSync(path, content.trim() + "\n", "utf-8");
}

function writeTextFileIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeTextFile(path, content);
  }
}

function buildSystemInstructions(displayName: string, personality: string): string {
  return [
    `You are ${displayName}, a voice-interactive VITA assistant for Mr Vailen.`,
    "Speak naturally, stay in-character, and avoid narration or theatrical stage directions.",
    `Personality:\n${personality.trim()}`,
  ].join("\n\n");
}

function normalizeWakeWord(name: string, wakeWord: string): string {
  const trimmed = wakeWord.trim().toLowerCase().replace(/\s+/g, "_");
  return trimmed || `hey_${name}`;
}

function getWakeWordSampleDir(name: string): string {
  return `wakeword/refs/${name}`;
}

export function getWakeWordInstructions(name: string, wakeWord: string, sampleDir = getWakeWordSampleDir(name)): string {
  const paths = [1, 2, 3].map((index) => `${sampleDir}/sample-${index}.wav`);
  return [
    `Wake phrase: ${wakeWord}`,
    "Record at least three clear examples with LocalWake from the node machine:",
    ...paths.map((path) => `  lwake record --duration 2 "${path}"`),
    "Say the wake phrase naturally each time.",
  ].join("\n");
}

function normalizeChannels(channels?: string[]): string[] {
  return (channels ?? []).map((value) => value.trim()).filter(Boolean);
}

export function listGeminiVoices(): readonly string[] {
  return GEMINI_PREBUILT_VOICES;
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

export function writeVitaSecrets(vitaName: string, secrets: VitaSecrets): void {
  const path = getVitaSecretsPath(vitaName);
  const validated = vitaSecretsSchema.parse(secrets);
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf-8");
}

export function readVitaSecrets(vitaName: string): VitaSecrets {
  return vitaSecretsSchema.parse(readJsonFile(getVitaSecretsPath(vitaName), {}));
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

  const wakeWord = normalizeWakeWord(name, input.wakeWord);
  const wakeWordSampleDir = getWakeWordSampleDir(name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, wakeWordSampleDir), { recursive: true });
  const blockedTools = (input.blockedTools ?? []).filter((tool) => GLOBAL_TOOL_NAMES.includes(tool as (typeof GLOBAL_TOOL_NAMES)[number]));
  const config = vitaConfigSchema.parse({
    name,
    displayName,
    personality: input.personality.trim(),
    systemInstructions: buildSystemInstructions(displayName, input.personality),
    voicePrompt: input.voicePrompt.trim(),
    voiceName: input.voiceName.trim(),
    liveModel: "gemini-3.1-flash-live-preview",
    textModel: "gemini-3-flash-preview",
    heartbeatModel: "ollama/gemma3:4b",
    heartbeatOllamaUrl: "http://localhost:11434",
    wakeWords: [wakeWord],
    wakeWordSampleDir,
    blockedTools,
    tools: undefined,
    discord: {
      applicationId: input.discord?.applicationId?.trim() || undefined,
      defaultDmUserId: input.discord?.defaultDmUserId?.trim() || undefined,
      channels: normalizeChannels(input.discord?.channels),
    },
    discordChannels: normalizeChannels(input.discord?.channels),
    scheduledTasks: [],
  });

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeTextFileIfMissing(join(dir, "IDENTITY.md"), `# Identity\n\nName: ${displayName}`);
  writeTextFileIfMissing(join(dir, "SOUL.md"), input.personality.trim());
  writeTextFileIfMissing(join(dir, "USER.md"), input.sharedUserProfile?.trim() || "Shared user profile is managed globally.");
  writeTextFileIfMissing(join(dir, "HEARTBEAT.md"), `You are ${displayName}'s lightweight heartbeat model. Reply briefly and stay aligned with the active persona.`);
  writeTextFileIfMissing(join(dir, "MEMORY.md"), `# ${displayName} Memory\n\nPrivate memories for ${displayName} live in this folder.`);
  writeTextFile(join(dir, "WAKEWORD.md"), getWakeWordInstructions(name, wakeWord, wakeWordSampleDir));

  if (input.sharedUserProfile?.trim()) {
    upsertSharedUserProfile(input.sharedUserProfile.trim());
  }

  if (input.discord?.botToken?.trim()) {
    writeVitaSecrets(name, { discordBotToken: input.discord.botToken.trim() });
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

export function getDiscordPromptSummary(vitaName: string): DiscordPromptSummary {
  const config = vitaConfigSchema.parse(readJsonFile(getVitaConfigPath(vitaName), {}));
  const secrets = readVitaSecrets(vitaName);
  return {
    applicationId: config.discord.applicationId,
    defaultDmUserId: config.discord.defaultDmUserId,
    channels: config.discord.channels,
    hasBotToken: Boolean(secrets.discordBotToken),
  };
}

export function migrateLocalVitaConfig(vitaName: string): VitaConfig {
  ensureSharedDir();
  const normalizedName = assertValidName(vitaName);
  const configPath = getVitaConfigPath(normalizedName);
  if (!existsSync(configPath)) {
    throw new Error(`No local VITA config found for '${normalizedName}'.`);
  }

  const raw = readJsonFile<Record<string, unknown>>(configPath, {});
  const displayName = typeof raw.displayName === "string" && raw.displayName.trim()
    ? raw.displayName.trim()
    : displayNameFor(normalizedName);
  const wakeWords = Array.isArray(raw.wakeWords) && raw.wakeWords.length > 0
    ? raw.wakeWords.map(String).filter(Boolean)
    : [normalizeWakeWord(normalizedName, `hey ${normalizedName}`)];
  const wakeWordSampleDir = typeof raw.wakeWordSampleDir === "string" && raw.wakeWordSampleDir.trim()
    ? raw.wakeWordSampleDir.trim()
    : getWakeWordSampleDir(normalizedName);
  const discordChannels = Array.isArray(raw.discordChannels) ? raw.discordChannels.map(String) : [];
  const discordRaw = typeof raw.discord === "object" && raw.discord !== null ? raw.discord as Record<string, unknown> : {};

  const migrated = vitaConfigSchema.parse({
    ...raw,
    name: normalizedName,
    displayName,
    personality: typeof raw.personality === "string" ? raw.personality : "",
    systemInstructions: typeof raw.systemInstructions === "string" ? raw.systemInstructions : "",
    voiceName: typeof raw.voiceName === "string" && raw.voiceName.trim() ? raw.voiceName : "Algieba",
    voicePrompt: typeof raw.voicePrompt === "string" && raw.voicePrompt.trim()
      ? raw.voicePrompt
      : `Speak as ${displayName} with a clear, distinctive voice.`,
    wakeWords,
    wakeWordSampleDir,
    blockedTools: normalizeBlockedTools({
      tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
      blockedTools: Array.isArray(raw.blockedTools) ? raw.blockedTools.map(String) : [],
    }),
    discord: {
      applicationId: typeof discordRaw.applicationId === "string" ? discordRaw.applicationId : undefined,
      defaultDmUserId: typeof discordRaw.defaultDmUserId === "string" ? discordRaw.defaultDmUserId : undefined,
      channels: normalizeChannels(
        Array.isArray(discordRaw.channels) ? discordRaw.channels.map(String) : discordChannels
      ),
    },
    discordChannels: normalizeChannels(discordChannels),
    scheduledTasks: Array.isArray(raw.scheduledTasks) ? raw.scheduledTasks : [],
  });

  writeFileSync(configPath, JSON.stringify(migrated, null, 2) + "\n", "utf-8");
  writeTextFileIfMissing(join(getVitaDir(normalizedName), "WAKEWORD.md"), getWakeWordInstructions(normalizedName, migrated.wakeWords[0], migrated.wakeWordSampleDir));
  logger.info(`[spawn] Migrated local VITA config '${normalizedName}' to the current format`);
  return migrated;
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

export function loadSharedScheduleFile() {
  ensureSharedDir();
  return sharedScheduleFileSchema.parse(readJsonFile(getSharedSchedulePath(), { tasks: [], migratedLegacySchedules: false }));
}

export function saveSharedScheduleFile(data: z.infer<typeof sharedScheduleFileSchema>): void {
  ensureSharedDir();
  const validated = sharedScheduleFileSchema.parse(data);
  writeFileSync(getSharedSchedulePath(), JSON.stringify(validated, null, 2) + "\n", "utf-8");
}

export function migrateLegacyScheduledTasks(vitas: VitaConfig[]): SharedScheduleTask[] {
  const scheduleFile = loadSharedScheduleFile();
  if (scheduleFile.migratedLegacySchedules) {
    return scheduleFile.tasks;
  }

  const mergedTasks = [...scheduleFile.tasks];
  for (const vita of vitas) {
    for (const legacyTask of vita.scheduledTasks ?? []) {
      if (mergedTasks.some((task) => task.id === legacyTask.id && task.vitaName === vita.name)) {
        continue;
      }
      mergedTasks.push(sharedScheduleTaskSchema.parse({
        id: legacyTask.id ?? `${vita.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        vitaName: vita.name,
        cron: legacyTask.cron,
        action: legacyTask.action,
        description: legacyTask.description,
        enabled: legacyTask.enabled ?? true,
        timezone: legacyTask.timezone,
        tools: legacyTask.tools,
      }));
    }
  }

  saveSharedScheduleFile({
    tasks: mergedTasks,
    migratedLegacySchedules: true,
  });
  return mergedTasks;
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
      wakeWordSampleDir: getWakeWordSampleDir("graves"),
      blockedTools: [],
      discord: {
        applicationId: process.env.DISCORD_APPLICATION_ID || undefined,
        defaultDmUserId: process.env.DISCORD_DM_USER_ID || undefined,
        channels: [],
      },
      discordChannels: [],
      scheduledTasks: [],
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    if (process.env.DISCORD_TOKEN) {
      writeVitaSecrets("graves", { discordBotToken: process.env.DISCORD_TOKEN });
    }
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
  writeTextFileIfMissing(join(dir, "WAKEWORD.md"), getWakeWordInstructions("graves", "hey_graves", getWakeWordSampleDir("graves")));

  logger.info("[spawn] Imported Graves into local storage");
  return vitaConfigSchema.parse(readJsonFile(configPath, {}));
}
