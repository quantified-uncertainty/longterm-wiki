import { describe, it, expect } from "vitest";
import { paginationQuery } from "../routes/shared/utils.js";

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
