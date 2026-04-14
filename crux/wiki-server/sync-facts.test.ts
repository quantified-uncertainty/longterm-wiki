import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  transformFact,
  groupFactsByEntity,
  pruneFacts,
  loadAndTransformFacts,
} from "./sync-facts.ts";
import type { Fact, Property } from "../../packages/factbase/src/types.ts";
import type { SyncFact } from "../../apps/wiki-server/src/api-types.ts";

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

  // QUA-397: Regression — label must come from property.name (not null),
  // otherwise the server-side things dual-write falls back to f.factId and
  // bakes raw "f_..." IDs into things.title / things.description, which
  // then leak to visible text on /organizations/*/data pages.
  it("populates label from property.name for things-table dual-write (QUA-397)", () => {
    const fact: Fact = {
      id: "f_mEKUPPFYRg",
      subjectId: "google-deepmind",
      propertyId: "founded-date",
      value: { type: "date", value: "2010-09" },
    };
    const property: Property = {
      id: "founded-date",
      name: "Founded",
      dataType: "date",
    };

    const result = transformFact(fact, property);

    expect(result.label).toBe("Founded");
    // Negative assertion: label must not be the raw fact id
    expect(result.label).not.toBe("f_mEKUPPFYRg");
  });

  it("label is null when property is not provided (server uses f.measure fallback)", () => {
    const fact: Fact = {
      id: "f_noprop",
      subjectId: "entity13",
      propertyId: "headcount",
      value: { type: "number", value: 6000 },
    };

    const result = transformFact(fact);

    // No property → label null. Server's fallback is `f.measure || "fact"`,
    // which uses the propertyId ("headcount") — a slug, never the raw factId.
    expect(result.label).toBeNull();
    expect(result.measure).toBe("headcount");
  });
});

// ---- groupFactsByEntity ----

function makeSyncFact(entityId: string, factId: string): SyncFact {
  return {
    entityId,
    factId,
    label: null,
    value: "1",
    numeric: 1,
    low: null,
    high: null,
    asOf: null,
    validEnd: null,
    currency: null,
    measure: "test",
    subject: null,
    note: null,
    source: null,
    format: "number",
    formatDivisor: null,
    sourceQuote: null,
    usdEquivalent: null,
    exchangeRate: null,
    exchangeRateDate: null,
    dollarYear: null,
  };
}

describe("groupFactsByEntity", () => {
  it("groups facts by entityId", () => {
    const facts = [
      makeSyncFact("anthropic", "f_aaa"),
      makeSyncFact("anthropic", "f_bbb"),
      makeSyncFact("openai", "f_ccc"),
    ];
    const entries = groupFactsByEntity(facts);
    expect(entries).toHaveLength(2);
    const anthropic = entries.find((e) => e.entityId === "anthropic");
    const openai = entries.find((e) => e.entityId === "openai");
    expect(anthropic?.factIds).toEqual(["f_aaa", "f_bbb"]);
    expect(openai?.factIds).toEqual(["f_ccc"]);
  });

  it("includes empty-fact entities passed via entityIdsWithNoFacts", () => {
    const facts = [makeSyncFact("anthropic", "f_aaa")];
    const entries = groupFactsByEntity(facts, ["constellation"]);
    expect(entries).toHaveLength(2);
    const constellation = entries.find((e) => e.entityId === "constellation");
    expect(constellation).toBeDefined();
    expect(constellation?.factIds).toEqual([]);
  });

  it("does not duplicate entries when entityIdsWithNoFacts overlaps", () => {
    // Defensive: caller might pass an entity that does have facts. We
    // shouldn't clobber its real factIds with an empty list.
    const facts = [makeSyncFact("anthropic", "f_aaa")];
    const entries = groupFactsByEntity(facts, ["anthropic"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].factIds).toEqual(["f_aaa"]);
  });

  it("returns empty array when no facts and no empty-entity list", () => {
    expect(groupFactsByEntity([])).toEqual([]);
  });
});

// ---- pruneFacts ----

