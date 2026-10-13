import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { jobWorkerHealth } from "./job-worker-health.js";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../wiki-server.js", () => ({ apiRequest }));
vi.mock("../logger.js", () => ({ logger: { child: () => ({ warn: vi.fn() }) } }));

describe("job-worker-health recent failure monitoring", () => {
  let config: Config;
  beforeEach(() => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_REPO", "WIKI_SERVER_URL", "DISCORD_WEBHOOK_URL"]) {
      vi.stubEnv(name, "test-fixture");
    }
    config = loadConfig();
    apiRequest.mockReset();
    apiRequest.mockResolvedValueOnce({ ok: true, data: { agents: [
      { sessionId: "worker-fixture", status: "active", heartbeatAt: new Date().toISOString() },
    ] } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function stats(byStatus: Record<string, number>, recentFinishedJobs: number, recentFailedJobs: number) {
    apiRequest.mockResolvedValueOnce({ ok: true, data: {
      totalJobs: 1, byType: { "auto-update": { byStatus, recentFinishedJobs, recentFailedJobs } },
    } });
  }

  it("ignores historical failures and requests the supported 24-hour window", async () => {
    stats({ failed: 172, pending: 17 }, 0, 0);
    expect(await jobWorkerHealth(config)).toEqual({ success: true, summary: "Job worker healthy" });
    expect(apiRequest.mock.calls[1][2]).toBe("/api/jobs/stats?hours=24");
  });

  it("warns for a genuine recent failure rate above the threshold", async () => {
    stats({ failed: 173, completed: 12 }, 10, 4);
    const result = await jobWorkerHealth(config);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("40% failure rate (4/10)");
  });

  it("requires a recent sample of at least ten finished jobs", async () => {
    stats({ failed: 173 }, 1, 1);
    expect((await jobWorkerHealth(config)).success).toBe(true);
  });

  it("still detects an old pending backlog instead of excluding it by age", async () => {
    stats({ pending: 51 }, 0, 0);
    const result = await jobWorkerHealth(config);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("51 pending jobs");
  });

  it("does not substitute lifetime failures while an older API is rolling out", async () => {
    apiRequest.mockResolvedValueOnce({ ok: true, data: {
      totalJobs: 1, byType: { "auto-update": { byStatus: { failed: 172 } } },
    } });
    expect((await jobWorkerHealth(config)).success).toBe(true);
  });
});
