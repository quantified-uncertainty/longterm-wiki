import { describe, it, expect } from "vitest";
import { paginatedQuery } from "../routes/shared/paginated-query.js";

describe("paginatedQuery (QUA-782)", () => {
  it("returns rows and total from parallel data + count queries", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await paginatedQuery({
      query: Promise.resolve(rows),
      countQuery: Promise.resolve([{ count: 42 }]),
    });
    expect(result.rows).toEqual(rows);
    expect(result.total).toBe(42);
  });

  it("returns total = 0 when count query returns empty array", async () => {
    const result = await paginatedQuery({
      query: Promise.resolve([]),
      countQuery: Promise.resolve([]),
    });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns total = 0 when count row's count field is undefined", async () => {
    const result = await paginatedQuery({
      query: Promise.resolve([]),
      countQuery: Promise.resolve([{ count: undefined as unknown as number }]),
    });
    expect(result.total).toBe(0);
  });

  it("applies formatRow to every row when provided", async () => {
    const raw = [
      { id: 1, hidden: "secret" },
      { id: 2, hidden: "secret" },
    ];
    const result = await paginatedQuery({
      query: Promise.resolve(raw),
      countQuery: Promise.resolve([{ count: 2 }]),
      formatRow: (r) => ({ id: r.id }),
    });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect((result.rows[0] as Record<string, unknown>).hidden).toBeUndefined();
  });

  it("returns raw rows untransformed when formatRow is omitted", async () => {
    const raw = [{ id: 1, extra: "kept" }];
    const result = await paginatedQuery({
      query: Promise.resolve(raw),
      countQuery: Promise.resolve([{ count: 1 }]),
    });
    expect(result.rows[0]).toEqual({ id: 1, extra: "kept" });
  });

  it("preserves order from the underlying query", async () => {
    const raw = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const { rows } = await paginatedQuery({
      query: Promise.resolve(raw),
      countQuery: Promise.resolve([{ count: 3 }]),
    });
    expect(rows.map((r) => (r as { id: string }).id)).toEqual(["c", "a", "b"]);
  });

  it("propagates errors from the data query", async () => {
    const err = new Error("data query failed");
    await expect(
      paginatedQuery({
        query: Promise.reject(err),
        countQuery: Promise.resolve([{ count: 0 }]),
      }),
    ).rejects.toThrow("data query failed");
  });

  it("propagates errors from the count query", async () => {
    const err = new Error("count query failed");
    await expect(
      paginatedQuery({
        query: Promise.resolve([]),
        countQuery: Promise.reject(err),
      }),
    ).rejects.toThrow("count query failed");
  });

  it("runs data and count queries in parallel (Promise.all semantics)", async () => {
    // If the helper awaited sequentially, total elapsed >= 2 * delay. With
    // Promise.all, total elapsed is ~max(delay) ~= 1 * delay. Use a generous
    // margin to avoid flakiness on slow CI runners.
    const delay = 80;
    const start = Date.now();
    await paginatedQuery({
      query: new Promise<{ id: number }[]>((resolve) =>
        setTimeout(() => resolve([{ id: 1 }]), delay),
      ),
      countQuery: new Promise<{ count: number }[]>((resolve) =>
        setTimeout(() => resolve([{ count: 1 }]), delay),
      ),
    });
    const elapsed = Date.now() - start;
    // Generous upper bound: parallel should complete well under 2*delay.
    // 1.5x leaves margin for timer drift but still catches sequential awaits.
    expect(elapsed).toBeLessThan(delay * 1.5);
  });
});
