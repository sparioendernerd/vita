import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import { validateToken } from "./token-manager.js";

export interface AuthContext {
  authenticated: boolean;
  method: "token" | "password" | "tailscale" | "none";
  identity?: string;  // Tailscale login or "operator"
}

/**
 * Authenticate an incoming WebSocket upgrade request.
 *
 * Checks are done in this order:
 *   1. auth.mode = "none"   → always pass
 *   2. Bearer token in Authorization header or `?token=` query param
 *   3. Password in `?password=` query param or X-Gateway-Password header
 *   4. Tailscale identity headers (if allowTailscale is true)
 */
export function authenticateUpgrade(
  req: IncomingMessage,
  config: GatewayConfig,
  expectedToken?: string
): AuthContext {
  const authConfig = config.gateway.auth;

  // Mode: none — skip all checks (dev only)
  if (authConfig.mode === "none") {
    return { authenticated: true, method: "none", identity: "operator" };
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // Token auth
  if (authConfig.mode === "token" && expectedToken) {
    // Check Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const presented = authHeader.slice(7).trim();
      if (validateToken(presented, expectedToken)) {
        return { authenticated: true, method: "token", identity: "operator" };
      }
    }

    // Check ?token= query param
    const queryToken = url.searchParams.get("token");
    if (queryToken && validateToken(queryToken, expectedToken)) {
      return { authenticated: true, method: "token", identity: "operator" };
    }
  }

  // Password auth
  if (authConfig.mode === "password" && authConfig.password) {
    const queryPassword = url.searchParams.get("password");
    const headerPassword = req.headers["x-gateway-password"] as string | undefined;
    const presented = queryPassword || headerPassword;
    if (presented && presented === authConfig.password) {
      return { authenticated: true, method: "password", identity: "operator" };
    }
  }

  // Tailscale identity headers (set by Tailscale Serve reverse proxy)
  if (authConfig.allowTailscale) {
    const tailscaleUser = req.headers["tailscale-user-login"] as string | undefined;
    if (tailscaleUser) {
      logger.info(`Tailscale identity: ${tailscaleUser}`);
      return { authenticated: true, method: "tailscale", identity: tailscaleUser };
    }
  }

  return { authenticated: false, method: "none" };
}

/**
 * Authenticate an in-band auth:handshake message (for nodes that can't set HTTP headers).
 */
export function authenticateHandshake(
  payload: { token?: string; password?: string },
  config: GatewayConfig,
  expectedToken?: string
): AuthContext {
  const authConfig = config.gateway.auth;

  if (authConfig.mode === "none") {
    return { authenticated: true, method: "none", identity: "operator" };
  }

  if (authConfig.mode === "token" && expectedToken && payload.token) {
    if (validateToken(payload.token, expectedToken)) {
      return { authenticated: true, method: "token", identity: "operator" };
    }
  }

  if (authConfig.mode === "password" && authConfig.password && payload.password) {
    if (payload.password === authConfig.password) {
      return { authenticated: true, method: "password", identity: "operator" };
    }
  }

  return { authenticated: false, method: "none" };
}
