import { exec, execSync } from "node:child_process";
import { logger } from "../logger.js";
import type { TailscaleConfig } from "../config/gateway-config.js";

interface TailscaleState {
  running: boolean;
  mode: "serve" | "funnel" | "off";
  port?: number;
}

let activeState: TailscaleState = { running: false, mode: "off" };

/**
 * Check if the Tailscale CLI is available and logged in.
 */
export function isTailscaleAvailable(): boolean {
  try {
    const result = execSync("tailscale status --json 2>/dev/null", {
      timeout: 5000,
      encoding: "utf-8",
    });
    const status = JSON.parse(result);
    return status.BackendState === "Running";
  } catch {
    return false;
  }
}

/**
 * Get the Tailscale IPv4 address for this machine.
 */
export function getTailscaleIP(): string | null {
  try {
    return execSync("tailscale ip -4", { timeout: 5000, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Get the MagicDNS hostname for this machine.
 */
export function getTailscaleHostname(): string | null {
  try {
    const result = execSync("tailscale status --json", { timeout: 5000, encoding: "utf-8" });
    const status = JSON.parse(result);
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Configure Tailscale Serve or Funnel based on config.
 */
export async function setupTailscale(
  tsConfig: TailscaleConfig,
  gatewayPort: number
): Promise<void> {
  if (tsConfig.mode === "off") {
    logger.info("[tailscale] Mode is 'off', skipping setup");
    return;
  }

  if (!isTailscaleAvailable()) {
    logger.error("[tailscale] Tailscale CLI not found or not logged in. Install with: curl -fsSL https://tailscale.com/install.sh | sh");
    logger.error("[tailscale] Falling back to mode 'off'");
    return;
  }

  const hostname = getTailscaleHostname();
  const ip = getTailscaleIP();
  logger.info(`[tailscale] Detected: ${hostname} (${ip})`);

  try {
    if (tsConfig.mode === "serve") {
      // tailscale serve --bg https+insecure://127.0.0.1:<port>
      const cmd = `tailscale serve --bg https+insecure://127.0.0.1:${gatewayPort}`;
      logger.info(`[tailscale] Running: ${cmd}`);
      execSync(cmd, { timeout: 15000, encoding: "utf-8" });
      activeState = { running: true, mode: "serve", port: gatewayPort };
      logger.info(`[tailscale] Serve active → https://${hostname}/`);

    } else if (tsConfig.mode === "funnel") {
      // tailscale funnel --bg https+insecure://127.0.0.1:<port>
      const cmd = `tailscale funnel --bg https+insecure://127.0.0.1:${gatewayPort}`;
      logger.info(`[tailscale] Running: ${cmd}`);
      execSync(cmd, { timeout: 15000, encoding: "utf-8" });
      activeState = { running: true, mode: "funnel", port: gatewayPort };
      logger.info(`[tailscale] Funnel active (public) → https://${hostname}/`);
    }
  } catch (err: any) {
    logger.error(`[tailscale] Setup failed: ${err.message}`);
    logger.error("[tailscale] Ensure Tailscale is installed, logged in, and has HTTPS/Funnel enabled on your tailnet");
  }
}

/**
 * Tear down Tailscale Serve/Funnel config on gateway shutdown.
 */
export function teardownTailscale(tsConfig: TailscaleConfig): void {
  if (!tsConfig.resetOnExit || !activeState.running) return;

  try {
    if (activeState.mode === "serve") {
      execSync("tailscale serve --https=443 off", { timeout: 5000 });
      logger.info("[tailscale] Serve configuration reset");
    } else if (activeState.mode === "funnel") {
      execSync("tailscale funnel --https=443 off", { timeout: 5000 });
      logger.info("[tailscale] Funnel configuration reset");
    }
    activeState = { running: false, mode: "off" };
  } catch (err: any) {
    logger.warn(`[tailscale] Teardown failed: ${err.message}`);
  }
}
