import type { Config } from "./config.js";
import { logger } from "./logger.js";

export async function sendDiscordNotification(
  config: Config,
  message: string
): Promise<void> {
  try {
    const response = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message.slice(0, 2000), // Discord message limit
      }),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, statusText: response.statusText },
        "Discord webhook failed"
      );
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to send Discord notification");
  }
}
