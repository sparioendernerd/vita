import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../logger.js";

const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 5 * 60 * 1000;
const MAX_OUTPUT = 50000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPTS_ROOT = resolve(__dirname, "../../../scripts");
export const SCRIPTS_ROOT = process.env.VITA_SCRIPTS_ROOT
  ? resolve(process.env.VITA_SCRIPTS_ROOT)
  : DEFAULT_SCRIPTS_ROOT;

const scriptArgSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  description: z.string().default(""),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const scriptManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().default(""),
  command: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT).default(DEFAULT_TIMEOUT),
  enabled: z.boolean().default(true),
  args: z.array(scriptArgSchema).default([]),
});

export type ScriptManifest = z.infer<typeof scriptManifestSchema>;
export type ScriptArgDefinition = z.infer<typeof scriptArgSchema>;

export interface ScriptSummary {
  name: string;
  description: string;
  folder: string;
  timeoutMs: number;
  args: ScriptArgDefinition[];
}

export interface RunScriptResult {
  script: ScriptSummary;
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
}

interface LoadedScript {
  manifest: ScriptManifest;
  scriptDir: string;
}

export function listScripts(): ScriptSummary[] {
  if (!existsSync(SCRIPTS_ROOT)) {
    return [];
  }

  const loaded: ScriptSummary[] = [];
  for (const entry of readdirSync(SCRIPTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const scriptDir = join(SCRIPTS_ROOT, entry.name);
    try {
      const script = loadScriptFromDir(scriptDir);
      if (!script.manifest.enabled) {
        continue;
      }
      loaded.push(toSummary(script));
    } catch (error) {
      logger.warn(`[scripts] Skipping ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runScript(
  name: string,
  providedArgs: Record<string, unknown> = {},
  timeoutOverride?: number
): Promise<RunScriptResult> {
  const script = loadScriptByName(name);
  if (!script.manifest.enabled) {
    throw new Error(`Script '${name}' is disabled.`);
  }

  const args = resolveScriptArgs(script.manifest, providedArgs);
  const command = renderCommand(script.manifest.command, args);
  if (command.length === 0) {
    throw new Error(`Script '${name}' resolved to an empty command.`);
  }

  const cwd = resolveScriptCwd(script);
  const timeoutMs = typeof timeoutOverride === "number"
    ? Math.min(Math.max(Math.trunc(timeoutOverride), 1), MAX_TIMEOUT)
    : script.manifest.timeoutMs;

  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, VITA_SCRIPT_NAME: script.manifest.name, VITA_SCRIPT_DIR: script.scriptDir },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const trimOutput = (value: string) => value.length > MAX_OUTPUT ? value.slice(0, MAX_OUTPUT) : value;

    const finalize = (result: RunScriptResult) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        ...result,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr),
      });
    };

    child.stdout?.on("data", (chunk) => {
      stdout = trimOutput(stdout + String(chunk));
    });

    child.stderr?.on("data", (chunk) => {
      stderr = trimOutput(stderr + String(chunk));
    });

    child.on("error", (error) => {
      finalize({
        script: toSummary(script),
        command,
        cwd,
        stdout,
        stderr,
        exitCode: null,
        error: error.message,
      });
    });

    child.on("close", (code) => {
      const result: RunScriptResult = {
        script: toSummary(script),
        command,
        cwd,
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        timedOut,
      };
      if (timedOut) {
        result.error = `Script timed out after ${timeoutMs}ms.`;
      }
      finalize(result);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

function loadScriptByName(name: string): LoadedScript {
  const scripts = listScripts();
  const match = scripts.find((script) => script.name === name);
  if (!match) {
    const available = scripts.map((script) => script.name).join(", ");
    throw new Error(`Unknown script '${name}'. Available: ${available || "(none)"}`);
  }

  return loadScriptFromDir(join(SCRIPTS_ROOT, match.folder));
}

function loadScriptFromDir(scriptDir: string): LoadedScript {
  const manifestPath = join(scriptDir, "script.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Missing script.json");
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const manifest = scriptManifestSchema.parse(raw);
  return { manifest, scriptDir };
}

function toSummary(script: LoadedScript): ScriptSummary {
  return {
    name: script.manifest.name,
    description: script.manifest.description,
    folder: normalize(script.scriptDir).split(/[\\/]/).pop() ?? script.manifest.name,
    timeoutMs: script.manifest.timeoutMs,
    args: script.manifest.args,
  };
}

function resolveScriptArgs(
  manifest: ScriptManifest,
  providedArgs: Record<string, unknown>
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const arg of manifest.args) {
    const value = providedArgs[arg.name] ?? arg.default;
    if (value === undefined || value === null || value === "") {
      if (arg.required) {
        throw new Error(`Script '${manifest.name}' requires argument '${arg.name}'.`);
      }
      resolved[arg.name] = "";
      continue;
    }
    resolved[arg.name] = coerceArgValue(value);
  }

  for (const [key, value] of Object.entries(providedArgs)) {
    if (!(key in resolved)) {
      resolved[key] = coerceArgValue(value);
    }
  }

  return resolved;
}

function renderCommand(command: string[], args: Record<string, string>): string[] {
  return command
    .map((segment) => renderTemplate(segment, args).trim())
    .filter(Boolean);
}

function renderTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (_match, name: string) => args[name] ?? "");
}

function coerceArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveScriptCwd(script: LoadedScript): string {
  const configured = script.manifest.cwd
    ? resolve(script.scriptDir, renderTemplate(script.manifest.cwd, {}))
    : script.scriptDir;

  const normalizedTarget = normalize(configured);
  const relativeTarget = relative(script.scriptDir, normalizedTarget);
  if (
    normalizedTarget !== normalize(script.scriptDir)
    && (relativeTarget === "" || relativeTarget.startsWith("..") || relativeTarget.includes(":"))
  ) {
    throw new Error(`Script '${script.manifest.name}' has a cwd outside its own folder.`);
  }

  return configured;
}
