import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import { v4 as uuid } from "uuid";
import { logger } from "../logger.js";
import {
  type ProtocolMessage,
  type NodeRegisterPayload,
  type AuthHandshakePayload,
  createMessage,
} from "./protocol.js";
import { type MessageHandlers, createHandlers } from "./handlers.js";
import type { VitaRegistry } from "../config/vita-registry.js";
import type { GatewayConfig } from "../config/gateway-config.js";
import { authenticateUpgrade, authenticateHandshake, type AuthContext } from "../auth/middleware.js";
import { isNodePaired, createPairingCode, touchPairedNode } from "../auth/token-manager.js";
import type { DiscordBridge } from "../discord/bridge.js";

export interface NodeConnection {
  id: string;
  ws: WebSocket;
  vitaName: string;
  capabilities: ("audio" | "vision" | "mobile")[];
  lastHeartbeat: number;
  state: "idle" | "listening" | "conversing" | "error";
  authenticated: boolean;
  authContext?: AuthContext;
}

export class GatewayServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private nodes = new Map<string, NodeConnection>();
  private handlers: MessageHandlers;
  private config: GatewayConfig;
  private gatewayToken?: string;

  constructor(
    port: number,
    host: string,
    vitaRegistry: VitaRegistry,
    geminiApiKey: string,
    config: GatewayConfig,
    gatewayToken?: string,
    discordBridge?: DiscordBridge
  ) {
    this.config = config;
    this.gatewayToken = gatewayToken;
    this.handlers = createHandlers(vitaRegistry, this, geminiApiKey, config, discordBridge);

    // Create HTTP server for future Control UI + WS upgrade
    this.httpServer = createServer((req, res) => {
      // Health check endpoint
      if (req.url === "/health" || req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          nodes: this.nodes.size,
          uptime: process.uptime(),
          auth: config.gateway.auth.mode,
        }));
        return;
      }

      // Node list endpoint (requires auth)
      if (req.url === "/api/nodes") {
        const auth = authenticateUpgrade(req, this.config, this.gatewayToken);
        if (!auth.authenticated && config.gateway.auth.mode !== "none") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          nodes: this.getConnectedNodes().map((n) => ({
            id: n.id,
            vitaName: n.vitaName,
            capabilities: n.capabilities,
            state: n.state,
            lastHeartbeat: n.lastHeartbeat,
          })),
        }));
        return;
      }

      // Placeholder for future Control UI
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html><head><title>VITA Gateway</title></head>
        <body style="font-family:system-ui;background:#0a0a0a;color:#e0e0e0;padding:2rem">
          <h1>🧠 VITA Gateway</h1>
          <p>Control UI coming soon. Gateway is running.</p>
          <p>Connected nodes: ${this.nodes.size}</p>
          <p>Auth mode: ${config.gateway.auth.mode}</p>
        </body></html>
      `);
    });

    // WebSocket server shares the HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      this.handleNewConnection(ws, req);
    });

    this.httpServer.listen(port, host, () => {
      logger.info(`Gateway listening on ${host}:${port}`);
      logger.info(`Auth mode: ${config.gateway.auth.mode}`);
      if (config.gateway.auth.mode === "token") {
        logger.info(`Nodes connect with: ws://${host}:${port}?token=<TOKEN>`);
      }
    });
  }

  // ── Connection handling ───────────────────────────────────────────────────

  private handleNewConnection(ws: WebSocket, req: IncomingMessage): void {
    const tempId = uuid();
    const authMode = this.config.gateway.auth.mode;

    // Try HTTP-level auth first (token in query param or header)
    let authCtx = authenticateUpgrade(req, this.config, this.gatewayToken);

    if (authMode !== "none" && !authCtx.authenticated) {
      // Not authenticated via HTTP — give them a chance to auth via handshake message
      logger.info(`Connection ${tempId.substring(0, 8)}... awaiting auth handshake`);
    } else if (authCtx.authenticated) {
      logger.info(`Connection ${tempId.substring(0, 8)}... authenticated via ${authCtx.method}`);
    }

    // Registration timeout: must register within 15s
    const timeout = setTimeout(() => {
      logger.warn(`Connection ${tempId.substring(0, 8)}... did not register in time, closing`);
      ws.close(4001, "Registration timeout");
    }, 15000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ProtocolMessage;
        this.handleMessage(tempId, ws, msg, timeout, authCtx);
      } catch (err) {
        logger.error(`Invalid message from ${tempId.substring(0, 8)}...: ${err}`);
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      const node = this.findNodeByWs(ws);
      if (node) {
        logger.info(`Node disconnected: ${node.id} (${node.vitaName})`);
        this.nodes.delete(node.id);
      }
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
    });
  }

  private handleMessage(
    tempId: string,
    ws: WebSocket,
    msg: ProtocolMessage,
    registrationTimeout: NodeJS.Timeout,
    authCtx: AuthContext
  ): void {

    // ── Auth handshake (in-band authentication) ─────────────────────────
    if (msg.type === "auth:handshake") {
      const payload = msg.payload as AuthHandshakePayload;
      authCtx = authenticateHandshake(
        { token: payload.token, password: payload.password },
        this.config,
        this.gatewayToken
      );

      if (!authCtx.authenticated && this.config.gateway.auth.mode !== "none") {
        ws.send(JSON.stringify(createMessage("auth:result", {
          success: false,
          error: "Authentication failed",
        })));
        ws.close(4003, "Authentication failed");
        clearTimeout(registrationTimeout);
        return;
      }

      // Auth succeeded — also register the node in one step
      clearTimeout(registrationTimeout);
      const nodeId = payload.nodeId || tempId;

      // Check if node is paired (when auth mode is not "none")
      if (this.config.gateway.auth.mode !== "none" && !isNodePaired(nodeId)) {
        const code = createPairingCode(nodeId, payload.capabilities);
        ws.send(JSON.stringify(createMessage("auth:result", {
          success: true,
          pairingRequired: true,
          pairingCode: code,
          nodeId,
        })));
        logger.info(`Node ${nodeId.substring(0, 8)}... needs pairing. Code: ${code}`);
        // Don't close — let them stay connected but don't register
        // They'll need operator approval before they can do anything else
        return;
      }

      // Fully authenticated and paired
      touchPairedNode(nodeId);
      const node: NodeConnection = {
        id: nodeId,
        ws,
        vitaName: payload.vitaName,
        capabilities: payload.capabilities,
        lastHeartbeat: Date.now(),
        state: "idle",
        authenticated: true,
        authContext: authCtx,
      };
      this.nodes.set(nodeId, node);

      ws.send(JSON.stringify(createMessage("auth:result", {
        success: true,
        nodeId,
      })));
      logger.info(`Node registered + authenticated: ${nodeId.substring(0, 8)}... (vita=${payload.vitaName})`);
      return;
    }

    // ── Legacy node:register (backward compat with existing Python node) ───
    if (msg.type === "node:register") {
      clearTimeout(registrationTimeout);
      const payload = msg.payload as NodeRegisterPayload;
      const nodeId = payload.nodeId || tempId;

      // In "none" auth mode, allow legacy register without auth
      if (this.config.gateway.auth.mode === "none" || authCtx.authenticated) {
        const node: NodeConnection = {
          id: nodeId,
          ws,
          vitaName: payload.vitaName,
          capabilities: payload.capabilities,
          lastHeartbeat: Date.now(),
          state: "idle",
          authenticated: this.config.gateway.auth.mode === "none" || authCtx.authenticated,
          authContext: authCtx,
        };
        this.nodes.set(nodeId, node);
        logger.info(`Node registered (legacy): ${nodeId.substring(0, 8)}... (vita=${payload.vitaName})`);
      } else {
        logger.warn(`Unauthenticated node:register from ${tempId.substring(0, 8)}... rejected`);
        ws.send(JSON.stringify(createMessage("auth:result", {
          success: false,
          error: "Authentication required. Send auth:handshake first.",
        })));
        ws.close(4003, "Authentication required");
      }
      return;
    }

    // ── All other messages require the node to be registered ──────────────
    const node = this.findNodeByWs(ws);
    if (!node) {
      logger.warn(`Message from unregistered connection, ignoring: ${msg.type}`);
      return;
    }

    if (msg.type === "node:heartbeat") {
      node.lastHeartbeat = Date.now();
      return;
    }

    // Route to handler
    const handler = this.handlers[msg.type];
    if (handler) {
      handler(node, msg);
    } else {
      logger.warn(`No handler for message type: ${msg.type}`);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private findNodeByWs(ws: WebSocket): NodeConnection | undefined {
    for (const node of this.nodes.values()) {
      if (node.ws === ws) return node;
    }
    return undefined;
  }

  sendToNode(nodeId: string, msg: ProtocolMessage): void {
    const node = this.nodes.get(nodeId);
    if (node && node.ws.readyState === WebSocket.OPEN) {
      node.ws.send(JSON.stringify(msg));
    }
  }

  broadcastToVita(vitaName: string, msg: ProtocolMessage): void {
    for (const node of this.nodes.values()) {
      if (node.vitaName === vitaName && node.ws.readyState === WebSocket.OPEN) {
        node.ws.send(JSON.stringify(msg));
      }
    }
  }

  pingAllNodes(): void {
    const ping = createMessage("gateway:ping", { timestamp: Date.now() });
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      if (now - node.lastHeartbeat > 90000) {
        logger.warn(`Node ${id.substring(0, 8)}... missed 3 heartbeats, removing`);
        node.ws.close(4002, "Heartbeat timeout");
        this.nodes.delete(id);
        continue;
      }
      if (node.ws.readyState === WebSocket.OPEN) {
        node.ws.send(JSON.stringify(ping));
      }
    }
  }

  getConnectedNodes(): NodeConnection[] {
    return Array.from(this.nodes.values());
  }

  close(): void {
    logger.info("Closing Gateway...");
    this.wss.close();
    this.httpServer.close();
  }
}
