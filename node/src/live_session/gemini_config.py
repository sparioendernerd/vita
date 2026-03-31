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
    }

    enabled_tools = vita_config.get("tools", [])
    declarations = []
    for tool_name in enabled_tools:
        if tool_name in tool_schemas:
            declarations.append(tool_schemas[tool_name])

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

    if "google_search" in vita_config.get("tools", []):
        tools.append(types.Tool(google_search=types.GoogleSearch()))

    if tools:
        config_dict["tools"] = tools

    return types.LiveConnectConfig(**config_dict)
