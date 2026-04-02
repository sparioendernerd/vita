# VITA: Voice Interactive Technical Assistant

VITA is a modular, personality-driven assistant with a split Gateway/Node architecture for real-time voice, persistent memory, and remote control.

## Architecture

- **VITA Gateway (TypeScript)**: control plane, memory store, tool execution, remote access, and now Discord chat bridging.
- **VITA Node (Python)**: microphone, speaker, wake word, vision/screenshare, and Gemini Live session handling.

## Key Features

- Real-time voice interaction via Gemini Live.
- SQLite + vector-backed memory.
- Gateway-side `system_run` and `system_notify`.
- Discord text messaging in both directions.
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

DMs to the bot are routed to the first loaded VITA automatically. Outbound `discord_notify` will prefer `DISCORD_DM_USER_ID`, and if that is not set it will fall back to the last user who DM'd that VITA.

---

Created by Vailen Industries. Inspired by OpenClaw.