describe("pruneFacts", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("sends entries grouped by entityId", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ deleted: 0, ids: [] }), { status: 200 }),
      );

    const items = [
      makeSyncFact("anthropic", "f_aaa"),
      makeSyncFact("anthropic", "f_bbb"),
      makeSyncFact("openai", "f_ccc"),
    ];

    await pruneFacts("http://localhost:3000", items);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/facts/prune");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.entries).toHaveLength(2);
    const anthropic = body.entries.find(
      (e: { entityId: string }) => e.entityId === "anthropic",
    );
    expect(anthropic.factIds).toEqual(["f_aaa", "f_bbb"]);
  });

  it("includes empty-fact entities so prune deletes their orphan facts (QUA-462)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            deleted: 3,
            ids: [
              { entityId: "constellation", factId: "f_old1" },
              { entityId: "constellation", factId: "f_old2" },
              { entityId: "constellation", factId: "f_old3" },
            ],
          }),
          { status: 200 },
        ),
      );

    // The QUA-462 case: constellation YAML was emptied, so loadAndTransformFacts
    // produces zero SyncFacts for it. Without entityIdsWithNoFacts, pruneFacts
    // would never tell the server about constellation, and the orphans stay.
    const result = await pruneFacts("http://localhost:3000", [], [
      "constellation",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.entries).toEqual([{ entityId: "constellation", factIds: [] }]);
    expect(result.deleted).toBe(3);
    expect(result.ids).toHaveLength(3);
  });

  it("returns deleted count and ids from server response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          deleted: 2,
          ids: [
            { entityId: "anthropic", factId: "stale1" },
            { entityId: "anthropic", factId: "stale2" },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await pruneFacts("http://localhost:3000", [
      makeSyncFact("anthropic", "f_keep"),
    ]);

    expect(result.deleted).toBe(2);
    expect(result.ids).toEqual([
      { entityId: "anthropic", factId: "stale1" },
      { entityId: "anthropic", factId: "stale2" },
    ]);
  });

  it("handles prune failure gracefully without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad Request", { status: 400 }),
    );

    const result = await pruneFacts("http://localhost:3000", [
      makeSyncFact("anthropic", "f_keep"),
    ]);

    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
  });

  it("returns zero with no fetches when there are no entries to prune", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await pruneFacts("http://localhost:3000", []);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
  });

  // QUA-462 regression: the constellation entity exists in the KB but its
  // factbase YAML was emptied (`facts: []`). Without entityIdsWithNoFacts,
  // pruneFacts has no signal that constellation should have its facts pruned,
  // and orphan PG rows leak forever (the QUA-447 alcohol-co incident).
  //
  // This test exercises the real KB loader against the real packages/factbase
  // data dir to make sure the empty-facts entity actually surfaces in
  // entityIdsWithNoFacts. If someone deletes constellation.yaml or repopulates
  // it, the assertion either no longer applies or means the test is stale —
  // the test logs a friendly note instead of silently passing.
  it("loadAndTransformFacts surfaces constellation as an empty-facts entity (QUA-462 regression)", async () => {
    const KB_DATA_DIR = join(__dirname, "../../packages/factbase/data");
    const { entityIdsWithNoFacts } = await loadAndTransformFacts(KB_DATA_DIR);

    // The entity stableId for constellation is sid_jwe4re7Ggo (data/entities/organizations.yaml).
    // If the KB no longer has constellation, this assertion will fail loudly
    // and an updater can substitute another empty-facts entity.
    expect(entityIdsWithNoFacts).toContain("sid_jwe4re7Ggo");
  });

  it("accumulates deleted counts across multiple batches", async () => {
    // Each batch returns 2 deletions; after 3 batches we expect 6 total.
    let callIndex = 0;
    const batches = [
      {
        deleted: 2,
        ids: [
          { entityId: "a", factId: "f1" },
          { entityId: "b", factId: "f1" },
        ],
      },
      {
        deleted: 2,
        ids: [
          { entityId: "c", factId: "f1" },
          { entityId: "d", factId: "f1" },
        ],
      },
      {
        deleted: 2,
        ids: [
          { entityId: "e", factId: "f1" },
          { entityId: "f", factId: "f1" },
        ],
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = batches[callIndex++] ?? { deleted: 0, ids: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const items = [
      makeSyncFact("a", "f_k"),
      makeSyncFact("b", "f_k"),
      makeSyncFact("c", "f_k"),
      makeSyncFact("d", "f_k"),
      makeSyncFact("e", "f_k"),
      makeSyncFact("f", "f_k"),
    ];
    const result = await pruneFacts("http://localhost:3000", items, [], {
      batchSize: 2,
    });
    expect(result.deleted).toBe(6);
    expect(result.ids).toHaveLength(6);
  });

  it("continues with remaining batches if one batch fails", async () => {
    // Batch 1 fails (400), batch 2 succeeds — pruneFacts should not abort.
    let callIndex = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return new Response("boom", { status: 400 });
      return new Response(
        JSON.stringify({
          deleted: 1,
          ids: [{ entityId: "b", factId: "stale" }],
        }),
        { status: 200 },
      );
    });

    const items = [makeSyncFact("a", "f_k"), makeSyncFact("b", "f_k")];
    const result = await pruneFacts("http://localhost:3000", items, [], {
      batchSize: 1,
    });
    expect(result.deleted).toBe(1);
    expect(result.ids).toEqual([{ entityId: "b", factId: "stale" }]);
  });

  it("batches entries when above batch size", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ deleted: 0, ids: [] }), { status: 200 }),
      );

    // 5 entities; batch size 2 → 3 requests.
    const items = [
      makeSyncFact("a", "f_1"),
      makeSyncFact("b", "f_1"),
      makeSyncFact("c", "f_1"),
      makeSyncFact("d", "f_1"),
      makeSyncFact("e", "f_1"),
    ];
    await pruneFacts("http://localhost:3000", items, [], { batchSize: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const sizes = fetchSpy.mock.calls.map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string).entries.length,
    );
    expect(sizes.sort()).toEqual([1, 2, 2]);
  });
});
