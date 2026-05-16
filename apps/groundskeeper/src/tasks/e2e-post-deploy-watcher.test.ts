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

const listWorkflowRunsMock = vi.fn();
vi.mock("../github.js", () => ({
  getOctokit: () => ({
    rest: { actions: { listWorkflowRuns: listWorkflowRunsMock } },
  }),
  parseRepo: () => ({ owner: "o", repo: "r" }),
}));

import {
  e2ePostDeployWatcher,
  evaluateWatcher,
  __resetAlertRateLimitForTest,
} from "./e2e-post-deploy-watcher.js";
import { sendDiscordNotification } from "../notify.js";
import type { Config } from "../config.js";

const sendDiscordMock = vi.mocked(sendDiscordNotification);

function makeConfig(): Config {
  return {
    githubAppId: "x",
    githubInstallationId: "x",
    githubAppPrivateKey: "x",
    githubRepo: "o/r",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/run-log.json",
    circuitBreakerCooldownMs: 1_800_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
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
      e2ePostDeployWatcher: { enabled: true, schedule: "15 * * * *" },
      thingsSearchRefresh: { enabled: false, schedule: "25 * * * *" },
    },
  };
}

function makeRun(conclusion: string | null, ageMs: number, n = 0) {
  return {
    conclusion,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    htmlUrl: `https://gh.test/run/${n}`,
  };
}

describe("evaluateWatcher", () => {
  it("only counts failures inside the window", () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const runs = [
      makeRun("failure", 60_000, 1),
      makeRun("failure", 23 * 60 * 60 * 1000, 2),
      makeRun("failure", 48 * 60 * 60 * 1000, 3), // outside
      makeRun("success", 120_000, 4),
    ];
    const r = evaluateWatcher(runs, cutoff, 3);
    expect(r.failures.length).toBe(2);
    expect(r.considered).toBe(3);
    expect(r.shouldAlert).toBe(false);
  });

  it("alerts at threshold", () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const runs = [
      makeRun("failure", 1_000, 1),
      makeRun("failure", 2_000, 2),
      makeRun("failure", 3_000, 3),
      makeRun("success", 4_000, 4),
    ];
    const r = evaluateWatcher(runs, cutoff, 3);
    expect(r.shouldAlert).toBe(true);
  });

  it("does not count cancelled/timed_out as failures", () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const runs = [
      makeRun("cancelled", 1_000, 1),
      makeRun("timed_out", 2_000, 2),
      makeRun("failure", 3_000, 3),
    ];
    const r = evaluateWatcher(runs, cutoff, 3);
    expect(r.failures.length).toBe(1);
    expect(r.shouldAlert).toBe(false);
  });
});

describe("e2ePostDeployWatcher", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    sendDiscordMock.mockClear();
    listWorkflowRunsMock.mockReset();
    __resetAlertRateLimitForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds silently when below threshold", async () => {
    listWorkflowRunsMock.mockResolvedValue({
      data: {
        workflow_runs: [
          { conclusion: "success", created_at: new Date().toISOString(), html_url: "x" },
          { conclusion: "failure", created_at: new Date().toISOString(), html_url: "x" },
        ],
      },
    });
    const r = await e2ePostDeployWatcher(config);
    expect(r.success).toBe(true);
    expect(sendDiscordMock).not.toHaveBeenCalled();
  });

  it("alerts when 3+ failures in last 24h", async () => {
    const now = Date.now();
    listWorkflowRunsMock.mockResolvedValue({
      data: {
        workflow_runs: [
          { conclusion: "failure", created_at: new Date(now - 1000).toISOString(), html_url: "https://gh.test/run/1" },
          { conclusion: "failure", created_at: new Date(now - 2000).toISOString(), html_url: "https://gh.test/run/2" },
          { conclusion: "failure", created_at: new Date(now - 3000).toISOString(), html_url: "https://gh.test/run/3" },
        ],
      },
    });
    const r = await e2ePostDeployWatcher(config);
    expect(r.success).toBe(true);
    expect(r.summary).toContain("alert fired");
    expect(sendDiscordMock).toHaveBeenCalledTimes(1);
    const msg = sendDiscordMock.mock.calls[0]?.[1] as string;
    expect(msg).toContain("red streak");
    expect(msg).toContain("https://gh.test/run/1");
  });

  it("rate-limits alerts to once per 6h", async () => {
    const runs = [
      { conclusion: "failure", created_at: new Date().toISOString(), html_url: "a" },
      { conclusion: "failure", created_at: new Date().toISOString(), html_url: "b" },
      { conclusion: "failure", created_at: new Date().toISOString(), html_url: "c" },
    ];
    listWorkflowRunsMock.mockResolvedValue({ data: { workflow_runs: runs } });

    await e2ePostDeployWatcher(config);
    await e2ePostDeployWatcher(config);
    expect(sendDiscordMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires after 6h", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-14T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    listWorkflowRunsMock.mockImplementation(async () => ({
      data: {
        workflow_runs: [
          { conclusion: "failure", created_at: new Date(Date.now() - 1000).toISOString(), html_url: "a" },
          { conclusion: "failure", created_at: new Date(Date.now() - 2000).toISOString(), html_url: "b" },
          { conclusion: "failure", created_at: new Date(Date.now() - 3000).toISOString(), html_url: "c" },
        ],
      },
    }));

    await e2ePostDeployWatcher(config);
    expect(sendDiscordMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(t0 + 6 * 60 * 60 * 1000 - 1000);
    await e2ePostDeployWatcher(config);
    expect(sendDiscordMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(t0 + 6 * 60 * 60 * 1000 + 1000);
    await e2ePostDeployWatcher(config);
    expect(sendDiscordMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed on API error without alerting", async () => {
    listWorkflowRunsMock.mockRejectedValue(new Error("boom"));
    const r = await e2ePostDeployWatcher(config);
    expect(r.success).toBe(false);
    expect(r.summary).toContain("Failed to fetch runs");
    expect(sendDiscordMock).not.toHaveBeenCalled();
  });
});
