from typing import Any
from google.genai import types


def build_system_prompt(vita_config: dict, memories: list[str]) -> str:
    """Build the full system prompt from VITA config and memories."""
    parts = []

    # Get system instructions (personality)
    core_instructions = vita_config.get("systemInstructions") or vita_config.get("personality")
    if core_instructions:
        parts.append(core_instructions)

    # Add voice-specific guiding prompt
    voice_prompt = vita_config.get("voicePrompt")
    if voice_prompt:
        parts.append(f"## Voice & Delivery Instructions\n{voice_prompt}")

    # Add memories if available
    if memories:
        memory_text = "\n".join(f"- {m}" for m in memories)
        parts.append(f"## Your Memories\n{memory_text}")

    shared_profile = vita_config.get("sharedUserProfile")
    if shared_profile:
        parts.append(f"## Shared User Profile\n{shared_profile}")

    known_vitas = vita_config.get("knownVitas") or []
    if known_vitas:
        vita_lines = []
        for vita in known_vitas:
            if isinstance(vita, dict):
                display = vita.get("displayName") or vita.get("name")
                name = vita.get("name")
                if display and name:
                    vita_lines.append(f"- {display} ({name})")
        if vita_lines:
            parts.append("## Other Known VITAs\n" + "\n".join(vita_lines))

    available_tools = vita_config.get("availableTools") or []
    if available_tools:
        parts.append("## Available Tools\n" + ", ".join(str(tool) for tool in available_tools))

    # Add tool instructions
    parts.append(
        "## Core Rule: Deactivation\n"
        "NEVER call `deactivate_agent` at the end of a normal back-and-forth exchange or conversational turn. Our system automatically manages conversational turns for you!\n"
        "The ONLY time you should ever call `deactivate_agent` is if the user issues a clear, explicit command to stop such as 'goodbye, Graves', 'shut down', 'go to sleep', or 'turn off'. Do NOT guess and do NOT call it because you answered a question.\n"
        "IMPORTANT: When you call `deactivate_agent`, you MUST say a brief, verbal goodbye in the exact same conversational turn so the user knows you are leaving.\n\n"
        "## Core Rule: Vision & Senses\n"
        "You have two distinct 'eyes' that are DISABLED by default. You MUST enable the correct one based on Mr Vailen's intent:\n\n"
        "1. **CAMERA (Physical Eye)** via `enable_vision`:\n"
        "   - Map phrases like: 'How do I look?', 'Look at me', 'Can you see this [physical object]?', 'See this room?', 'Check out my outfit'.\n"
        "   - Use this for anything in the physical world.\n\n"
        "2. **SCREENSHARE (Digital Eye)** via `enable_screenshare`:\n"
        "   - Map phrases like: 'What's on my screen?', 'Look at this code', 'Check out this document', 'What am I doing?', 'See this website?'.\n"
        "   - Use this for anything happening on his computer desktop.\n\n"
        "Clarification: Both modes share a 1-minute timeout. Calling one switches the source from the other. \n"
        "Vision/Screenshare stays ON automatically for 1 minute. Do NOT call `disable_vision` yourself unless Mr Vailen explicitly says 'stop looking', 'stop sharing', or 'close your eye'. Otherwise, just let the timer handle it."
    )
    parts.append(
        "## Core Rule: Background Work\n"
        "If Mr Vailen asks for a complex, multi-step, or long-running task that does not need to finish inside this live exchange, prefer `start_background_task`.\n"
        "When you do that, briefly confirm that you'll handle it and report back when it's done.\n"
        "Use recurring `schedule_task` only for repeated jobs. Use `start_background_task` for one-off async work."
    )
    parts.append(
        "## Core Rule: Tool Discipline\n"
        "If a dedicated tool exists for the job, use the tool instead of improvising with `system_run`.\n"
        "Do NOT try shell commands like `which schedule_task`, `crontab`, or similar to access tools. Tools are called directly by name, not through the terminal.\n"
        "Use `schedule_task` for recurring schedules, one distinct tool call per schedule entry.\n"
        "Use `start_background_task` for one-off complex jobs that need several steps or follow-up.\n"
        "Use `run_script` only for scripts already registered in the gateway. Use `list_scripts` first if you're unsure what exists.\n"
        "Use `system_run` only when there is no dedicated tool for the task."
    )

    return "\n\n".join(parts)


