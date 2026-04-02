# VITA: Voice Interactive Technical Assistant

VITA is a modular, personality-driven assistant with a split Gateway/Node architecture for real-time voice, persistent memory, and remote control.

## Architecture

- **VITA Gateway (TypeScript)**: control plane, memory store, tool execution, remote access, and now Discord chat bridging.
- **VITA Node (Python)**: microphone, speaker, wake word, vision/screenshare, and Gemini Live session handling.

## Key Features

- Real-time voice interaction via Gemini Live.
- SQLite + vector-backed memory.
- SQLite memory works by default; Chroma semantic memory is optional via `CHROMA_URL`.
- Gateway-side `system_run` and `system_notify`.
- Gateway-side reusable `scripts/` tool system for custom script folders.
- Cron-style scheduled tasks that can execute VITA tool workflows on a schedule.
- Discord text messaging in both directions.
- Discord file/image attachments from the gateway machine via `discord_send_file`.
- Tailscale-ready remote access.

## Getting Started

### Gateway

```bash
cd gateway
npm install
npm run build
npm start
```

Check `~/.vita/gateway-token` for the generated gateway token if you use token auth.

### Node

1. Configure `.env` with `GATEWAY_URL` and `VITA_GATEWAY_TOKEN`.
2. Install dependencies: `pip install -r requirements.txt`
3. Run the node: `python -m src.main`

## Discord Setup

1. Create a Discord bot in the developer portal.
2. Enable the `Message Content Intent`.
3. Put the bot token in `DISCORD_TOKEN` and the app ID in `DISCORD_APPLICATION_ID`.
4. Invite the bot to your server.
5. Optional: add one or more Discord channel IDs to the target VITA config in `gateway/data/vitas/default.vita.json` if you want server-channel replies.
6. Set `DISCORD_DM_USER_ID` in `.env` if you want `discord_notify` to DM a fixed Discord account.

Example:

```json
{
  "name": "graves",
  "discordChannels": ["123456789012345678"],
  "tools": ["system_notify", "discord_notify"]
}
```

## Scheduled Tasks

Each VITA config can include `scheduledTasks` entries. The gateway watches these and runs them on time using the VITA's text model plus its enabled tools.

Example:

```json
{
  "scheduledTasks": [
    {
      "id": "daily-research",
      "cron": "0 1 * * *",
      "description": "Daily research sweep",
      "action": "Research notable AI and tooling updates from the last day, save useful findings to memory, and notify Mr Vailen on Discord with a concise summary.",
      "timezone": "America/New_York",
      "enabled": true
    }
  ]
}
```

You can also create, list, and remove these tasks from VITA itself through the `schedule_task`, `list_scheduled_tasks`, and `remove_scheduled_task` tools.

DMs to the bot are routed to the first loaded VITA automatically. Outbound `discord_notify` will prefer `DISCORD_DM_USER_ID`, and if that is not set it will fall back to the last user who DM'd that VITA.

## Scripts System

Custom gateway scripts live in the top-level `scripts/` folder. Each script gets its own folder with a `script.json` manifest plus whatever files it needs. Graves can inspect them with `list_scripts` and run them with `run_script`.

See [docs/scripts-system.md](docs/scripts-system.md) for the folder format and the included Codex-powered scaffolding example.

## Optional Chroma

If you want semantic/vector memory, set `CHROMA_URL` in `.env` to a running Chroma server such as `http://localhost:8000`. If `CHROMA_URL` is unset, VITA will use SQLite memory only and will not attempt Chroma connections.

---

Created by Vailen Industries. Inspired by OpenClaw.
