import { describe, it, expect } from "vitest";
import { parseSort, paginationMeta } from "../routes/query-helpers.js";

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
