/**
 * Tests for heuristic FactBase entity-reference detection.
 *
 * The ref-detection module decides whether a raw string value (from a FactBase
 * record field without schema info) should be rendered as an entity link or
 * as plain text. Getting this wrong either:
 *   - Shows raw `sid_` IDs to users (bad: leaks internal IDs)
 *   - Turns prose like "Board Member" into broken entity links (bad: broken UI)
 *
 * These tests cover both exported functions:
 *   shouldResolveAsRef  — boolean decision for FBCellValue
 *   tryResolveEntityRef — entity lookup for record detail pages
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@longterm-wiki/id-utils", () => ({
  isSid: vi.fn((s: string) =>
    typeof s === "string" && s.startsWith("sid_"),
  ),
}));

import { isSid } from "@longterm-wiki/id-utils";
import { shouldResolveAsRef, tryResolveEntityRef, type EntityResolver } from "../ref-detection";

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * Mock entity store: maps IDs/slugs to entity-like objects.
 * Only these values will "resolve" as known entities.
 */
const KNOWN_ENTITIES: Record<string, { id: string; name: string }> = {
  sid_ENI8sgChDQ: { id: "sid_ENI8sgChDQ", name: "Anthropic" },
  sid_tKMznr07QA: { id: "sid_tKMznr07QA", name: "OpenAI" },
  mK9pX3rQ7n: { id: "mK9pX3rQ7n", name: "DeepMind" },
  anthropic: { id: "sid_ENI8sgChDQ", name: "Anthropic" },
  amazon: { id: "sid_amazon123", name: "Amazon" },
  "employee-equity-pool": { id: "sid_eep1234567", name: "Employee Equity Pool" },
  "series-g-institutional": { id: "sid_sgi1234567", name: "Series G Institutional" },
  active: { id: "sid_active1234", name: "Active Status" },
};

const mockGetEntity: EntityResolver = (idOrSlug: string) =>
  KNOWN_ENTITIES[idOrSlug];

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// shouldResolveAsRef
// ═══════════════════════════════════════════════════════════════════════

