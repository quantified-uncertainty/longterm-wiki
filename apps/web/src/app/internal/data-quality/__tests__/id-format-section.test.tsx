/**
 * Unit tests for the IdFormatSection dashboard component helpers.
 *
 * Covered cases (QUA-439 Phase 1 plan):
 *   1. empty       — no snapshots carry idFormatAudit → null parse
 *   2. sparse      — <7 snapshots → sparkline gated off
 *   3. full        — ≥7 snapshots with valid audits parse + render
 *   4. regression-yellow — legacy delta +1 in [1, 10) → yellow
 *   5. regression-red    — legacy delta ≥10 or ≥+25% → red
 *   6. render-error fallback — malformed audit payload → parseAudit returns null
 */

import { describe, it, expect } from "vitest";
import type { IdFormatAudit } from "@wiki-server/api-types";
import {
  parseAudit,
  computeAlerts,
  IdFormatSection,
} from "@/app/internal/data-quality/id-format-section";

function emptyBuckets() {
  return {
    canonical_f: 0,
    canonical_sid: 0,
    legacy_hex8: 0,
    legacy_alnum10: 0,
    legacy_hex16: 0,
    other: 0,
  };
}

function makeAudit(overrides: Partial<IdFormatAudit["totals"]> = {}): IdFormatAudit {
  const totals = { ...emptyBuckets(), ...overrides };
  return {
    scannedAt: "2026-04-13T06:00:00.000Z",
    totals,
    bySourceTable: {
      facts: { ...totals },
      resources: { ...emptyBuckets() },
    },
  };
}

function snap(audit: IdFormatAudit | null, at = "2026-04-13T06:00:00Z") {
  return {
    id: 1,
    capturedAt: at,
    verdictsTotal: 0,
    verdictsConfirmed: 0,
    verdictsContradicted: 0,
    verdictsPartial: 0,
    verdictsUnverifiable: 0,
    verdictsOutdated: 0,
    verdictsNeedsRecheck: 0,
    personnelTotal: 0,
    personnelWithSource: 0,
    personnelWithStartDate: 0,
    grantsTotal: 0,
    grantsWithSource: 0,
    investmentsTotal: 0,
    investmentsWithSource: 0,
    fundingRoundsTotal: 0,
    entitiesTotal: 0,
    entitiesWithWikiPage: 0,
    factbaseEntities: 0,
    factbaseFacts: 0,
    pagesTotal: 0,
    extra: audit ? { idFormatAudit: audit } : {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("parseAudit", () => {
  it("empty: returns null when extra has no idFormatAudit", () => {
    expect(parseAudit(snap(null))).toBeNull();
  });

  it("full: parses a valid audit payload", () => {
    const audit = makeAudit({ canonical_f: 100, legacy_hex8: 5 });
    const parsed = parseAudit(snap(audit));
    expect(parsed).not.toBeNull();
    expect(parsed?.totals.canonical_f).toBe(100);
    expect(parsed?.totals.legacy_hex8).toBe(5);
  });

  it("render-error fallback: malformed payload parses to null", () => {
    const broken = {
      extra: { idFormatAudit: { totals: "nope" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(parseAudit(broken)).toBeNull();
  });
});

describe("computeAlerts", () => {
  it("empty: no previous snapshot yields no alerts", () => {
    const latest = makeAudit({ legacy_hex8: 10 });
    expect(computeAlerts(latest, null)).toEqual([]);
  });

  it("ignores canonical growth (good news is not an alert)", () => {
    const prev = makeAudit({ canonical_f: 100 });
    const latest = makeAudit({ canonical_f: 1000 });
    expect(computeAlerts(latest, prev)).toEqual([]);
  });

  it("regression-yellow: legacy +1 with low pct is yellow on the facts row", () => {
    const prev = makeAudit({ legacy_hex8: 100 });
    const latest = makeAudit({ legacy_hex8: 101 });
    const alerts = computeAlerts(latest, prev);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("yellow");
    expect(alerts[0].delta).toBe(1);
    expect(alerts[0].sourceTable).toBe("facts");
  });

  it("regression-red: legacy delta ≥10 is red", () => {
    const prev = makeAudit({ legacy_hex8: 100 });
    const latest = makeAudit({ legacy_hex8: 115 });
    const alerts = computeAlerts(latest, prev);
    expect(alerts[0].severity).toBe("red");
    expect(alerts[0].delta).toBe(15);
    expect(alerts[0].sourceTable).toBe("facts");
  });

  it("regression-red: legacy delta ≥25% is red even when delta <10", () => {
    const prev = makeAudit({ legacy_alnum10: 20 });
    const latest = makeAudit({ legacy_alnum10: 26 });
    const alerts = computeAlerts(latest, prev);
    expect(alerts[0].severity).toBe("red");
    expect(alerts[0].deltaPct).toBeCloseTo(30);
  });

  it("resources-scoped alert: regression in resources does NOT render on facts row", () => {
    const prev: IdFormatAudit = {
      scannedAt: "2026-04-12T06:00:00Z",
      totals: { ...emptyBuckets(), legacy_alnum10: 100 },
      bySourceTable: {
        facts: emptyBuckets(),
        resources: { ...emptyBuckets(), legacy_alnum10: 100 },
      },
    };
    const latest: IdFormatAudit = {
      scannedAt: "2026-04-13T06:00:00Z",
      totals: { ...emptyBuckets(), legacy_alnum10: 120 },
      bySourceTable: {
        facts: emptyBuckets(),
        resources: { ...emptyBuckets(), legacy_alnum10: 120 },
      },
    };
    const alerts = computeAlerts(latest, prev);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sourceTable).toBe("resources");
    expect(alerts[0].bucket).toBe("legacy_alnum10");
  });
});

describe("IdFormatSection rendering", () => {
  it("empty: renders fallback message when no audits", () => {
    const el = IdFormatSection({ snapshots: [] });
    expect(el).toBeTruthy();
  });

  it("sparse (<7): does not throw", () => {
    const snapshots = [
      snap(makeAudit({ canonical_f: 10 })),
      snap(makeAudit({ canonical_f: 9 })),
    ];
    expect(() => IdFormatSection({ snapshots })).not.toThrow();
  });

  it("full (≥7): does not throw with history", () => {
    const snapshots = Array.from({ length: 8 }, (_, i) =>
      snap(makeAudit({ legacy_hex8: i })),
    );
    expect(() => IdFormatSection({ snapshots })).not.toThrow();
  });
});
