/**
 * Discord webhook helper for crux scripts (QUA-711).
 *
 * Best-effort, fail-open. Reads the webhook URL from env and POSTs a JSON
 * `{content}` payload. Network errors and non-2xx responses are logged
 * and swallowed — Discord outages must never wedge an agent pipeline.
 *
 * Dedup is the caller's responsibility. The frontier-safety re-fetch flow
 * dedups via `framework_ingest_log` natural-key idempotency: a
 * `silent_update_detected` row only gets written once per
 * `(framework_id, content_hash)`, so the alert can't fire twice for the
 * same drift event without manually deleting the log row.
 */

const DISCORD_MAX_CONTENT_CHARS = 2000;

export interface DiscordWebhookOptions {
  /** Override the webhook URL (else read from env). */
  webhookUrl?: string;
  /**
   * Override `fetch` — used by tests so they don't go to the network.
   * The default is the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Logger — defaults to `console`. */
  logger?: Pick<Console, "warn" | "error">;
}

export interface DiscordSendResult {
  /** True on HTTP 2xx, false on any other path (including no webhook configured). */
  delivered: boolean;
  /** Coarse classification — useful for callers that want to track skip vs failure. */
  reason?: "no-webhook" | "http-error" | "network-error";
}

/**
 * Resolve the webhook URL. Prefers the framework-specific env var so this
 * doesn't share a channel with groundskeeper alerts (which are noisier).
 * Falls back to the generic `DISCORD_WEBHOOK_URL` so a workspace with only
 * one webhook configured still gets the alerts.
 */
export function resolveWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const specific = env.DISCORD_FRAMEWORK_WEBHOOK_URL;
  if (specific && specific.length > 0) return specific;
  const generic = env.DISCORD_WEBHOOK_URL;
  if (generic && generic.length > 0) return generic;
  return null;
}

export async function sendDiscordMessage(
  message: string,
  options: DiscordWebhookOptions = {},
): Promise<DiscordSendResult> {
  const log = options.logger ?? console;
  const webhookUrl = options.webhookUrl ?? resolveWebhookUrl();
  if (!webhookUrl) {
    log.warn(
      "[discord] No webhook configured (DISCORD_FRAMEWORK_WEBHOOK_URL or DISCORD_WEBHOOK_URL) — skipping",
    );
    return { delivered: false, reason: "no-webhook" };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message.slice(0, DISCORD_MAX_CONTENT_CHARS),
      }),
    });
    if (!response.ok) {
      log.error(
        `[discord] webhook returned ${response.status} ${response.statusText}`,
      );
      return { delivered: false, reason: "http-error" };
    }
    return { delivered: true };
  } catch (err) {
    log.error(
      `[discord] webhook POST failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { delivered: false, reason: "network-error" };
  }
}

// ── Framework-specific message builders ────────────────────────────────────

export interface PendingReviewAlert {
  frameworkLabel: string; // e.g. "Anthropic RSP"
  versionLabel: string; // e.g. "v3.1"
  versionId: string;
  sourceUrl: string;
  reviewUrl?: string; // optional /internal/framework-review link
}

export function formatPendingReviewMessage(alert: PendingReviewAlert): string {
  const review = alert.reviewUrl ? `\n→ Review: ${alert.reviewUrl}` : "";
  return [
    `🆕 **New framework version pending review**`,
    `**${alert.frameworkLabel} ${alert.versionLabel}** (\`${alert.versionId}\`)`,
    `Source: ${alert.sourceUrl}${review}`,
  ].join("\n");
}

export interface SilentUpdateAlert {
  frameworkLabel: string;
  frameworkId: string;
  sourceUrl: string;
  newContentHash: string;
  previousContentHash: string;
  /** Stable ID of the latest known version that this drift superseded. */
  latestKnownVersionId: string | null;
}

export function formatSilentUpdateMessage(alert: SilentUpdateAlert): string {
  const prev = alert.previousContentHash.slice(0, 12);
  const next = alert.newContentHash.slice(0, 12);
  const supersedes = alert.latestKnownVersionId
    ? ` (supersedes \`${alert.latestKnownVersionId}\`)`
    : "";
  return [
    `⚠️ **Silent framework update detected**`,
    `**${alert.frameworkLabel}** (\`${alert.frameworkId}\`) — published page changed without a version bump${supersedes}`,
    `Source: ${alert.sourceUrl}`,
    `Hash: \`${prev}…\` → \`${next}…\``,
  ].join("\n");
}

export async function sendPendingReviewAlert(
  alert: PendingReviewAlert,
  options: DiscordWebhookOptions = {},
): Promise<DiscordSendResult> {
  return sendDiscordMessage(formatPendingReviewMessage(alert), options);
}

export async function sendSilentUpdateAlert(
  alert: SilentUpdateAlert,
  options: DiscordWebhookOptions = {},
): Promise<DiscordSendResult> {
  return sendDiscordMessage(formatSilentUpdateMessage(alert), options);
}
