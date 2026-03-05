import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the wiki-server module before importing anything that uses it
vi.mock("./wiki-server.js", () => ({
  recordIncident: vi.fn(),
}));

// Mock the logger to avoid pino output in tests
vi.mock("./logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import {
  recordFailure,
  getCurrentOutage,
  clearOutage,
  addToBuffer,
  getBufferSize,
  getBufferSnapshot,
  flushBuffer,
  backfillOutageIncident,
  _resetForTesting,
  type BufferedIncident,
} from "./incident-buffer.js";
import { recordIncident } from "./wiki-server.js";
import type { Config } from "./config.js";

const mockRecordIncident = vi.mocked(recordIncident);

function makeConfig(): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test/test",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/test-run-log.json",
    circuitBreakerCooldownMs: 60_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
      githubShadowbanCheck: { enabled: false, schedule: "0 9 * * *", usernames: [] },
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 100 },
      sessionSweep: { enabled: false, schedule: "0 */4 * * *" },
    },
  };
}

describe("incident-buffer", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    _resetForTesting();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Outage tracking
  // -----------------------------------------------------------------------
  describe("outage tracking", () => {
    it("starts with no active outage", () => {
      expect(getCurrentOutage()).toBeNull();
    });

    it("creates an outage window on first failure", () => {
      recordFailure();
      const outage = getCurrentOutage();
      expect(outage).not.toBeNull();
      expect(outage!.consecutiveFailures).toBe(1);
      expect(outage!.detectedAt).toBeTruthy();
    });

    it("increments consecutive failures on subsequent failures", () => {
      recordFailure();
      recordFailure();
      recordFailure();
      const outage = getCurrentOutage();
      expect(outage!.consecutiveFailures).toBe(3);
    });

    it("preserves detectedAt across multiple failures", () => {
      recordFailure();
      const firstDetectedAt = getCurrentOutage()!.detectedAt;

      recordFailure();
      recordFailure();

      expect(getCurrentOutage()!.detectedAt).toBe(firstDetectedAt);
    });

    it("clears outage window", () => {
      recordFailure();
      expect(getCurrentOutage()).not.toBeNull();

      clearOutage();
      expect(getCurrentOutage()).toBeNull();
    });

    it("starts a new outage window after clearing", () => {
      recordFailure();
      recordFailure();
      clearOutage();

      recordFailure();
      const outage = getCurrentOutage();
      expect(outage!.consecutiveFailures).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Buffer operations
  // -----------------------------------------------------------------------
  describe("buffer operations", () => {
    const sampleIncident: BufferedIncident = {
      service: "wiki-server",
      severity: "critical",
      title: "Test incident",
      detail: "Some detail",
      checkSource: "test",
      timestamp: "2026-02-28T00:00:00.000Z",
    };

    it("starts with empty buffer", () => {
      expect(getBufferSize()).toBe(0);
      expect(getBufferSnapshot()).toEqual([]);
    });

    it("accumulates incidents during outage", () => {
      addToBuffer({ ...sampleIncident, title: "Incident 1" });
      addToBuffer({ ...sampleIncident, title: "Incident 2" });
      addToBuffer({ ...sampleIncident, title: "Incident 3" });

      expect(getBufferSize()).toBe(3);

      const snapshot = getBufferSnapshot();
      expect(snapshot).toHaveLength(3);
      expect(snapshot[0].title).toBe("Incident 1");
      expect(snapshot[2].title).toBe("Incident 3");
    });

    it("respects max buffer size (100 entries)", () => {
      // Add 110 entries
      for (let i = 0; i < 110; i++) {
        addToBuffer({
          ...sampleIncident,
          title: `Incident ${i}`,
          timestamp: `2026-02-28T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }

      expect(getBufferSize()).toBe(100);

      // Should keep the newest 100, dropping the oldest 10
      const snapshot = getBufferSnapshot();
      expect(snapshot[0].title).toBe("Incident 10");
      expect(snapshot[99].title).toBe("Incident 109");
    });

    it("returns a defensive copy from getBufferSnapshot", () => {
      addToBuffer(sampleIncident);
      const snapshot = getBufferSnapshot();
      // Mutating the snapshot should not affect the internal buffer
      (snapshot as BufferedIncident[]).push({
        ...sampleIncident,
        title: "Injected",
      });
      expect(getBufferSize()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Buffer flushing
  // -----------------------------------------------------------------------
  describe("flushBuffer", () => {
    const sampleIncident: BufferedIncident = {
      service: "wiki-server",
      severity: "critical",
      title: "Buffered failure",
      detail: "Server was down",
      checkSource: "groundskeeper",
      timestamp: "2026-02-28T12:00:00.000Z",
    };

    it("returns 0 when buffer is empty", async () => {
      const flushed = await flushBuffer(config);
      expect(flushed).toBe(0);
      expect(mockRecordIncident).not.toHaveBeenCalled();
    });

    it("flushes all buffered incidents on recovery", async () => {
      mockRecordIncident.mockResolvedValue(true);

      addToBuffer({ ...sampleIncident, title: "Incident A" });
      addToBuffer({ ...sampleIncident, title: "Incident B" });

      const flushed = await flushBuffer(config);

      expect(flushed).toBe(2);
      expect(mockRecordIncident).toHaveBeenCalledTimes(2);
      expect(getBufferSize()).toBe(0);
    });

    it("marks flushed incidents with buffered=true metadata", async () => {
      mockRecordIncident.mockResolvedValue(true);

      addToBuffer(sampleIncident);
      await flushBuffer(config);

      expect(mockRecordIncident).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          metadata: expect.objectContaining({
            buffered: true,
            originalTimestamp: sampleIncident.timestamp,
          }),
        })
      );
    });

    it("counts partial successes correctly", async () => {
      // First call succeeds, second fails
      mockRecordIncident
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      addToBuffer({ ...sampleIncident, title: "Success" });
      addToBuffer({ ...sampleIncident, title: "Failure" });

      const flushed = await flushBuffer(config);

      expect(flushed).toBe(1);
      expect(getBufferSize()).toBe(0); // Buffer is cleared regardless
    });

    it("empties the buffer even if all flushes fail", async () => {
      mockRecordIncident.mockResolvedValue(false);

      addToBuffer(sampleIncident);
      addToBuffer(sampleIncident);

      const flushed = await flushBuffer(config);

      expect(flushed).toBe(0);
      expect(getBufferSize()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Backfill on recovery
  // -----------------------------------------------------------------------
  describe("backfillOutageIncident", () => {
    it("posts a backfill incident with detectedAt and resolvedAt", async () => {
      mockRecordIncident.mockResolvedValue(true);

      const outage = {
        detectedAt: "2026-02-28T10:00:00.000Z",
        consecutiveFailures: 5,
      };

      await backfillOutageIncident(config, outage);

      expect(mockRecordIncident).toHaveBeenCalledTimes(1);
      const call = mockRecordIncident.mock.calls[0];
      expect(call[0]).toBe(config);

      const payload = call[1];
      expect(payload.service).toBe("wiki-server");
      expect(payload.severity).toBe("critical");
      expect(payload.title).toContain("backfilled");
      expect(payload.detail).toContain(outage.detectedAt);
      expect(payload.detail).toContain("5");
      expect(payload.metadata).toMatchObject({
        backfilled: true,
        detectedAt: outage.detectedAt,
        consecutiveFailures: 5,
      });
      // resolvedAt should be a recent ISO timestamp
      expect(payload.metadata!.resolvedAt).toBeTruthy();
    });

    it("handles backfill failure gracefully (no throw)", async () => {
      mockRecordIncident.mockResolvedValue(false);

      const outage = {
        detectedAt: "2026-02-28T10:00:00.000Z",
        consecutiveFailures: 3,
      };

      // Should not throw
      await expect(
        backfillOutageIncident(config, outage)
      ).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Integration: full outage-to-recovery cycle
  // -----------------------------------------------------------------------
  describe("full outage-to-recovery cycle", () => {
    it("tracks failures, buffers incidents, backfills on recovery, and flushes", async () => {
      // Phase 1: Outage starts — failures accumulate
      recordFailure();
      addToBuffer({
        service: "wiki-server",
        severity: "critical",
        title: "Check 1 failed",
        timestamp: "2026-02-28T10:00:00.000Z",
      });

      recordFailure();
      addToBuffer({
        service: "wiki-server",
        severity: "critical",
        title: "Check 2 failed",
        timestamp: "2026-02-28T10:05:00.000Z",
      });

      expect(getCurrentOutage()!.consecutiveFailures).toBe(2);
      expect(getBufferSize()).toBe(2);

      // Phase 2: Recovery — backfill + flush
      mockRecordIncident.mockResolvedValue(true);

      const outage = getCurrentOutage()!;
      await backfillOutageIncident(config, outage);
      clearOutage();

      const flushed = await flushBuffer(config);

      // 1 backfill + 2 buffered = 3 total calls
      expect(mockRecordIncident).toHaveBeenCalledTimes(3);
      expect(flushed).toBe(2);
      expect(getCurrentOutage()).toBeNull();
      expect(getBufferSize()).toBe(0);
    });
  });
});
