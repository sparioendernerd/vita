// ── Message Types ─────────────────────────────────────────────────────────────

export type MessageType =
  // Auth
  | "auth:handshake"       // Node -> Gateway: present credentials
  | "auth:result"          // Gateway -> Node: accept/reject + pairing info

  // Node lifecycle
  | "node:register"        // Node -> Gateway: register with capabilities
  | "node:heartbeat"       // Node -> Gateway: I'm alive
  | "node:status"          // Node -> Gateway: state change
  | "node:list"            // Query connected nodes
  | "node:describe"        // Node capabilities + permissions
  | "node:command:result"  // Node -> Gateway: result for a gateway-issued command

  // Session
  | "session:start"        // Node -> Gateway: request session config
  | "session:end"          // Node -> Gateway: session ended
  | "session:config"       // Gateway -> Node: config + memories
  | "session:transcript"   // Transcript entry (richer than old transcript:entry)

  // Tools
  | "tool:request"         // Node -> Gateway: invoke a tool
  | "tool:response"        // Gateway -> Node: tool result

  // Gateway control
  | "gateway:ping"         // Gateway -> Node: heartbeat check
  | "gateway:command"      // Gateway -> Node: command (e.g. reload config)
  | "vita:updated"         // Gateway -> Node: VITA config changed

  // System execution (VITA controlling the gateway PC)
  | "system:run"           // Execute command on gateway host
  | "system:run:result"    // Command result (stdout/stderr/exit)
  | "system:notify"        // Send desktop notification

  // Knowledge
  | "knowledge:query"      // Search the knowledge base
  | "knowledge:result"     // Search results
  | "knowledge:ingest"     // Add content to knowledge base

  // Config
  | "config:get"           // Read gateway config
  | "config:patch"         // Update gateway config

  // Legacy (backward compat)
  | "transcript:entry";

// ── Core Protocol Message ─────────────────────────────────────────────────────

export interface ProtocolMessage<T = unknown> {
  type: MessageType;
  timestamp: string;
  payload: T;
}

// ── Auth Payloads ─────────────────────────────────────────────────────────────

export interface AuthHandshakePayload {
  token?: string;
  password?: string;
  nodeId: string;
  vitaName: string;
  capabilities: ("audio" | "vision" | "mobile" | "tools")[];
}

export interface AuthResultPayload {
  success: boolean;
  nodeId?: string;
  error?: string;
  pairingCode?: string;  // set when node needs to be paired
  pairingRequired?: boolean;
}

// ── Node Payloads ─────────────────────────────────────────────────────────────

export interface NodeRegisterPayload {
  nodeId: string;
  vitaName: string;
  capabilities: ("audio" | "vision" | "mobile" | "tools")[];
}

export interface NodeStatusPayload {
  nodeId: string;
  state: "idle" | "listening" | "conversing" | "error";
}

export interface NodeCommandResultPayload {
  callId: string;
  result?: unknown;
  error?: string;
}

export interface NodeListPayload {
  nodes: Array<{
    id: string;
    vitaName: string;
    capabilities: string[];
    state: string;
    lastHeartbeat: number;
  }>;
}

// ── Session Payloads ──────────────────────────────────────────────────────────

export interface SessionStartPayload {
  vitaName: string;
}

export interface SessionConfigPayload {
  vitaConfig: Record<string, unknown> | null;
  memories: string[];
  sharedUserProfile?: string;
  knownVitas?: Array<{ name: string; displayName: string }>;
  error?: string;
}

export interface SessionEndPayload {
  vitaName: string;
  reason: string;
}

export interface SessionTranscriptPayload {
  vitaName: string;
  sessionId: string;
  role: "user" | "model" | "system" | "tool";
  text: string;
  metadata?: Record<string, unknown>;
}

// ── Tool Payloads ─────────────────────────────────────────────────────────────

export interface ToolRequestPayload {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResponsePayload {
  callId: string;
  result?: unknown;
  error?: string;
}

// ── System Execution Payloads ─────────────────────────────────────────────────

export interface SystemRunPayload {
  callId: string;
  command: string;
  cwd?: string;
  timeout?: number;     // ms, default 30000
  elevated?: boolean;   // requires explicit opt-in
}

export interface SystemRunResultPayload {
  callId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
}

export interface SystemNotifyPayload {
  callId: string;
  title: string;
  body: string;
  urgency?: "low" | "normal" | "critical";
}

// ── Knowledge Payloads ────────────────────────────────────────────────────────

export interface KnowledgeQueryPayload {
  callId: string;
  query: string;
  categories?: string[];
  limit?: number;
}

export interface KnowledgeResultPayload {
  callId: string;
  results: Array<{
    content: string;
    category: string;
    importance: number;
    timestamp: number;
  }>;
}

export interface KnowledgeIngestPayload {
  callId: string;
  content: string;
  category: string;
  tags?: string[];
  source?: string;
}

// ── Legacy Payloads (backward compat) ─────────────────────────────────────────

export interface TranscriptEntryPayload {
  vitaName: string;
  role: "user" | "model";
  text: string;
}

export interface GatewayCommandPayload {
  command: string;
  args?: Record<string, unknown>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMessage<T>(type: MessageType, payload: T): ProtocolMessage<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}
