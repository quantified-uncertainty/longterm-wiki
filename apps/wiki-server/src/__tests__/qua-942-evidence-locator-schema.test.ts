/**
 * Zod-shape tests for QUA-942 EvidenceLocatorSchema.
 *
 * The schema is the source of truth for what shapes can be persisted in
 * source_check_evidence.evidence_locator. The DB column is JSONB (no shape
 * enforcement) precisely because we want to add new locator kinds without
 * a migration — but that means the Zod gate has to be tight.
 */

import { describe, it, expect } from "vitest";
import { EvidenceLocatorSchema } from "../routes/sourcing/sourcing.js";

describe("EvidenceLocatorSchema (QUA-942)", () => {
  describe("pdf-page locator", () => {
    it("accepts a basic 1-based page number", () => {
      const parsed = EvidenceLocatorSchema.parse({ kind: "pdf-page", page: 14 });
      expect(parsed).toEqual({ kind: "pdf-page", page: 14 });
    });

    it("accepts page + table reference", () => {
      const parsed = EvidenceLocatorSchema.parse({
        kind: "pdf-page",
        page: 14,
        table: "2.3",
      });
      expect(parsed.kind).toBe("pdf-page");
      if (parsed.kind === "pdf-page") {
        expect(parsed.table).toBe("2.3");
      }
    });

    it("accepts page + table + row", () => {
      const parsed = EvidenceLocatorSchema.parse({
        kind: "pdf-page",
        page: 14,
        table: "2.3",
        row: 12,
      });
      expect(parsed.kind).toBe("pdf-page");
    });

    it("rejects page=0 (must be 1-based)", () => {
      expect(() => EvidenceLocatorSchema.parse({ kind: "pdf-page", page: 0 })).toThrow();
    });

    it("rejects negative pages", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "pdf-page", page: -3 }),
      ).toThrow();
    });

    it("rejects non-integer pages", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "pdf-page", page: 1.5 }),
      ).toThrow();
    });

    it("rejects absurdly large pages (likely typo / overflow guard)", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "pdf-page", page: 200_000 }),
      ).toThrow();
    });

    it("rejects missing page", () => {
      expect(() => EvidenceLocatorSchema.parse({ kind: "pdf-page" })).toThrow();
    });
  });

  describe("csv-cell locator", () => {
    it("accepts row + column", () => {
      const parsed = EvidenceLocatorSchema.parse({
        kind: "csv-cell",
        row: 23,
        column: "risk-assessment",
      });
      expect(parsed).toEqual({ kind: "csv-cell", row: 23, column: "risk-assessment" });
    });

    it("rejects empty column name", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "csv-cell", row: 1, column: "" }),
      ).toThrow();
    });

    it("rejects row=0", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "csv-cell", row: 0, column: "x" }),
      ).toThrow();
    });
  });

  describe("html-anchor locator", () => {
    it("accepts a CSS selector", () => {
      const parsed = EvidenceLocatorSchema.parse({
        kind: "html-anchor",
        selector: "#table-2",
      });
      expect(parsed).toEqual({ kind: "html-anchor", selector: "#table-2" });
    });

    it("rejects empty selector", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "html-anchor", selector: "" }),
      ).toThrow();
    });
  });

  describe("discrimination", () => {
    it("rejects unknown kinds (forces a schema update for new locators)", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "transcript-time", seconds: 30 }),
      ).toThrow();
    });

    it("rejects missing kind", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({ page: 14 } as unknown as { kind: string }),
      ).toThrow();
    });

    it("rejects pdf-page fields under csv-cell kind (cross-kind contamination)", () => {
      // A common mistake when copy-pasting between locator kinds. The
      // discriminated union should reject this even though the field names
      // are recognized in pdf-page — csv-cell requires its own row+column.
      expect(() =>
        EvidenceLocatorSchema.parse({ kind: "csv-cell", page: 14 }),
      ).toThrow();
    });

    it("strips extra keys from valid locators (Zod default)", () => {
      // The DB column is JSONB so the ONLY thing protecting downstream
      // consumers from arbitrary extra-key pollution is Zod's default-strip
      // behavior. If a future config switches schemas to .passthrough(),
      // this test breaks loudly so we notice.
      const parsed = EvidenceLocatorSchema.parse({
        kind: "pdf-page",
        page: 14,
        injectedKey: "should not survive",
        anotherInjection: { nested: true },
      });
      expect(parsed).toEqual({ kind: "pdf-page", page: 14 });
      expect((parsed as Record<string, unknown>).injectedKey).toBeUndefined();
      expect((parsed as Record<string, unknown>).anotherInjection).toBeUndefined();
    });
  });

  describe("field length caps", () => {
    it("rejects pdf-page table > 50 chars", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({
          kind: "pdf-page",
          page: 1,
          table: "x".repeat(51),
        }),
      ).toThrow();
    });
    it("accepts pdf-page row as string or number", () => {
      const a = EvidenceLocatorSchema.parse({
        kind: "pdf-page",
        page: 1,
        row: "header-row",
      });
      const b = EvidenceLocatorSchema.parse({
        kind: "pdf-page",
        page: 1,
        row: 12,
      });
      expect(a.kind).toBe("pdf-page");
      expect(b.kind).toBe("pdf-page");
    });
    it("rejects csv-cell column > 200 chars", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({
          kind: "csv-cell",
          row: 1,
          column: "x".repeat(201),
        }),
      ).toThrow();
    });
    it("rejects html-anchor selector > 500 chars", () => {
      expect(() =>
        EvidenceLocatorSchema.parse({
          kind: "html-anchor",
          selector: "#" + "x".repeat(500),
        }),
      ).toThrow();
    });
  });
});
