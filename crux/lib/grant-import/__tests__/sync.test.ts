import { describe, it, expect } from "vitest";
import { toSyncGrant } from "../sync.ts";
import type { RawGrant } from "../types.ts";

describe("toSyncGrant", () => {
  const defaultSourceUrl = "https://example.org/grants/";

  it("generates a deterministic ID", () => {
    const raw: RawGrant = {
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      granteeName: "MIRI",
      granteeId: "abc123",
      name: "General support",
      amount: 100000,
      date: "2022-01",
      focusArea: "AI Safety",
      description: "A grant for research",
    };
    const sync1 = toSyncGrant(raw, defaultSourceUrl);
    const sync2 = toSyncGrant(raw, defaultSourceUrl);
    expect(sync1.id).toBe(sync2.id);
    expect(sync1.id).toHaveLength(10);
  });

  it("uses granteeName as display granteeId", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Redwood Research",
      granteeId: "someEntityId",
      name: "Grant to Redwood",
      amount: 500000,
      date: "2024-01",
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.granteeId).toBe("Redwood Research");
  });

  it("uses defaultSourceUrl when no sourceUrl on raw grant", () => {
    const raw: RawGrant = {
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      granteeName: "Test Org",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, "https://coefficientgiving.org/grants/");
    expect(sync.source).toBe("https://coefficientgiving.org/grants/");
  });

  it("uses raw.sourceUrl when present (Manifund)", () => {
    const raw: RawGrant = {
      source: "manifund",
      funderId: "fFVOuFZCRf",
      granteeName: "John Doe",
      granteeId: null,
      name: "AI Safety Project",
      amount: 25000,
      date: "2024-03-15",
      focusArea: "AI Safety",
      description: "A project",
      sourceUrl: "https://manifund.org/projects/ai-safety-project",
    };
    const sync = toSyncGrant(raw, "https://manifund.org");
    expect(sync.source).toBe("https://manifund.org/projects/ai-safety-project");
  });

  it("combines focusArea and description into notes", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: "AI Safety",
      description: "Research on alignment",
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.notes).toBe("[AI Safety] Research on alignment");
  });

  it("uses focusArea alone when no description", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: "Global Health",
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.notes).toBe("Global Health");
  });

  it("uses description alone when no focusArea", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: null,
      description: "Research on alignment techniques",
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.notes).toBe("Research on alignment techniques");
  });

  it("sets notes to null when neither focusArea nor description", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.notes).toBeNull();
  });

  it("passes through null amount", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test Org",
      granteeId: null,
      name: "Undisclosed grant",
      amount: null,
      date: "2024-01",
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.amount).toBeNull();
  });

  it("generates ID correctly with null date", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test Org",
      granteeId: null,
      name: "Grant with no date",
      amount: 5000,
      date: null,
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.id).toHaveLength(10);
    // Null date becomes empty string in ID input
    expect(sync.date).toBeNull();
  });

  it("truncates very long granteeName in granteeId to 200 chars", () => {
    const longName = "A".repeat(500);
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: longName,
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.granteeId).toHaveLength(200);
  });

  it("truncates name in ID input to 100 chars", () => {
    const longName = "B".repeat(200);
    const raw1: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test",
      granteeId: null,
      name: longName,
      amount: 1000,
      date: null,
      focusArea: null,
      description: null,
    };
    // Same raw but with name extended beyond 100 chars in a different way
    const raw2: RawGrant = {
      ...raw1,
      name: longName + "EXTRA",
    };
    const sync1 = toSyncGrant(raw1, defaultSourceUrl);
    const sync2 = toSyncGrant(raw2, defaultSourceUrl);
    // Both should produce the same ID since name is truncated to 100 chars
    // and both share the same first 100 chars
    expect(sync1.id).toBe(sync2.id);
  });

  it("defaults currency to USD when not specified on raw grant", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Test Org",
      granteeId: null,
      name: "Test",
      amount: 1000,
      date: null,
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.currency).toBe("USD");
  });

  it("passes through currency from raw grant", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "UK Org",
      granteeId: null,
      name: "Grant in GBP",
      amount: 50000,
      currency: "GBP",
      date: "2024-06",
      focusArea: null,
      description: null,
    };
    const sync = toSyncGrant(raw, defaultSourceUrl);
    expect(sync.currency).toBe("GBP");
  });

  // ID stability tests — these pin the exact ID for existing CG/EA Funds grants
  it("produces stable ID for CG grant (ID must not change)", () => {
    const raw: RawGrant = {
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      granteeName: "Machine Intelligence Research Institute",
      granteeId: "abc123",
      name: "Support for general research",
      amount: 1255000,
      date: "2017-07",
      focusArea: "Potential Risks from Advanced AI",
      description: "To support general research",
    };
    const sync = toSyncGrant(raw, "https://coefficientgiving.org/grants/");
    expect(sync.id).toBe("VvNfsbv6vA");
  });

  it("produces stable ID for EA Funds grant (ID must not change)", () => {
    const raw: RawGrant = {
      source: "ea-funds",
      funderId: "yA12C1KcjQ",
      granteeName: "Redwood Research",
      granteeId: "someId",
      name: "Grant to Redwood Research",
      amount: 500000,
      date: "2024-01",
      focusArea: "Long-Term Future Fund",
      description: "Grant to Redwood Research",
    };
    const sync = toSyncGrant(raw, "https://funds.effectivealtruism.org/grants");
    expect(sync.id).toBe("kPQNkZFIDW");
  });
});
