import { exec } from "node:child_process";
import { logger } from "../logger.js";
import type { SystemNotifyPayload } from "../websocket/protocol.js";

/**
 * Send a desktop notification on the Linux gateway host.
 *
 * Uses `notify-send` (part of libnotify-bin on Debian/Ubuntu).
 * Falls back gracefully if not available.
 */
export async function sendSystemNotify(
  payload: SystemNotifyPayload
): Promise<{ callId: string; success: boolean; error?: string }> {
  const { callId, title, body, urgency = "normal" } = payload;

  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body.replace(/"/g, '\\"');
  const cmd = `notify-send --urgency=${urgency} "${escapedTitle}" "${escapedBody}"`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000 }, (error) => {
      if (error) {
        // Try wall as fallback (terminal broadcast)
        const fallback = `echo "🧠 VITA: ${escapedTitle} — ${escapedBody}" | wall 2>/dev/null || true`;
        exec(fallback, { timeout: 3000 }, () => {
          // Don't fail on fallback failure either
        });

        logger.warn(`[system.notify] notify-send failed, used wall fallback: ${error.message}`);
        resolve({
          callId,
          success: false,
          error: `notify-send failed: ${error.message} (tried wall fallback)`,
        });
      } else {
        logger.info(`[system.notify] Sent: ${title}`);
        resolve({ callId, success: true });
      }
    });
  });
}
