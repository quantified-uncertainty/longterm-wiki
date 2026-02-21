import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForHealthy, fetchWithRetry, syncPages } from "./sync-pages.ts";

const noSleep = async () => {};

// Minimal SyncPage for tests
function makePage(id: string) {
  return {
    id,
    numericId: null,
    title: `Page ${id}`,
    description: null,
    llmSummary: null,
    category: null,
    subcategory: null,
    entityType: null,
    tags: null,
    quality: null,
    readerImportance: null,
    hallucinationRiskLevel: null,
    hallucinationRiskScore: null,
    contentPlaintext: null,
    wordCount: null,
    lastUpdated: null,
    contentFormat: null,
  };
}

describe("waitForHealthy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when server responds healthy on first attempt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "healthy" }), { status: 200 })
    );

    const result = await waitForHealthy("http://localhost:3000", {
      maxRetries: 3,
      delayMs: 0,
      timeoutMs: 1000,
      _sleep: noSleep,
    });

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("retries and returns true when server becomes healthy on second attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "healthy" }), { status: 200 })
      );

    const result = await waitForHealthy("http://localhost:3000", {
      maxRetries: 3,
      delayMs: 0,
      timeoutMs: 1000,
      _sleep: noSleep,
    });

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns false after exhausting all retries", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await waitForHealthy("http://localhost:3000", {
      maxRetries: 3,
      delayMs: 0,
      timeoutMs: 1000,
      _sleep: noSleep,
    });

    expect(result).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("returns false when server returns 503", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    const result = await waitForHealthy("http://localhost:3000", {
      maxRetries: 2,
      delayMs: 0,
      timeoutMs: 1000,
      _sleep: noSleep,
    });

    expect(result).toBe(false);
  });

  it("returns false when server returns 200 but not healthy status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "starting" }), { status: 200 })
    );

    const result = await waitForHealthy("http://localhost:3000", {
      maxRetries: 2,
      delayMs: 0,
      timeoutMs: 1000,
      _sleep: noSleep,
    });

    expect(result).toBe(false);
  });

  it("calls sleep between retries", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED")
    );
    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await waitForHealthy("http://localhost:3000", {
      maxRetries: 3,
      delayMs: 5000,
      timeoutMs: 1000,
      _sleep: trackingSleep,
    });

    // Should sleep between attempts 1->2 and 2->3, but not after the last attempt
    expect(sleepCalls).toEqual([5000, 5000]);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns response on successful first attempt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const res = await fetchWithRetry(
      "http://localhost:3000/api/test",
      { method: "POST" },
      { maxAttempts: 3, _sleep: noSleep }
    );

    expect(res.status).toBe(200);
  });

  it("retries on 503 and succeeds on second attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Service Unavailable", { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const res = await fetchWithRetry(
      "http://localhost:3000/api/test",
      { method: "POST" },
      { maxAttempts: 3, baseDelayMs: 100, _sleep: noSleep }
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Bad Request", { status: 400 })
    );

    const res = await fetchWithRetry(
      "http://localhost:3000/api/test",
      { method: "POST" },
      { maxAttempts: 3, _sleep: noSleep }
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(
      fetchWithRetry(
        "http://localhost:3000/api/test",
        { method: "POST" },
        { maxAttempts: 3, _sleep: noSleep }
      )
    ).rejects.toThrow("HTTP 500");
  });

  it("throws after exhausting retries on network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED")
    );

    await expect(
      fetchWithRetry(
        "http://localhost:3000/api/test",
        { method: "POST" },
        { maxAttempts: 2, _sleep: noSleep }
      )
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("uses exponential backoff between retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad Gateway", { status: 502 })
    );
    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await fetchWithRetry(
      "http://localhost:3000/api/test",
      { method: "POST" },
      { maxAttempts: 4, baseDelayMs: 1000, _sleep: trackingSleep }
    ).catch(() => {});

    // Exponential: 1000 * 2^0 = 1000, 1000 * 2^1 = 2000, 1000 * 2^2 = 4000
    // (no sleep after last attempt)
    expect(sleepCalls).toEqual([1000, 2000, 4000]);
  });

  it("retries on network error then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const res = await fetchWithRetry(
      "http://localhost:3000/api/test",
      { method: "POST" },
      { maxAttempts: 3, _sleep: noSleep }
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("syncPages", () => {
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

  it("upserts all pages successfully", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ upserted: 2 }), { status: 200 })
    );

    const pages = [makePage("a"), makePage("b"), makePage("c"), makePage("d")];
    const result = await syncPages("http://localhost:3000", "key", pages, 2, {
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

    const pages = [makePage("a"), makePage("b"), makePage("c"), makePage("d")];
    const result = await syncPages("http://localhost:3000", "key", pages, 2, {
      _sleep: noSleep,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("surfaces parsed server error message from JSON 4xx/5xx response", async () => {
    const errorBody = JSON.stringify({
      error: "internal_error",
      message: "column \"nonexistent\" does not exist",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(errorBody, { status: 400 })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pages = [makePage("a")];
    await syncPages("http://localhost:3000", "key", pages, 10, {
      _sleep: noSleep,
    });

    // Should print both the raw body and the parsed server error message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 400")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      `    Server error: column "nonexistent" does not exist`
    );
  });

  it("fast-fails after 3 consecutive batch failures", async () => {
    // All fetches return 503 (after fetchWithRetry exhausts its retries, it throws)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    // 10 pages, batch size 2 = 5 batches. Should abort after 3.
    const pages = Array.from({ length: 10 }, (_, i) => makePage(`p${i}`));
    const result = await syncPages("http://localhost:3000", "key", pages, 2, {
      _sleep: noSleep,
    });

    // 3 batches failed (6 pages) + 4 remaining pages = 10 total errors
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

    const pages = [makePage("a"), makePage("b"), makePage("c"), makePage("d")];
    const result = await syncPages("http://localhost:3000", "key", pages, 1, {
      _sleep: noSleep,
    });

    // Non-consecutive failures: no fast-fail triggered
    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it("handles empty pages array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncPages("http://localhost:3000", "key", [], 50, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles batchSize larger than pages array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 3 }), { status: 200 })
    );

    const pages = [makePage("a"), makePage("b"), makePage("c")];
    const result = await syncPages("http://localhost:3000", "key", pages, 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ upserted: 3, errors: 0 });
  });
});
