import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  Partials,
} from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VitaRegistry, VitaConfig } from "../config/vita-registry.js";
import { getMemoryStore } from "../memory/index.js";
import { appendTranscript, createSessionId } from "../knowledge/transcript-logger.js";
import { logger } from "../logger.js";
import { GoogleGenAI } from "@google/genai";

interface DiscordBridgeOptions {
  token: string;
  applicationId?: string;
  geminiApiKey: string;
  vitaRegistry: VitaRegistry;
}

interface DiscordReplyResult {
  vitaName: string;
  reply: string;
  sessionId: string;
}

type SessionKey = `${string}:${string}`;

export class DiscordBridge {
  private readonly client: Client;
  private readonly genai: GoogleGenAI;
  private readonly geminiApiKey: string;
  private readonly vitaRegistry: VitaRegistry;
  private readonly sessionIds = new Map<SessionKey, string>();
  private readonly inFlight = new Set<SessionKey>();
  private readonly token: string;
  private readonly applicationId?: string;
  private ready = false;

  constructor(options: DiscordBridgeOptions) {
    this.token = options.token;
    this.applicationId = options.applicationId;
    this.geminiApiKey = options.geminiApiKey;
    this.vitaRegistry = options.vitaRegistry;
    this.genai = new GoogleGenAI({ apiKey: options.geminiApiKey });
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(): Promise<void> {
    this.client.once("ready", () => {
      this.ready = true;
      logger.info(`[discord] Connected as ${this.client.user?.tag ?? "unknown user"}`);
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });

    this.client.on("error", (error) => {
      logger.error(`[discord] Client error: ${error.message}`);
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    if (!this.ready) {
      return;
    }
    this.client.destroy();
    this.ready = false;
  }

  async notifyVita(
    vitaName: string,
    payload: { title: string; body: string }
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    const vita = this.vitaRegistry.get(vitaName);
    if (!vita) {
      return { success: false, sent: 0, error: `Unknown VITA: ${vitaName}` };
    }

    if (!vita.discordChannels.length) {
      return { success: false, sent: 0, error: `No Discord channels configured for ${vitaName}` };
    }

    const message = `**${payload.title.trim()}**\n${payload.body.trim()}`.trim();
    let sent = 0;

    for (const channelId of vita.discordChannels) {
      const channel = await this.fetchChannel(channelId);
      if (!channel) {
        logger.warn(`[discord] Could not fetch configured channel ${channelId} for ${vitaName}`);
        continue;
      }
      if (!this.canSend(channel)) {
        logger.warn(`[discord] Channel ${channelId} is not sendable for ${vitaName}`);
        continue;
      }
      await channel.send(message);
      sent += 1;
    }

    if (!sent) {
      return { success: false, sent: 0, error: "No configured Discord channels were reachable" };
    }

    logger.info(`[discord] Sent outbound notification for ${vitaName} to ${sent} channel(s)`);
    return { success: true, sent };
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    const vita = this.resolveVitaForMessage(message);
    if (!vita) {
      return;
    }

    const content = this.extractPromptContent(message);
    if (!content) {
      return;
    }

    const sessionKey = this.makeSessionKey(vita.name, message.channelId);
    if (this.inFlight.has(sessionKey)) {
      await message.reply("One moment. Even the undead prefer one crisis at a time.");
      return;
    }

    this.inFlight.add(sessionKey);
    try {
      if (this.canSend(message.channel) && "sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }
      const result = await this.generateReply(vita, message, content);
      await message.reply(result.reply);
    } catch (error: any) {
      logger.error(`[discord] Failed to handle message in ${message.channelId}: ${error.message}`);
      await message.reply("Discord has managed to complicate a simple conversation. Try again in a moment.");
    } finally {
      this.inFlight.delete(sessionKey);
    }
  }

  private resolveVitaForMessage(message: Message): VitaConfig | undefined {
    const allVitas = this.vitaRegistry.getAll().filter((vita) =>
      vita.discordChannels.includes(message.channelId)
    );

    if (allVitas.length === 1) {
      return allVitas[0];
    }

    if (allVitas.length > 1) {
      logger.warn(`[discord] Multiple VITAs mapped to channel ${message.channelId}; using first match`);
      return allVitas[0];
    }

    if (message.channel.type === ChannelType.DM) {
      return this.vitaRegistry.getFirst();
    }

    return undefined;
  }

  private extractPromptContent(message: Message): string {
    const me = this.client.user;
    let content = message.content.trim();

    if (me) {
      const mentionPatterns = [
        new RegExp(`<@!?${me.id}>`, "g"),
      ];
      for (const pattern of mentionPatterns) {
        content = content.replace(pattern, "").trim();
      }
    }

    if (!content && message.attachments.size > 0) {
      content = "[User sent attachments without text]";
    }

    return content;
  }

  private async generateReply(
    vita: VitaConfig,
    message: Message,
    userText: string
  ): Promise<DiscordReplyResult> {
    const store = getMemoryStore(vita.name, this.geminiApiKey);
    const sessionId = this.getOrCreateSessionId(vita.name, message.channelId);
    const memories = store.getSessionContext(vita.name, 12).map((entry) => entry.content);
    const history = await this.getRecentTranscript(vita.name, sessionId, 8);

    appendTranscript(vita.name, sessionId, {
      timestamp: new Date().toISOString(),
      role: "user",
      text: userText,
      metadata: {
        source: "discord",
        channelId: message.channelId,
        author: message.author.username,
        authorId: message.author.id,
      },
    });

    store.writeMemory(
      vita.name,
      "conversations",
      `Discord user (${message.author.username}): ${userText}`,
      ["discord", "user-message"],
      0.45
    );

    const prompt = this.buildPrompt(vita, message.author.username, userText, memories, history);
    const result = await this.genai.models.generateContent({
      model: vita.textModel,
      contents: prompt,
    });

    const reply = (result.text ?? "").trim() || "Silence. Inspiring. Try that again.";

    appendTranscript(vita.name, sessionId, {
      timestamp: new Date().toISOString(),
      role: "model",
      text: reply,
      metadata: {
        source: "discord",
        channelId: message.channelId,
      },
    });

    store.writeMemory(
      vita.name,
      "conversations",
      `${vita.displayName} on Discord: ${reply}`,
      ["discord", "assistant-message"],
      0.4
    );

    return { vitaName: vita.name, reply, sessionId };
  }

  private buildPrompt(
    vita: VitaConfig,
    username: string,
    userText: string,
    memories: string[],
    history: string[]
  ): string {
    const parts: string[] = [];

    if (vita.systemInstructions) {
      parts.push(vita.systemInstructions);
    } else if (vita.personality) {
      parts.push(vita.personality);
    }

    if (memories.length) {
      parts.push(`Relevant memories:\n${memories.map((memory) => `- ${memory}`).join("\n")}`);
    }

    if (history.length) {
      parts.push(`Recent conversation:\n${history.join("\n")}`);
    }

    parts.push(
      "Mode: You are replying over Discord text, not voice. Keep responses concise and natural for chat." +
      " If you need to proactively alert Mr Vailen outside the current exchange, use the discord_notify tool in voice sessions rather than narrating that intention here."
    );
    parts.push(`Discord user: ${username}`);
    parts.push(`Latest message: ${userText}`);
    parts.push("Reply with just the message text.");

    return parts.join("\n\n");
  }

  private async getRecentTranscript(
    vitaName: string,
    sessionId: string,
    limit: number
  ): Promise<string[]> {
    const date = new Date().toISOString().split("T")[0];
    const transcriptPath = join(homedir(), ".vita", vitaName, "sessions", date, `${sessionId}.jsonl`);

    if (!existsSync(transcriptPath)) {
      return [];
    }

    const lines = readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit);

    return lines.map((line) => {
      const entry = JSON.parse(line) as { role: string; text: string };
      return `${entry.role}: ${entry.text}`;
    });
  }

  private async fetchChannel(channelId: string): Promise<Message["channel"] | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return null;
      }
      return channel as Message["channel"];
    } catch (error: any) {
      logger.error(`[discord] Failed to fetch channel ${channelId}: ${error.message}`);
      return null;
    }
  }

  private canSend(
    channel: Message["channel"]
  ): channel is Message["channel"] & { send: (content: string) => Promise<unknown>; sendTyping: () => Promise<unknown> } {
    return typeof (channel as { send?: unknown }).send === "function";
  }

  private getOrCreateSessionId(vitaName: string, channelId: string): string {
    const key = this.makeSessionKey(vitaName, channelId);
    const existing = this.sessionIds.get(key);
    if (existing) {
      return existing;
    }

    const created = createSessionId();
    this.sessionIds.set(key, created);
    return created;
  }

  private makeSessionKey(vitaName: string, channelId: string): SessionKey {
    return `${vitaName}:${channelId}`;
  }
}
