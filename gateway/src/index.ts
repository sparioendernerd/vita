import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadGatewayConfig,
  ensureConfigFile,
  resolveBindAddress,
  type GatewayConfig,
} from "./config/gateway-config.js";
import { VitaRegistry } from "./config/vita-registry.js";
import { GatewayServer } from "./websocket/server.js";
import { loadOrCreateToken } from "./auth/token-manager.js";
import { setupTailscale, teardownTailscale } from "./network/tailscale.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../.env") });

async function main() {
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info("  🧠  VITA Gateway  —  Knowledge Hub & Control Plane  ");
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Ensure ~/.vita/vita.json exists with defaults
  ensureConfigFile();

  // Load gateway config (vita.json + env overrides)
  let config: GatewayConfig;
  try {
    config = loadGatewayConfig();
  } catch (err) {
    logger.error(`Config validation failed: ${err}`);
    process.exit(1);
  }

  // Resolve GEMINI_API_KEY from env (still required as env)
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    logger.error("GEMINI_API_KEY is required in environment");
    process.exit(1);
  }

  // ── Auth Setup ──────────────────────────────────────────────────────────
  let gatewayToken: string | undefined;
  if (config.gateway.auth.mode === "token") {
    // Use explicit token from config, or auto-generate one
    gatewayToken = config.gateway.auth.token || loadOrCreateToken();
    logger.info(`Auth mode: token (first 8: ${gatewayToken.substring(0, 8)}...)`);
  } else if (config.gateway.auth.mode === "password") {
    if (!config.gateway.auth.password) {
      logger.error("Auth mode is 'password' but no password is set. Set VITA_GATEWAY_PASSWORD or gateway.auth.password in vita.json.");
      process.exit(1);
    }
    logger.info("Auth mode: password");
  } else {
    logger.warn("⚠ Auth mode: NONE — gateway is open to all connections. Set auth.mode in vita.json for production.");
  }

  // ── Resolve bind address ────────────────────────────────────────────────
  const host = resolveBindAddress(config.gateway.bind);
  const port = config.gateway.port;

  if (host === "0.0.0.0" && config.gateway.auth.mode === "none") {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("  ⚠  INSECURE: Bound to 0.0.0.0 with NO auth!       ");
    logger.warn("  Set gateway.auth.mode in ~/.vita/vita.json          ");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  // ── Load VITA configs ───────────────────────────────────────────────────
  const vitasDir = resolve(__dirname, "../data/vitas");
  const vitaRegistry = new VitaRegistry(vitasDir);
  vitaRegistry.load();
  vitaRegistry.watchForChanges();

  // ── Start Gateway Server ────────────────────────────────────────────────
  const server = new GatewayServer(port, host, vitaRegistry, geminiApiKey, config, gatewayToken);

  // Heartbeat ping every 30 seconds
  setInterval(() => {
    server.pingAllNodes();
  }, 30000);

  // ── Tailscale Setup ─────────────────────────────────────────────────────
  if (config.gateway.tailscale.mode !== "off") {
    await setupTailscale(config.gateway.tailscale, port);
  }

  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(`  Gateway ready on ${host}:${port}`);
  logger.info(`  Config: ~/.vita/vita.json`);
  logger.info(`  Bind:   ${config.gateway.bind} (${host})`);
  logger.info(`  Auth:   ${config.gateway.auth.mode}`);
  logger.info(`  Tailscale: ${config.gateway.tailscale.mode}`);
  logger.info(`  Exec:   ${config.tools.exec.enabled ? config.tools.exec.security : "disabled"}`);
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    teardownTailscale(config.gateway.tailscale);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