describe("shouldResolveAsRef", () => {
  // ── Schema-confirmed refs ──────────────────────────────────────────

  describe("schema-confirmed refs (fieldType='ref')", () => {
    it("returns true regardless of value content", () => {
      expect(shouldResolveAsRef("anything", "ref", mockGetEntity)).toBe(true);
    });

    it("returns true even for values with spaces", () => {
      expect(shouldResolveAsRef("some entity name", "ref", mockGetEntity)).toBe(true);
    });

    it("returns true even for URLs", () => {
      expect(shouldResolveAsRef("https://example.com", "ref", mockGetEntity)).toBe(true);
    });

    it("returns true for empty string when fieldType is ref", () => {
      expect(shouldResolveAsRef("", "ref", mockGetEntity)).toBe(true);
    });
  });

  // ── Non-ref schema types block heuristic ───────────────────────────

  describe("non-ref schema types", () => {
    it("returns false when fieldType is 'text'", () => {
      expect(shouldResolveAsRef("anthropic", "text", mockGetEntity)).toBe(false);
    });

    it("returns false when fieldType is 'number'", () => {
      expect(shouldResolveAsRef("42", "number", mockGetEntity)).toBe(false);
    });

    it("returns false when fieldType is 'date'", () => {
      expect(shouldResolveAsRef("2024-01-15", "date", mockGetEntity)).toBe(false);
    });

    it("returns false when fieldType is 'boolean'", () => {
      expect(shouldResolveAsRef("true", "boolean", mockGetEntity)).toBe(false);
    });
  });

  // ── sid_ IDs (heuristic, no schema) ────────────────────────────────

  describe("sid_ IDs (no schema)", () => {
    it("resolves sid_ENI8sgChDQ as a ref", () => {
      expect(shouldResolveAsRef("sid_ENI8sgChDQ", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves sid_tKMznr07QA as a ref", () => {
      expect(shouldResolveAsRef("sid_tKMznr07QA", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves short sid (sid_abc) as a ref", () => {
      expect(shouldResolveAsRef("sid_abc", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves bare sid_ prefix as a ref", () => {
      expect(shouldResolveAsRef("sid_", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves sid_ even when entity is not in the store", () => {
      // sid_ IDs are structurally identifiable — we always treat them as refs
      expect(shouldResolveAsRef("sid_UNKNOWN12345", undefined, mockGetEntity)).toBe(true);
    });
  });

  // ── Entity slugs (heuristic, no schema) ────────────────────────────

  describe("entity slugs (no schema)", () => {
    it("resolves known entity slug 'anthropic'", () => {
      expect(shouldResolveAsRef("anthropic", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves known entity slug 'amazon'", () => {
      expect(shouldResolveAsRef("amazon", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves hyphenated known entity slug 'employee-equity-pool'", () => {
      expect(shouldResolveAsRef("employee-equity-pool", undefined, mockGetEntity)).toBe(true);
    });

    it("resolves hyphenated known entity slug 'series-g-institutional'", () => {
      expect(shouldResolveAsRef("series-g-institutional", undefined, mockGetEntity)).toBe(true);
    });

    it("returns false for unknown slug 'nonexistent-slug'", () => {
      expect(shouldResolveAsRef("nonexistent-slug", undefined, mockGetEntity)).toBe(false);
    });

    it("resolves single-word known entity 'active'", () => {
      expect(shouldResolveAsRef("active", undefined, mockGetEntity)).toBe(true);
    });

    it("returns false for single-word non-entity 'quarterly'", () => {
      expect(shouldResolveAsRef("quarterly", undefined, mockGetEntity)).toBe(false);
    });

    it("returns false for hyphenated non-entity 'non-existent-thing'", () => {
      expect(shouldResolveAsRef("non-existent-thing", undefined, mockGetEntity)).toBe(false);
    });
  });

  // ── Prose values (should NEVER resolve) ────────────────────────────

  describe("prose values (contain spaces)", () => {
    it("rejects prose with spaces: alignment researcher description", () => {
      expect(
        shouldResolveAsRef(
          "Alignment researcher; no publicly documented EA connections",
          undefined,
          mockGetEntity,
        ),
      ).toBe(false);
    });

    it("rejects prose with dollar amounts", () => {
      expect(
        shouldResolveAsRef(
          "$500M already in Good Ventures nonprofit vehicle",
          undefined,
          mockGetEntity,
        ),
      ).toBe(false);
    });

    it("rejects parenthetical descriptions", () => {
      expect(
        shouldResolveAsRef(
          "Married to Holden Karnofsky (GiveWell co-founder)",
          undefined,
          mockGetEntity,
        ),
      ).toBe(false);
    });

    it("rejects two-word role: 'Board Member'", () => {
      expect(shouldResolveAsRef("Board Member", undefined, mockGetEntity)).toBe(false);
    });
  });

  // ── URLs (should NEVER resolve) ────────────────────────────────────

  describe("URLs", () => {
    it("rejects https URL", () => {
      expect(shouldResolveAsRef("https://anthropic.com", undefined, mockGetEntity)).toBe(false);
    });

    it("rejects http URL", () => {
      expect(shouldResolveAsRef("http://arxiv.org/paper", undefined, mockGetEntity)).toBe(false);
    });

    it("rejects URL with path and query", () => {
      expect(
        shouldResolveAsRef("https://example.com/path?q=1", undefined, mockGetEntity),
      ).toBe(false);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("rejects empty string", () => {
      expect(shouldResolveAsRef("", undefined, mockGetEntity)).toBe(false);
    });

    it("resolves legacy 10-char ID that maps to a known entity", () => {
      // mK9pX3rQ7n is in KNOWN_ENTITIES
      expect(shouldResolveAsRef("mK9pX3rQ7n", undefined, mockGetEntity)).toBe(true);
    });

    it("returns false for 10-char string that is NOT a known entity", () => {
      expect(shouldResolveAsRef("AAAAAAAAAA", undefined, mockGetEntity)).toBe(false);
    });

    it("returns false for number-as-string '42' when not an entity", () => {
      expect(shouldResolveAsRef("42", undefined, mockGetEntity)).toBe(false);
    });

    it("resolves number-as-string if it happens to be an entity slug", () => {
      const customResolver: EntityResolver = (id) => (id === "42" ? { id: "42", name: "Answer" } : undefined);
      expect(shouldResolveAsRef("42", undefined, customResolver)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// tryResolveEntityRef
// ═══════════════════════════════════════════════════════════════════════

describe("tryResolveEntityRef", () => {
  // ── Non-string values ──────────────────────────────────────────────

  describe("non-string values return undefined", () => {
    it("returns undefined for null", () => {
      expect(tryResolveEntityRef(null, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(tryResolveEntityRef(undefined, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for number", () => {
      expect(tryResolveEntityRef(42, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for boolean true", () => {
      expect(tryResolveEntityRef(true, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for boolean false", () => {
      expect(tryResolveEntityRef(false, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for object", () => {
      expect(tryResolveEntityRef({ key: "value" }, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for array", () => {
      expect(tryResolveEntityRef(["a", "b"], mockGetEntity)).toBeUndefined();
    });
  });

  // ── sid_ IDs ───────────────────────────────────────────────────────

  describe("sid_ IDs", () => {
    it("resolves known sid_ to entity object", () => {
      const result = tryResolveEntityRef("sid_ENI8sgChDQ", mockGetEntity);
      expect(result).toEqual({ id: "sid_ENI8sgChDQ", name: "Anthropic" });
    });

    it("returns undefined for unknown sid_", () => {
      const result = tryResolveEntityRef("sid_UNKNOWN12345", mockGetEntity);
      expect(result).toBeUndefined();
    });
  });

  // ── Legacy 10-char IDs ─────────────────────────────────────────────

  describe("legacy 10-char alphanumeric IDs", () => {
    it("resolves known 10-char ID to entity", () => {
      const result = tryResolveEntityRef("mK9pX3rQ7n", mockGetEntity);
      expect(result).toEqual({ id: "mK9pX3rQ7n", name: "DeepMind" });
    });

    it("returns undefined for unknown 10-char ID", () => {
      const result = tryResolveEntityRef("AAAAAAAAAA", mockGetEntity);
      expect(result).toBeUndefined();
    });

    it("returns undefined for 10-char ID with special chars", () => {
      // Not matching ENTITY_ID_RE but still passes to slug resolution
      // which also won't find it
      const result = tryResolveEntityRef("abc!@#$%^&", mockGetEntity);
      expect(result).toBeUndefined();
    });
  });

  // ── Entity slugs ───────────────────────────────────────────────────

  describe("entity slugs", () => {
    it("resolves known slug 'anthropic'", () => {
      const result = tryResolveEntityRef("anthropic", mockGetEntity);
      expect(result).toEqual({ id: "sid_ENI8sgChDQ", name: "Anthropic" });
    });

    it("resolves known slug 'amazon'", () => {
      const result = tryResolveEntityRef("amazon", mockGetEntity);
      expect(result).toEqual({ id: "sid_amazon123", name: "Amazon" });
    });

    it("resolves known hyphenated slug", () => {
      const result = tryResolveEntityRef("employee-equity-pool", mockGetEntity);
      expect(result).toEqual({ id: "sid_eep1234567", name: "Employee Equity Pool" });
    });

    it("returns undefined for unknown slug", () => {
      const result = tryResolveEntityRef("nonexistent-slug", mockGetEntity);
      expect(result).toBeUndefined();
    });
  });

  // ── Prose and URLs rejected ────────────────────────────────────────

  describe("prose and URLs", () => {
    it("returns undefined for prose with spaces", () => {
      expect(
        tryResolveEntityRef("Board Member", mockGetEntity),
      ).toBeUndefined();
    });

    it("returns undefined for long prose", () => {
      expect(
        tryResolveEntityRef(
          "Alignment researcher; no publicly documented EA connections",
          mockGetEntity,
        ),
      ).toBeUndefined();
    });

    it("returns undefined for https URL", () => {
      expect(
        tryResolveEntityRef("https://anthropic.com", mockGetEntity),
      ).toBeUndefined();
    });

    it("returns undefined for http URL", () => {
      expect(
        tryResolveEntityRef("http://arxiv.org/paper", mockGetEntity),
      ).toBeUndefined();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(tryResolveEntityRef("", mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for zero (number)", () => {
      expect(tryResolveEntityRef(0, mockGetEntity)).toBeUndefined();
    });

    it("returns undefined for NaN", () => {
      expect(tryResolveEntityRef(NaN, mockGetEntity)).toBeUndefined();
    });

    it("uses entity resolver return value directly", () => {
      const custom: EntityResolver = (id) =>
        id === "test" ? { id: "test", name: "Test Entity", extra: true } : undefined;
      const result = tryResolveEntityRef("test", custom);
      expect(result).toEqual({ id: "test", name: "Test Entity", extra: true });
    });

    it("returns undefined when resolver returns undefined for all inputs", () => {
      const emptyResolver: EntityResolver = () => undefined;
      expect(tryResolveEntityRef("anthropic", emptyResolver)).toBeUndefined();
      expect(tryResolveEntityRef("mK9pX3rQ7n", emptyResolver)).toBeUndefined();
      // sid_ still goes to resolver — but resolver returns undefined
      expect(tryResolveEntityRef("sid_ENI8sgChDQ", emptyResolver)).toBeUndefined();
    });
  });
});
