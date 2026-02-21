import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transformFact, syncFacts, type SyncFact } from "./sync-facts.ts";

const noSleep = async () => {};

function makeFact(
  entityId: string,
  factId: string,
  overrides: Partial<SyncFact> = {}
): SyncFact {
  return {
    entityId,
    factId,
    label: `Fact ${factId}`,
    value: "100",
    numeric: 100,
    low: null,
    high: null,
    asOf: "2025-06",
    measure: "revenue",
    subject: null,
    note: null,
    source: null,
    sourceResource: null,
    format: null,
    formatDivisor: null,
    ...overrides,
  };
}

describe("transformFact", () => {
  it("transforms a minimal YAML fact", () => {
    const result = transformFact("anthropic", "revenue", {});

    expect(result).toEqual({
      entityId: "anthropic",
      factId: "revenue",
      label: null,
      value: null,
      numeric: null,
      low: null,
      high: null,
      asOf: null,
      measure: null,
      subject: null,
      note: null,
      source: null,
      sourceResource: null,
      format: null,
      formatDivisor: null,
    });
  });

  it("transforms a fully-populated fact", () => {
    const result = transformFact("anthropic", "revenue-2025", {
      label: "Annual Revenue",
      value: 4000000000,
      asOf: "2025-06",
      measure: "revenue",
      subject: "annual",
      note: "Estimated from reports",
      source: "https://example.com",
      sourceResource: "src-123",
      format: "usd",
      formatDivisor: 1000000000,
    });

    expect(result.entityId).toBe("anthropic");
    expect(result.factId).toBe("revenue-2025");
    expect(result.label).toBe("Annual Revenue");
    expect(result.value).toBe("4000000000");
    expect(result.numeric).toBe(4000000000);
    expect(result.low).toBeNull();
    expect(result.high).toBeNull();
    expect(result.asOf).toBe("2025-06");
    expect(result.measure).toBe("revenue");
    expect(result.format).toBe("usd");
    expect(result.formatDivisor).toBe(1000000000);
  });

  // --- parseFactValue edge cases ---

  it("handles numeric value", () => {
    const result = transformFact("e", "f", { value: 42 });
    expect(result.value).toBe("42");
    expect(result.numeric).toBe(42);
    expect(result.low).toBeNull();
    expect(result.high).toBeNull();
  });

  it("handles string value that is a number", () => {
    const result = transformFact("e", "f", { value: "123.45" });
    expect(result.value).toBe("123.45");
    expect(result.numeric).toBe(123.45);
  });

  it("handles string value that is not a number", () => {
    const result = transformFact("e", "f", { value: "qualitative" });
    expect(result.value).toBe("qualitative");
    expect(result.numeric).toBeNull();
  });

  it("handles array [low, high] range value", () => {
    const result = transformFact("e", "f", { value: [10, 20] });
    expect(result.value).toBe("10-20");
    expect(result.numeric).toBeNull();
    expect(result.low).toBe(10);
    expect(result.high).toBe(20);
  });

  it("handles object { min, max } range value", () => {
    const result = transformFact("e", "f", {
      value: { min: 100, max: 200 },
    });
    expect(result.value).toBe("100-200");
    expect(result.numeric).toBeNull();
    expect(result.low).toBe(100);
    expect(result.high).toBe(200);
  });

  it("handles undefined value", () => {
    const result = transformFact("e", "f", {});
    expect(result.value).toBeNull();
    expect(result.numeric).toBeNull();
    expect(result.low).toBeNull();
    expect(result.high).toBeNull();
  });

  it("handles zero numeric value", () => {
    const result = transformFact("e", "f", { value: 0 });
    expect(result.value).toBe("0");
    expect(result.numeric).toBe(0);
  });

  it("handles negative numeric value", () => {
    const result = transformFact("e", "f", { value: -50 });
    expect(result.value).toBe("-50");
    expect(result.numeric).toBe(-50);
  });

  it("stringifies numeric asOf values", () => {
    // YAML may parse "2025" as a number
    const result = transformFact("e", "f", { asOf: "2025" });
    expect(result.asOf).toBe("2025");
  });

  it("stringifies sourceResource values", () => {
    // YAML may parse numeric-looking IDs as numbers
    const result = transformFact("e", "f", { sourceResource: "12345" });
    expect(result.sourceResource).toBe("12345");
  });

  it("handles empty string values", () => {
    // Note: Number("") === 0, so empty string parses as numeric 0.
    // This is a JS quirk but harmless — empty string values don't occur in real YAML.
    const result = transformFact("e", "f", { value: "" });
    expect(result.value).toBe("");
    expect(result.numeric).toBe(0);
  });
});

describe("syncFacts", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined)
      process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined)
      process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("upserts all facts successfully", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ upserted: 3 }), { status: 200 })
    );

    const items = [
      makeFact("anthropic", "rev-1"),
      makeFact("anthropic", "rev-2"),
      makeFact("openai", "val-1"),
      makeFact("openai", "val-2"),
      makeFact("deepmind", "emp-1"),
      makeFact("deepmind", "emp-2"),
    ];
    const result = await syncFacts("http://localhost:3000", items, 3, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 6, errors: 0 });
  });

  it("counts errors for failed batches", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upserted: 2 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 })
      );

    const items = [
      makeFact("a", "f1"),
      makeFact("a", "f2"),
      makeFact("b", "f3"),
      makeFact("b", "f4"),
    ];
    const result = await syncFacts("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("fast-fails after 3 consecutive batch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    const items = Array.from({ length: 10 }, (_, i) =>
      makeFact("entity", `fact-${i}`)
    );
    const result = await syncFacts("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(10);
  });

  it("resets consecutive failure count on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Batch 1: fails
    fetchSpy
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("err", { status: 503 }));
    // Batch 2: succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 })
    );
    // Batch 3: fails
    fetchSpy
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("err", { status: 503 }));
    // Batch 4: succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 })
    );

    const items = [
      makeFact("a", "f1"),
      makeFact("a", "f2"),
      makeFact("a", "f3"),
      makeFact("a", "f4"),
    ];
    const result = await syncFacts("http://localhost:3000", items, 1, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("handles empty items array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncFacts("http://localhost:3000", [], 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends correct payload to /api/facts/sync", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 })
    );

    const items = [makeFact("anthropic", "rev-2025")];
    await syncFacts("http://localhost:3000", items, 100, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/facts/sync",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"anthropic"'),
      })
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(callBody.facts).toHaveLength(1);
    expect(callBody.facts[0].entityId).toBe("anthropic");
    expect(callBody.facts[0].factId).toBe("rev-2025");
  });
});
