import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";
import { TOKEN_PATH, PAIRING_PATH, VITA_HOME } from "../config/gateway-config.js";

// ── Token Management ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure 256-bit token.
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Load the gateway token from disk, or generate and persist a new one.
 */
export function loadOrCreateToken(): string {
  mkdirSync(VITA_HOME, { recursive: true });

  if (existsSync(TOKEN_PATH)) {
    const token = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (token.length >= 32) {
      return token;
    }
    logger.warn("Gateway token too short, regenerating...");
  }

  const token = generateToken();
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  logger.info(`Generated new gateway token → ${TOKEN_PATH}`);
  logger.info(`Token (first 8 chars): ${token.substring(0, 8)}...`);
  return token;
}

// ── Token Validation ──────────────────────────────────────────────────────────

/**
 * Constant-time comparison to prevent timing attacks.
 */
export function validateToken(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < presented.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Pairing ───────────────────────────────────────────────────────────────────

export interface PairedNode {
  nodeId: string;
  name: string;          // human-readable label (e.g. "ray-bans", "desktop-mic")
  pairedAt: string;      // ISO timestamp
  lastSeen?: string;
  capabilities: string[];
}

interface PairingStore {
  nodes: PairedNode[];
  pendingCodes: Record<string, PendingPairing>;
}

interface PendingPairing {
  code: string;
  nodeId: string;
  requestedAt: string;
  capabilities: string[];
}

function loadPairingStore(): PairingStore {
  if (existsSync(PAIRING_PATH)) {
    try {
      return JSON.parse(readFileSync(PAIRING_PATH, "utf-8"));
    } catch {
      logger.warn("Corrupted paired-nodes.json, resetting");
    }
  }
  return { nodes: [], pendingCodes: {} };
}

function savePairingStore(store: PairingStore): void {
  mkdirSync(dirname(PAIRING_PATH), { recursive: true });
  writeFileSync(PAIRING_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Check if a node ID is already paired.
 */
export function isNodePaired(nodeId: string): boolean {
  const store = loadPairingStore();
  return store.nodes.some((n) => n.nodeId === nodeId);
}

/**
 * Generate a short pairing code for a new node.
 * Returns the 6-char alphanumeric code.
 */
export function createPairingCode(nodeId: string, capabilities: string[]): string {
  const store = loadPairingStore();

  // If there's already a pending code for this node, return it
  const existing = store.pendingCodes[nodeId];
  if (existing) return existing.code;

  const code = randomBytes(3).toString("hex").toUpperCase(); // 6 chars like "A3F1B2"
  store.pendingCodes[nodeId] = {
    code,
    nodeId,
    requestedAt: new Date().toISOString(),
    capabilities,
  };
  savePairingStore(store);

  logger.info(`Pairing code generated for node ${nodeId}: ${code}`);
  return code;
}

/**
 * Approve a pairing code, adding the node to the paired list.
 */
export function approvePairing(code: string, name?: string): PairedNode | null {
  const store = loadPairingStore();

  const entry = Object.values(store.pendingCodes).find((p) => p.code === code);
  if (!entry) return null;

  const paired: PairedNode = {
    nodeId: entry.nodeId,
    name: name || `node-${entry.nodeId.substring(0, 8)}`,
    pairedAt: new Date().toISOString(),
    capabilities: entry.capabilities,
  };

  store.nodes.push(paired);
  delete store.pendingCodes[entry.nodeId];
  savePairingStore(store);

  logger.info(`Node paired: ${paired.name} (${paired.nodeId})`);
  return paired;
}

/**
 * Update last-seen timestamp for a paired node.
 */
export function touchPairedNode(nodeId: string): void {
  const store = loadPairingStore();
  const node = store.nodes.find((n) => n.nodeId === nodeId);
  if (node) {
    node.lastSeen = new Date().toISOString();
    savePairingStore(store);
  }
}

/**
 * List all paired nodes.
 */
export function listPairedNodes(): PairedNode[] {
  return loadPairingStore().nodes;
}

/**
 * List pending pairing requests.
 */
export function listPendingPairings(): PendingPairing[] {
  return Object.values(loadPairingStore().pendingCodes);
}

/**
 * Remove a paired node.
 */
export function unpairNode(nodeId: string): boolean {
  const store = loadPairingStore();
  const before = store.nodes.length;
  store.nodes = store.nodes.filter((n) => n.nodeId !== nodeId);
  if (store.nodes.length < before) {
    savePairingStore(store);
    logger.info(`Unpaired node: ${nodeId}`);
    return true;
  }
  return false;
}
