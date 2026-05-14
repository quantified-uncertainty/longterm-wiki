import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger before importing the task
vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { thingsSearchRefresh } from "./things-search-refresh.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test/test",
    wikiServerUrl: "http://wiki-server.test",
    discordWebhookUrl: "https://discord.test/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/run-log.json",
    circuitBreakerCooldownMs: 1_800_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/15 * * * *" },
      githubShadowbanCheck: { enabled: false, schedule: "0 9 * * *", usernames: [] },
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 30 },
      sessionSweep: { enabled: false, schedule: "0 */4 * * *" },
      activeAgentsSweep: { enabled: false, schedule: "*/30 * * * *" },
      dataQualitySnapshot: { enabled: false, schedule: "0 6 * * *" },
      jobWorkerHealth: { enabled: false, schedule: "*/5 * * * *" },
      autoUpdateEnqueue: { enabled: false, schedule: "0 6 * * *", budget: 30, maxPages: 5 },
      backfillSourcesEnqueue: { enabled: false, schedule: "0 2 * * *", limit: 100, maxCost: 5 },
      jobFailureTriage: { enabled: false, schedule: "0 */6 * * *" },
      tablebaseScan: { enabled: false, schedule: "0 5 * * *" },
      e2ePostDeployWatcher: { enabled: false, schedule: "15 * * * *" },
      thingsSearchRefresh: { enabled: true, schedule: "25 * * * *" },
    },
  };
}

describe("thingsSearchRefresh", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["WIKI_SERVER_ENV"];
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    delete process.env["PROD_LONGTERMWIKI_SERVER_API_KEY"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("returns success when the wiki-server refresh endpoint returns 200", async () => {
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        durationMs: 1234,
        rowCount: 48000,
        totalBytes: 40 * 1024 * 1024,
      }),
    });

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(true);
    expect(result.summary).toContain("1234ms");
    expect(result.summary).toContain("48000");
  });

  it("returns failure when the refresh endpoint returns non-2xx", async () => {
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(false);
    expect(result.summary).toContain("503");
  });

  it("returns failure when refresh endpoint reports success=false in body", async () => {
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        durationMs: 500,
        error: "not populated",
      }),
    });

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(false);
    expect(result.summary).toContain("not populated");
  });

  it("returns failure on network error", async () => {
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(false);
    expect(result.summary).toContain("ECONNREFUSED");
  });

  it("returns success=false with clear error in prod when API key is missing", async () => {
    process.env["WIKI_SERVER_ENV"] = "prod";
    // Ensure no api key set
    delete process.env["PROD_LONGTERMWIKI_SERVER_API_KEY"];

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Missing");
    expect(result.summary).toContain("PROD_LONGTERMWIKI_SERVER_API_KEY");
  });

  it("returns skipped (success=true) in non-prod when API key is missing", async () => {
    delete process.env["WIKI_SERVER_ENV"];
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];

    const result = await thingsSearchRefresh(makeConfig());
    expect(result.success).toBe(true);
    expect(result.summary).toContain("Skipped");
  });

  it("uses PROD_ env var prefix when WIKI_SERVER_ENV=prod", async () => {
    process.env["WIKI_SERVER_ENV"] = "prod";
    process.env["PROD_LONGTERMWIKI_SERVER_API_KEY"] = "prod-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, durationMs: 5000, rowCount: 50000, totalBytes: 0 }),
    });
    globalThis.fetch = fetchMock;

    await thingsSearchRefresh(makeConfig());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://wiki-server.test/api/things-search/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer prod-key",
        }),
      }),
    );
  });
});
