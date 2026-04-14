import { describe, it, expect } from "vitest";
import {
  RECORD_TYPE_TO_TABLE,
  recordTypeToTable,
} from "./record-type-table-map";
import {
  VALID_RECORD_TYPES,
  SOURCING_EXEMPT_TYPES,
} from "@wiki-server/api-types";

describe("recordTypeToTable", () => {
  it("maps known recordType to table name", () => {
    expect(recordTypeToTable("grant")).toBe("grants");
    expect(recordTypeToTable("funding-round")).toBe("funding_rounds");
    expect(recordTypeToTable("policy-stakeholder")).toBe("policy_stakeholders");
    expect(recordTypeToTable("fact")).toBe("facts");
  });

  it("returns null for unknown recordType (no regex fallback)", () => {
    // QUA-420 regression: these previously returned garbage like "entity_s"
    expect(recordTypeToTable("entity")).toBeNull();
    expect(recordTypeToTable("race")).toBeNull();
    expect(recordTypeToTable("race-candidate")).toBeNull();
    expect(recordTypeToTable("unknown-garbage")).toBeNull();
    expect(recordTypeToTable("")).toBeNull();
  });

  it("covers every non-exempt VALID_RECORD_TYPES entry", () => {
    // secondary-market-price is exempt and has no record-lookup table; everything
    // else in VALID_RECORD_TYPES must have a mapping.
    const exempt = new Set<string>([...SOURCING_EXEMPT_TYPES]);
    const missing: string[] = [];
    for (const t of VALID_RECORD_TYPES) {
      if (exempt.has(t)) continue;
      if (!(t in RECORD_TYPE_TO_TABLE)) missing.push(t);
    }
    expect(missing, `Missing RECORD_TYPE_TO_TABLE entries: ${missing.join(", ")}`).toEqual([]);
  });
});
