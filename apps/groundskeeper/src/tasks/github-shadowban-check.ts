import type { Config } from "../config.js";
import { sendDiscordNotification } from "../notify.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "github-shadowban-check" });

/**
 * Track which usernames are currently known-banned so we only alert once
 * per ban (not every 30 minutes).
 */
const knownBanned = new Set<string>();

/**
 * Check whether a GitHub account is shadow-banned by making an
 * unauthenticated request to the public user endpoint.
 *
 * - 200 → account is fine
 * - 404 → account is shadow-banned (or doesn't exist)
 * - 403 → rate-limited, inconclusive
 *
 * Must be unauthenticated: the shadow-ban is only visible from outside.
 * See: https://x.com/BobSummerwill/status/2021620449982181848
 */
async function checkAccount(
  username: string
): Promise<"ok" | "banned" | "rate-limited" | "error"> {
  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}`,
      {
        headers: { "User-Agent": "longterm-wiki-groundskeeper" },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (res.status === 200) return "ok";
    if (res.status === 404) return "banned";
    if (res.status === 403 || res.status === 429) return "rate-limited";

    logger.warn(
      { username, status: res.status },
      "Unexpected status from GitHub user API"
    );
    return "error";
  } catch (e) {
    logger.warn(
      { username, error: e instanceof Error ? e.message : String(e) },
      "Failed to check GitHub user"
    );
    return "error";
  }
}

export async function githubShadowbanCheck(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  const usernames = config.tasks.githubShadowbanCheck.usernames;

  if (usernames.length === 0) {
    return { success: true, summary: "No usernames configured to monitor" };
  }

  const results: string[] = [];
  let anyBanned = false;

  for (const username of usernames) {
    const status = await checkAccount(username);

    if (status === "banned") {
      anyBanned = true;

      if (!knownBanned.has(username)) {
        knownBanned.add(username);

        // Immediate Discord alert — this is critical
        await sendDiscordNotification(
          config,
          `🚨 **GitHub shadow-ban detected**: \`${username}\` is returning 404 on the public API. ` +
            `All issues and PRs created by this account are invisible to others. ` +
            `Action: contact GitHub support to unflag the account, and switch automation to a different account immediately.\n` +
            `Test: \`curl -s -o /dev/null -w "%{http_code}" https://api.github.com/users/${username}\``
        );

        logger.error({ username }, "GitHub account shadow-banned");
      } else {
        logger.info(
          { username },
          "Account still shadow-banned (already alerted)"
        );
      }

      results.push(`${username}: BANNED`);
    } else if (status === "ok") {
      // If the account was previously banned and is now ok, that's a recovery
      if (knownBanned.has(username)) {
        knownBanned.delete(username);

        await sendDiscordNotification(
          config,
          `✅ **GitHub shadow-ban lifted**: \`${username}\` is accessible again.`
        );

        logger.info({ username }, "GitHub account shadow-ban lifted");
      }

      results.push(`${username}: ok`);
    } else {
      // rate-limited or error — don't change state, just log
      results.push(`${username}: ${status}`);
    }
  }

  return {
    success: !anyBanned,
    summary: results.join(", "),
  };
}
