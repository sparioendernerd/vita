import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { getBackgroundTasksPath, getSharedDir } from "../config/vita-home.js";

const backgroundTaskStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

const backgroundTaskLogEntrySchema = z.object({
  timestamp: z.string(),
  message: z.string(),
});

const backgroundTaskSchema = z.object({
  id: z.string(),
  vitaName: z.string(),
  title: z.string(),
  goal: z.string(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  status: backgroundTaskStatusSchema.default("queued"),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  logs: z.array(backgroundTaskLogEntrySchema).default([]),
});

const backgroundTaskFileSchema = z.object({
  tasks: z.array(backgroundTaskSchema).default([]),
});

export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

function ensureStore(): void {
  mkdirSync(getSharedDir(), { recursive: true });
  if (!existsSync(getBackgroundTasksPath())) {
    writeFileSync(getBackgroundTasksPath(), JSON.stringify({ tasks: [] }, null, 2) + "\n", "utf-8");
  }
}

function loadTaskFile() {
  ensureStore();
  return backgroundTaskFileSchema.parse(JSON.parse(readFileSync(getBackgroundTasksPath(), "utf-8")));
}

function saveTaskFile(data: z.infer<typeof backgroundTaskFileSchema>): void {
  ensureStore();
  const validated = backgroundTaskFileSchema.parse(data);
  writeFileSync(getBackgroundTasksPath(), JSON.stringify(validated, null, 2) + "\n", "utf-8");
}

export function startBackgroundTask(input: {
  vitaName: string;
  title?: string;
  goal: string;
  description?: string;
  tools?: string[];
}): BackgroundTask {
  const file = loadTaskFile();
  const now = new Date().toISOString();
  const task = backgroundTaskSchema.parse({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    vitaName: input.vitaName,
    title: input.title?.trim() || input.goal.trim().slice(0, 80),
    goal: input.goal.trim(),
    description: input.description?.trim() || undefined,
    tools: input.tools?.length ? input.tools : undefined,
    status: "queued",
    createdAt: now,
    logs: [{ timestamp: now, message: "Task accepted and queued." }],
  });
  file.tasks.push(task);
  saveTaskFile(file);
  return task;
}

export function listBackgroundTasks(vitaName?: string, status?: BackgroundTaskStatus): BackgroundTask[] {
  const file = loadTaskFile();
  return file.tasks
    .filter((task) => (vitaName ? task.vitaName === vitaName : true))
    .filter((task) => (status ? task.status === status : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getBackgroundTask(taskId: string, vitaName?: string): BackgroundTask | null {
  return listBackgroundTasks(vitaName).find((task) => task.id === taskId) ?? null;
}

export function markBackgroundTaskRunning(taskId: string): BackgroundTask {
  return updateBackgroundTask(taskId, (task) => ({
    ...task,
    status: "running",
    startedAt: task.startedAt ?? new Date().toISOString(),
    logs: [...task.logs, { timestamp: new Date().toISOString(), message: "Task started." }],
  }));
}

export function completeBackgroundTask(taskId: string, summary: string): BackgroundTask {
  return updateBackgroundTask(taskId, (task) => ({
    ...task,
    status: "completed",
    finishedAt: new Date().toISOString(),
    resultSummary: summary.trim(),
    logs: [...task.logs, { timestamp: new Date().toISOString(), message: "Task completed." }],
  }));
}

export function failBackgroundTask(taskId: string, error: string): BackgroundTask {
  return updateBackgroundTask(taskId, (task) => ({
    ...task,
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: error.trim(),
    logs: [...task.logs, { timestamp: new Date().toISOString(), message: `Task failed: ${error.trim()}` }],
  }));
}

export function cancelBackgroundTask(taskId: string, vitaName: string): BackgroundTask {
  return updateBackgroundTask(taskId, (task) => {
    if (task.vitaName !== vitaName) {
      throw new Error("You can only cancel your own background tasks.");
    }
    if (task.status === "running") {
      throw new Error("Running background tasks cannot be cancelled yet.");
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      throw new Error(`Task is already ${task.status}.`);
    }
    return {
      ...task,
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      logs: [...task.logs, { timestamp: new Date().toISOString(), message: "Task cancelled." }],
    };
  });
}

function updateBackgroundTask(taskId: string, updater: (task: BackgroundTask) => BackgroundTask): BackgroundTask {
  const file = loadTaskFile();
  const index = file.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) {
    throw new Error(`No background task found with id '${taskId}'.`);
  }
  const updated = backgroundTaskSchema.parse(updater(file.tasks[index]));
  file.tasks[index] = updated;
  saveTaskFile(file);
  return updated;
}
