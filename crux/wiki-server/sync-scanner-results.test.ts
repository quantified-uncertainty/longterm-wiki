import { describe, it, expect } from "vitest";
import { transformScanToItems } from "./sync-scanner-results.ts";
import type { ScanSummary } from "../tablebase/types.ts";

describe("transformScanToItems", () => {
  const sampleScan: ScanSummary = {
    timestamp: "2026-04-10T12:00:00.000Z",
    tables: [
      {
        table: "personnel",
        totalEntities: 2,
        entitiesWithRecords: 1,
        totalRecords: 15,
        avgCompleteness: 50,
        profiles: [
          {
            entityId: "sid_abc1234567",
            entityName: "Anthropic",
            entityType: "organization",
            table: "personnel",
            totalRecords: 15,
            completenessPercent: 75,
            missingFields: ["deeper coverage needed"],
            website: "https://anthropic.com",
            entityImportance: 85.5,
          },
          {
            entityId: "sid_def7654321",
            entityName: "OpenAI",
            entityType: "organization",
            table: "personnel",
            totalRecords: 0,
            completenessPercent: 0,
            missingFields: ["no personnel records"],
            entityImportance: 90,
          },
        ],
      },
      {
        table: "grants",
        totalEntities: 1,
        entitiesWithRecords: 1,
        totalRecords: 10,
        avgCompleteness: 80,
        profiles: [
          {
            entityId: "sid_ghi9999999",
            entityName: "Open Philanthropy",
            entityType: "organization",
            table: "grants",
            totalRecords: 10,
            completenessPercent: 80,
            missingFields: ["2 grants missing granteeId"],
          },
        ],
      },
    ],
  };

  it("produces one row per profile across all tables", () => {
    const items = transformScanToItems(sampleScan, "test-run-uuid");
    expect(items).toHaveLength(3);
  });

  it("assigns the scanRunId to all rows", () => {
    const items = transformScanToItems(sampleScan, "run-123");
    for (const item of items) {
      expect(item.scanRunId).toBe("run-123");
    }
  });

  it("maps TableProfile fields correctly", () => {
    const items = transformScanToItems(sampleScan, "run-abc");
    const anthropic = items.find((i) => i.entityId === "sid_abc1234567");
    expect(anthropic).toBeDefined();
    expect(anthropic!.recordType).toBe("personnel");
    expect(anthropic!.entityName).toBe("Anthropic");
    expect(anthropic!.entityType).toBe("organization");
    expect(anthropic!.totalRecords).toBe(15);
    expect(anthropic!.completenessPct).toBe(75);
    expect(anthropic!.missingFields).toEqual(["deeper coverage needed"]);
    expect(anthropic!.entityImportance).toBe(85.5);
    expect(anthropic!.scannedAt).toBe("2026-04-10T12:00:00.000Z");
  });

  it("computes verifiedRecords from totalRecords and completeness", () => {
    const items = transformScanToItems(sampleScan, "run-abc");
    const anthropic = items.find((i) => i.entityId === "sid_abc1234567");
    // 15 * 75 / 100 = 11.25, rounded to 11
    expect(anthropic!.verifiedRecords).toBe(11);

    const openai = items.find((i) => i.entityId === "sid_def7654321");
    // 0 * 0 / 100 = 0
    expect(openai!.verifiedRecords).toBe(0);

    const openPhil = items.find((i) => i.entityId === "sid_ghi9999999");
    // 10 * 80 / 100 = 8
    expect(openPhil!.verifiedRecords).toBe(8);
  });

  it("handles null entityImportance", () => {
    const items = transformScanToItems(sampleScan, "run-abc");
    const openPhil = items.find((i) => i.entityId === "sid_ghi9999999");
    expect(openPhil!.entityImportance).toBeNull();
  });

  it("returns empty array for scan with no profiles", () => {
    const emptyScan: ScanSummary = {
      timestamp: "2026-04-10T00:00:00Z",
      tables: [
        {
          table: "investments",
          totalEntities: 0,
          entitiesWithRecords: 0,
          totalRecords: 0,
          avgCompleteness: 0,
          profiles: [],
        },
      ],
    };
    const items = transformScanToItems(emptyScan, "empty-run");
    expect(items).toHaveLength(0);
  });
});
