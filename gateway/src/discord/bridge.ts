import {
  AttachmentBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  Partials,
  type User,
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { VitaRegistry, VitaConfig } from "../config/vita-registry.js";
import { getMemoryStore } from "../memory/index.js";
import { appendTranscript, createSessionId } from "../knowledge/transcript-logger.js";
import { logger } from "../logger.js";
import { GoogleGenAI, createPartFromFunctionResponse } from "@google/genai";
import { executeSystemRun } from "../tools/system-run.js";
import { sendSystemNotify } from "../tools/system-notify.js";
import { listScripts, runScript, SCRIPTS_ROOT } from "../tools/script-runner.js";
import { ingestContent } from "../knowledge/ingest.js";
import { makeTextModelFn } from "../gemini/text-client.js";
import type { GatewayServer } from "../websocket/server.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import { getVitaDir } from "../config/vita-home.js";
import { listVitaSummaries, markMailboxMessageRead, readMailboxMessages, readSharedUserProfile, sendMailboxMessage } from "../config/spawn-storage.js";

interface DiscordBridgeOptions {
  token: string;
  applicationId?: string;
  defaultDmUserId?: string;
  geminiApiKey: string;
  vitaRegistry: VitaRegistry;
}

interface DiscordReplyResult {
  vitaName: string;
  reply: string;
  sessionId: string;
}

interface DiscordFilePayload {
  filePath: string;
  caption?: string;
}

interface TranscriptTurn {
  role: "user" | "model";
  text: string;
}

const NODE_LOCAL_TOOLS = new Set([
  "enable_vision",
  "disable_vision",
  "enable_screenshare",
  "media_play_pause",
  "media_next_track",
  "media_prev_track",
  "media_volume_up",
  "media_volume_down",
  "list_steam_games",
  "launch_steam_game",
]);

type SessionKey = `${string}:${string}`;

export class DiscordBridge {
  private readonly client: Client;
  private readonly genai: GoogleGenAI;
  private readonly geminiApiKey: string;
  private readonly vitaRegistry: VitaRegistry;
  private readonly sessionIds = new Map<SessionKey, string>();
  private readonly lastDmUsers = new Map<string, string>();
  private readonly inFlight = new Set<SessionKey>();
  private readonly token: string;
  private readonly applicationId?: string;
  private readonly defaultDmUserId?: string;
  private gatewayServer?: GatewayServer;
  private gatewayConfig?: GatewayConfig;
  private ready = false;

  constructor(options: DiscordBridgeOptions) {
    this.token = options.token;
    this.applicationId = options.applicationId;
    this.defaultDmUserId = options.defaultDmUserId;
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

  attachGateway(server: GatewayServer, config: GatewayConfig): void {
    this.gatewayServer = server;
    this.gatewayConfig = config;
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

    const dmTargetUserId = this.getDmTargetUserId(vita);
    const message = `**${payload.title.trim()}**\n${payload.body.trim()}`.trim();
    let sent = 0;

    if (dmTargetUserId) {
      const user = await this.fetchUser(dmTargetUserId);
      if (user) {
        const dmChannel = await user.createDM();
        await dmChannel.send(message);
        sent += 1;
      }
    }

    if (!vita.discordChannels.length) {
      if (!sent) {
        return {
          success: false,
          sent: 0,
          error: `No Discord DM target or channels configured for ${vitaName}`,
        };
      }
      logger.info(`[discord] Sent outbound DM notification for ${vitaName}`);
      return { success: true, sent };
    }

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
      return { success: false, sent: 0, error: "No Discord DM target or configured channels were reachable" };
    }

    logger.info(`[discord] Sent outbound notification for ${vitaName} to ${sent} destination(s)`);
    return { success: true, sent };
  }

  async sendFileToVita(
    vitaName: string,
    payload: DiscordFilePayload,
    options?: { channelId?: string }
  ): Promise<{ success: boolean; sent: number; error?: string; filename?: string }> {
    const vita = this.vitaRegistry.get(vitaName);
    if (!vita) {
      return { success: false, sent: 0, error: `Unknown VITA: ${vitaName}` };
    }

    const filePath = payload.filePath.trim();
    if (!filePath || !existsSync(filePath)) {
      return { success: false, sent: 0, error: `File not found: ${filePath}` };
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { success: false, sent: 0, error: `Path is not a file: ${filePath}` };
    }

    const maxBytes = 25 * 1024 * 1024;
    if (stat.size > maxBytes) {
      return { success: false, sent: 0, error: `File is too large for Discord upload (${stat.size} bytes).` };
    }

    const attachment = new AttachmentBuilder(filePath);
    const messagePayload = {
      content: payload.caption?.trim() || undefined,
      files: [attachment],
    };

    let sent = 0;

    if (options?.channelId) {
      const channel = await this.fetchChannel(options.channelId);
      if (!channel || !this.canSend(channel)) {
        return { success: false, sent: 0, error: `Channel ${options.channelId} is not sendable.` };
      }
      await channel.send(messagePayload);
    return { success: true, sent: 1, filename: basename(filePath) };
    }

    const dmTargetUserId = this.getDmTargetUserId(vita);
    if (dmTargetUserId) {
      const user = await this.fetchUser(dmTargetUserId);
      if (user) {
        const dmChannel = await user.createDM();
        await dmChannel.send(messagePayload);
        sent += 1;
      }
    }

    for (const channelId of vita.discordChannels) {
      const channel = await this.fetchChannel(channelId);
      if (!channel || !this.canSend(channel)) {
        continue;
      }
      await channel.send(messagePayload);
      sent += 1;
    }

    if (!sent) {
      return { success: false, sent: 0, error: "No Discord DM target or configured channels were reachable." };
    }

    return { success: true, sent, filename: basename(filePath) };
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
      await this.sendMessage(message, "One moment. Even the undead prefer one crisis at a time.");
      return;
    }

    this.inFlight.add(sessionKey);
    try {
      if (this.canSend(message.channel) && "sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }
      const result = await this.generateReply(vita, message, content);
      await this.sendMessage(message, result.reply);
    } catch (error: any) {
      logger.error(`[discord] Failed to handle message in ${message.channelId}: ${error.message}`);
      await this.sendMessage(message, "Discord has managed to complicate a simple conversation. Try again in a moment.");
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
      const vita = this.vitaRegistry.getFirst();
      if (vita) {
        this.lastDmUsers.set(vita.name, message.author.id);
      }
      return vita;
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

    const reply = await this.runToolAwareChat(vita, message.author, userText, memories, history, message.channelId);

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

  private buildSystemInstruction(vita: VitaConfig, memories: string[]): string {
    const parts: string[] = [];

    if (vita.systemInstructions) {
      parts.push(vita.systemInstructions);
    } else if (vita.personality) {
      parts.push(vita.personality);
    }

    if (memories.length) {
      parts.push(`Relevant memories:\n${memories.map((memory) => `- ${memory}`).join("\n")}`);
    }

    parts.push(
      "Mode: You are replying over Discord text, not voice. Keep responses concise and natural for chat."
    );
    parts.push(
      "You may use tools when needed. For node-local tools such as media, Steam, or vision, first assume they require a live node connection." +
      " If no node is online, clearly say you cannot do it because the node is offline instead of pretending."
    );
    parts.push(
      "After you receive tool results, answer the user directly. Do not call the same tool repeatedly with the same arguments unless something materially changed."
    );
    parts.push(
      "Do not use memory tools for routine chat. Only read, search, write, or consolidate memory when it is genuinely necessary to answer the request or preserve something worth remembering."
    );
    parts.push(
      "For Discord replies, send plain messages. Do not mention function calls, internal errors, or protocol details unless a failure genuinely matters to Mr Vailen."
    );
    parts.push(
      "If Mr Vailen asks you to build a new script or tool, ask concise clarifying questions if requirements are missing." +
      " Once clear, briefly state what you will build, start the Codex script creation job in the background, and tell him you will report back when it finishes." +
      " Do not wait silently for long-running code generation jobs."
    );

    return parts.join("\n\n");
  }

  private async getRecentTranscript(
    vitaName: string,
    sessionId: string,
    limit: number
  ): Promise<TranscriptTurn[]> {
    const date = new Date().toISOString().split("T")[0];
    const transcriptPath = join(getVitaDir(vitaName), "sessions", date, `${sessionId}.jsonl`);

    if (!existsSync(transcriptPath)) {
      return [];
    }

    const lines = readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit);

    return lines
      .map((line) => JSON.parse(line) as { role: string; text: string })
      .filter((entry): entry is TranscriptTurn => entry.role === "user" || entry.role === "model");
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

  private async fetchUser(userId: string) {
    try {
      return await this.client.users.fetch(userId);
    } catch (error: any) {
      logger.error(`[discord] Failed to fetch user ${userId}: ${error.message}`);
      return null;
    }
  }

  private async runToolAwareChat(
    vita: VitaConfig,
    user: User,
    userText: string,
    memories: string[],
    history: TranscriptTurn[],
    channelId?: string
  ): Promise<string> {
    const chat = this.genai.chats.create({
      model: vita.textModel,
      config: {
        systemInstruction: this.buildSystemInstruction(vita, memories),
        tools: [{ functionDeclarations: this.getToolDeclarations(vita) }],
      },
      history: history.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
    });

    let response = await chat.sendMessage({ message: userText });
    const seenCallSignatures = new Map<string, number>();
    let lastToolError: string | undefined;

    for (let i = 0; i < 8; i += 1) {
      const functionCalls = response.functionCalls;
      if (!functionCalls?.length) {
        const text = (response.text ?? "").trim();
        return text || lastToolError || "Silence. Inspiring. Try that again.";
      }

      const signature = JSON.stringify(
        functionCalls.map((call) => ({
          name: call.name ?? "unknown_tool",
          args: call.args ?? {},
        }))
      );
      const signatureCount = (seenCallSignatures.get(signature) ?? 0) + 1;
      seenCallSignatures.set(signature, signatureCount);
      if (signatureCount >= 3) {
        logger.warn(`[discord] Repeated tool loop detected for ${vita.name}: ${signature}`);
        return lastToolError || "I keep hitting the same tool problem. Try that again in a moment.";
      }

      const functionResponses = [];
      for (const call of functionCalls) {
        const callName = call.name ?? "unknown_tool";
        const result = await this.executeTool(vita, callName, (call.args ?? {}) as Record<string, unknown>, user, channelId);
        if (typeof result.error === "string" && result.error.trim()) {
          lastToolError = result.error;
        }
        functionResponses.push(createPartFromFunctionResponse(call.id ?? `${Date.now()}-${callName}`, callName, result));
      }
      response = await chat.sendMessage({ message: functionResponses });
    }

    return lastToolError || "This is becoming elaborate even by our standards. Try that again in a moment.";
  }

  private getToolDeclarations(vita: VitaConfig): Array<Record<string, unknown>> {
    const declarations: Record<string, Record<string, unknown>> = {
      read_memory: {
        name: "read_memory",
        description: "Read memories from a specific category.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["core", "conversations", "user-profiles", "world-knowledge"] },
            query: { type: "string" },
          },
          required: ["category"],
        },
      },
      write_memory: {
        name: "write_memory",
        description: "Write a new memory.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["core", "conversations", "user-profiles", "world-knowledge"] },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            importance: { type: "number" },
          },
          required: ["category", "content"],
        },
      },
      search_memory: {
        name: "search_memory",
        description: "Search across memories.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      list_vitas: {
        name: "list_vitas",
        description: "List known VITAs.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      read_shared_profile: {
        name: "read_shared_profile",
        description: "Read the shared user profile.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      send_vita_message: {
        name: "send_vita_message",
        description: "Leave a durable mailbox message for another VITA.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            to_vita: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to_vita", "body"],
        },
      },
      read_vita_messages: {
        name: "read_vita_messages",
        description: "Read mailbox messages sent to this VITA.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["unread", "read"] },
          },
        },
      },
      mark_vita_message_read: {
        name: "mark_vita_message_read",
        description: "Mark a mailbox message as read.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            message_id: { type: "string" },
          },
          required: ["message_id"],
        },
      },
      consolidate_memories: {
        name: "consolidate_memories",
        description: "Summarize and consolidate older memories.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            category: { type: "string" },
          },
        },
      },
      get_current_time: {
        name: "get_current_time",
        description: "Get the current local date and time.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      system_run: {
        name: "system_run",
        description: "Run a shell command on the gateway host, subject to gateway security policy.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["command"],
        },
      },
      list_scripts: {
        name: "list_scripts",
        description: "List registered gateway scripts that Graves can run.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      run_script: {
        name: "run_script",
        description: "Run a registered gateway script by name with optional named arguments.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            args: {
              type: "object",
              additionalProperties: true,
            },
            timeout: { type: "number" },
          },
          required: ["name"],
        },
      },
      create_script_with_codex: {
        name: "create_script_with_codex",
        description: "Create or update a script folder by asking Codex CLI to build it in the background, then notify Mr Vailen when done.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            script_name: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["script_name", "prompt"],
        },
      },
      system_notify: {
        name: "system_notify",
        description: "Send a desktop notification on the gateway host.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            urgency: { type: "string", enum: ["low", "normal", "critical"] },
          },
          required: ["title", "body"],
        },
      },
      discord_notify: {
        name: "discord_notify",
        description: "Send a proactive Discord message to Mr Vailen.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["title", "body"],
        },
      },
      discord_send_file: {
        name: "discord_send_file",
        description: "Send a file or image from the gateway machine to Discord as an attachment.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            caption: { type: "string" },
          },
          required: ["file_path"],
        },
      },
      system_list_nodes: {
        name: "system_list_nodes",
        description: "List connected VITA nodes and whether they are online.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      ingest_knowledge: {
        name: "ingest_knowledge",
        description: "Ingest a URL or raw text into long-term memory.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      enable_vision: {
        name: "enable_vision",
        description: "Enable the camera feed on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      disable_vision: {
        name: "disable_vision",
        description: "Disable the camera or screenshare feed on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      enable_screenshare: {
        name: "enable_screenshare",
        description: "Enable desktop screenshare on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      media_play_pause: {
        name: "media_play_pause",
        description: "Toggle play or pause on an online node's active media player.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      media_next_track: {
        name: "media_next_track",
        description: "Skip to the next track on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      media_prev_track: {
        name: "media_prev_track",
        description: "Go to the previous track on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      media_volume_up: {
        name: "media_volume_up",
        description: "Increase volume on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      media_volume_down: {
        name: "media_volume_down",
        description: "Decrease volume on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      list_steam_games: {
        name: "list_steam_games",
        description: "List installed Steam games on an online node.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      launch_steam_game: {
        name: "launch_steam_game",
        description: "Launch a Steam game by app ID on an online node.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            app_id: { type: "string" },
          },
          required: ["app_id"],
        },
      },
    };

    return vita.tools
      .filter((toolName) => declarations[toolName])
      .map((toolName) => declarations[toolName]);
  }

  private async executeTool(
    vita: VitaConfig,
    toolName: string,
    args: Record<string, unknown>,
    user: User,
    channelId?: string
  ): Promise<Record<string, unknown>> {
    const store = getMemoryStore(vita.name, this.geminiApiKey);

    try {
      if (toolName === "get_current_time") {
        const now = new Date();
        return {
          time: now.toLocaleTimeString(),
          date: now.toLocaleDateString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      }

      if (toolName === "write_memory") {
        return store.writeMemory(
          vita.name,
          String(args.category ?? "conversations"),
          String(args.content ?? ""),
          Array.isArray(args.tags) ? args.tags.map(String) : [],
          typeof args.importance === "number" ? args.importance : undefined
        );
      }

      if (toolName === "read_memory") {
        return {
          memories: store.readMemory(
            vita.name,
            String(args.category ?? "conversations"),
            typeof args.query === "string" ? args.query : undefined
          ),
        };
      }

      if (toolName === "search_memory") {
        return {
          memories: await store.searchMemory(
            vita.name,
            String(args.query ?? ""),
            typeof args.limit === "number" ? args.limit : undefined
          ),
        };
      }

      if (toolName === "list_vitas") {
        return { vitas: listVitaSummaries() };
      }

      if (toolName === "read_shared_profile") {
        return { sharedProfile: readSharedUserProfile() };
      }

      if (toolName === "send_vita_message") {
        return {
          success: true,
          message: sendMailboxMessage({
            fromVita: vita.name,
            toVita: String(args.to_vita ?? ""),
            subject: typeof args.subject === "string" ? args.subject : undefined,
            body: String(args.body ?? ""),
          }),
        };
      }

      if (toolName === "read_vita_messages") {
        return {
          messages: readMailboxMessages(
            vita.name,
            args.status === "unread" || args.status === "read"
              ? args.status
              : undefined
          ),
        };
      }

      if (toolName === "mark_vita_message_read") {
        return {
          success: true,
          message: markMailboxMessageRead(vita.name, String(args.message_id ?? "")),
        };
      }

      if (toolName === "consolidate_memories") {
        const textModelFn = makeTextModelFn(this.geminiApiKey, vita.textModel);
        const consolidation = (
          await store.consolidateMemories(vita.name, textModelFn, {
            category: typeof args.category === "string" ? args.category : "conversations",
          })
        ) ?? { message: "Nothing to consolidate yet." };
        return { ...consolidation };
      }

      if (toolName === "system_run") {
        const execConfig = this.gatewayConfig?.tools.exec ?? { enabled: false, security: "deny" as const, allowlist: [] };
        const runResult = await executeSystemRun({
          callId: `discord-${Date.now()}`,
          command: String(args.command ?? ""),
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        }, execConfig);
        return { ...runResult };
      }

      if (toolName === "list_scripts") {
        return { scripts: listScripts() };
      }

      if (toolName === "run_script") {
        const result = await runScript(
          String(args.name ?? ""),
          isRecord(args.args) ? args.args : {},
          typeof args.timeout === "number" ? args.timeout : undefined
        );
        return { ...result };
      }

      if (toolName === "create_script_with_codex") {
        return await this.startCodexScriptCreation(
          vita,
          user,
          String(args.script_name ?? ""),
          String(args.prompt ?? ""),
          channelId
        );
      }

      if (toolName === "system_notify") {
        return await sendSystemNotify({
          callId: `discord-${Date.now()}`,
          title: String(args.title ?? ""),
          body: String(args.body ?? ""),
          urgency: (args.urgency as "low" | "normal" | "critical" | undefined),
        });
      }

      if (toolName === "discord_notify") {
        const originalTarget = this.lastDmUsers.get(vita.name);
        this.lastDmUsers.set(vita.name, user.id);
        try {
          return await this.notifyVita(vita.name, {
            title: String(args.title ?? ""),
            body: String(args.body ?? ""),
          });
        } finally {
          if (originalTarget) {
            this.lastDmUsers.set(vita.name, originalTarget);
          }
        }
      }

      if (toolName === "discord_send_file") {
        return await this.sendFileToVita(
          vita.name,
          {
            filePath: String(args.file_path ?? ""),
            caption: typeof args.caption === "string" ? args.caption : undefined,
          },
          channelId ? { channelId } : undefined
        );
      }

      if (toolName === "system_list_nodes") {
        return {
          nodes: this.gatewayServer?.getConnectedNodes().map((node) => ({
            id: node.id,
            vitaName: node.vitaName,
            capabilities: node.capabilities,
            state: node.state,
            lastHeartbeat: node.lastHeartbeat,
          })) ?? [],
        };
      }

      if (toolName === "ingest_knowledge") {
        const ingestResult = await ingestContent(
          typeof args.url === "string" ? args.url : undefined,
          typeof args.content === "string" ? args.content : undefined
        );
        if (ingestResult.success && ingestResult.content) {
          const memoryId = store.writeMemory(
            vita.name,
            "world-knowledge",
            `Document: ${ingestResult.title}\nSource: ${ingestResult.source}\nContent: ${ingestResult.content.substring(0, 5000)}`,
            ["ingested", ...(Array.isArray(args.tags) ? args.tags.map(String) : [])]
          );
          return { success: true, id: memoryId.id, title: ingestResult.title };
        }
        return { success: false, error: ingestResult.error ?? "Ingestion failed." };
      }

      if (NODE_LOCAL_TOOLS.has(toolName)) {
        const node = this.pickNodeForVita(vita.name);
        if (!node) {
          return { error: `I can't use '${toolName}' because no node for ${vita.displayName} is online.` };
        }
        const result = await this.gatewayServer?.executeToolOnNode(node.id, toolName, args);
        return { ...(typeof result === "object" && result ? result as Record<string, unknown> : { result }), nodeId: node.id };
      }
    } catch (error: any) {
      logger.error(`[discord] Tool execution failed for ${toolName}: ${error.message}`);
      return { error: error.message };
    }

    return { error: `Unsupported tool: ${toolName}` };
  }

  private async sendMessage(message: Message, content: string): Promise<void> {
    if (this.canSend(message.channel)) {
      await message.channel.send(content);
      return;
    }
    throw new Error(`Channel ${message.channelId} is not sendable`);
  }

  private getDmTargetUserId(vita: VitaConfig): string | undefined {
    return this.defaultDmUserId?.trim() || this.lastDmUsers.get(vita.name);
  }

  private pickNodeForVita(vitaName: string) {
    const nodes = this.gatewayServer?.getConnectedNodesForVita(vitaName) ?? [];
    return nodes
      .filter((node) => node.capabilities.includes("tools") && node.state !== "error")
      .sort((a, b) => b.lastHeartbeat - a.lastHeartbeat)[0];
  }

  private canSend(
    channel: Message["channel"]
  ): channel is Message["channel"] & { send: (content: unknown) => Promise<unknown>; sendTyping: () => Promise<unknown> } {
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

  private async startCodexScriptCreation(
    vita: VitaConfig,
    user: User,
    scriptNameRaw: string,
    promptRaw: string,
    channelId?: string
  ): Promise<Record<string, unknown>> {
    const scriptName = scriptNameRaw.trim().toLowerCase();
    const prompt = promptRaw.trim();

    if (!/^[a-z][a-z0-9_-]*$/.test(scriptName)) {
      return { accepted: false, error: "script_name must match ^[a-z][a-z0-9_-]*$" };
    }
    if (!prompt) {
      return { accepted: false, error: "prompt is required" };
    }

    const targetDir = resolve(SCRIPTS_ROOT, scriptName);
    mkdirSync(targetDir, { recursive: true });

    const manifestPath = join(targetDir, "script.json");
    if (!existsSync(manifestPath)) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            name: scriptName,
            description: `Generated by Codex for ${scriptName}`,
            command: ["python", "main.py"],
            cwd: ".",
            timeoutMs: 30000,
            enabled: true,
            args: [],
          },
          null,
          2
        ) + "\n",
        "utf-8"
      );
    }

    const codexPrompt =
      `You are creating a VITA gateway script inside '${targetDir}'. ` +
      "Use the existing script.json manifest as the entry point and create any helper files needed. " +
      "Keep all files inside that script folder. " +
      `Task: ${prompt}`;

    const startedAt = new Date().toISOString();
    const child = spawn("codex", ["exec", codexPrompt], {
      cwd: targetDir,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        VITA_SCRIPT_NAME: scriptName,
        VITA_SCRIPT_DIR: targetDir,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, String(chunk));
    });

    child.on("error", async (error) => {
      logger.error(`[discord] Codex script creation failed to start for ${scriptName}: ${error.message}`);
      await this.notifyScriptCreationFinished(vita.name, {
        title: `Script build failed: ${scriptName}`,
        body: `Codex refused to start.\nError: ${error.message}`,
      });
    });

    child.on("close", async (code) => {
      const bodyLines = [
        `Script: ${scriptName}`,
        `Started: ${startedAt}`,
        `Finished: ${new Date().toISOString()}`,
        `Exit code: ${typeof code === "number" ? code : "unknown"}`,
      ];

      const output = stdout.trim() || stderr.trim();
      if (output) {
        bodyLines.push("", "Last output:", output.slice(0, 1500));
      }

      const title = code === 0
        ? `Script build finished: ${scriptName}`
        : `Script build failed: ${scriptName}`;

      await this.notifyScriptCreationFinished(vita.name, {
        title,
        body: bodyLines.join("\n"),
      });
    });

    return {
      accepted: true,
      background: true,
      script_name: scriptName,
      folder: targetDir,
      started_at: startedAt,
      message: `Started Codex in the background for '${scriptName}'. Mr Vailen will be notified when it finishes.`,
      requested_by: user.username,
      channel_id: channelId ?? null,
    };
  }

  private async notifyScriptCreationFinished(
    vitaName: string,
    payload: { title: string; body: string }
  ): Promise<void> {
    const result = await this.notifyVita(vitaName, payload);
    if (!result.success) {
      logger.warn(`[discord] Failed to send script completion notice for ${vitaName}: ${result.error ?? "unknown error"}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendLimited(current: string, next: string, maxLength = 4000): string {
  const combined = current + next;
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}
