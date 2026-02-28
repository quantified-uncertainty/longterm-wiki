import type { Config } from "./config.js";

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
      console.error(
        `Discord webhook failed: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    console.error("Failed to send Discord notification:", error);
  }
}
