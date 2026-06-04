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

import { activeAgentsSweep } from "./active-agents-sweep.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
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
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 100 },
      sessionSweep: { enabled: true, schedule: "0 */4 * * *" },
      activeAgentsSweep: { enabled: true, schedule: "*/30 * * * *" },
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

describe("activeAgentsSweep", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    process.env["LONGTERMWIKI_SERVER_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];
  });

  it("returns success with 'no stale' summary when swept=0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ swept: 0, agents: [] }),
      }),
    );

    const result = await activeAgentsSweep(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("No stale");
  });

  it("calls the active-agents sweep endpoint with timeoutMinutes=30", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ swept: 0, agents: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await activeAgentsSweep(config);

    const calls = fetchMock.mock.calls;
    expect(calls[0][0]).toBe("http://localhost:3000/api/active-agents/sweep");
    expect((calls[0][1] as RequestInit).method).toBe("POST");
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ timeoutMinutes: 30 });
  });

  it("includes Authorization header when API key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ swept: 0, agents: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await activeAgentsSweep(config);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("returns failure when no API key is set", async () => {
    delete process.env["LONGTERMWIKI_SERVER_API_KEY"];

    const result = await activeAgentsSweep(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("failed");
  });

  it("returns failure when the sweep endpoint returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      }),
    );

    const result = await activeAgentsSweep(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("failed");
  });

  it("returns failure when the fetch call throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const result = await activeAgentsSweep(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("failed");
  });

  it("returns success summary with the swept count when agents are present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 3,
          agents: [
            { id: 1, sessionId: "claude/qua-100" },
            { id: 2, sessionId: "claude/qua-200" },
            { id: 3, sessionId: "claude/qua-300" },
          ],
        }),
      }),
    );

    const result = await activeAgentsSweep(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Swept 3");
  });
});
