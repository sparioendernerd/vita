import { GoogleGenAI } from "@google/genai";
import { logger } from "../logger.js";
import type { VitaConfig, ScheduledTaskConfig, VitaRegistry } from "../config/vita-registry.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import type { GatewayServer } from "../websocket/server.js";
import { getMemoryStore } from "../memory/index.js";
import { makeTextModelFn } from "../gemini/text-client.js";
import { executeSystemRun } from "../tools/system-run.js";
import { sendSystemNotify } from "../tools/system-notify.js";
import type { DiscordBridge } from "../discord/bridge.js";
import { ingestContent } from "../knowledge/ingest.js";

const MAX_TOOL_STEPS = 8;

type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export interface ScheduledTaskRunnerDeps {
  vitaRegistry: VitaRegistry;
  server: GatewayServer;
  geminiApiKey: string;
  gatewayConfig: GatewayConfig;
  discordBridge?: DiscordBridge;
}

export class ScheduledTaskRunner {
  constructor(private readonly deps: ScheduledTaskRunnerDeps) {}

  async runTask(vita: VitaConfig, task: ScheduledTaskConfig): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: this.deps.geminiApiKey });
    const tools = this.buildTools(vita, task);
    const executors = this.buildExecutors(vita);

    const prompt = [
      `You are executing a scheduled task for ${vita.displayName}.`,
      `Current time: ${new Date().toISOString()}`,
      task.description ? `Task description: ${task.description}` : undefined,
      `Task to complete: ${task.action}`,
      "Use tools when needed. Finish the task fully, then return a concise status summary.",
    ].filter(Boolean).join("\n");

    let interaction = await ai.interactions.create({
      model: vita.textModel,
      system_instruction: vita.systemInstructions || `You are ${vita.displayName}.`,
      input: prompt,
      tools,
    });

    let finalText = "";

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      const outputs = interaction.outputs ?? [];
      const functionCalls = outputs.filter((output: any) => output.type === "function_call");
      const textOutputs = outputs
        .filter((output: any) => output.type === "text" && typeof output.text === "string")
        .map((output: any) => output.text.trim())
        .filter(Boolean);

      if (textOutputs.length > 0) {
        finalText = textOutputs.join("\n\n");
      }

      if (functionCalls.length === 0) {
        return finalText || "Scheduled task completed.";
      }

      const results: any[] = [];
      for (const call of functionCalls as any[]) {
        const executor = executors.get(call.name);
        if (!executor) {
          results.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result: { error: `Unsupported tool: ${call.name}` },
          });
          continue;
        }

        try {
          const result = await executor(call.arguments ?? {});
          results.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result: { error: message },
          });
        }
      }

      interaction = await ai.interactions.create({
        model: vita.textModel,
        previous_interaction_id: interaction.id,
        input: results as any,
      });
    }

    return finalText || "Scheduled task stopped after reaching the tool step limit.";
  }

  private buildTools(vita: VitaConfig, task: ScheduledTaskConfig): any[] {
    const enabledTools = new Set(task.tools?.length ? task.tools : vita.tools);
    const tools: any[] = [];
    const functionTools: any[] = [];

    const addFunction = (name: string, description: string, parameters: Record<string, unknown>) => {
      if (enabledTools.has(name)) {
        functionTools.push({ type: "function", name, description, parameters });
      }
    };

    addFunction("read_memory", "Read memories from a specific category.", {
      type: "object",
      properties: {
        category: { type: "string" },
        query: { type: "string" },
      },
      required: ["category"],
    });
    addFunction("write_memory", "Write a new memory.", {
      type: "object",
      properties: {
        category: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number" },
      },
      required: ["category", "content"],
    });
    addFunction("search_memory", "Search across all memories.", {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });
    addFunction("consolidate_memories", "Consolidate conversation memories into distilled facts.", {
      type: "object",
      properties: {
        category: { type: "string" },
      },
    });
    addFunction("system_run", "Execute a command on the gateway machine.", {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "integer" },
      },
      required: ["command"],
    });
    addFunction("system_notify", "Send a desktop notification.", {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        urgency: { type: "string" },
      },
      required: ["title", "body"],
    });
    addFunction("discord_notify", "Send a Discord message.", {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
    });
    addFunction("discord_send_file", "Send a file to Discord.", {
      type: "object",
      properties: {
        file_path: { type: "string" },
        caption: { type: "string" },
      },
      required: ["file_path"],
    });
    addFunction("system_list_nodes", "List connected VITA nodes.", {
      type: "object",
      properties: {},
    });
    addFunction("ingest_knowledge", "Ingest content from a URL or raw text into memory.", {
      type: "object",
      properties: {
        url: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    });

    for (const nodeTool of [
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
    ]) {
      addFunction(nodeTool, `Execute the ${nodeTool} tool on an online VITA node.`, {
        type: "object",
        properties: nodeTool === "launch_steam_game" ? { app_id: { type: "string" } } : {},
        required: nodeTool === "launch_steam_game" ? ["app_id"] : [],
      });
    }

    if (functionTools.length > 0) {
      tools.push(...functionTools);
    }

    if (enabledTools.has("google_search")) {
      tools.push({ type: "google_search" });
    }

    return tools;
  }

  private buildExecutors(vita: VitaConfig): Map<string, ToolExecutor> {
    const store = getMemoryStore(vita.name, this.deps.geminiApiKey);
    const executors = new Map<string, ToolExecutor>();

    executors.set("read_memory", async (args) => ({
      memories: store.readMemory(vita.name, String(args.category), args.query ? String(args.query) : undefined),
    }));
    executors.set("write_memory", async (args) =>
      store.writeMemory(
        vita.name,
        String(args.category),
        String(args.content),
        Array.isArray(args.tags) ? args.tags.map(String) : [],
        typeof args.importance === "number" ? args.importance : undefined
      )
    );
    executors.set("search_memory", async (args) => ({
      memories: await store.searchMemory(
        vita.name,
        String(args.query),
        typeof args.limit === "number" ? args.limit : undefined
      ),
    }));
    executors.set("consolidate_memories", async (args) => {
      const textModelFn = makeTextModelFn(this.deps.geminiApiKey, vita.textModel);
      return (await store.consolidateMemories(vita.name, textModelFn, {
        category: args.category ? String(args.category) : "conversations",
      })) ?? { message: "Nothing to consolidate yet." };
    });
    executors.set("system_run", async (args) =>
      executeSystemRun({
        callId: "scheduled-task",
        command: String(args.command),
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeout: typeof args.timeout === "number" ? args.timeout : undefined,
      }, this.deps.gatewayConfig.tools.exec)
    );
    executors.set("system_notify", async (args) =>
      sendSystemNotify({
        callId: "scheduled-task",
        title: String(args.title),
        body: String(args.body),
        urgency: args.urgency ? String(args.urgency) as "low" | "normal" | "critical" : undefined,
      })
    );
    executors.set("discord_notify", async (args) => {
      if (!this.deps.discordBridge) {
        return { success: false, error: "Discord bridge is not enabled on the gateway." };
      }
      return this.deps.discordBridge.notifyVita(vita.name, {
        title: String(args.title),
        body: String(args.body),
      });
    });
    executors.set("discord_send_file", async (args) => {
      if (!this.deps.discordBridge) {
        return { success: false, error: "Discord bridge is not enabled on the gateway." };
      }
      return this.deps.discordBridge.sendFileToVita(vita.name, {
        filePath: String(args.file_path),
        caption: args.caption ? String(args.caption) : undefined,
      });
    });
    executors.set("system_list_nodes", async () => ({
      nodes: this.deps.server.getConnectedNodes().map((node) => ({
        id: node.id,
        vitaName: node.vitaName,
        capabilities: node.capabilities,
        state: node.state,
        lastSeen: new Date(node.lastHeartbeat).toISOString(),
      })),
    }));
    executors.set("ingest_knowledge", async (args) => {
      const ingestResult = await ingestContent(
        args.url ? String(args.url) : undefined,
        args.content ? String(args.content) : undefined
      );
      if (!ingestResult.success || !ingestResult.content) {
        return { success: false, error: ingestResult.error ?? "Knowledge ingestion failed." };
      }
      const memory = store.writeMemory(
        vita.name,
        "world-knowledge",
        `Document: ${ingestResult.title}\nSource: ${ingestResult.source}\nContent: ${ingestResult.content.substring(0, 5000)}`,
        ["ingested", ...(Array.isArray(args.tags) ? args.tags.map(String) : [])]
      );
      return {
        success: true,
        title: ingestResult.title,
        source: ingestResult.source,
        id: memory.id,
      };
    });

    for (const nodeTool of [
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
    ]) {
      executors.set(nodeTool, async (args) => {
        const node = this.deps.server.getConnectedNodesForVita(vita.name)[0];
        if (!node) {
          return { error: `No online node is available for ${vita.displayName}.` };
        }
        return this.deps.server.executeToolOnNode(node.id, nodeTool, args);
      });
    }

    return executors;
  }
}

export async function runScheduledTask(
  deps: ScheduledTaskRunnerDeps,
  vita: VitaConfig,
  task: ScheduledTaskConfig
): Promise<void> {
  logger.info(`[scheduler] Starting task ${task.id ?? "(no-id)"} for ${vita.name}: ${task.cron}`);
  const runner = new ScheduledTaskRunner(deps);

  try {
    const summary = await runner.runTask(vita, task);
    logger.info(`[scheduler] Completed task ${task.id ?? "(no-id)"} for ${vita.name}: ${summary}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[scheduler] Task ${task.id ?? "(no-id)"} failed for ${vita.name}: ${message}`);
  }
}
