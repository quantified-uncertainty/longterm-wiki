import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transformResource, syncResources, type SyncResource } from "./sync-resources.ts";

const noSleep = async () => {};

function makeResource(id: string): SyncResource {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Resource ${id}`,
    type: "web",
    summary: null,
    review: null,
    abstract: null,
    keyPoints: null,
    publicationId: null,
    authors: null,
    publishedDate: null,
    tags: null,
    localFilename: null,
    credibilityOverride: null,
    fetchedAt: null,
    contentHash: null,
    citedBy: null,
  };
}

describe("transformResource", () => {
  it("transforms a minimal YAML resource", () => {
    const result = transformResource({
      id: "abc123",
      url: "https://example.com/paper",
    });

    expect(result).toEqual({
      id: "abc123",
      url: "https://example.com/paper",
      title: null,
      type: null,
      summary: null,
      review: null,
      abstract: null,
      keyPoints: null,
      publicationId: null,
      authors: null,
      publishedDate: null,
      tags: null,
      localFilename: null,
      credibilityOverride: null,
      fetchedAt: null,
      contentHash: null,
      citedBy: null,
    });
  });

  it("transforms a fully-populated YAML resource", () => {
    const result = transformResource({
      id: "abc123",
      url: "https://example.com/paper",
      title: "A Paper",
      type: "paper",
      summary: "Summary text",
      review: "Review text",
      abstract: "Abstract text",
      key_points: ["Point 1", "Point 2"],
      publication_id: "nature",
      authors: ["Author A", "Author B"],
      published_date: "2025-01-15",
      tags: ["ai", "safety"],
      local_filename: "abc123.txt",
      credibility_override: 0.9,
      fetched_at: "2025-12-28 02:55:47",
      content_hash: "deadbeef",
      cited_by: ["page-a", "page-b"],
    });

    expect(result.id).toBe("abc123");
    expect(result.title).toBe("A Paper");
    expect(result.type).toBe("paper");
    expect(result.keyPoints).toEqual(["Point 1", "Point 2"]);
    expect(result.publicationId).toBe("nature");
    expect(result.authors).toEqual(["Author A", "Author B"]);
    expect(result.publishedDate).toBe("2025-01-15");
    expect(result.tags).toEqual(["ai", "safety"]);
    expect(result.localFilename).toBe("abc123.txt");
    expect(result.credibilityOverride).toBe(0.9);
    expect(result.fetchedAt).toBe("2025-12-28T02:55:47Z");
    expect(result.contentHash).toBe("deadbeef");
    expect(result.citedBy).toEqual(["page-a", "page-b"]);
  });

  it("normalizes Date objects in published_date", () => {
    const result = transformResource({
      id: "abc",
      url: "https://example.com",
      published_date: new Date("2025-06-15T00:00:00Z"),
    });

    expect(result.publishedDate).toBe("2025-06-15");
  });

  it("normalizes Date objects in fetched_at", () => {
    const result = transformResource({
      id: "abc",
      url: "https://example.com",
      fetched_at: new Date("2025-12-28T02:55:47Z"),
    });

    expect(result.fetchedAt).toBe("2025-12-28T02:55:47.000Z");
  });

  it("normalizes date-only fetched_at strings", () => {
    const result = transformResource({
      id: "abc",
      url: "https://example.com",
      fetched_at: "2025-12-28",
    });

    expect(result.fetchedAt).toBe("2025-12-28T00:00:00Z");
  });

  it("returns null for unparseable fetched_at strings", () => {
    const result = transformResource({
      id: "abc",
      url: "https://example.com",
      fetched_at: "not-a-date",
    });

    expect(result.fetchedAt).toBeNull();
  });

  it("returns null for unparseable published_date strings", () => {
    const result = transformResource({
      id: "abc",
      url: "https://example.com",
      published_date: "bad-date",
    });

    expect(result.publishedDate).toBeNull();
  });
});

describe("syncResources", () => {
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

  it("upserts all resources successfully", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ upserted: 2 }), { status: 200 })
    );

    const items = [makeResource("a"), makeResource("b"), makeResource("c"), makeResource("d")];
    const result = await syncResources("http://localhost:3000", items, 2, {
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

    const items = [makeResource("a"), makeResource("b"), makeResource("c"), makeResource("d")];
    const result = await syncResources("http://localhost:3000", items, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("fast-fails after 3 consecutive batch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    // 10 resources, batch size 2 = 5 batches. Should abort after 3.
    const items = Array.from({ length: 10 }, (_, i) => makeResource(`r${i}`));
    const result = await syncResources("http://localhost:3000", items, 2, {
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

    const items = [makeResource("a"), makeResource("b"), makeResource("c"), makeResource("d")];
    const result = await syncResources("http://localhost:3000", items, 1, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("handles empty items array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncResources("http://localhost:3000", [], 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles batchSize larger than items array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 3 }), { status: 200 })
    );

    const items = [makeResource("a"), makeResource("b"), makeResource("c")];
    const result = await syncResources("http://localhost:3000", items, 200, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 3, errors: 0 });
  });

  it("sends correct payload to /api/resources/batch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 })
    );

    const items = [makeResource("test-id")];
    await syncResources("http://localhost:3000", items, 100, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/resources/batch",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"test-id"'),
      })
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(callBody.items).toHaveLength(1);
    expect(callBody.items[0].id).toBe("test-id");
    expect(callBody.items[0].url).toBe("https://example.com/test-id");
  });
});
