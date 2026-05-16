import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../notify.js", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  snapshotRetention,
  __resetMissingKeyRateLimitForTest,
} from "./snapshot-retention.js";
import { sendDiscordNotification } from "../notify.js";
import type { Config } from "../config.js";

const sendDiscordNotificationMock = vi.mocked(sendDiscordNotification);

function makeConfig(keep = 100): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test-owner/test-repo",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/test-run-log.json",
    circuitBreakerCooldownMs: 1_800_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
      githubShadowbanCheck: { enabled: false, schedule: "0 9 * * *", usernames: [] },
      snapshotRetention: { enabled: true, schedule: "0 3 * * *", keep },
      sessionSweep: { enabled: false, schedule: "0 */4 * * *" },
      activeAgentsSweep: { enabled: false, schedule: "*/30 * * * *" },
      dataQualitySnapshot: { enabled: false, schedule: "0 6 * * *" },
      jobWorkerHealth: { enabled: false, schedule: "*/5 * * * *" },
      autoUpdateEnqueue: { enabled: false, schedule: "0 6 * * *", budget: 30, maxPages: 5 },
      backfillSourcesEnqueue: { enabled: false, schedule: "0 2 * * *", limit: 100, maxCost: 5 },
      jobFailureTriage: { enabled: false, schedule: "0 */6 * * *" },
      tablebaseScan: { enabled: false, schedule: "0 5 * * *" },
      e2ePostDeployWatcher: { enabled: false, schedule: "15 * * * *" },
      thingsSearchRefresh: { enabled: false, schedule: "25 * * * *" },
    },
  };
}

describe("snapshotRetention", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
    sendDiscordNotificationMock.mockClear();
    __resetMissingKeyRateLimitForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
  });

  it("returns success when both cleanups succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ deleted: 500, keep: 100 }),
      })
    );

    const result = await snapshotRetention(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("hallucination_risk: deleted 500");
    expect(result.summary).toContain("citation_accuracy: deleted 500");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("calls correct endpoints with keep parameter", async () => {
    config = makeConfig(50);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ deleted: 0, keep: 50 }),
      })
    );

    await snapshotRetention(config);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("http://localhost:3000/api/hallucination-risk/cleanup?keep=50");
    expect(calls[1][0]).toBe("http://localhost:3000/api/citations/accuracy-snapshots/cleanup?keep=50");
  });

  it("returns failure when one cleanup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ deleted: 100, keep: 100 }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })
    );

    const result = await snapshotRetention(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("hallucination_risk: deleted 100");
    expect(result.summary).toContain("citation_accuracy: FAILED (HTTP 500)");
  });

  it("returns failure and emits Discord warning when no API key is set", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    // Make sure we don't actually hit fetch
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await snapshotRetention(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Skipped");
    expect(result.summary).toContain("LONGTERMWIKI_SERVER_API_KEY");
    // No cleanup endpoints should be called when the key is missing.
    expect(fetchMock).not.toHaveBeenCalled();
    // Discord warning should fire on first missing-key run.
    expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(1);
    const message = sendDiscordNotificationMock.mock.calls[0]?.[1] as string;
    expect(message).toContain("snapshot retention disabled");
    expect(message).toContain("LONGTERMWIKI_SERVER_API_KEY");
  });

  it("rate-limits the missing-API-key Discord warning to once per day", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // First call fires a Discord warning.
    const r1 = await snapshotRetention(config);
    expect(r1.success).toBe(false);
    expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(1);

    // Second call within the same process/day must NOT fire a second warning.
    const r2 = await snapshotRetention(config);
    expect(r2.success).toBe(false);
    expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires the missing-API-key Discord warning after 24h elapses", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-04-12T00:00:00Z").getTime();
      vi.setSystemTime(t0);

      // First call at t=0 fires.
      await snapshotRetention(config);
      expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(1);

      // Just under 24h later — still suppressed.
      vi.setSystemTime(t0 + 24 * 60 * 60 * 1000 - 1000);
      await snapshotRetention(config);
      expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(1);

      // Just over 24h later — fires again.
      vi.setSystemTime(t0 + 24 * 60 * 60 * 1000 + 1000);
      await snapshotRetention(config);
      expect(sendDiscordNotificationMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still runs second cleanup when first throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ deleted: 10, keep: 100 }),
        })
    );

    const result = await snapshotRetention(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("hallucination_risk: FAILED (Connection refused)");
    expect(result.summary).toContain("citation_accuracy: deleted 10");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses DELETE method for cleanup requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ deleted: 0, keep: 100 }),
      })
    );

    await snapshotRetention(config);

    const calls = vi.mocked(fetch).mock.calls;
    for (const call of calls) {
      expect((call[1] as RequestInit).method).toBe("DELETE");
    }
  });
});
