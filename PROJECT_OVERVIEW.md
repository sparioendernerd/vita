# VITA: Project Overview & Architecture

VITA (Voice Interactive Technical Assistant) is a modular, high-performance voice assistant system. It is designed to provide a low-latency, personality-driven experience using the **Gemini 3.1 Flash Live** model.

> [!TIP]
> **LLM Context**: This file is a "source of truth" for the VITA project. When analyzing or modifying this codebase, refer to this document for architectural patterns and component roles.

---

## 🏗️ Core Architecture (Gateway-Node)

VITA follows a split **Gateway-Node** architecture, optimizing for central knowledge management and distributed edge interaction.

### 1. VITA Gateway (TypeScript/Node.js)
The **Control Plane** and **Knowledge Hub**. It runs on a primary host (typically Linux).
- **Orchestration**: Manages connections from multiple VITA nodes.
- **Auth & Pairing**: Token-based handshake and 6-character node pairing codes.
- **Character Management**: Loads personality, identity, and memory from `~/.vita/`.
- **Tool Proxy**: Orchestrates tool execution between Gemini and the system/node.
- **Persistent Memory**: SQLite (FTS5) for fast search and ChromaDB for semantic/vector memory.
- **Remote Access**: Integrated Tailscale Serve/Funnel for secure HTTPS access.

### 2. VITA Node (Python 3.x)
The **Edge Interface** (the "Ears" and "Mouth"). It runs on interaction devices (typically Windows/Linux).
- **Audio Pipeline**: 16kHz microphone capture and 24kHz speaker playback.
- **Wake Word Engine**: Uses `local-wake` for "Hey Graves" detection.
- **Live Session**: Manages real-time WebSocket streaming with the Gemini Live API.
- **Vision**: Integrated screen-sharing and camera support for multi-modal context.
- **Local Tools**: Executes node-specific commands (media control, app launching).

---

## 🔒 Security & Auth

VITA implements a security-first model inspired by OpenClaw:
- **Token Handshake**: Nodes must provide a valid `GATEWAY_TOKEN` for initial connection.
- **Node Pairing**: New nodes require manual approval via a 6-character code (`npm run cli pairing approve <CODE>`).
- **Execution Policy**: `system_run` permissions are granular: `deny`, `ask`, `allowlist`, or `full`.
- **Encryption**: Remote connections are secured via Tailscale's automated HTTPS/TLS.

---

## 📂 Project Structure

```text
VITA/
├── gateway/                # TypeScript Gateway Source
│   ├── src/
│   │   ├── auth/          # Authentication & Pairing logic
│   │   ├── memory/        # SQLite + ChromaDB implementations
│   │   ├── tools/         # Tool proxy & execution handlers
│   │   ├── network/       # Tailscale & Socket management
│   │   └── index.ts       # Gateway Entry Point
├── node/                   # Python Node Source
│   ├── src/
│   │   ├── audio/         # PyAudio capture/playback
│   │   ├── wakeword/      # Local-wake integration
│   │   ├── vision/        # Screenshare & Camera tools
│   │   └── main.py        # Node Entry Point
├── shared/                 # Common schemas and protocol definitions
│   ├── protocol.schema.json
│   └── vita-config.schema.json
└── docs/                   # Additional documentation
```

---

## 🛠️ Key Technologies

-   **Model**: Gemini 3.1 Flash Live (via Google GenAI SDK).
-   **Database**: SQLite (FTS5) + ChromaDB (Vector Store).
-   **Wake Word**: `local-wake`.
-   **Network**: WebSockets (`ws` in TS, `websockets` in Py) + Tailscale.
-   **Validation**: Zod (Gateway) + Pydantic/Manual (Node).

---

## 🤖 LLM Implementation Notes

-   **Gateway Extensions**: When adding new tools, update `gateway/src/tools/` and ensure the tool is registered in the Gemini session config.
-   **Node Extensions**: Hardware-specific capabilities (new sensors/outputs) should be added to `node/src/` with a corresponding tool definition.
-   **Memory Access**: Use the `MemoryStore` abstraction to ensure both keyword (SQLite) and semantic (Chroma) search are utilized.
-   **Protocol**: All Gateway-Node communication must follow the schema in `shared/protocol.schema.json`.
