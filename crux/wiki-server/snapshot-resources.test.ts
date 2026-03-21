import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const SNAPSHOT_PATH = join(PROJECT_ROOT, "data/resources-snapshot.json");

// The snapshot file is gitignored (generated locally or by CI artifact).
// Skip the entire suite when it's absent so CI doesn't fail spuriously.
const snapshotExists = existsSync(SNAPSHOT_PATH);

interface SnapshotResource {
  id: string;
  url: string;
  title?: string;
  type?: string;
  enrichment_status?: string;
  context_note?: string;
  resource_subtype?: string;
  resource_purpose?: string;
  summary?: string;
  importance_score?: number;
  key_points?: string[];
  tags?: string[];
  fetched_at?: string;
  cited_by?: string[];
  [key: string]: unknown;
}

function loadSnapshot(): SnapshotResource[] {
  const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
  return JSON.parse(raw) as SnapshotResource[];
}

/**
 * Returns the percentage of resources in the array that have a truthy value
 * for the given field name.
 */
function fieldCoverage(
  resources: SnapshotResource[],
  field: string
): { count: number; total: number; pct: number } {
  const total = resources.length;
  const count = resources.filter(
    (r) => r[field] !== undefined && r[field] !== null
  ).length;
  return { count, total, pct: total > 0 ? (count / total) * 100 : 0 };
}

describe.skipIf(!snapshotExists)("resources-snapshot.json", () => {
  const resources = snapshotExists ? loadSnapshot() : [];

  it("is not empty (sanity: >4000 resources)", () => {
    expect(resources.length).toBeGreaterThan(4000);
  });

  describe("required fields present on all resources", () => {
    it("every resource has id", () => {
      const missing = resources.filter((r) => !r.id);
      expect(missing.length).toBe(0);
    });

    it("every resource has url", () => {
      const missing = resources.filter((r) => !r.url);
      expect(missing.length).toBe(0);
    });

    it("every resource has title", () => {
      const missing = resources.filter((r) => !r.title);
      expect(missing.length).toBe(0);
    });

    it("every resource has type", () => {
      const missing = resources.filter((r) => !r.type);
      expect(missing.length).toBe(0);
    });
  });

  describe("enrichment field coverage meets minimum thresholds", () => {
    // Each entry: [fieldName, minimumPercentage, description]
    const fieldThresholds: [string, number, string][] = [
      ["enrichment_status", 99, "should be on 99%+ of resources"],
      ["context_note", 95, "should be on 95%+ of resources"],
      ["resource_subtype", 95, "should be on 95%+ of resources"],
      ["resource_purpose", 95, "should be on 95%+ of resources"],
      ["summary", 30, "should be on 30%+ of resources"],
      ["importance_score", 5, "should be on 5%+ of resources"],
      ["key_points", 10, "should be on 10%+ of resources"],
      ["tags", 50, "should be on 50%+ of resources"],
      ["fetched_at", 10, "should be on 10%+ of resources"],
    ];

    for (const [field, minPct, desc] of fieldThresholds) {
      it(`${field} — ${desc}`, () => {
        const { pct, count, total } = fieldCoverage(resources, field);
        expect(
          pct,
          `${field}: ${count}/${total} (${pct.toFixed(1)}%) is below minimum ${minPct}%`
        ).toBeGreaterThanOrEqual(minPct);
      });
    }
  });

  describe("data quality", () => {
    it("no HTML tags in titles", () => {
      // Matches common HTML elements that shouldn't appear in titles.
      // Uses word boundary to avoid false positives on strings like "<100ms".
      const htmlTagPattern =
        /<(?:p|div|br|span|a|em|strong|i|b|h[1-6]|ul|ol|li|table|tr|td|th|img|script|style|link|meta|html|body|head|font|center|blockquote|pre|code|sup|sub)\b/i;

      const corrupted = resources.filter(
        (r) => r.title && htmlTagPattern.test(r.title)
      );

      // Allow up to 20 existing known-bad entries (data debt), but catch
      // large regressions where the snapshot generator breaks title extraction.
      expect(
        corrupted.length,
        `Found ${corrupted.length} resources with HTML in title. ` +
          `Examples: ${corrupted
            .slice(0, 3)
            .map((r) => `${r.id}: "${(r.title ?? "").slice(0, 80)}"`)
            .join("; ")}`
      ).toBeLessThanOrEqual(20);
    });

    it(">50% of resources have cited_by arrays", () => {
      const { pct, count, total } = fieldCoverage(resources, "cited_by");
      expect(
        pct,
        `cited_by: ${count}/${total} (${pct.toFixed(1)}%) is below 50%`
      ).toBeGreaterThanOrEqual(50);
    });
  });
});
