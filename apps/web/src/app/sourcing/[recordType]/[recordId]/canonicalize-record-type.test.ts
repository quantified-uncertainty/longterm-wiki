import { describe, it, expect } from "vitest";
import { canonicalizeSourcingRecordType } from "./canonicalize-record-type";

describe("canonicalizeSourcingRecordType", () => {
  it("maps plural grants → singular grant", () => {
    expect(canonicalizeSourcingRecordType("grants")).toBe("grant");
  });

  it("maps hyphenated plurals", () => {
    expect(canonicalizeSourcingRecordType("board-seats")).toBe("board-seat");
    expect(canonicalizeSourcingRecordType("funding-programs")).toBe("funding-program");
    expect(canonicalizeSourcingRecordType("funding-rounds")).toBe("funding-round");
    expect(canonicalizeSourcingRecordType("policy-stakeholders")).toBe("policy-stakeholder");
  });

  it("maps publications, divisions, investments, citations, wiki-pages", () => {
    expect(canonicalizeSourcingRecordType("publications")).toBe("publication");
    expect(canonicalizeSourcingRecordType("divisions")).toBe("division");
    expect(canonicalizeSourcingRecordType("investments")).toBe("investment");
    expect(canonicalizeSourcingRecordType("citations")).toBe("citation");
    expect(canonicalizeSourcingRecordType("wiki-pages")).toBe("wiki-page");
  });

  it("returns null for already-canonical singular forms", () => {
    expect(canonicalizeSourcingRecordType("grant")).toBeNull();
    expect(canonicalizeSourcingRecordType("publication")).toBeNull();
    expect(canonicalizeSourcingRecordType("board-seat")).toBeNull();
    expect(canonicalizeSourcingRecordType("fact")).toBeNull();
    expect(canonicalizeSourcingRecordType("entity")).toBeNull();
    expect(canonicalizeSourcingRecordType("personnel")).toBeNull();
  });

  it("returns null for unknown record types (letting the page fall through to notFound)", () => {
    expect(canonicalizeSourcingRecordType("nonsense")).toBeNull();
    expect(canonicalizeSourcingRecordType("")).toBeNull();
    expect(canonicalizeSourcingRecordType("Grants")).toBeNull();
  });
});
