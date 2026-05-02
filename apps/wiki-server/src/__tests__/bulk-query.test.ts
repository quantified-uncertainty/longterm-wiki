import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bulkQuery } from "../routes/shared/bulk-query.js";

describe("bulkQuery (QUA-1040)", () => {
  it("awaits the query and returns rows + total = rows.length", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await bulkQuery({ query: Promise.resolve(rows) });
    expect(result.rows).toEqual(rows);
    expect(result.total).toBe(3);
  });

  it("returns total = 0 for an empty result", async () => {
    const result = await bulkQuery({ query: Promise.resolve([]) });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("applies formatRow to every row", async () => {
    const raw = [{ id: 1, hidden: "secret" }, { id: 2, hidden: "secret" }];
    const result = await bulkQuery({
      query: Promise.resolve(raw),
      formatRow: (r) => ({ id: r.id }),
    });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    // Confirm raw shape was mapped, not leaked through
    expect((result.rows[0] as Record<string, unknown>).hidden).toBeUndefined();
  });

  it("preserves order from the underlying query", async () => {
    const raw = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const { rows } = await bulkQuery({ query: Promise.resolve(raw) });
    expect(rows.map((r) => (r as { id: string }).id)).toEqual(["c", "a", "b"]);
  });

  it("propagates query errors", async () => {
    const err = new Error("DB exploded");
    await expect(
      bulkQuery({ query: Promise.reject(err) }),
    ).rejects.toThrow("DB exploded");
  });

  it("logs a soft-limit warning when row count exceeds threshold", async () => {
    // Spy on the logger module so we don't depend on its actual implementation.
    const loggerModule = await import("../logger.js");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    try {
      const big = Array.from({ length: 11 }, (_, i) => ({ id: i }));
      await bulkQuery({
        query: Promise.resolve(big),
        routeName: "test/bulk",
        softLimit: 10,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [meta] = warnSpy.mock.calls[0];
      expect(meta).toMatchObject({ route: "test/bulk", rows: 11, softLimit: 10 });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when row count is at or below the soft limit", async () => {
    const loggerModule = await import("../logger.js");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    try {
      const small = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      await bulkQuery({
        query: Promise.resolve(small),
        routeName: "test/bulk",
        softLimit: 10,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
