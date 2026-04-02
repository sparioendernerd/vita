import { readFileSync, writeFileSync } from "node:fs";
import { v4 as uuid } from "uuid";
import cron from "node-cron";
import { vitaConfigSchema, type ScheduledTaskConfig, type VitaRegistry } from "../config/vita-registry.js";

export function listScheduledTasks(vitaRegistry: VitaRegistry, vitaName: string): ScheduledTaskConfig[] {
  return vitaRegistry.get(vitaName)?.scheduledTasks ?? [];
}

export function addScheduledTask(
  vitaRegistry: VitaRegistry,
  vitaName: string,
  task: Omit<ScheduledTaskConfig, "id" | "enabled"> & { id?: string; enabled?: boolean }
): ScheduledTaskConfig {
  if (!cron.validate(task.cron)) {
    throw new Error(`Invalid cron expression: ${task.cron}`);
  }

  const taskWithId: ScheduledTaskConfig = {
    id: task.id ?? uuid(),
    ...task,
    enabled: task.enabled ?? true,
  };

  updateVitaConfig(vitaRegistry, vitaName, (config) => ({
    ...config,
    scheduledTasks: [...config.scheduledTasks, taskWithId],
  }));

  return taskWithId;
}

export function removeScheduledTask(vitaRegistry: VitaRegistry, vitaName: string, taskId: string): boolean {
  let removed = false;

  updateVitaConfig(vitaRegistry, vitaName, (config) => {
    const nextTasks = config.scheduledTasks.filter((task) => {
      const keep = task.id !== taskId;
      if (!keep) {
        removed = true;
      }
      return keep;
    });

    return {
      ...config,
      scheduledTasks: nextTasks,
    };
  });

  return removed;
}

function updateVitaConfig(
  vitaRegistry: VitaRegistry,
  vitaName: string,
  updater: (config: ReturnType<typeof vitaConfigSchema.parse>) => ReturnType<typeof vitaConfigSchema.parse>
): void {
  const configPath = vitaRegistry.getConfigPath(vitaName);
  if (!configPath) {
    throw new Error(`Unknown VITA config path for '${vitaName}'.`);
  }

  const current = vitaConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf-8")));
  const updated = updater(current);
  const validated = vitaConfigSchema.parse(updated);
  writeFileSync(configPath, JSON.stringify(validated, null, 2), "utf-8");
}
