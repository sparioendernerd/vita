import cron from "node-cron";
import { logger } from "../logger.js";
import type { VitaRegistry } from "../config/vita-registry.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import type { GatewayServer } from "../websocket/server.js";
import type { DiscordBridgeManager } from "../discord/bridge.js";
import { runScheduledTask } from "./runner.js";
import { listScheduledTasks } from "./store.js";

export class VitaScheduler {
  private scheduledJobs = new Map<string, cron.ScheduledTask>();
  private runningJobs = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly vitaRegistry: VitaRegistry,
    private readonly server: GatewayServer,
    private readonly geminiApiKey: string,
    private readonly gatewayConfig: GatewayConfig,
    private readonly discordBridge?: DiscordBridgeManager
  ) {}

  start(): void {
    this.rebuild();
    this.unsubscribe = this.vitaRegistry.onChange(() => this.rebuild());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const job of this.scheduledJobs.values()) {
      job.stop();
    }
    this.scheduledJobs.clear();
  }

  private rebuild(): void {
    for (const job of this.scheduledJobs.values()) {
      job.stop();
    }
    this.scheduledJobs.clear();

    for (const task of listScheduledTasks(this.vitaRegistry)) {
      const vita = this.vitaRegistry.get(task.vitaName);
      if (!vita) {
        logger.warn(`[scheduler] Skipping task for unknown VITA ${task.vitaName}`);
        continue;
      }
      if (task.enabled === false) {
        continue;
      }
      if (!cron.validate(task.cron)) {
        logger.warn(`[scheduler] Skipping invalid cron for ${vita.name}: ${task.cron}`);
        continue;
      }

      const jobKey = `${vita.name}:${task.id ?? task.cron}:${task.action}`;
      const scheduled = cron.schedule(task.cron, () => {
        void this.executeTask(jobKey, vita.name, task.id);
      }, {
        timezone: task.timezone,
      });
      this.scheduledJobs.set(jobKey, scheduled);
      logger.info(`[scheduler] Registered ${jobKey}`);
    }
  }

  private async executeTask(jobKey: string, vitaName: string, taskId?: string): Promise<void> {
    if (this.runningJobs.has(jobKey)) {
      logger.warn(`[scheduler] Skipping overlapping run for ${jobKey}`);
      return;
    }

    const vita = this.vitaRegistry.get(vitaName);
    const task = listScheduledTasks(this.vitaRegistry, vitaName).find((item) => item.id === taskId)
      ?? listScheduledTasks(this.vitaRegistry, vitaName).find((item) => `${vitaName}:${item.id ?? item.cron}:${item.action}` === jobKey);

    if (!vita || !task) {
      logger.warn(`[scheduler] Task disappeared before execution: ${jobKey}`);
      return;
    }

    this.runningJobs.add(jobKey);
    try {
      await runScheduledTask({
        vitaRegistry: this.vitaRegistry,
        server: this.server,
        geminiApiKey: this.geminiApiKey,
        gatewayConfig: this.gatewayConfig,
        discordBridge: this.discordBridge,
      }, vita, task);
    } finally {
      this.runningJobs.delete(jobKey);
    }
  }
}
