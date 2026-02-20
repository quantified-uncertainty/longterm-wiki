import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isServerAvailable, allocateId, allocateBatch } from "../id-client.mjs";

let originalFetch;
let savedEnv;

beforeEach(() => {
  originalFetch = global.fetch;
  savedEnv = {
    ID_SERVER_URL: process.env.ID_SERVER_URL,
    ID_SERVER_API_KEY: process.env.ID_SERVER_API_KEY,
  };
  // Default: no server configured
  delete process.env.ID_SERVER_URL;
  delete process.env.ID_SERVER_API_KEY;
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
    it("returns false when ID_SERVER_URL is not set", async () => {
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns true when server responds healthy", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });
      expect(await isServerAvailable()).toBe(true);
    });

    it("returns false when server responds unhealthy", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "degraded" }),
      });
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns false when fetch throws (network error)", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await isServerAvailable()).toBe(false);
    });

    it("returns false when server returns non-200", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      expect(await isServerAvailable()).toBe(false);
    });
  });

  describe("allocateId", () => {
    it("returns null when ID_SERVER_URL is not set", async () => {
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("returns parsed response on 201 (new ID)", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
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
      process.env.ID_SERVER_URL = "http://localhost:3100";
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
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("returns null on 500 response", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      expect(await allocateId("test-slug")).toBeNull();
    });

    it("sends Authorization header when API key is set", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
      process.env.ID_SERVER_API_KEY = "my-key";
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
    it("returns null when ID_SERVER_URL is not set", async () => {
      expect(await allocateBatch([{ slug: "a" }])).toBeNull();
    });

    it("returns results array on success", async () => {
      process.env.ID_SERVER_URL = "http://localhost:3100";
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
      process.env.ID_SERVER_URL = "http://localhost:3100";
      global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
      expect(await allocateBatch([{ slug: "a" }])).toBeNull();
    });
  });
});
