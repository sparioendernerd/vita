import { logger } from "../logger.js";
import type { VitaRegistry } from "../config/vita-registry.js";
import type { GatewayServer } from "../websocket/server.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import type { DiscordBridgeManager } from "../discord/bridge.js";
import {
  completeBackgroundTask,
  failBackgroundTask,
  listBackgroundTasks,
  markBackgroundTaskRunning,
  type BackgroundTask,
} from "./store.js";
import { ScheduledTaskRunner } from "../scheduler/runner.js";
import { sendSystemNotify } from "../tools/system-notify.js";

export class BackgroundTaskRunner {
  private timer?: NodeJS.Timeout;
  private readonly active = new Set<string>();

  constructor(
    private readonly deps: {
      vitaRegistry: VitaRegistry;
      server: GatewayServer;
      geminiApiKey: string;
      gatewayConfig: GatewayConfig;
      discordBridge?: DiscordBridgeManager;
    }
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const queued = listBackgroundTasks(undefined, "queued");
    for (const task of queued) {
      if (this.active.has(task.id)) {
        continue;
      }
      this.active.add(task.id);
      void this.executeTask(task).finally(() => {
        this.active.delete(task.id);
      });
    }
  }

  private async executeTask(task: BackgroundTask): Promise<void> {
    const vita = this.deps.vitaRegistry.get(task.vitaName);
    if (!vita) {
      failBackgroundTask(task.id, `Unknown VITA '${task.vitaName}'.`);
      return;
    }

    markBackgroundTaskRunning(task.id);
    const runner = new ScheduledTaskRunner({
      vitaRegistry: this.deps.vitaRegistry,
      server: this.deps.server,
      geminiApiKey: this.deps.geminiApiKey,
      gatewayConfig: this.deps.gatewayConfig,
      discordBridge: this.deps.discordBridge,
    });

    try {
      const summary = await runner.runTask(vita, {
        id: task.id,
        action: task.goal,
        description: task.description ?? task.title,
        tools: task.tools,
      });
      completeBackgroundTask(task.id, summary);
      await this.notifyCompletion(vita.name, task, summary, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[background] Task ${task.id} failed for ${vita.name}: ${message}`);
      failBackgroundTask(task.id, message);
      await this.notifyCompletion(vita.name, task, message, true);
    }
  }

  private async notifyCompletion(vitaName: string, task: BackgroundTask, body: string, failed: boolean): Promise<void> {
    const title = failed
      ? `Background task failed: ${task.title}`
      : `Background task finished: ${task.title}`;

    if (this.deps.discordBridge) {
      const result = await this.deps.discordBridge.notifyVita(vitaName, {
        title,
        body,
      });
      if (result.success) {
        return;
      }
    }

    await sendSystemNotify({
      callId: `background-${task.id}`,
      title,
      body,
    });
  }
}
