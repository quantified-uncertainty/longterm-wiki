import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isServerAvailable, allocateId, allocateBatch, allocateIds } from "../id-client.mjs";

let originalFetch;
let savedEnv;

beforeEach(() => {
  originalFetch = global.fetch;
  savedEnv = {
    LONGTERMWIKI_SERVER_URL: process.env.LONGTERMWIKI_SERVER_URL,
    LONGTERMWIKI_SERVER_API_KEY: process.env.LONGTERMWIKI_SERVER_API_KEY,
  };
  // Default: no server configured
  delete process.env.LONGTERMWIKI_SERVER_URL;
  delete process.env.LONGTERMWIKI_SERVER_API_KEY;
});

afterEach(() => {
  global.fetch = originalFetch;
  // Restore env
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("id-client", () => {
  describe("isServerAvailable", () => {
    it("returns false when LONGTERMWIKI_SERVER_URL is not set", async () => {
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns true when server responds healthy", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });
      expect(await isServerAvailable()).toBe(true);
    });

    it("returns false when server responds unhealthy", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "degraded" }),
      });
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns false when fetch throws (network error)", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns false when server returns non-200", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      expect(await isServerAvailable()).toBe(false);
    });
  });

  describe("allocateId", () => {
    it("returns null when LONGTERMWIKI_SERVER_URL is not set", async () => {
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("returns parsed response on 201 (new ID)", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            numericId: "E886",
            slug: "test-slug",
            created: true,
            createdAt: "2026-01-01T00:00:00Z",
          }),
      });
      const result = await allocateId("test-slug");
      expect(result).toEqual({ numericId: "E886", created: true });
    });

    it("returns parsed response on 200 (existing ID)", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            numericId: "E42",
            slug: "existing-slug",
            created: false,
            createdAt: "2025-06-01T00:00:00Z",
          }),
      });
      const result = await allocateId("existing-slug");
      expect(result).toEqual({ numericId: "E42", created: false });
    });

    it("returns null on network error", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("returns null on 500 response", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("sends Authorization header when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      process.env.LONGTERMWIKI_SERVER_API_KEY = "my-key";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            numericId: "E886",
            slug: "test",
            created: true,
          }),
      });
      await allocateId("test");

      const call = global.fetch.mock.calls[0];
      expect(call[1].headers.Authorization).toBe("Bearer my-key");
    });
  });

  describe("allocateBatch", () => {
    it("returns null when LONGTERMWIKI_SERVER_URL is not set", async () => {
      expect(await allocateBatch([{ slug: "a" }])).toBeNull();
    });

    it("returns results array on success", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      const mockResults = [
        { numericId: "E886", slug: "a", created: true },
        { numericId: "E887", slug: "b", created: true },
      ];
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: mockResults }),
      });
      const result = await allocateBatch([{ slug: "a" }, { slug: "b" }]);
      expect(result).toEqual(mockResults);
    });

    it("returns null on failure", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
      expect(await allocateBatch([{ slug: "a" }])).toBeNull();
    });
  });

  describe("allocateIds", () => {
    it("returns a Map of slug → numericId", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              { numericId: "E100", slug: "alpha", created: true },
              { numericId: "E101", slug: "beta", created: true },
            ],
          }),
      });
      const result = await allocateIds(["alpha", "beta"]);
      expect(result).toBeInstanceOf(Map);
      expect(result.get("alpha")).toBe("E100");
      expect(result.get("beta")).toBe("E101");
    });

    it("returns empty Map for empty input", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      const result = await allocateIds([]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("chunks large batches into groups of 50", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      // Create 75 slugs — should result in 2 fetch calls (50 + 25)
      const slugs = Array.from({ length: 75 }, (_, i) => `slug-${i}`);
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        callCount++;
        const body = JSON.parse(opts.body);
        const results = body.items.map((item, idx) => ({
          numericId: `E${callCount * 100 + idx}`,
          slug: item.slug,
          created: true,
        }));
        return { ok: true, json: () => Promise.resolve({ results }) };
      });

      const result = await allocateIds(slugs);
      expect(result.size).toBe(75);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      // First batch: 50 items, second batch: 25 items
      const firstCall = JSON.parse(global.fetch.mock.calls[0][1].body);
      const secondCall = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(firstCall.items).toHaveLength(50);
      expect(secondCall.items).toHaveLength(25);
    });

    it("throws when a batch request fails", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      await expect(allocateIds(["fail-slug"])).rejects.toThrow(
        "Batch allocation failed"
      );
    });

    it("throws when a batch request returns null (network error)", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
      await expect(allocateIds(["fail-slug"])).rejects.toThrow(
        "Batch allocation failed"
      );
    });

    it("throws when second chunk fails (partial batch failure)", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      // 60 slugs → chunk 1 (50) succeeds, chunk 2 (10) fails
      const slugs = Array.from({ length: 60 }, (_, i) => `slug-${i}`);
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        callCount++;
        if (callCount === 2) {
          return { ok: false, status: 500 };
        }
        const body = JSON.parse(opts.body);
        const results = body.items.map((item, idx) => ({
          numericId: `E${idx}`,
          slug: item.slug,
          created: true,
        }));
        return { ok: true, json: () => Promise.resolve({ results }) };
      });

      await expect(allocateIds(slugs)).rejects.toThrow("Batch allocation failed");
    });

    it("throws when server omits a slug from the response", async () => {
      process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            // Only returns result for "alpha", omits "beta"
            results: [{ numericId: "E100", slug: "alpha", created: true }],
          }),
      });
      await expect(allocateIds(["alpha", "beta"])).rejects.toThrow(
        "Batch allocation missing results for slugs: beta"
      );
    });
  });
});
