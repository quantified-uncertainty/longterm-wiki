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

/**
 * Scrub the webhook URL out of an error message before logging. Node's
 * `fetch()` puts the full URL (including the `<ID>/<TOKEN>` path) into
 * `TypeError`s and connection-failure messages, so naively logging the raw
 * error message will leak the webhook secret into any centralized log store.
 */
function redactWebhookUrl(raw: string, webhookUrl: string): string {
  if (!webhookUrl) return raw;
  // Replace both the full URL and the bare token-bearing path component (the
  // latter survives some error formatters that split on whitespace).
  return raw.split(webhookUrl).join("<redacted-webhook-url>");
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
        // Belt-and-suspenders against @everyone / @here / role-ping injection
        // via interpolated content (e.g., a fat-fingered framework label or a
        // future enrichment-pipeline value). escapeForDiscord() in the
        // builders below handles markdown-link / code-block injection; this
        // disables Discord's own mention parser as the second layer.
        allowed_mentions: { parse: [] },
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
    const raw = err instanceof Error ? err.message : String(err);
    log.error(
      `[discord] webhook POST failed: ${redactWebhookUrl(raw, webhookUrl)}`,
    );
    return { delivered: false, reason: "network-error" };
  }
}

// ── Framework-specific message builders ────────────────────────────────────

/**
 * Escape Discord markdown / mention metacharacters so an interpolated label
 * cannot render as a link, code block, mass-ping, or formatting injection.
 *
 * Today the labels come from a PR-reviewed YAML (`data/frameworks/*.yaml`),
 * but this is defense-in-depth: a fat-fingered label like `@everyone` would
 * otherwise mass-ping the channel, and a future enrichment pipeline that
 * pulls labels from less-trusted sources would silently inherit the gap.
 *
 * The ZWSP after `@` is the documented mitigation for `@everyone` / `@here`
 * — it breaks Discord's mention tokenizer without altering the visual
 * rendering. `allowed_mentions: { parse: [] }` in `sendDiscordMessage` is
 * the second layer.
 */
export function escapeForDiscord(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/[`*_~|>#\-+=\[\]()!]/g, (ch) => `\\${ch}`)
    .replace(/@/g, "@\u200b");
}

export interface PendingReviewAlert {
  frameworkLabel: string; // e.g. "Anthropic RSP"
  versionLabel: string; // e.g. "v3.1"
  versionId: string;
  sourceUrl: string;
  reviewUrl?: string; // optional /internal/framework-review link
}

export function formatPendingReviewMessage(alert: PendingReviewAlert): string {
  const label = escapeForDiscord(alert.frameworkLabel);
  const version = escapeForDiscord(alert.versionLabel);
  const versionId = escapeForDiscord(alert.versionId);
  const sourceUrl = escapeForDiscord(alert.sourceUrl);
  const reviewUrl = alert.reviewUrl ? escapeForDiscord(alert.reviewUrl) : null;
  const review = reviewUrl ? `\n→ Review: ${reviewUrl}` : "";
  return [
    `🆕 **New framework version pending review**`,
    `**${label} ${version}** (\`${versionId}\`)`,
    `Source: ${sourceUrl}${review}`,
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
  const label = escapeForDiscord(alert.frameworkLabel);
  const frameworkId = escapeForDiscord(alert.frameworkId);
  const sourceUrl = escapeForDiscord(alert.sourceUrl);
  const prev = escapeForDiscord(alert.previousContentHash.slice(0, 12));
  const next = escapeForDiscord(alert.newContentHash.slice(0, 12));
  const supersedes = alert.latestKnownVersionId
    ? ` (supersedes \`${escapeForDiscord(alert.latestKnownVersionId)}\`)`
    : "";
  return [
    `⚠️ **Silent framework update detected**`,
    `**${label}** (\`${frameworkId}\`) — published page changed without a version bump${supersedes}`,
    `Source: ${sourceUrl}`,
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
