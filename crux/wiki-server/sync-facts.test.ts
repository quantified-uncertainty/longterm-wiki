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
    expect(result.errors).toBe(0);
    expect(result.ids).toEqual([
      { entityId: "anthropic", factId: "stale1" },
      { entityId: "anthropic", factId: "stale2" },
    ]);
  });

  it("counts batch failures in errors and does not throw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad Request", { status: 400 }),
    );

    const result = await pruneFacts("http://localhost:3000", [
      makeSyncFact("anthropic", "f_keep"),
    ]);

    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
    // Per the review, silent 4xx used to lie about success — now the batch
    // error is counted and the caller surfaces it.
    expect(result.errors).toBe(1);
  });

  it("returns zero with no fetches when there are no entries to prune", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await pruneFacts("http://localhost:3000", []);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("throws a clear error when a single entity exceeds the per-entry factIds cap", () => {
    // Per the review: a silently-dropped oversized batch is exactly the
    // "falsely all-clear" failure mode QUA-462 is trying to prevent.
    const items: SyncFact[] = [];
    for (let i = 0; i < 2001; i++) {
      items.push(makeSyncFact("big-entity", `f_${i}`));
    }
    expect(() => groupFactsByEntity(items)).toThrow(/exceeding the per-entry cap/);
  });

  // QUA-462 regression: loadAndTransformFacts must surface entities that exist
  // in the KB but have no source facts in YAML, otherwise the prune endpoint
  // never hears about them and their orphan PG rows leak forever (the
  // QUA-447 alcohol-co incident). We exercise the real KB loader so the
  // integration between loadKB → loadAndTransformFacts → entityIdsWithNoFacts
  // is end-to-end tested. The assertion is count-based so it doesn't break
  // when the set of empty entities changes over time; a concrete sample is
  // logged for human-readable regression hints.
  it("loadAndTransformFacts surfaces empty-facts entities from the real KB (QUA-462 regression)", async () => {
    const KB_DATA_DIR = join(__dirname, "../../packages/factbase/data");
    const { facts, entityCount, entityIdsWithNoFacts } =
      await loadAndTransformFacts(KB_DATA_DIR);

    // Sanity: the real KB has at least a few hundred entities and some facts.
    expect(entityCount).toBeGreaterThan(100);
    expect(facts.length).toBeGreaterThan(100);

    // The load must surface at least one empty-facts entity. If every entity
    // in the KB has facts, this test is a no-op and someone should either
    // add an intentional empty fixture or delete this test. Failing loudly
    // when the signal disappears is better than silently passing.
    expect(entityIdsWithNoFacts.length).toBeGreaterThanOrEqual(1);
    // Belt-and-suspenders: log a sample for forensics if the assertion
    // shape ever drifts. Not asserted on because the set is not stable.
    const sample = entityIdsWithNoFacts.slice(0, 5);
    expect(sample.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
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
    expect(result.errors).toBe(1);
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

  // ---- QUA-930: cascade counts surface in PruneFactsOutcome ----

  it("aggregates cascade counts across batches (QUA-930)", async () => {
    let call = 0;
    const responses = [
      { deleted: 1, ids: [{ entityId: "a", factId: "f_1" }], cascaded: { verdicts: 2, evidence: 5, suggestions: 1 } },
      { deleted: 1, ids: [{ entityId: "b", factId: "f_1" }], cascaded: { verdicts: 0, evidence: 1, suggestions: 0 } },
      { deleted: 1, ids: [{ entityId: "c", factId: "f_1" }], cascaded: { verdicts: 3, evidence: 0, suggestions: 4 } },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(responses[call++]), { status: 200 }),
    );

    const items = [
      makeSyncFact("a", "f_1"),
      makeSyncFact("b", "f_1"),
      makeSyncFact("c", "f_1"),
    ];
    const result = await pruneFacts("http://localhost:3000", items, [], {
      batchSize: 1,
    });

    expect(result.deleted).toBe(3);
    expect(result.cascadedVerdicts).toBe(5); // 2 + 0 + 3
    expect(result.cascadedEvidence).toBe(6); // 5 + 1 + 0
    expect(result.cascadedSuggestions).toBe(5); // 1 + 0 + 4
  });

  it("defaults cascade counts to zero when server omits them (older server compat)", async () => {
    // Older server pre-QUA-930 returns only {deleted, ids, truncated}. The
    // client must not crash and should report zero cascade counts.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          deleted: 1,
          ids: [{ entityId: "anthropic", factId: "f_old" }],
        }),
        { status: 200 },
      ),
    );

    const items = [makeSyncFact("anthropic", "f_keep")];
    const result = await pruneFacts("http://localhost:3000", items);

    expect(result.deleted).toBe(1);
    expect(result.cascadedVerdicts).toBe(0);
    expect(result.cascadedEvidence).toBe(0);
    expect(result.cascadedSuggestions).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("returns zero cascade counts when entries is empty", async () => {
    const result = await pruneFacts("http://localhost:3000", [], []);
    expect(result.cascadedVerdicts).toBe(0);
    expect(result.cascadedEvidence).toBe(0);
    expect(result.cascadedSuggestions).toBe(0);
  });
});
