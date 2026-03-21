import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  parseSort,
  paginationMeta,
  buildTsvectorSearchCondition,
  buildTsvectorRankExpr,
  buildTrigramFallbackCondition,
  buildTrigramRankExpr,
  TRIGRAM_FALLBACK_THRESHOLD,
  TRIGRAM_SIMILARITY_THRESHOLD,
} from "../routes/shared/query-helpers.js";
import { entities } from "../schema.js";

describe("parseSort", () => {
  const allowed = ["amount", "date", "name"] as const;

  it("returns defaults when sortStr is undefined", () => {
    expect(parseSort(undefined, allowed, "amount", "desc")).toEqual({
      field: "amount",
      dir: "desc",
    });
  });

  it("parses valid field:dir", () => {
    expect(parseSort("date:asc", allowed, "amount")).toEqual({
      field: "date",
      dir: "asc",
    });
  });

  it("falls back to default when field is not in whitelist", () => {
    expect(parseSort("hacked:asc", allowed, "amount", "desc")).toEqual({
      field: "amount",
      dir: "desc",
    });
  });

  it("falls back to default direction when dir is invalid", () => {
    expect(parseSort("name:sideways", allowed, "amount", "desc")).toEqual({
      field: "name",
      dir: "desc",
    });
  });

  it("handles field with no direction", () => {
    expect(parseSort("date", allowed, "amount", "desc")).toEqual({
      field: "date",
      dir: "desc",
    });
  });

  it("uses default dir of desc when not specified", () => {
    expect(parseSort(undefined, allowed, "amount")).toEqual({
      field: "amount",
      dir: "desc",
    });
  });
});

describe("paginationMeta", () => {
  it("computes correct page count", () => {
    expect(paginationMeta(100, 1, 20)).toEqual({
      total: 100,
      page: 1,
      pageSize: 20,
      pageCount: 5,
    });
  });

  it("rounds up page count for partial pages", () => {
    expect(paginationMeta(101, 1, 20)).toEqual({
      total: 101,
      page: 1,
      pageSize: 20,
      pageCount: 6,
    });
  });

  it("returns pageCount of 1 for zero total", () => {
    expect(paginationMeta(0, 1, 20)).toEqual({
      total: 0,
      page: 1,
      pageSize: 20,
      pageCount: 1,
    });
  });
});

describe("buildTsvectorSearchCondition", () => {
  const searchVectorExpr = sql.raw("search_vector");
  const columns = [entities.title, entities.description];

  it("returns undefined for empty search term", () => {
    expect(buildTsvectorSearchCondition(searchVectorExpr, "", columns)).toBeUndefined();
    expect(buildTsvectorSearchCondition(searchVectorExpr, "   ", columns)).toBeUndefined();
  });

  it("returns a SQL object for a valid search term", () => {
    const result = buildTsvectorSearchCondition(searchVectorExpr, "alignment", columns);
    expect(result).toBeDefined();
    // Should be a Drizzle SQL object (has queryChunks or similar structure)
    expect(result).toHaveProperty("queryChunks");
  });

  it("falls back to ILIKE for all-punctuation input", () => {
    // buildPrefixTsquery returns "" for "!@#" so buildTsvectorSearchCondition
    // should fall back to buildSearchCondition (ILIKE)
    const result = buildTsvectorSearchCondition(searchVectorExpr, "!@#$%", columns);
    // All-punctuation produces empty tsquery AND empty ILIKE pattern after stripping
    // The ILIKE fallback will still produce a condition for the raw input "%!@#$%%"
    expect(result).toBeDefined();
  });

  it("normalizes letter/digit boundaries (sb1047 → sb 1047)", () => {
    const result = buildTsvectorSearchCondition(searchVectorExpr, "sb1047", columns);
    // Should produce a tsvector condition since "sb 1047" has valid words
    expect(result).toBeDefined();
    expect(result).toHaveProperty("queryChunks");
  });
});

describe("buildTsvectorRankExpr", () => {
  const searchVectorExpr = sql.raw("search_vector");

  it("returns undefined for empty or all-punctuation input", () => {
    expect(buildTsvectorRankExpr(searchVectorExpr, entities.title, "")).toBeUndefined();
    expect(buildTsvectorRankExpr(searchVectorExpr, entities.title, "   ")).toBeUndefined();
    expect(buildTsvectorRankExpr(searchVectorExpr, entities.title, "!@#")).toBeUndefined();
  });

  it("returns a SQL expression for valid input", () => {
    const result = buildTsvectorRankExpr(searchVectorExpr, entities.title, "alignment");
    expect(result).toBeDefined();
    expect(result).toHaveProperty("queryChunks");
  });

  it("handles multi-word queries", () => {
    const result = buildTsvectorRankExpr(searchVectorExpr, entities.title, "AI safety");
    expect(result).toBeDefined();
  });
});

describe("buildTrigramFallbackCondition", () => {
  it("returns a SQL condition for any input", () => {
    const result = buildTrigramFallbackCondition(entities.title, "anthropic");
    expect(result).toBeDefined();
    expect(result).toHaveProperty("queryChunks");
  });

  it("accepts a custom threshold", () => {
    const result = buildTrigramFallbackCondition(entities.title, "test", 0.5);
    expect(result).toBeDefined();
  });
});

describe("buildTrigramRankExpr", () => {
  it("returns a SQL expression", () => {
    const result = buildTrigramRankExpr(entities.title, "anthropic");
    expect(result).toBeDefined();
    expect(result).toHaveProperty("queryChunks");
  });
});

describe("tsvector search constants", () => {
  it("exports TRIGRAM_FALLBACK_THRESHOLD", () => {
    expect(TRIGRAM_FALLBACK_THRESHOLD).toBeGreaterThanOrEqual(1);
  });

  it("exports TRIGRAM_SIMILARITY_THRESHOLD", () => {
    expect(TRIGRAM_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(TRIGRAM_SIMILARITY_THRESHOLD).toBeLessThan(1);
  });
});
