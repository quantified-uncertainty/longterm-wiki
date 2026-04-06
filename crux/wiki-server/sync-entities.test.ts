import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transformEntity, syncEntities, pruneEntities, mergeExpertData, loadExperts, type SyncEntity } from "./sync-entities.ts";

const noSleep = async () => {};

function makeEntity(id: string, overrides: Partial<SyncEntity> = {}): SyncEntity {
  return {
    id,
    stableId: `test${id}`.slice(0, 10).padEnd(10, "0"),
    wikiId: null,
    entityType: "organization",
    title: `Entity ${id}`,
    description: null,
    website: null,
    tags: null,
    clusters: null,
    status: null,
    lastUpdated: null,
    customFields: null,
    relatedEntries: null,
    sources: null,
    metadata: null,
    ...overrides,
  };
}

describe("transformEntity", () => {
  it("transforms a YAML entity with stableId", () => {
    const result = transformEntity({
      id: "anthropic",
      stableId: "aB1cD2eF3g",
      type: "organization",
      title: "Anthropic",
    });

    expect(result).toEqual({
      id: "anthropic",
      stableId: "aB1cD2eF3g",
      wikiId: null,
      entityType: "organization",
      title: "Anthropic",
      description: null,
      website: null,
      tags: null,
      clusters: null,
      status: null,
      lastUpdated: null,
      customFields: null,
      relatedEntries: null,
      sources: null,
      metadata: null,
    });
  });

  it("returns null for entities without stableId", () => {
    const result = transformEntity({
      id: "anthropic",
      type: "organization",
      title: "Anthropic",
    });

    expect(result).toBeNull();
  });

  it("transforms a fully-populated YAML entity", () => {
    const result = transformEntity({
      id: "anthropic",
      stableId: "aB1cD2eF3g",
      wikiId: "E22",
      type: "organization",
      title: "Anthropic",
      description: "AI safety company",
      website: "https://anthropic.com",
      tags: ["ai-safety", "frontier-lab"],
      clusters: ["ai-labs"],
      status: "active",
      lastUpdated: "2025-06",
      customFields: [{ label: "Founded", value: "2021" }],
      relatedEntries: [{ id: "openai", type: "organization" }],
      sources: [{ title: "Website", url: "https://anthropic.com" }],
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("anthropic");
    expect(result!.stableId).toBe("aB1cD2eF3g");
    expect(result!.wikiId).toBe("E22");
    expect(result!.entityType).toBe("organization");
    expect(result!.title).toBe("Anthropic");
    expect(result!.description).toBe("AI safety company");
    expect(result!.tags).toEqual(["ai-safety", "frontier-lab"]);
    expect(result!.customFields).toEqual([{ label: "Founded", value: "2021" }]);
    expect(result!.relatedEntries).toEqual([{ id: "openai", type: "organization" }]);
    expect(result!.sources).toEqual([{ title: "Website", url: "https://anthropic.com" }]);
  });

  it("resolves legacy entity type 'researcher' to 'person'", () => {
    const result = transformEntity({
      id: "yann-lecun",
      stableId: "yL1234abcd",
      type: "researcher",
      title: "Yann LeCun",
    });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("person");
  });

  it("resolves legacy entity type 'lab' to 'organization'", () => {
    const result = transformEntity({
      id: "deepmind",
      stableId: "dM5678efgh",
      type: "lab",
      title: "DeepMind",
    });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("organization");
  });

  it("resolves 'lab-frontier' to 'organization'", () => {
    const result = transformEntity({
      id: "openai",
      stableId: "oA9012ijkl",
      type: "lab-frontier",
      title: "OpenAI",
    });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("organization");
  });

  it("resolves 'lab-research' to 'organization'", () => {
    const result = transformEntity({
      id: "miri",
      stableId: "mI3456mnop",
      type: "lab-research",
      title: "MIRI",
    });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("organization");
  });

  it("passes through unknown entity types unchanged", () => {
    const result = transformEntity({
      id: "custom-thing",
      stableId: "cT7890qrst",
      type: "my-custom-type",
      title: "Custom",
    });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("my-custom-type");
  });

  it("extracts type-specific fields into metadata", () => {
    const result = transformEntity({
      id: "anthropic",
      stableId: "aB1cD2eF3g",
      type: "organization",
      title: "Anthropic",
      orgType: "frontier-lab",
      summaryPage: "labs-overview",
    });

    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual({
      orgType: "frontier-lab",
      summaryPage: "labs-overview",
    });
  });

  it("extracts AI model metadata fields", () => {
    const result = transformEntity({
      id: "gpt-4",
      stableId: "gP4uvwxyz1",
      type: "ai-model",
      title: "GPT-4",
      developer: "openai",
      releaseDate: "2023-03-14",
      contextWindow: 128000,
    });

    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual({
      developer: "openai",
      releaseDate: "2023-03-14",
      contextWindow: 128000,
    });
  });

  it("converts undefined optional fields to null", () => {
    const result = transformEntity({
      id: "test",
      stableId: "tS2345abcd",
      type: "concept",
      title: "Test",
    });

    expect(result).not.toBeNull();
    expect(result!.wikiId).toBeNull();
    expect(result!.description).toBeNull();
    expect(result!.website).toBeNull();
    expect(result!.tags).toBeNull();
    expect(result!.clusters).toBeNull();
    expect(result!.status).toBeNull();
    expect(result!.lastUpdated).toBeNull();
    expect(result!.customFields).toBeNull();
    expect(result!.relatedEntries).toBeNull();
    expect(result!.sources).toBeNull();
    expect(result!.metadata).toBeNull();
  });
});

describe("mergeExpertData", () => {
  it("merges expert positions, knownFor, affiliation, and role into metadata", () => {
    const entity = makeEntity("dario-amodei", { entityType: "person", metadata: null });
    const experts = new Map([
      ["dario-amodei", {
        id: "dario-amodei",
        name: "Dario Amodei",
        affiliation: "anthropic",
        role: "Co-founder & CEO",
        knownFor: ["Constitutional AI", "Responsible Scaling Policy"],
        positions: [
          { topic: "timelines", view: "Very short", estimate: "2026-2027", confidence: "medium", date: "2025" },
        ],
      }],
    ]);
    const result = mergeExpertData(entity, experts);

    expect(result.metadata).toEqual({
      expertPositions: [
        { topic: "timelines", view: "Very short", estimate: "2026-2027", confidence: "medium", date: "2025" },
      ],
      knownFor: ["Constitutional AI", "Responsible Scaling Policy"],
      affiliation: "anthropic",
      expertRole: "Co-founder & CEO",
    });
  });

  it("merges expert data with existing metadata", () => {
    const entity = makeEntity("dario-amodei", {
      entityType: "person",
      metadata: { orgType: "frontier-lab" },
    });
    const experts = new Map([
      ["dario-amodei", {
        id: "dario-amodei",
        name: "Dario Amodei",
        affiliation: "anthropic",
        role: "CEO",
      }],
    ]);
    const result = mergeExpertData(entity, experts);

    expect(result.metadata).toEqual({
      orgType: "frontier-lab",
      affiliation: "anthropic",
      expertRole: "CEO",
    });
  });

  it("does not modify entity if no expert data or pub count exists", () => {
    const entity = makeEntity("openai", { entityType: "organization", metadata: { orgType: "lab" } });
    const experts = new Map<string, { id: string; name: string }>();
    const result = mergeExpertData(entity, experts);

    expect(result.metadata).toEqual({ orgType: "lab" });
  });

  it("skips empty positions and knownFor arrays", () => {
    const entity = makeEntity("sparse-expert", { entityType: "person", metadata: null });
    const experts = new Map([
      ["sparse-expert", {
        id: "sparse-expert",
        name: "Sparse Expert",
        affiliation: "some-org",
        knownFor: [],
        positions: [],
      }],
    ]);
    const result = mergeExpertData(entity, experts);

    expect(result.metadata).toEqual({
      affiliation: "some-org",
    });
    // No expertPositions or knownFor keys since arrays were empty
    expect(result.metadata).not.toHaveProperty("expertPositions");
    expect(result.metadata).not.toHaveProperty("knownFor");
  });
});

describe("loadExperts", () => {
  it("returns empty map for non-existent file", () => {
    const result = loadExperts("/nonexistent/path.yaml");
    expect(result.size).toBe(0);
  });
});

describe("syncEntities", () => {
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

  it("upserts all entities successfully", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ upserted: 2 }), { status: 200 })
    );

    const items = [makeEntity("a"), makeEntity("b"), makeEntity("c"), makeEntity("d")];
    const result = await syncEntities("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 4, errors: 0 });
  });

  it("counts errors for failed batches", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upserted: 2 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 })
      );

    const items = [makeEntity("a"), makeEntity("b"), makeEntity("c"), makeEntity("d")];
    const result = await syncEntities("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("fast-fails after 3 consecutive batch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    // 10 entities, batch size 2 = 5 batches. Should abort after 3.
    const items = Array.from({ length: 10 }, (_, i) => makeEntity(`e${i}`));
    const result = await syncEntities("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(10);
  });

  it("resets consecutive failure count on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Batch 1: fails (503 -> throw after retries)
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

    const items = [makeEntity("a"), makeEntity("b"), makeEntity("c"), makeEntity("d")];
    const result = await syncEntities("http://localhost:3000", items, 1, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("handles empty items array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncEntities("http://localhost:3000", [], 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends correct payload to /api/entities/sync", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 })
    );

    const items = [makeEntity("anthropic", { title: "Anthropic" })];
    await syncEntities("http://localhost:3000", items, 100, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/entities/sync",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"anthropic"'),
      })
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(callBody.entities).toHaveLength(1);
    expect(callBody.entities[0].id).toBe("anthropic");
    expect(callBody.entities[0].title).toBe("Anthropic");
  });
});

