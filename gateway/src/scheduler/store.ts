import cron from "node-cron";
import { v4 as uuid } from "uuid";
import type { VitaRegistry } from "../config/vita-registry.js";
import {
  loadSharedScheduleFile,
  migrateLegacyScheduledTasks,
  saveSharedScheduleFile,
  type SharedScheduleTask,
} from "../config/spawn-storage.js";

export function listScheduledTasks(vitaRegistry: VitaRegistry, vitaName?: string): SharedScheduleTask[] {
  const tasks = ensureScheduleMigration(vitaRegistry);
  return vitaName ? tasks.filter((task) => task.vitaName === vitaName) : tasks;
}

export function addScheduledTask(
  vitaRegistry: VitaRegistry,
  vitaName: string,
  task: Omit<SharedScheduleTask, "id" | "vitaName" | "enabled"> & { id?: string; enabled?: boolean }
): SharedScheduleTask {
  if (!cron.validate(task.cron)) {
    throw new Error(`Invalid cron expression: ${task.cron}`);
  }

  const schedule = loadSharedScheduleFile();
  const nextTask: SharedScheduleTask = {
    id: task.id ?? uuid(),
    vitaName,
    cron: task.cron,
    action: task.action,
    description: task.description,
    timezone: task.timezone,
    enabled: task.enabled ?? true,
    tools: task.tools,
  };
  saveSharedScheduleFile({
    ...schedule,
    migratedLegacySchedules: true,
    tasks: [...ensureScheduleMigration(vitaRegistry), nextTask],
  });
  return nextTask;
}

export function removeScheduledTask(vitaRegistry: VitaRegistry, vitaName: string, taskId: string): boolean {
  const schedule = loadSharedScheduleFile();
  const existing = ensureScheduleMigration(vitaRegistry);
  const nextTasks = existing.filter((task) => !(task.vitaName === vitaName && task.id === taskId));
  if (nextTasks.length === existing.length) {
    return false;
  }
  saveSharedScheduleFile({
    ...schedule,
    migratedLegacySchedules: true,
    tasks: nextTasks,
  });
  return true;
}

export function ensureScheduleMigration(vitaRegistry: VitaRegistry): SharedScheduleTask[] {
  return migrateLegacyScheduledTasks(vitaRegistry.getAll());
}
