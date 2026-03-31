# VITA: Voice Interactive Technical Assistant

VITA is a modular, high-performance voice assistant system designed to provide a personality-driven, real-time experience using the **Gemini 3.1 Flash Live** model. It features a decentralized, security-first architecture inspired by OpenClaw.

## 🏗️ Architecture

VITA uses a split **Gateway-Node** model to ensure reliability and secure remote access:

-   **VITA Gateway (TypeScript)**: The central control plane. It manages node connections, character configurations, persistent memories, and provides a secure proxy for tool execution.
-   **VITA Node (Python)**: The "ears" and "mouth" of the system. It handles microphone/speaker I/O and wake-word detection using `local-wake`.

## ✨ Key Features

-   **Real-time Voice**: Near-instant interaction via Gemini 3.1 Flash Live.
-   **Structured Memory**: FTS5-powered SQLite memory store with importance decay and AI-driven consolidation.
-   **System Control**: VITA can control the host machine (Linux gateway) through `system_run` and `system_notify` tools.
-   **Secure Remote Access**: Integrated **Tailscale Serve/Funnel** support for accessing your VITA safely from anywhere.
-   **Dynamic Context**: Personality and identity details are loaded from markdown files in `~/.vita/`.
-   **Token-based Auth**: Secure node-to-gateway communication with constant-time token validation and node pairing.

## 🔒 Security Model

VITA prioritizes security and local-first operation:
-   **Node Pairing**: New nodes must be explicitly approved by the operator using a 6-character pairing code.
-   **Isolation**: Bindings default to `loopback`. LAN and public access (via Tailscale) require explicit configuration.
-   **Execution Policy**: Command execution (`system_run`) is disabled by default and supports multiple security levels: `deny`, `ask`, `allowlist`, and `full`.
-   **Health Audit**: Use `npm run doctor` to perform a security audit on your gateway configuration.

## 🚦 Roadmap

VITA is evolving into a more powerful, centralized AI hub.

### Phase 1: Security & Auth Foundation ✅
- [x] Token-based authentication
- [x] Node pairing flow
- [x] JSON configuration system (`vita.json`)
- [x] Security Audit CLI (`npm run doctor`)

### Phase 2: Tailscale Integration ✅
- [x] Native `tailscale serve` support
- [x] Public `tailscale funnel` support with enforced password auth
- [x] Automated lifecycle management

### Phase 3: Knowledge Hub Expansion ✅
- [x] Persistent session transcripts (JSONL)
- [x] Vector database integration (Chroma) for semantic memory
- [x] Document/URL ingestion pipeline

### Phase 4: Node Execution ✅
- [x] `system_run` tool for remote host control
- [x] `system_notify` for desktop notifications
- [x] Fine-grained tool permission policies

### Phase 5: Control UI 📅
- [ ] Web-based dashboard for system monitoring
- [ ] Real-time node/session management
- [ ] Memory browser and editor
- [ ] Browser-based "WebChat" interface

### Phase 6: Protocol Evolution 🔄
- [x] Enhanced message types for telemetry and control
- [ ] Presence/Status API for multi-node orchestration
- [ ] Media/File transfer protocol

## 🚀 Getting Started

### Gateway Setup (Linux Recommended)
```bash
cd gateway
npm install
npm run build
npm start
```
Check `~/.vita/gateway-token` for your auto-generated access token.

### Node Setup
1. Configure your `.env` with `GATEWAY_URL` and `VITA_GATEWAY_TOKEN`.
2. Install dependencies: `pip install -r requirements.txt`.
3. Run the node: `python -m src.main`.

---
*Created by Vailen Industries. Inspired by OpenClaw.*
