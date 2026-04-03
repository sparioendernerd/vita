import type { VitaConfig } from "../config/vita-registry.js";

export const GLOBAL_TOOL_NAMES = [
  "read_memory",
  "write_memory",
  "search_memory",
  "consolidate_memories",
  "get_current_time",
  "deactivate_agent",
  "google_search",
  "system_run",
  "list_scripts",
  "run_script",
  "create_script_with_codex",
  "system_notify",
  "discord_notify",
  "discord_send_file",
  "system_list_nodes",
  "enable_vision",
  "enable_screenshare",
  "disable_vision",
  "ingest_knowledge",
  "schedule_task",
  "list_scheduled_tasks",
  "remove_scheduled_task",
  "media_play_pause",
  "media_next_track",
  "media_prev_track",
  "media_volume_up",
  "media_volume_down",
  "list_steam_games",
  "launch_steam_game",
  "list_vitas",
  "read_shared_profile",
  "send_vita_message",
  "read_vita_messages",
  "mark_vita_message_read",
  "start_background_task",
  "list_background_tasks",
  "get_background_task",
  "cancel_background_task",
] as const;

export type GlobalToolName = (typeof GLOBAL_TOOL_NAMES)[number];

export function getLegacyAllowedTools(vita: Pick<VitaConfig, "tools" | "blockedTools">): string[] | null {
  if (Array.isArray(vita.tools) && vita.tools.length > 0) {
    return vita.tools;
  }
  return null;
}

export function normalizeBlockedTools(vita: Pick<VitaConfig, "tools" | "blockedTools">): string[] {
  if (Array.isArray(vita.blockedTools) && vita.blockedTools.length > 0) {
    return Array.from(new Set(vita.blockedTools.filter((tool) => GLOBAL_TOOL_NAMES.includes(tool as GlobalToolName))));
  }
  const legacyAllowed = getLegacyAllowedTools(vita);
  if (legacyAllowed) {
    return GLOBAL_TOOL_NAMES.filter((tool) => !legacyAllowed.includes(tool));
  }
  return [];
}

export function getAvailableToolNames(vita: Pick<VitaConfig, "tools" | "blockedTools">): string[] {
  const blocked = new Set(normalizeBlockedTools(vita));
  return GLOBAL_TOOL_NAMES.filter((tool) => !blocked.has(tool));
}

export function isToolBlocked(vita: Pick<VitaConfig, "tools" | "blockedTools">, toolName: string): boolean {
  return !getAvailableToolNames(vita).includes(toolName);
}
