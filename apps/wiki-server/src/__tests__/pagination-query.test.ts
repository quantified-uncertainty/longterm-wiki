import { describe, it, expect } from "vitest";
import { paginationQuery, clampedLimit } from "../routes/shared/utils.js";
import { z } from "zod";

describe("paginationQuery", () => {
  const schema = paginationQuery({ maxLimit: 200, defaultLimit: 50 });

  it("accepts limit within range", () => {
    const result = schema.parse({ limit: "100", offset: "0" });
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it("uses default limit when not provided", () => {
    const result = schema.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("clamps limit exceeding maxLimit instead of rejecting", () => {
    const result = schema.parse({ limit: "500" });
    expect(result.limit).toBe(200);
  });

  it("clamps limit exactly at maxLimit", () => {
    const result = schema.parse({ limit: "200" });
    expect(result.limit).toBe(200);
  });

  it("rejects limit below minimum (0)", () => {
    expect(() => schema.parse({ limit: "0" })).toThrow();
  });

  it("rejects limit below minimum (-1)", () => {
    expect(() => schema.parse({ limit: "-1" })).toThrow();
  });

  it("rejects non-integer limit", () => {
    expect(() => schema.parse({ limit: "abc" })).toThrow();
  });

  it("clamps with custom maxLimit", () => {
    const custom = paginationQuery({ maxLimit: 50, defaultLimit: 10 });
    const result = custom.parse({ limit: "100" });
    expect(result.limit).toBe(50);
  });

  it("uses default maxLimit of 200 when not specified", () => {
    const defaultSchema = paginationQuery();
    const result = defaultSchema.parse({ limit: "999" });
    expect(result.limit).toBe(200);
  });

  it("uses default defaultLimit of 50 when not specified", () => {
    const defaultSchema = paginationQuery();
    const result = defaultSchema.parse({});
    expect(result.limit).toBe(50);
  });
});

describe("clampedLimit", () => {
  it("accepts limit within range", () => {
    const schema = z.object({ limit: clampedLimit(200, 50) });
    const result = schema.parse({ limit: "100" });
    expect(result.limit).toBe(100);
  });

  it("uses default when not provided", () => {
    const schema = z.object({ limit: clampedLimit(200, 50) });
    const result = schema.parse({});
    expect(result.limit).toBe(50);
  });

  it("clamps oversized limit instead of rejecting", () => {
    const schema = z.object({ limit: clampedLimit(200, 50) });
    const result = schema.parse({ limit: "500" });
    expect(result.limit).toBe(200);
  });

  it("clamps limit exactly at max", () => {
    const schema = z.object({ limit: clampedLimit(200, 50) });
    const result = schema.parse({ limit: "200" });
    expect(result.limit).toBe(200);
  });

  it("rejects limit below minimum (0)", () => {
    const schema = z.object({ limit: clampedLimit(200, 50) });
    expect(() => schema.parse({ limit: "0" })).toThrow();
  });

  it("works with different max limits", () => {
    const schema = z.object({ limit: clampedLimit(50, 10) });
    expect(schema.parse({ limit: "100" }).limit).toBe(50);
    expect(schema.parse({}).limit).toBe(10);
  });

  it("works with .catch() chained after it", () => {
    const schema = z.object({ limit: clampedLimit(500, 100).catch(100) });
    // Non-numeric input gets caught and returns 100
    const result = schema.parse({ limit: "not-a-number" });
    expect(result.limit).toBe(100);
    // Oversized input gets clamped
    const result2 = schema.parse({ limit: "9999" });
    expect(result2.limit).toBe(500);
  });

  it("paginationQuery uses clampedLimit internally", () => {
    // Verify that paginationQuery and clampedLimit produce the same clamping behavior
    const pq = paginationQuery({ maxLimit: 100, defaultLimit: 20 });
    const cl = z.object({ limit: clampedLimit(100, 20), offset: z.coerce.number().int().min(0).default(0) });

    expect(pq.parse({ limit: "500" }).limit).toBe(cl.parse({ limit: "500" }).limit);
    expect(pq.parse({}).limit).toBe(cl.parse({}).limit);
  });
});
