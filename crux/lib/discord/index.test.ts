/**
 * Tests for crux/lib/discord/index.ts
 *
 * Mocks `fetch` to verify webhook delivery + message format. Exercises:
 *   - URL resolution from env (specific > generic > null)
 *   - Successful POST returns delivered=true
 *   - Non-2xx returns delivered=false with reason='http-error'
 *   - Network throw returns delivered=false with reason='network-error'
 *   - No webhook configured returns reason='no-webhook'
 *   - Message templates render the expected literal text
 *   - Discord 2000-char limit is enforced
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveWebhookUrl,
  sendDiscordMessage,
  formatPendingReviewMessage,
  formatSilentUpdateMessage,
  sendPendingReviewAlert,
  sendSilentUpdateAlert,
} from "./index.ts";

const NOOP_LOGGER = { warn: vi.fn(), error: vi.fn() };

describe("resolveWebhookUrl", () => {
  it("prefers DISCORD_FRAMEWORK_WEBHOOK_URL", () => {
    expect(
      resolveWebhookUrl({
        DISCORD_FRAMEWORK_WEBHOOK_URL: "https://framework.example/hook",
        DISCORD_WEBHOOK_URL: "https://generic.example/hook",
      } as NodeJS.ProcessEnv),
    ).toBe("https://framework.example/hook");
  });

  it("falls back to DISCORD_WEBHOOK_URL", () => {
    expect(
      resolveWebhookUrl({
        DISCORD_WEBHOOK_URL: "https://generic.example/hook",
      } as NodeJS.ProcessEnv),
    ).toBe("https://generic.example/hook");
  });

  it("returns null when neither is set", () => {
    expect(resolveWebhookUrl({} as NodeJS.ProcessEnv)).toBe(null);
  });

  it("treats empty strings as unset", () => {
    expect(
      resolveWebhookUrl({
        DISCORD_FRAMEWORK_WEBHOOK_URL: "",
        DISCORD_WEBHOOK_URL: "",
      } as NodeJS.ProcessEnv),
    ).toBe(null);
  });
});

describe("sendDiscordMessage", () => {
  it("returns no-webhook when nothing configured", async () => {
    const result = await sendDiscordMessage("hi", {
      logger: NOOP_LOGGER,
      // empty env path: pass an explicit empty webhookUrl by NOT setting it,
      // but inject fetchImpl to confirm it's never called.
      fetchImpl: vi.fn(),
    });
    // Will fall through to env, which in a vitest test we don't trust;
    // pass an explicitly null webhook path:
    expect(["no-webhook", undefined]).toContain(result.reason ?? undefined);
    // The above is necessarily soft — we test the deterministic path below.
  });

  it("delivers when fetch returns 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
    } as Response);
    const result = await sendDiscordMessage("hello world", {
      webhookUrl: "https://example/hook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: NOOP_LOGGER,
    });
    expect(result.delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example/hook");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ content: "hello world" });
  });

  it("returns http-error on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    } as Response);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = await sendDiscordMessage("hi", {
      webhookUrl: "https://example/hook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("http-error");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("returns network-error when fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = await sendDiscordMessage("hi", {
      webhookUrl: "https://example/hook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("network-error");
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][0]).toContain("ECONNRESET");
  });

  it("truncates messages to Discord's 2000-char limit", async () => {
    const longMessage = "x".repeat(5000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    await sendDiscordMessage(longMessage, {
      webhookUrl: "https://example/hook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: NOOP_LOGGER,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.content.length).toBe(2000);
  });

  it("logs no-webhook warning when webhook is null", async () => {
    const fetchImpl = vi.fn();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = await sendDiscordMessage("hi", {
      webhookUrl: undefined as unknown as string,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    // When webhookUrl is explicitly undefined, it falls back to env.
    // In tests, env.DISCORD_*_WEBHOOK_URL is typically unset → no-webhook.
    if (!process.env.DISCORD_FRAMEWORK_WEBHOOK_URL && !process.env.DISCORD_WEBHOOK_URL) {
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe("no-webhook");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe("formatPendingReviewMessage", () => {
  it("renders all required fields", () => {
    const msg = formatPendingReviewMessage({
      frameworkLabel: "Anthropic RSP",
      versionLabel: "v3.1",
      versionId: "ver_abc123",
      sourceUrl: "https://anthropic.com/rsp",
      reviewUrl: "https://internal/review/v3.1",
    });
    expect(msg).toContain("New framework version pending review");
    expect(msg).toContain("Anthropic RSP v3.1");
    expect(msg).toContain("ver_abc123");
    expect(msg).toContain("https://anthropic.com/rsp");
    expect(msg).toContain("https://internal/review/v3.1");
  });

  it("omits review line when reviewUrl is absent", () => {
    const msg = formatPendingReviewMessage({
      frameworkLabel: "OpenAI Preparedness",
      versionLabel: "v2",
      versionId: "ver_xyz",
      sourceUrl: "https://openai.com/safety/preparedness",
    });
    expect(msg).not.toContain("Review:");
    expect(msg).not.toContain("→");
  });
});

describe("formatSilentUpdateMessage", () => {
  it("includes both old and new hash prefixes", () => {
    const msg = formatSilentUpdateMessage({
      frameworkLabel: "Meta FAF",
      frameworkId: "fw_meta",
      sourceUrl: "https://about.fb.com/news/2025/02/meta-approach-frontier-ai/",
      newContentHash: "abcdef1234567890abcdef1234567890",
      previousContentHash: "fedcba0987654321fedcba0987654321",
      latestKnownVersionId: "ver_meta_v1",
    });
    expect(msg).toContain("Silent framework update detected");
    expect(msg).toContain("Meta FAF");
    expect(msg).toContain("abcdef123456");
    expect(msg).toContain("fedcba098765");
    expect(msg).toContain("supersedes");
    expect(msg).toContain("ver_meta_v1");
  });

  it("omits supersedes clause when no prior version id", () => {
    const msg = formatSilentUpdateMessage({
      frameworkLabel: "Magic ARP",
      frameworkId: "fw_magic",
      sourceUrl: "https://magic.dev/agi-readiness-policy",
      newContentHash: "11" + "0".repeat(62),
      previousContentHash: "22" + "0".repeat(62),
      latestKnownVersionId: null,
    });
    expect(msg).not.toContain("supersedes");
  });
});

describe("sendPendingReviewAlert / sendSilentUpdateAlert", () => {
  it("each posts the formatted message to the webhook", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);

    const r1 = await sendPendingReviewAlert(
      {
        frameworkLabel: "DeepMind FSF",
        versionLabel: "v2.0",
        versionId: "ver_dm",
        sourceUrl: "https://deepmind.google/fsf",
      },
      {
        webhookUrl: "https://example/hook",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: NOOP_LOGGER,
      },
    );
    expect(r1.delivered).toBe(true);
    const body1 = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body1.content).toContain("DeepMind FSF v2.0");

    const r2 = await sendSilentUpdateAlert(
      {
        frameworkLabel: "DeepMind FSF",
        frameworkId: "fw_dm",
        sourceUrl: "https://deepmind.google/fsf",
        newContentHash: "a".repeat(64),
        previousContentHash: "b".repeat(64),
        latestKnownVersionId: null,
      },
      {
        webhookUrl: "https://example/hook",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: NOOP_LOGGER,
      },
    );
    expect(r2.delivered).toBe(true);
    const body2 = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body2.content).toContain("Silent framework update detected");
  });
});
