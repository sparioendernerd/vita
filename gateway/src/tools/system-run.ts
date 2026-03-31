import { exec } from "node:child_process";
import { logger } from "../logger.js";
import type { ExecConfig } from "../config/gateway-config.js";
import type {
  SystemRunPayload,
  SystemRunResultPayload,
} from "../websocket/protocol.js";

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT = 50000; // 50KB max per stream

/**
 * Execute a command on the gateway host.
 *
 * Security is gated by the tools.exec config:
 *   - deny:     reject all commands
 *   - ask:      log + execute (future: operator approval via Control UI)
 *   - allowlist: only run commands whose binary is in the allowlist
 *   - full:     run anything (dangerous)
 */
export async function executeSystemRun(
  payload: SystemRunPayload,
  execConfig: ExecConfig
): Promise<SystemRunResultPayload> {
  const { callId, command, cwd, timeout = DEFAULT_TIMEOUT } = payload;

  // ── Security gate ─────────────────────────────────────────────────────

  if (!execConfig.enabled) {
    logger.warn(`[system.run] BLOCKED (exec disabled): ${command}`);
    return {
      callId,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: "Command execution is disabled. Set tools.exec.enabled=true in vita.json.",
    };
  }

  if (execConfig.security === "deny") {
    logger.warn(`[system.run] DENIED by policy: ${command}`);
    return {
      callId,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: "Command execution denied by security policy (tools.exec.security='deny').",
    };
  }

  if (execConfig.security === "allowlist") {
    const binary = command.split(/\s+/)[0];
    if (!execConfig.allowlist.includes(binary)) {
      logger.warn(`[system.run] DENIED (not in allowlist): ${binary}`);
      return {
        callId,
        stdout: "",
        stderr: "",
        exitCode: null,
        error: `Command '${binary}' is not in the exec allowlist. Allowed: ${execConfig.allowlist.join(", ") || "(empty)"}`,
      };
    }
  }

  // Block obviously dangerous patterns even in "full" mode
  const dangerousPatterns = [
    /rm\s+(-rf?|--recursive)\s+\//,   // rm -rf /
    /mkfs/,                            // format disk
    /dd\s+.*of=\/dev\//,              // raw disk write
    /:(){ :\|:& };:/,                  // fork bomb
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      logger.error(`[system.run] BLOCKED dangerous command: ${command}`);
      return {
        callId,
        stdout: "",
        stderr: "",
        exitCode: null,
        error: "Command blocked: matches a dangerous pattern.",
      };
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────

  logger.info(`[system.run] Executing: ${command}${cwd ? ` (cwd: ${cwd})` : ""}`);

  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: cwd || undefined,
      timeout,
      maxBuffer: MAX_OUTPUT,
      shell: "/bin/bash", // Linux gateway
      env: { ...process.env, TERM: "dumb" },
    }, (error, stdout, stderr) => {
      const result: SystemRunResultPayload = {
        callId,
        stdout: stdout.substring(0, MAX_OUTPUT),
        stderr: stderr.substring(0, MAX_OUTPUT),
        exitCode: error?.code ?? (error ? 1 : 0),
        timedOut: error?.killed ?? false,
      };

      if (error?.killed) {
        result.error = `Command timed out after ${timeout}ms`;
        logger.warn(`[system.run] Timed out: ${command}`);
      } else if (error) {
        result.error = error.message;
        logger.warn(`[system.run] Error: ${error.message}`);
      } else {
        logger.info(`[system.run] Completed (exit ${result.exitCode}): ${command}`);
      }

      resolve(result);
    });
  });
}
