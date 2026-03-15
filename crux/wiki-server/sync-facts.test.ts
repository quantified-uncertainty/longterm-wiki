import { describe, it, expect } from "vitest";
import { transformFact } from "./sync-facts.ts";
import type { Fact, Property } from "../../packages/factbase/src/types.ts";

describe("transformFact", () => {
  it("transforms a number fact", () => {
    const fact: Fact = {
      id: "f_abc123",
      subjectId: "entity1",
      propertyId: "revenue",
      value: { type: "number", value: 5_000_000_000 },
      asOf: "2025-06",
      source: "https://example.com",
      notes: "Annual revenue",
    };

    const result = transformFact(fact);

    expect(result.entityId).toBe("entity1");
    expect(result.factId).toBe("f_abc123");
    expect(result.value).toBe("5000000000");
    expect(result.numeric).toBe(5_000_000_000);
    expect(result.low).toBeNull();
    expect(result.high).toBeNull();
    expect(result.asOf).toBe("2025-06");
    expect(result.measure).toBe("revenue");
    expect(result.subject).toBe("entity1");
    expect(result.source).toBe("https://example.com");
    expect(result.note).toBe("Annual revenue");
    expect(result.format).toBe("number");
  });

  it("transforms a text fact", () => {
    const fact: Fact = {
      id: "f_text1",
      subjectId: "entity2",
      propertyId: "description",
      value: { type: "text", value: "A research lab" },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("A research lab");
    expect(result.numeric).toBeNull();
    expect(result.format).toBe("text");
    expect(result.asOf).toBeNull();
    expect(result.source).toBeNull();
    expect(result.note).toBeNull();
  });

  it("transforms a range fact", () => {
    const fact: Fact = {
      id: "f_range1",
      subjectId: "entity3",
      propertyId: "employee-count",
      value: { type: "range", low: 1000, high: 1500 },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("1000\u20131500");
    expect(result.numeric).toBeNull();
    expect(result.low).toBe(1000);
    expect(result.high).toBe(1500);
    expect(result.format).toBe("range");
  });

  it("transforms a ref fact", () => {
    const fact: Fact = {
      id: "f_ref1",
      subjectId: "entity4",
      propertyId: "ceo",
      value: { type: "ref", value: "person123" },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("person123");
    expect(result.numeric).toBeNull();
    expect(result.format).toBe("ref");
  });

  it("transforms a refs fact", () => {
    const fact: Fact = {
      id: "f_refs1",
      subjectId: "entity5",
      propertyId: "subsidiaries",
      value: { type: "refs", value: ["sub1", "sub2", "sub3"] },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("sub1, sub2, sub3");
    expect(result.format).toBe("refs");
  });

  it("transforms a boolean fact", () => {
    const fact: Fact = {
      id: "f_bool1",
      subjectId: "entity6",
      propertyId: "is-public",
      value: { type: "boolean", value: true },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("true");
    expect(result.format).toBe("boolean");
  });

  it("transforms a min fact", () => {
    const fact: Fact = {
      id: "f_min1",
      subjectId: "entity7",
      propertyId: "minimum-funding",
      value: { type: "min", value: 100_000_000 },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("\u2265100000000");
    expect(result.numeric).toBe(100_000_000);
    expect(result.format).toBe("min");
  });

  it("transforms a date fact", () => {
    const fact: Fact = {
      id: "f_date1",
      subjectId: "entity8",
      propertyId: "founded",
      value: { type: "date", value: "2021-01-01" },
    };

    const result = transformFact(fact);

    expect(result.value).toBe("2021-01-01");
    expect(result.format).toBe("date");
  });

  it("sets label to null", () => {
    const fact: Fact = {
      id: "f_nolabel",
      subjectId: "entity9",
      propertyId: "name",
      value: { type: "text", value: "test" },
    };

    const result = transformFact(fact);

    expect(result.label).toBeNull();
  });

  it("sets formatDivisor from property display config", () => {
    const fact: Fact = {
      id: "f_rev1",
      subjectId: "entity10",
      propertyId: "revenue",
      value: { type: "number", value: 5_000_000_000 },
    };
    const property: Property = {
      id: "revenue",
      name: "Revenue",
      dataType: "number",
      unit: "USD",
      display: { divisor: 1e9, prefix: "$", suffix: "B" },
    };

    const result = transformFact(fact, property);

    expect(result.formatDivisor).toBe(1e9);
  });

  it("sets formatDivisor to null when no property provided", () => {
    const fact: Fact = {
      id: "f_nodiv",
      subjectId: "entity11",
      propertyId: "headcount",
      value: { type: "number", value: 1000 },
    };

    const result = transformFact(fact);

    expect(result.formatDivisor).toBeNull();
  });

  it("sets formatDivisor to null when property has no display config", () => {
    const fact: Fact = {
      id: "f_nodisplay",
      subjectId: "entity12",
      propertyId: "founded",
      value: { type: "date", value: "2020-01-01" },
    };
    const property: Property = {
      id: "founded",
      name: "Founded",
      dataType: "date",
    };

    const result = transformFact(fact, property);

    expect(result.formatDivisor).toBeNull();
  });
});
