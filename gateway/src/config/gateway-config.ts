import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { logger } from "../logger.js";
import { ensureVitaHome, getGlobalConfigPath, getGatewayTokenPath, getPairingPath, getVitaHome } from "./vita-home.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const authConfigSchema = z.object({
  mode: z.enum(["none", "token", "password"]).default("token"),
  token: z.string().optional(),      // auto-generated if not set
  password: z.string().optional(),   // required for funnel
  allowTailscale: z.boolean().default(true),
});

const tailscaleConfigSchema = z.object({
  mode: z.enum(["off", "serve", "funnel"]).default("off"),
  resetOnExit: z.boolean().default(false),
});

const execConfigSchema = z.object({
  enabled: z.boolean().default(false),
  security: z.enum(["deny", "ask", "allowlist", "full"]).default("deny"),
  allowlist: z.array(z.string()).default([]),
});

const toolsConfigSchema = z.object({
  exec: execConfigSchema.default({}),
  browser: z.object({ enabled: z.boolean().default(false) }).default({}),
  profile: z.enum(["minimal", "messaging", "standard", "full"]).default("standard"),
  deny: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
});

const gatewayBlockSchema = z.object({
  bind: z.enum(["loopback", "lan", "tailnet"]).default("loopback"),
  port: z.coerce.number().default(8765),
  auth: authConfigSchema.default({}),
  tailscale: tailscaleConfigSchema.default({}),
  controlUi: z.object({
    enabled: z.boolean().default(true),
    allowedOrigins: z.array(z.string()).default([]),
  }).default({}),
});

const sessionConfigSchema = z.object({
  dmScope: z.enum(["global", "per-channel-peer"]).default("per-channel-peer"),
  transcriptRetentionDays: z.coerce.number().default(30),
});

export const gatewayConfigSchema = z.object({
  gateway: gatewayBlockSchema.default({}),
  tools: toolsConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;
export type ExecConfig = z.infer<typeof execConfigSchema>;

// ── Paths ─────────────────────────────────────────────────────────────────────

export const VITA_HOME = getVitaHome();
export const CONFIG_PATH = getGlobalConfigPath();
export const TOKEN_PATH = getGatewayTokenPath();
export const PAIRING_PATH = getPairingPath();

// ── Load / Save ───────────────────────────────────────────────────────────────

export function loadGatewayConfig(): GatewayConfig {
  mkdirSync(ensureVitaHome(), { recursive: true });

  let raw: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      logger.info(`Loaded gateway config from ${CONFIG_PATH}`);
    } catch (err) {
      logger.error(`Failed to parse vita.json, using defaults: ${err}`);
    }
  } else {
    logger.info("No vita.json found, using defaults");
  }

  // Merge env overrides into the raw config
  const envOverrides = getEnvOverrides();
  const merged = deepMerge(raw, envOverrides);

  const config = gatewayConfigSchema.parse(merged);

  // Validate Funnel requires password auth
  if (config.gateway.tailscale.mode === "funnel") {
    if (config.gateway.auth.mode !== "password" || !config.gateway.auth.password) {
      logger.error("Tailscale Funnel requires auth.mode='password' with a password set. Falling back to tailscale.mode='off'.");
      config.gateway.tailscale.mode = "off";
    }
  }

  // Validate LAN bind requires auth
  if (config.gateway.bind === "lan" && config.gateway.auth.mode === "none") {
    logger.warn("⚠ WARNING: Gateway bound to LAN (0.0.0.0) with NO auth! This is insecure. Set gateway.auth.mode to 'token' or 'password'.");
  }

  return config;
}

export function saveGatewayConfig(config: GatewayConfig): void {
  mkdirSync(ensureVitaHome(), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  logger.info(`Saved gateway config to ${CONFIG_PATH}`);
}

// Create default config file if none exists
export function ensureConfigFile(): void {
  if (!existsSync(CONFIG_PATH)) {
    const defaults = gatewayConfigSchema.parse({});
    saveGatewayConfig(defaults);
    logger.info(`Created default vita.json at ${CONFIG_PATH}`);
  }
}

// ── Env Overrides ─────────────────────────────────────────────────────────────

function getEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  if (process.env.GATEWAY_PORT) {
    overrides.gateway = { ...(overrides.gateway as Record<string, unknown> || {}), port: Number(process.env.GATEWAY_PORT) };
  }
  if (process.env.GATEWAY_HOST) {
    const host = process.env.GATEWAY_HOST.trim();
    let bind: "loopback" | "lan" = "loopback";
    if (host === "0.0.0.0") bind = "lan";
    else if (host === "127.0.0.1" || host === "localhost") bind = "loopback";
    
    overrides.gateway = { ...(overrides.gateway as Record<string, unknown> || {}), bind };
  }
  if (process.env.VITA_GATEWAY_TOKEN) {
    overrides.gateway = {
      ...(overrides.gateway as Record<string, unknown> || {}),
      auth: { mode: "token", token: process.env.VITA_GATEWAY_TOKEN },
    };
  }
  if (process.env.VITA_GATEWAY_PASSWORD) {
    overrides.gateway = {
      ...(overrides.gateway as Record<string, unknown> || {}),
      auth: { mode: "password", password: process.env.VITA_GATEWAY_PASSWORD },
    };
  }

  return overrides;
}

// ── Resolve bind address ──────────────────────────────────────────────────────

export function resolveBindAddress(bind: GatewayConfig["gateway"]["bind"]): string {
  switch (bind) {
    case "loopback":
      return "127.0.0.1";
    case "lan":
      return "0.0.0.0";
    case "tailnet":
      // TODO: detect Tailscale IP from `tailscale ip -4`
      logger.warn("Tailnet bind not yet implemented, falling back to loopback");
      return "127.0.0.1";
    default:
      return "127.0.0.1";
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal && typeof sourceVal === "object" && !Array.isArray(sourceVal) &&
      targetVal && typeof targetVal === "object" && !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
