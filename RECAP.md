# VITA: Voice Interactive Technical Assistant

VITA is a modular, high-performance voice assistant system designed to provide a low-latency, personality-driven experience using the **Gemini 3.1 Flash Live** model.

## 🏗️ Architecture

VITA follows a split **Gateway-Node** architecture inspired by [OpenClaw](https://github.com/openclaw/openclaw):

1.  **VITA Gateway (TypeScript/Node.js)** — *Knowledge Hub & Control Plane*:
    -   **Central Hub**: Orchestrates connections from multiple VITA nodes.
    -   **Auth & Pairing**: Token-based authentication with node pairing (like OpenClaw's DM pairing model).
    -   **Registry**: Manages VITA character configurations (like Graves).
    -   **Context Manager**: Dynamically loads personality and memories (soul, identity, user data) from `~/.vita`.
    -   **Tool Proxy**: Handles tool requests (memory, time, system commands) between Gemini and the node.
    -   **System Execution**: Can run commands on the gateway host (`system.run`) and send desktop notifications.
    -   **Transcript Logger**: Persists full session transcripts to `~/.vita/<vita>/sessions/`.
    -   **Tailscale Integration**: Serve (tailnet-only) or Funnel (public) modes for remote access.
    -   **Config File**: `~/.vita/vita.json` — comprehensive gateway config with env overrides.
    -   **CLI**: `npm run cli` — pairing management, security audit, token management.

2.  **VITA Node (Python 3.x)**:
    -   **Audio I/O**: High-speed microphone capture (16kHz) and speaker playback (24kHz).
    -   **Wake Word Engine**: Uses **local-wake** for efficient, low-latency detection ("Hey Graves").
    -   **Session Orchestrator**: Manages the real-time interaction with Gemini Live.
    -   **Auth Support**: Sends `auth:handshake` with token; handles pairing codes.
    -   **Live Audio Streaming**: Pipes audio chunks to/from Gemini for near-instant voice interaction.

## 🔒 Security (OpenClaw-inspired)

-   **Auth modes**: `none` (dev), `token` (default — auto-generated), `password` (for Funnel).
-   **Bind**: `loopback` (default), `lan` (explicit opt-in), `tailnet` (Tailscale IP).
-   **Node Pairing**: New nodes get a 6-char code; operator must approve via `npm run cli pairing approve <code>`.
-   **System Execution**: Disabled by default. Security levels: `deny`, `ask`, `allowlist`, `full`.
-   **Dangerous Command Blocking**: Even in `full` mode, patterns like `rm -rf /` are blocked.
-   **Security Audit**: `npm run doctor` checks auth, bind, exec, Tailscale, and token strength.

## 🌐 Tailscale Remote Access

-   **Serve mode**: Gateway stays on loopback, Tailscale Serve exposes via HTTPS to the tailnet.
-   **Funnel mode**: Public HTTPS — requires password auth (enforced).
-   **Reset on exit**: Optional cleanup of Serve/Funnel config on shutdown.
-   Configure via `~/.vita/vita.json` → `gateway.tailscale.mode`.

## ✨ Key Features

-   **Gemini Live Integration**: Leverages Gemini 3.1 Flash Live for multi-modal, real-time conversations.
-   **Dynamic Personalities**: VITA is a platform — swap personalities via JSON configurations.
-   **Graves Agent**: The current default — a posh, deadpan British co-host.
-   **Structured Memory**: Persistent memory through `read_memory`, `write_memory`, `search_memory` tools with FTS5 search, importance decay, and AI-driven consolidation.
-   **System Control**: VITA can run commands on the gateway PC and send desktop notifications.
-   **Session Transcripts**: Full JSONL transcripts persisted to disk.
-   **Graceful Shutdown**: Robust handling with Tailscale teardown.

## 🛠️ Technical Stack

-   **Gateway**: Node.js, TypeScript, WebSocket (ws), Zod, better-sqlite3, Winston.
-   **Node**: Python, AsyncIO, PyAudio, NumPy, websockets.
-   **AI Services**: Google GenAI SDK (Gemini Live API), Ollama (offline heartbeats).
-   **Networking**: Tailscale Serve/Funnel for remote access.
-   **Security**: Token auth (constant-time validation), node pairing, exec policy.

## 🚀 Gateway Configuration

Config file: `~/.vita/vita.json`

```jsonc
{
  "gateway": {
    "bind": "loopback",       // "loopback" | "lan" | "tailnet"
    "port": 8765,
    "auth": { "mode": "token" },
    "tailscale": { "mode": "off" }  // "off" | "serve" | "funnel"
  },
  "tools": {
    "exec": {
      "enabled": false,
      "security": "deny"      // "deny" | "ask" | "allowlist" | "full"
    }
  }
}
```

## 📋 CLI Commands

```bash
npm run cli -- pairing list        # Pending pairing requests
npm run cli -- pairing approve ABC # Approve a node
npm run cli -- pairing nodes       # List paired nodes
npm run cli -- token               # Show gateway token
npm run cli -- token reset         # Regenerate token
npm run cli -- doctor              # Security audit
npm run cli -- config              # Show current config
npm run cli -- status              # Full status check
```

## 🚀 Current Status

The project is configured for **Graves** as the primary agent, responding to the wake word **"hey graves"**. The gateway and node communicate over a configurable port (default `8765`), secured by token auth. The gateway runs on a dedicated **Linux PC** and can be reached remotely via **Tailscale**.

---
*Created by Antigravity for the VITA Project.*
