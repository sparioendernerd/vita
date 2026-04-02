import { logger } from "../logger.js";
import type { VitaRegistry } from "../config/vita-registry.js";
import type { GatewayServer, NodeConnection } from "./server.js";
import {
  type ProtocolMessage,
  type SessionStartPayload,
  type SessionEndPayload,
  type ToolRequestPayload,
  type TranscriptEntryPayload,
  type NodeStatusPayload,
  type NodeCommandResultPayload,
  type SystemRunPayload,
  type SystemNotifyPayload,
  type SessionTranscriptPayload,
  type KnowledgeQueryPayload,
  createMessage,
} from "./protocol.js";
import { getMemoryStore } from "../memory/index.js";
import { makeTextModelFn } from "../gemini/text-client.js";
import { executeSystemRun } from "../tools/system-run.js";
import { sendSystemNotify } from "../tools/system-notify.js";
import { appendTranscript } from "../knowledge/transcript-logger.js";
import { ingestContent } from "../knowledge/ingest.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import type { DiscordBridge } from "../discord/bridge.js";
import { addScheduledTask, listScheduledTasks, removeScheduledTask } from "../scheduler/task-config.js";

export type MessageHandler = (node: NodeConnection, msg: ProtocolMessage) => void;
export type MessageHandlers = Record<string, MessageHandler>;

// Track active session IDs per node
const activeSessions = new Map<string, string>();

