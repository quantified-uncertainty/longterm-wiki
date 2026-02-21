import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transformEntity, syncEntities, type SyncEntity } from "./sync-entities.ts";

const noSleep = async () => {};

function makeEntity(id: string, overrides: Partial<SyncEntity> = {}): SyncEntity {
  return {
    id,
    numericId: null,
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
    ...overrides,
  };
}

describe("transformEntity", () => {
  it("transforms a minimal YAML entity", () => {
    const result = transformEntity({
      id: "anthropic",
      type: "organization",
      title: "Anthropic",
    });

    expect(result).toEqual({
      id: "anthropic",
      numericId: null,
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
    });
  });

  it("transforms a fully-populated YAML entity", () => {
    const result = transformEntity({
      id: "anthropic",
      numericId: "E22",
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

    expect(result.id).toBe("anthropic");
    expect(result.numericId).toBe("E22");
    expect(result.entityType).toBe("organization");
    expect(result.title).toBe("Anthropic");
    expect(result.description).toBe("AI safety company");
    expect(result.tags).toEqual(["ai-safety", "frontier-lab"]);
    expect(result.customFields).toEqual([{ label: "Founded", value: "2021" }]);
    expect(result.relatedEntries).toEqual([{ id: "openai", type: "organization" }]);
    expect(result.sources).toEqual([{ title: "Website", url: "https://anthropic.com" }]);
  });

  it("resolves legacy entity type 'researcher' to 'person'", () => {
    const result = transformEntity({
      id: "yann-lecun",
      type: "researcher",
      title: "Yann LeCun",
    });
    expect(result.entityType).toBe("person");
  });

  it("resolves legacy entity type 'lab' to 'organization'", () => {
    const result = transformEntity({
      id: "deepmind",
      type: "lab",
      title: "DeepMind",
    });
    expect(result.entityType).toBe("organization");
  });

  it("resolves 'lab-frontier' to 'organization'", () => {
    const result = transformEntity({
      id: "openai",
      type: "lab-frontier",
      title: "OpenAI",
    });
    expect(result.entityType).toBe("organization");
  });

  it("resolves 'lab-research' to 'organization'", () => {
    const result = transformEntity({
      id: "miri",
      type: "lab-research",
      title: "MIRI",
    });
    expect(result.entityType).toBe("organization");
  });

  it("passes through unknown entity types unchanged", () => {
    const result = transformEntity({
      id: "custom-thing",
      type: "my-custom-type",
      title: "Custom",
    });
    expect(result.entityType).toBe("my-custom-type");
  });

  it("converts undefined optional fields to null", () => {
    const result = transformEntity({
      id: "test",
      type: "concept",
      title: "Test",
    });

    expect(result.numericId).toBeNull();
    expect(result.description).toBeNull();
    expect(result.website).toBeNull();
    expect(result.tags).toBeNull();
    expect(result.clusters).toBeNull();
    expect(result.status).toBeNull();
    expect(result.lastUpdated).toBeNull();
    expect(result.customFields).toBeNull();
    expect(result.relatedEntries).toBeNull();
    expect(result.sources).toBeNull();
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
