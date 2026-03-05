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

import { snapshotRetention } from "./snapshot-retention.js";
import type { Config } from "../config.js";

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
    },
  };
}

describe("snapshotRetention", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    process.env["WIKI_SERVER_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["WIKI_SERVER_API_KEY"];
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
          text: async () => "Internal Server Error",
        })
    );

    const result = await snapshotRetention(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("hallucination_risk: deleted 100");
    expect(result.summary).toContain("citation_accuracy: FAILED");
  });

  it("returns failure when API key is not set", async () => {
    delete process.env["WIKI_SERVER_API_KEY"];

    const result = await snapshotRetention(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("FAILED");
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
    expect(result.summary).toContain("hallucination_risk: FAILED");
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
