#!/usr/bin/env node
/**
 * vita-cli - Gateway management CLI
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../.env") });

import {
  loadOrCreateToken,
  generateToken,
  listPairedNodes,
  listPendingPairings,
  approvePairing,
  unpairNode,
} from "./auth/token-manager.js";
import {
  loadGatewayConfig,
  CONFIG_PATH,
  TOKEN_PATH,
  PAIRING_PATH,
} from "./config/gateway-config.js";
import { isTailscaleAvailable, getTailscaleIP, getTailscaleHostname } from "./network/tailscale.js";
import {
  createLocalVita,
  formatVitaList,
  getDiscordPromptSummary,
  getWakeWordInstructions,
  hasLocalVitas,
  importExistingGraves,
  listGeminiVoices,
  listVitaSummaries,
  readSharedUserProfile,
} from "./config/spawn-storage.js";

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function printHelp() {
  console.log(`
VITA Gateway CLI

Commands:
  pairing list                    List pending pairing requests
  pairing approve <code> [name]   Approve a node pairing
  pairing nodes                   List all paired nodes
  pairing unpair <nodeId>         Remove a paired node
  token                           Show current gateway token
  token reset                     Generate a new gateway token
  doctor                          Security audit of your gateway
  config                          Show current gateway configuration
  status                          Show gateway status
  spawn init                      Create the first local VITA
  spawn create                    Create an additional local VITA
  spawn list                      List local VITAs
  spawn import-graves             Import legacy Graves into local storage
`);
}

async function promptForSpawn(options: { requireSharedProfile: boolean }) {
  const rl = createInterface({ input, output });
  try {
    const name = (await rl.question("VITA name: ")).trim();
    const personality = (await rl.question("Personality: ")).trim();
    const voices = listGeminiVoices();
    console.log(`Gemini voices: ${voices.join(", ")}`);
    const voiceName = (await rl.question("Voice name: ")).trim();
    const voicePrompt = (await rl.question("Voice instructions: ")).trim();
    const wakeWord = (await rl.question("Wake phrase: ")).trim();
    if (!name || !personality) {
      throw new Error("Name and personality are required.");
    }
    if (!voiceName || !voices.includes(voiceName as (typeof voices)[number])) {
      throw new Error(`Voice name must be one of: ${voices.join(", ")}`);
    }
    if (!voicePrompt || !wakeWord) {
      throw new Error("Voice instructions and wake phrase are required.");
    }

    const configureDiscord = (await rl.question("Configure Discord bot now? (y/N): ")).trim().toLowerCase();
    const discord = configureDiscord === "y" || configureDiscord === "yes"
      ? {
          applicationId: (await rl.question("Discord application ID (optional): ")).trim() || undefined,
          defaultDmUserId: (await rl.question("Default DM user ID (optional): ")).trim() || undefined,
          channels: ((await rl.question("Discord channel IDs (comma-separated, optional): ")).trim()
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)),
          botToken: (await rl.question("Discord bot token (optional): ")).trim() || undefined,
        }
      : undefined;

    let sharedUserProfile: string | undefined;
    if (options.requireSharedProfile) {
      sharedUserProfile = (await rl.question("Tell VITA about yourself: ")).trim();
      if (!sharedUserProfile) {
        throw new Error("Shared user profile is required for the first VITA.");
      }
    }

    return { name, personality, sharedUserProfile, voiceName, voicePrompt, wakeWord, discord };
  } finally {
    rl.close();
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  switch (command) {
    case "spawn": {
      if (subcommand === "init") {
        if (hasLocalVitas()) {
          console.error("Local VITAs already exist. Use `spawn create` instead.");
          process.exit(1);
        }
        const answers = await promptForSpawn({ requireSharedProfile: true });
        const vita = createLocalVita(answers);
        console.log(`Created first VITA: ${vita.displayName} (${vita.name})`);
        console.log("");
        console.log(getWakeWordInstructions(vita.name, vita.wakeWords[0], vita.wakeWordSampleDir));
        return;
      }

      if (subcommand === "create") {
        const sharedProfile = readSharedUserProfile();
        if (!sharedProfile) {
          console.error("No shared user profile found. Run `spawn init` first.");
          process.exit(1);
        }
        const answers = await promptForSpawn({ requireSharedProfile: false });
        const vita = createLocalVita(answers);
        console.log(`Created VITA: ${vita.displayName} (${vita.name})`);
        console.log("");
        console.log(getWakeWordInstructions(vita.name, vita.wakeWords[0], vita.wakeWordSampleDir));
        return;
      }

      if (subcommand === "list") {
        console.log(formatVitaList());
        const summaries = listVitaSummaries();
        if (summaries.length) {
          console.log("");
          for (const vita of summaries) {
            const discord = getDiscordPromptSummary(vita.name);
            console.log(`${vita.name}: voice + wake configured, discord token ${discord.hasBotToken ? "present" : "missing"}`);
          }
        }
        const shared = readSharedUserProfile();
        if (shared) {
          console.log("");
          console.log("Shared user profile:");
          console.log(shared.profile);
        }
        return;
      }

      if (subcommand === "import-graves") {
        const vita = importExistingGraves();
        console.log(`Imported ${vita.displayName} (${vita.name}) into local storage.`);
        console.log("");
        console.log(getWakeWordInstructions(vita.name, vita.wakeWords[0], vita.wakeWordSampleDir));
        return;
      }

      printHelp();
      process.exit(1);
    }

    case "pairing": {
      if (!subcommand || subcommand === "list") {
        const pending = listPendingPairings();
        if (pending.length === 0) {
          console.log("No pending pairing requests.");
        } else {
          console.log(`\nPending pairing requests (${pending.length}):\n`);
          for (const p of pending) {
            console.log(`  Code: ${p.code}  |  Node: ${p.nodeId.substring(0, 12)}...  |  Requested: ${p.requestedAt}`);
            console.log(`  Capabilities: ${p.capabilities.join(", ")}\n`);
          }
        }
      } else if (subcommand === "approve") {
        const code = args[2];
        const name = args[3];
        if (!code) {
          console.error("Usage: vita-cli pairing approve <code> [name]");
          process.exit(1);
        }
        const result = approvePairing(code, name);
        if (result) {
          console.log(`Node paired: ${result.name} (${result.nodeId.substring(0, 12)}...)`);
        } else {
          console.error(`No pending pairing with code: ${code}`);
          process.exit(1);
        }
      } else if (subcommand === "nodes") {
        const nodes = listPairedNodes();
        if (nodes.length === 0) {
          console.log("No paired nodes.");
        } else {
          console.log(`\nPaired nodes (${nodes.length}):\n`);
          for (const n of nodes) {
            console.log(`  ${n.name}`);
            console.log(`    ID: ${n.nodeId.substring(0, 16)}...`);
            console.log(`    Paired: ${n.pairedAt}`);
            console.log(`    Last seen: ${n.lastSeen || "never"}`);
            console.log(`    Capabilities: ${n.capabilities.join(", ")}\n`);
          }
        }
      } else if (subcommand === "unpair") {
        const nodeId = args[2];
        if (!nodeId) {
          console.error("Usage: vita-cli pairing unpair <nodeId>");
          process.exit(1);
        }
        if (unpairNode(nodeId)) {
          console.log(`Node unpaired: ${nodeId}`);
        } else {
          console.error(`No paired node with ID: ${nodeId}`);
        }
      }
      return;
    }

    case "token": {
      if (subcommand === "reset") {
        const newToken = generateToken();
        writeFileSync(TOKEN_PATH, newToken, { mode: 0o600 });
        console.log(`New token generated: ${newToken}`);
        console.log(`Saved to: ${TOKEN_PATH}`);
        console.log("All connected nodes will need the new token.");
      } else {
        const token = loadOrCreateToken();
        console.log(`Gateway token: ${token}`);
        console.log(`Stored at: ${TOKEN_PATH}`);
      }
      return;
    }

    case "doctor": {
      console.log("\nVITA Gateway Security Audit\n");
      const config = loadGatewayConfig();
      let issues = 0;
      let warnings = 0;

      if (config.gateway.auth.mode === "none") {
        console.log("  CRITICAL: Auth mode is 'none' - anyone can connect to the gateway");
        issues++;
      } else {
        console.log(`  Auth mode: ${config.gateway.auth.mode}`);
      }

      if (config.gateway.bind === "lan") {
        if (config.gateway.auth.mode === "none") {
          console.log("  CRITICAL: Gateway bound to LAN (0.0.0.0) with no auth");
          issues++;
        } else {
          console.log("  WARNING: Gateway bound to LAN (0.0.0.0) - ensure firewall is configured");
          warnings++;
        }
      } else {
        console.log(`  Bind: ${config.gateway.bind} (loopback = safe)`);
      }

      if (config.tools.exec.enabled) {
        if (config.tools.exec.security === "full") {
          console.log("  WARNING: Command execution enabled with security='full'");
          warnings++;
        } else {
          console.log(`  Exec enabled with security: ${config.tools.exec.security}`);
        }
      } else {
        console.log("  Exec disabled");
      }

      if (config.gateway.tailscale.mode === "funnel") {
        if (!config.gateway.auth.password) {
          console.log("  CRITICAL: Tailscale Funnel enabled without password auth");
          issues++;
        } else {
          console.log("  Tailscale Funnel with password auth");
        }
      } else {
        console.log(`  Tailscale: ${config.gateway.tailscale.mode}`);
      }

      if (config.gateway.auth.mode === "token") {
        const token = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf-8").trim() : "";
        if (token.length < 32) {
          console.log("  WARNING: Gateway token is too short (< 32 chars)");
          warnings++;
        } else {
          console.log("  Token length OK");
        }
      }

      const nodes = listPairedNodes();
      const pending = listPendingPairings();
      console.log(`  Paired nodes: ${nodes.length}`);
      console.log(`  Local VITAs: ${listVitaSummaries().length}`);
      if (pending.length > 0) {
        console.log(`  Pending pairing requests: ${pending.length}`);
        warnings++;
      }

      console.log("");
      console.log("  Tailscale status:");
      const tsAvailable = isTailscaleAvailable();
      if (tsAvailable) {
        console.log(`     Tailscale running (IP: ${getTailscaleIP()}, Host: ${getTailscaleHostname()})`);
      } else {
        console.log("     Tailscale not detected");
      }

      console.log("");
      if (issues === 0 && warnings === 0) {
        console.log("  No issues found.\n");
      } else {
        console.log(`  Summary: ${issues} critical issue(s), ${warnings} warning(s)\n`);
      }
      return;
    }

    case "config": {
      const config = loadGatewayConfig();
      console.log(`\nGateway Configuration (${CONFIG_PATH}):\n`);
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    case "status": {
      const config = loadGatewayConfig();
      console.log("\nVITA Gateway Status\n");
      console.log(`  Config:     ${CONFIG_PATH}`);
      console.log(`  Token:      ${TOKEN_PATH}`);
      console.log(`  Pairings:   ${PAIRING_PATH}`);
      console.log(`  Bind:       ${config.gateway.bind}`);
      console.log(`  Port:       ${config.gateway.port}`);
      console.log(`  Auth:       ${config.gateway.auth.mode}`);
      console.log(`  Tailscale:  ${config.gateway.tailscale.mode}`);
      console.log(`  Exec:       ${config.tools.exec.enabled ? config.tools.exec.security : "disabled"}`);
      console.log(`  VITAs:      ${listVitaSummaries().length}`);

      const nodes = listPairedNodes();
      console.log(`  Paired:     ${nodes.length} node(s)`);

      const tsAvail = isTailscaleAvailable();
      console.log(`  Tailscale:  ${tsAvail ? "available" : "not installed"}`);
      if (tsAvail) {
        console.log(`    IP:       ${getTailscaleIP()}`);
        console.log(`    Host:     ${getTailscaleHostname()}`);
      }
      console.log("");
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