def build_tool_declarations(vita_config: dict) -> list[dict[str, Any]]:
    """Build Gemini tool declarations from the VITA's tool list."""
    tool_schemas: dict[str, dict] = {
        "read_memory": {
            "name": "read_memory",
            "description": "Read memories from a specific category",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["core", "conversations", "user-profiles", "world-knowledge"],
                        "description": "Memory category to read from",
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional search query to filter memories",
                    },
                },
                "required": ["category"],
            },
        },
        "write_memory": {
            "name": "write_memory",
            "description": "Write a new memory",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["core", "conversations", "user-profiles", "world-knowledge"],
                    },
                    "content": {
                        "type": "string",
                        "description": "The memory content to store",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization",
                    },
                },
                "required": ["category", "content"],
            },
        },
        "search_memory": {
            "name": "search_memory",
            "description": "Search across all memories",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results to return",
                    },
                },
                "required": ["query"],
            },
        },
        "list_vitas": {
            "name": "list_vitas",
            "description": "List the other VITAs known to the gateway.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "read_shared_profile": {
            "name": "read_shared_profile",
            "description": "Read the shared user profile that all VITAs can access.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "send_vita_message": {
            "name": "send_vita_message",
            "description": "Leave a durable mailbox message for another VITA.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_vita": {
                        "type": "string",
                        "description": "Target VITA name.",
                    },
                    "subject": {
                        "type": "string",
                        "description": "Optional short subject line.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Message body.",
                    },
                },
                "required": ["to_vita", "body"],
            },
        },
        "read_vita_messages": {
            "name": "read_vita_messages",
            "description": "Read mailbox messages left for you by other VITAs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["unread", "read"],
                        "description": "Optional mailbox status filter.",
                    },
                },
            },
        },
        "mark_vita_message_read": {
            "name": "mark_vita_message_read",
            "description": "Mark one mailbox message as read.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {
                        "type": "string",
                        "description": "Mailbox message ID.",
                    },
                },
                "required": ["message_id"],
            },
        },
        "get_current_time": {
            "name": "get_current_time",
            "description": "Get the current date and time",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "deactivate_agent": {
            "name": "deactivate_agent",
            "description": "Terminates your own process and shuts down the connection. Use this ONLY if the user tells you to leave or says a final goodbye. Do NOT use this between normal conversational turns.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason_for_leaving": {
                        "type": "string",
                        "description": "A brief explanation of why the user wants to leave (e.g., 'User said goodnight')."
                    }
                },
                "required": ["reason_for_leaving"]
            },
        },
        "consolidate_memories": {
            "name": "consolidate_memories",
            "description": "Consolidate older conversation memories into distilled core facts. Call this periodically (e.g. after a long session) to keep memory efficient. Returns a summary of what was consolidated.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Category to consolidate (default: conversations)",
                    },
                },
                "required": [],
            },
        },
        "system_run": {
            "name": "system_run",
            "description": "Execute a terminal command on your own Linux host (the Gateway PC). Use this for file management, system checks, or running scripts. Use /bin/bash syntax.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute.",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional working directory.",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in milliseconds (default: 30000).",
                    },
                },
                "required": ["command"],
            },
        },
        "system_notify": {
            "name": "system_notify",
            "description": "Send a desktop notification to your host system to alert the user.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title of the notification.",
                    },
                    "body": {
                        "type": "string",
                        "description": "The main text of the notification.",
                    },
                    "urgency": {
                        "type": "string",
                        "enum": ["low", "normal", "critical"],
                        "description": "Urgency level.",
                    },
                },
                "required": ["title", "body"],
            },
        },
        "discord_notify": {
            "name": "discord_notify",
            "description": "Send a Discord message to Mr Vailen through your configured Discord channel when you need to proactively get his attention.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the Discord message.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Main Discord message body.",
                    },
                },
                "required": ["title", "body"],
            },
        },
        "discord_send_file": {
            "name": "discord_send_file",
            "description": "Send a file or image from your gateway machine to Discord as an attachment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file on the gateway machine.",
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional caption to include with the attachment.",
                    },
                },
                "required": ["file_path"],
            },
        },
        "system_list_nodes": {
            "name": "system_list_nodes",
            "description": "List all connected VITA nodes. Use this to see what devices are active in your network.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "enable_vision": {
            "name": "enable_vision",
            "description": "Enable the camera/vision feed. Call this when Mr Vailen asks you to look at something or tell him what you see.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "disable_vision": {
            "name": "disable_vision",
            "description": "Disable the camera or screenshare feed to save resources. Call this once you've finished looking at what Mr Vailen showed you.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "enable_screenshare": {
            "name": "enable_screenshare",
            "description": "Enable the digital screenshare feed. Call this when Mr Vailen specifically mentions seeing his screen or digital files.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "ingest_knowledge": {
            "name": "ingest_knowledge",
            "description": "Ingest information from a URL or raw text into your long-term memory. Use this to 'learn' new things or save documents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch and ingest content from.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Raw text content to ingest directly.",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional tags for the ingested content.",
                    },
                },
            },
        },
        "schedule_task": {
            "name": "schedule_task",
            "description": "Create a recurring scheduled task for yourself. Use this when Mr Vailen asks you to do something on a schedule such as daily, weekly, or at a specific time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cron": {
                        "type": "string",
                        "description": "Cron expression in the gateway timezone. For example, daily at 1am is '0 1 * * *'.",
                    },
                    "action": {
                        "type": "string",
                        "description": "The task instruction you should execute when the schedule fires.",
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional short label for the task.",
                    },
                    "timezone": {
                        "type": "string",
                        "description": "Optional IANA timezone such as 'America/New_York'.",
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Whether the task should start enabled. Defaults to true.",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional subset of tools the scheduled task may use.",
                    },
                },
                "required": ["cron", "action"],
            },
        },
        "list_scheduled_tasks": {
            "name": "list_scheduled_tasks",
            "description": "List your currently scheduled recurring tasks.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
        "remove_scheduled_task": {
            "name": "remove_scheduled_task",
            "description": "Remove a scheduled recurring task by its ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The scheduled task ID returned by list_scheduled_tasks.",
                    }
                },
                "required": ["id"],
            },
        },
        "start_background_task": {
            "name": "start_background_task",
            "description": "Queue a one-off background task for yourself. Use this for complex or long-running work that should continue after this conversation turn.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short label for the task."},
                    "goal": {"type": "string", "description": "What you should accomplish."},
                    "description": {"type": "string", "description": "Optional extra context."},
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional subset of tools the task may use.",
                    },
                },
                "required": ["goal"],
            },
        },
        "list_background_tasks": {
            "name": "list_background_tasks",
            "description": "List your background tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["queued", "running", "completed", "failed", "cancelled"],
                    },
                },
            },
        },
        "get_background_task": {
            "name": "get_background_task",
            "description": "Get one of your background tasks by ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                },
                "required": ["id"],
            },
        },
        "cancel_background_task": {
            "name": "cancel_background_task",
            "description": "Cancel one of your queued background tasks by ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                },
                "required": ["id"],
            },
        },
        "media_play_pause": {
            "name": "media_play_pause",
            "description": "Toggles play/pause for the system's active media player (e.g. Spotify, YouTube).",
            "parameters": {"type": "object", "properties": {}},
        },
        "media_next_track": {
            "name": "media_next_track",
            "description": "Skips to the next track in the system's active media player.",
            "parameters": {"type": "object", "properties": {}},
        },
        "media_prev_track": {
            "name": "media_prev_track",
            "description": "Goes to the previous track in the system's active media player.",
            "parameters": {"type": "object", "properties": {}},
        },
        "media_volume_up": {
            "name": "media_volume_up",
            "description": "Increases the system volume by a small increment.",
            "parameters": {"type": "object", "properties": {}},
        },
        "media_volume_down": {
            "name": "media_volume_down",
            "description": "Decreases the system volume by a small increment.",
            "parameters": {"type": "object", "properties": {}},
        },
        "list_steam_games": {
            "name": "list_steam_games",
            "description": "List all installed Steam games on the user's PC. Use this to see what games are available to launch.",
            "parameters": {"type": "object", "properties": {}},
        },
        "launch_steam_game": {
            "name": "launch_steam_game",
            "description": "Launches a Steam game by its App ID. You should usually call list_steam_games first to find the correct ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_id": {
                        "type": "string",
                        "description": "The Steam App ID of the game to launch.",
                    }
                },
                "required": ["app_id"],
            },
        },
    }

    blocked_tools = set(vita_config.get("blockedTools", []))
    declarations = []
    for tool_name, schema in tool_schemas.items():
        if tool_name not in blocked_tools:
            declarations.append(schema)

    return declarations


def build_live_config(vita_config: dict, memories: list[str]) -> types.LiveConnectConfig:
    """Build the Gemini Live connection config from VITA config."""
    system_prompt = build_system_prompt(vita_config, memories)
    tool_declarations = build_tool_declarations(vita_config)

    config_dict: dict[str, Any] = {
        "response_modalities": ["AUDIO"],
        "speech_config": types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=vita_config.get("voiceName", "Kore")
                )
            )
        ),
        "system_instruction": system_prompt,
        "realtime_input_config": types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False
            )
        ),
        "output_audio_transcription": types.AudioTranscriptionConfig(),
    }

    tools = []
    if tool_declarations:
        tools.append(types.Tool(function_declarations=tool_declarations))

    if "google_search" not in set(vita_config.get("blockedTools", [])):
        tools.append(types.Tool(google_search=types.GoogleSearch()))

    if tools:
        config_dict["tools"] = tools

    return types.LiveConnectConfig(**config_dict)