export function createHandlers(
  vitaRegistry: VitaRegistry,
  server: GatewayServer,
  geminiApiKey: string,
  config?: GatewayConfig,
  discordBridge?: DiscordBridge
): MessageHandlers {
  return {
    // ── Session ──────────────────────────────────────────────────────────

    "session:start": (node, msg) => {
      const payload = msg.payload as SessionStartPayload;
      const vita = vitaRegistry.get(payload.vitaName);

      if (!vita) {
        logger.error(`Unknown VITA requested: ${payload.vitaName}`);
        server.sendToNode(
          node.id,
          createMessage("session:config", { vitaConfig: null, memories: [], error: "Unknown VITA" })
        );
        return;
      }

      logger.info(`Session start requested by ${node.id.substring(0, 8)}... for VITA ${vita.displayName}`);

      const store = getMemoryStore(vita.name, geminiApiKey);
      const memories: string[] = store.getSessionContext(vita.name, 12).map((m) => m.content);

      // Track session
      const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      activeSessions.set(node.id, sessionId);

      server.sendToNode(
        node.id,
        createMessage("session:config", { vitaConfig: vita, memories })
      );
    },

    "session:end": (node, msg) => {
      const payload = msg.payload as SessionEndPayload;
      logger.info(`Session ended on ${node.id.substring(0, 8)}...: ${payload.reason}`);

      activeSessions.delete(node.id);

      // Decay old memories on session end
      try {
        getMemoryStore(node.vitaName, geminiApiKey).applyImportanceDecay(node.vitaName);
      } catch (err) {
        logger.error(`[memory] Decay failed for ${node.vitaName}: ${err}`);
      }
    },

    // ── Tools ────────────────────────────────────────────────────────────

    "tool:request": (node, msg) => {
      const payload = msg.payload as ToolRequestPayload;
      logger.info(`Tool request from ${node.id.substring(0, 8)}...: ${payload.toolName}(${JSON.stringify(payload.args)})`);

      const store = getMemoryStore(node.vitaName, geminiApiKey);
      let result: unknown;

      const handleAsync = async () => {
        try {
          if (payload.toolName === "write_memory") {
            result = store.writeMemory(
              node.vitaName,
              payload.args.category as string,
              payload.args.content as string,
              (payload.args.tags as string[]) ?? [],
              payload.args.importance as number | undefined
            );
          } else if (payload.toolName === "read_memory") {
            const memories = store.readMemory(
              node.vitaName,
              payload.args.category as string,
              payload.args.query as string | undefined
            );
            result = { memories };
          } else if (payload.toolName === "search_memory") {
            const memories = await store.searchMemory(
              node.vitaName,
              payload.args.query as string,
              payload.args.limit as number | undefined
            );
            result = { memories };
          } else if (payload.toolName === "consolidate_memories") {
            const vita = vitaRegistry.get(node.vitaName);
            if (!vita) {
              result = { error: "Unknown VITA" };
            } else {
              const textModelFn = makeTextModelFn(geminiApiKey, vita.textModel);
              const consolidationResult = await store.consolidateMemories(
                node.vitaName,
                textModelFn,
                { category: (payload.args.category as string | undefined) ?? "conversations" }
              );
              result = consolidationResult ?? { message: "Nothing to consolidate yet" };
            }

          // ── System tools (new) ──────────────────────────────────────

          } else if (payload.toolName === "system_run") {
            const execConfig = config?.tools.exec ?? { enabled: false, security: "deny" as const, allowlist: [] };
            result = await executeSystemRun(
              {
                callId: payload.callId,
                command: payload.args.command as string,
                cwd: payload.args.cwd as string | undefined,
                timeout: payload.args.timeout as number | undefined,
              },
              execConfig
            );
          } else if (payload.toolName === "system_notify") {
            result = await sendSystemNotify({
              callId: payload.callId,
              title: payload.args.title as string,
              body: payload.args.body as string,
              urgency: payload.args.urgency as "low" | "normal" | "critical" | undefined,
            });
          } else if (payload.toolName === "discord_notify") {
            if (!discordBridge) {
              result = { success: false, error: "Discord bridge is not enabled on the gateway." };
            } else {
              result = await discordBridge.notifyVita(node.vitaName, {
                title: payload.args.title as string,
                body: payload.args.body as string,
              });
            }
          } else if (payload.toolName === "discord_send_file") {
            if (!discordBridge) {
              result = { success: false, error: "Discord bridge is not enabled on the gateway." };
            } else {
              result = await discordBridge.sendFileToVita(node.vitaName, {
                filePath: payload.args.file_path as string,
                caption: payload.args.caption as string | undefined,
              });
            }
          } else if (payload.toolName === "system_list_nodes") {
            const nodes = server.getConnectedNodes().map((n) => ({
              id: n.id,
              name: n.vitaName,
              capabilities: n.capabilities,
              state: n.state,
              lastSeen: new Date(n.lastHeartbeat).toISOString(),
            }));
            result = { nodes };
          } else if (payload.toolName === "ingest_knowledge") {
            const { url, content, tags = [] } = payload.args as any;
            const ingestResult = await ingestContent(url, content);
            if (ingestResult.success && ingestResult.content) {
              const memoryId = store.writeMemory(
                node.vitaName,
                "world-knowledge",
                `Document: ${ingestResult.title}\nSource: ${ingestResult.source}\nContent: ${ingestResult.content.substring(0, 5000)}`,
                ["ingested", ...tags]
              );
              result = {
                success: true,
                title: ingestResult.title,
                id: memoryId.id,
                message: `Knowledge ingested successfully into long-term memory.`
              };
            } else {
              result = { success: false, error: ingestResult.error };
            }
          } else if (payload.toolName === "schedule_task") {
            result = {
              success: true,
              task: addScheduledTask(vitaRegistry, node.vitaName, {
                cron: payload.args.cron as string,
                action: payload.args.action as string,
                description: payload.args.description as string | undefined,
                timezone: payload.args.timezone as string | undefined,
                enabled: typeof payload.args.enabled === "boolean" ? payload.args.enabled : undefined,
                tools: payload.args.tools as string[] | undefined,
              }),
            };
          } else if (payload.toolName === "list_scheduled_tasks") {
            result = {
              tasks: listScheduledTasks(vitaRegistry, node.vitaName),
            };
          } else if (payload.toolName === "remove_scheduled_task") {
            const removed = removeScheduledTask(
              vitaRegistry,
              node.vitaName,
              payload.args.id as string
            );
            result = removed
              ? { success: true, removedId: payload.args.id }
              : { success: false, error: `No scheduled task found with id '${payload.args.id as string}'.` };
          } else {
            result = { message: `Unknown tool: ${payload.toolName}` };
          }
        } catch (err: any) {
          logger.error(`Error executing tool ${payload.toolName}: ${err.message}`);
          result = { error: err.message };
        }

        server.sendToNode(
          node.id,
          createMessage("tool:response", { callId: payload.callId, result })
        );
      };

      handleAsync();
    },

    // ── Transcript (legacy + new) ────────────────────────────────────────

    "transcript:entry": (_node, msg) => {
      const payload = msg.payload as TranscriptEntryPayload;
      logger.info(`[${payload.vitaName}] ${payload.role}: ${payload.text}`);

      // Also persist as transcript
      const sessionId = activeSessions.get(_node.id) || "unknown";
      appendTranscript(payload.vitaName, sessionId, {
        timestamp: msg.timestamp,
        role: payload.role,
        text: payload.text,
      });
    },

    "session:transcript": (_node, msg) => {
      const payload = msg.payload as SessionTranscriptPayload;
      logger.info(`[${payload.vitaName}] ${payload.role}: ${payload.text}`);
      appendTranscript(payload.vitaName, payload.sessionId, {
        timestamp: msg.timestamp,
        role: payload.role,
        text: payload.text,
        metadata: payload.metadata,
      });
    },

    // ── System execution (direct message types) ──────────────────────────

    "system:run": (node, msg) => {
      const payload = msg.payload as SystemRunPayload;
      const execConfig = config?.tools.exec ?? { enabled: false, security: "deny" as const, allowlist: [] };

      executeSystemRun(payload, execConfig).then((result) => {
        server.sendToNode(node.id, createMessage("system:run:result", result));
      });
    },

    "system:notify": (node, msg) => {
      const payload = msg.payload as SystemNotifyPayload;
      sendSystemNotify(payload).then((result) => {
        server.sendToNode(node.id, createMessage("tool:response", result));
      });
    },

    // ── Knowledge (new) ──────────────────────────────────────────────────

    "knowledge:query": async (node, msg) => {
      const payload = msg.payload as KnowledgeQueryPayload;
      const store = getMemoryStore(node.vitaName, geminiApiKey);

      try {
        const memories = await store.searchMemory(node.vitaName, payload.query, payload.limit ?? 10);
        server.sendToNode(
          node.id,
          createMessage("knowledge:result", {
            callId: payload.callId,
            results: memories.map((m) => ({
              content: m.content,
              category: m.category,
              importance: m.importance,
              timestamp: m.timestamp,
            })),
          })
        );
      } catch (err: any) {
        server.sendToNode(
          node.id,
          createMessage("knowledge:result", {
            callId: payload.callId,
            results: [],
            error: err.message,
          })
        );
      }
    },

    // ── Node status ──────────────────────────────────────────────────────

    "node:status": (node, msg) => {
      const payload = msg.payload as NodeStatusPayload;
      node.state = payload.state;
      logger.info(`Node ${node.id.substring(0, 8)}... status: ${payload.state}`);
    },

    // ── Node list (query from any connected node) ────────────────────────

    "node:command:result": (_node, msg) => {
      const payload = msg.payload as NodeCommandResultPayload;
      server.resolveNodeCommand(payload.callId, payload.result, payload.error);
    },

    "node:list": (node, _msg) => {
      const nodes = server.getConnectedNodes().map((n) => ({
        id: n.id,
        vitaName: n.vitaName,
        capabilities: n.capabilities,
        state: n.state,
        lastHeartbeat: n.lastHeartbeat,
      }));
      server.sendToNode(node.id, createMessage("node:list", { nodes }));
    },
  };
}