describe("pruneEntities", () => {
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

  it("sends one prune request per entity type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: 0, ids: [] }), { status: 200 })
    );

    const items = [
      makeEntity("anthropic", { entityType: "organization" }),
      makeEntity("openai", { entityType: "organization" }),
      makeEntity("rsp", { entityType: "policy" }),
    ];

    await pruneEntities("http://localhost:3000", items);

    // Should send 2 prune requests — one for organization, one for policy
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const calls = fetchSpy.mock.calls;
    const bodies = calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string)
    );

    const orgBody = bodies.find((b) => b.entityType === "organization");
    const policyBody = bodies.find((b) => b.entityType === "policy");

    expect(orgBody).toBeDefined();
    expect(orgBody.keepIds).toEqual(expect.arrayContaining(["anthropic", "openai"]));
    expect(orgBody.keepIds).toHaveLength(2);

    expect(policyBody).toBeDefined();
    expect(policyBody.keepIds).toEqual(["rsp"]);
  });

  it("returns deleted count and ids from server response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ deleted: 2, ids: ["stale-a", "stale-b"] }),
        { status: 200 }
      )
    );

    const items = [makeEntity("good", { entityType: "organization" })];
    const result = await pruneEntities("http://localhost:3000", items);

    expect(result.deleted).toBe(2);
    expect(result.ids).toEqual(["stale-a", "stale-b"]);
  });

  it("handles prune failure gracefully without throwing", async () => {
    // Use 400 (client error) to avoid fetchWithRetry's 5xx retry loop
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad Request", { status: 400 })
    );

    const items = [makeEntity("good", { entityType: "organization" })];
    const result = await pruneEntities("http://localhost:3000", items);

    // Should not throw; returns zero deletions
    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
  });

  it("returns zero when no stale entities exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: 0, ids: [] }), { status: 200 })
    );

    const items = [makeEntity("a", { entityType: "policy" })];
    const result = await pruneEntities("http://localhost:3000", items);

    expect(result.deleted).toBe(0);
    expect(result.ids).toEqual([]);
  });
});
