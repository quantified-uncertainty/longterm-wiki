import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock wiki-server before importing the module under test
vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
}));

import { fetchAllPaginated } from "../fetch-paginated";
import { fetchDetailed } from "@lib/wiki-server";
import type { FetchResult } from "@lib/wiki-server";

const mockFetchDetailed = vi.mocked(fetchDetailed);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAllPaginated", () => {
  it("returns all items when they fit in a single page", async () => {
    mockFetchDetailed.mockResolvedValueOnce({
      ok: true,
      data: { items: [{ id: 1 }, { id: 2 }], total: 2 },
    } as FetchResult<Record<string, unknown>>);

    const result = await fetchAllPaginated<{ id: number }>({
      path: "/api/things",
      itemsKey: "items",
      pageSize: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.data.total).toBe(2);
      expect(result.data.pagesFetched).toBe(1);
    }
    expect(mockFetchDetailed).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple pages in parallel and concatenates results", async () => {
    // First page: total=5, pageSize=2 → 3 pages needed
    mockFetchDetailed
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ id: 1 }, { id: 2 }], total: 5 },
      } as FetchResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ id: 3 }, { id: 4 }], total: 5 },
      } as FetchResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ id: 5 }], total: 5 },
      } as FetchResult<Record<string, unknown>>);

    const result = await fetchAllPaginated<{ id: number }>({
      path: "/api/things",
      itemsKey: "items",
      pageSize: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 },
      ]);
      expect(result.data.total).toBe(5);
      expect(result.data.pagesFetched).toBe(3);
    }
    expect(mockFetchDetailed).toHaveBeenCalledTimes(3);
  });

  it("fails if the first page fails", async () => {
    mockFetchDetailed.mockResolvedValueOnce({
      ok: false,
      error: { type: "server-error", status: 500, statusText: "Internal Server Error" },
    } as FetchResult<Record<string, unknown>>);

    const result = await fetchAllPaginated<{ id: number }>({
      path: "/api/things",
      itemsKey: "items",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("server-error");
    }
  });

  it("fails if any intermediate page fails (no silent partial data)", async () => {
    mockFetchDetailed
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ id: 1 }], total: 3 },
      } as FetchResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: false,
        error: { type: "connection-error", message: "timeout" },
      } as FetchResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ id: 3 }], total: 3 },
      } as FetchResult<Record<string, unknown>>);

    const result = await fetchAllPaginated<{ id: number }>({
      path: "/api/things",
      itemsKey: "items",
      pageSize: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("connection-error");
    }
  });

  it("fails if response lacks the expected items key", async () => {
    mockFetchDetailed.mockResolvedValueOnce({
      ok: true,
      data: { wrongKey: [{ id: 1 }], total: 1 },
    } as FetchResult<Record<string, unknown>>);

    const result = await fetchAllPaginated<{ id: number }>({
      path: "/api/things",
      itemsKey: "items",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("connection-error");
      expect((result.error as { message: string }).message).toContain("items");
    }
  });

  it("appends extraParams to the URL", async () => {
    mockFetchDetailed.mockResolvedValueOnce({
      ok: true,
      data: { claims: [{ id: 1 }], total: 1 },
    } as FetchResult<Record<string, unknown>>);

    await fetchAllPaginated<{ id: number }>({
      path: "/api/claims/all",
      itemsKey: "claims",
      extraParams: "includeSources=true",
      pageSize: 500,
    });

    expect(mockFetchDetailed).toHaveBeenCalledWith(
      "/api/claims/all?limit=500&offset=0&includeSources=true",
      expect.any(Object)
    );
  });

  it("passes revalidate and timeoutMs to fetchDetailed", async () => {
    mockFetchDetailed.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0 },
    } as FetchResult<Record<string, unknown>>);

    await fetchAllPaginated({
      path: "/api/things",
      itemsKey: "items",
      revalidate: 60,
      timeoutMs: 5000,
    });

    expect(mockFetchDetailed).toHaveBeenCalledWith(
      expect.any(String),
      { revalidate: 60, timeoutMs: 5000 }
    );
  });
});
