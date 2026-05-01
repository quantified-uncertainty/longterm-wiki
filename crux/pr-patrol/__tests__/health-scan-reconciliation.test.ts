import { describe, it, expect } from "vitest";
import { evaluateReconciliation, RECONCILIATION_STALE_THRESHOLD_HOURS } from "../health-scan.ts";

const NOW = new Date("2026-05-01T12:00:00Z");

function summary(
  startedAtIso: string,
  nonEmptyDiffsObserved: number | null,
  errorCode: string | null = null,
) {
  return {
    latestRun: { startedAt: startedAtIso, nonEmptyDiffsObserved, errorCode },
  };
}

describe("evaluateReconciliation (QUA-958 sentinel)", () => {
  it("returns unhealthy when there's no completed run", () => {
    const r = evaluateReconciliation(null, NOW);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/never run|no completed/i);
  });

  it("returns unhealthy when latestRun is null", () => {
    const r = evaluateReconciliation({ latestRun: null }, NOW);
    expect(r.healthy).toBe(false);
  });

  it("returns healthy on a fresh run with zero non-empty diffs", () => {
    const startedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
    const r = evaluateReconciliation(summary(startedAt, 0), NOW);
    expect(r.healthy).toBe(true);
    expect(r.latestNonEmptyDiffsObserved).toBe(0);
  });

  it("returns unhealthy when latest run is stale (cron stalled)", () => {
    const ageHours = RECONCILIATION_STALE_THRESHOLD_HOURS + 1;
    const startedAt = new Date(NOW.getTime() - ageHours * 60 * 60 * 1000).toISOString();
    const r = evaluateReconciliation(summary(startedAt, 0), NOW);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/stalled/i);
  });

  it("returns unhealthy when latest run has errorCode", () => {
    const startedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const r = evaluateReconciliation(summary(startedAt, 0, "scan_error"), NOW);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/errorCode/i);
  });

  it("returns unhealthy when latest run has non-empty divergence", () => {
    const startedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const r = evaluateReconciliation(summary(startedAt, 3), NOW);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/non-empty YAML stakeholders that disagree/i);
    expect(r.latestNonEmptyDiffsObserved).toBe(3);
  });

  it("treats a single divergence as unhealthy (no minimum threshold)", () => {
    // Once any divergence is detected the canary should halt — we don't
    // want to wait for "3 divergences" before reacting.
    const startedAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const r = evaluateReconciliation(summary(startedAt, 1), NOW);
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain("1 policy entity has");
  });
});
