import { describe, it, expect, vi } from "vitest";
import { checkCanaryHalt } from "../canary-halt-guard.ts";
import { RECONCILIATION_STALE_THRESHOLD_HOURS } from "../../../pr-patrol/health-scan.ts";

const NOW = new Date("2026-05-01T12:00:00Z");

function summary(
  startedAtIso: string,
  nonEmptyDiffsObserved: number | null,
  errorCode: string | null = null,
) {
  return {
    ok: true as const,
    data: {
      domain: "policy_stakeholders" as const,
      latestRun: { startedAt: startedAtIso, nonEmptyDiffsObserved, errorCode },
    },
  };
}

describe("checkCanaryHalt (QUA-958 health-gate guard)", () => {
  it("does NOT halt when latest run is fresh and clean", async () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const fetchSummary = vi.fn(async () => summary(fresh, 0));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(false);
    expect(r.lastRunAt).toEqual(new Date(fresh));
    expect(r.nonEmptyDiffs).toBe(0);
  });

  it("halts when latest run reports non-empty divergence", async () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const fetchSummary = vi.fn(async () => summary(fresh, 4));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(true);
    expect(r.nonEmptyDiffs).toBe(4);
    expect(r.reason).toMatch(/non-empty YAML stakeholders/);
  });

  it("halts when latest run is stale (cron stalled)", async () => {
    const stale = new Date(
      NOW.getTime() - (RECONCILIATION_STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    ).toISOString();
    const fetchSummary = vi.fn(async () => summary(stale, 0));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/stalled/);
  });

  it("halts when latest run finished with errorCode", async () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const fetchSummary = vi.fn(async () => summary(fresh, 0, "scan_error"));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/errorCode/);
  });

  it("halts when there's no completed run at all", async () => {
    const fetchSummary = vi.fn(async () => ({
      ok: true as const,
      data: { domain: "policy_stakeholders" as const, latestRun: null },
    }));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/never run|no completed/);
  });

  it("does NOT halt (fail-soft) when fetch returns ok:false", async () => {
    const fetchSummary = vi.fn(async () => ({
      ok: false as const,
      error: "unavailable" as const,
      message: "wiki-server timeout",
    }));
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(false);
    expect(r.reason).toMatch(/unavailable.*timeout/);
  });

  it("does NOT halt (fail-soft) when fetch throws", async () => {
    const fetchSummary = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await checkCanaryHalt({ fetchSummary, now: NOW });
    expect(r.halt).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it("does NOT halt when bypass is requested", async () => {
    // bypass means we don't even hit the fetch.
    const fetchSummary = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const r = await checkCanaryHalt({ bypass: true, fetchSummary });
    expect(r.halt).toBe(false);
    expect(r.reason).toBe("bypass requested by caller");
    expect(fetchSummary).not.toHaveBeenCalled();
  });
});
