import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../config.js";
import { tablebaseScan } from "./tablebase-scan.js";

// Minimal config for testing
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test/repo",
    wikiServerUrl: "http://localhost:9999",
    discordWebhookUrl: "http://localhost:9999/discord",
    dailyRunCap: 20,
    runLogPath: "/tmp/test-run-log.json",
    circuitBreakerCooldownMs: 1800000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/15 * * * *" },
      githubShadowbanCheck: {
        enabled: true,
        schedule: "0 9 * * *",
        usernames: [],
      },
      snapshotRetention: {
        enabled: true,
        schedule: "0 3 * * *",
        keep: 100,
      },
      sessionSweep: { enabled: true, schedule: "0 */4 * * *" },
      activeAgentsSweep: { enabled: false, schedule: "*/30 * * * *" },
      dataQualitySnapshot: { enabled: true, schedule: "0 6 * * *" },
      jobWorkerHealth: { enabled: true, schedule: "*/5 * * * *" },
      autoUpdateEnqueue: {
        enabled: true,
        schedule: "0 6 * * *",
        budget: 30,
        maxPages: 5,
      },
      backfillSourcesEnqueue: { enabled: false, schedule: "0 2 * * *", limit: 100, maxCost: 5 },
      jobFailureTriage: { enabled: true, schedule: "0 */6 * * *" },
      tablebaseScan: { enabled: true, schedule: "0 5 * * *" },
      e2ePostDeployWatcher: { enabled: false, schedule: "15 * * * *" },
      thingsSearchRefresh: { enabled: false, schedule: "25 * * * *" },
    },
    ...overrides,
  };
}

describe("tablebaseScan task", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-api-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns success when wiki-server responds with valid scan data", async () => {
    const mockResponse = {
      scanRunId: "test-uuid-1234",
      inserted: 42,
      tables: 6,
      recordTypes: ["grants", "personnel", "funding_rounds", "investments", "benchmark_results", "source_quality"],
      avgCompleteness: 45.2,
      scannedAt: "2026-04-11T05:00:00.000Z",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("42 rows");
    expect(result.summary).toContain("6 tables");
    expect(result.summary).toContain("avg 45.2%");
  });

  it("returns failure on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(false);
    expect(result.summary).toContain("HTTP 500");
  });

  it("returns failure on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Connection refused");
  });

  it("skips gracefully when API key is missing (non-prod)", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    delete process.env["PROD_LONGTERMWIKI_SERVER_API_KEY"];

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Skipped");
  });

  it("fails when API key is missing in prod mode", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
    delete process.env["PROD_LONGTERMWIKI_SERVER_API_KEY"];
    process.env["WIKI_SERVER_ENV"] = "prod";

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Missing");
  });

  it("returns failure on invalid response schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await tablebaseScan(makeConfig());

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Invalid scan response schema");
  });
});
