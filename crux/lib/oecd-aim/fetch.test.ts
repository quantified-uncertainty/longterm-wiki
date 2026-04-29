/**
 * Tests for the OECD AIM fetch module.
 *
 * No live network — all fetch is injected via FetchOptions. Covers:
 *   - addDaysISO / daysBetween arithmetic edge cases
 *   - adaptive halving when a window has > MAX_NUM_RESULTS
 *   - dedup across overlapping recursive halves
 *   - the >100/single-day error path
 *   - detail endpoint id-format validation (defense against path injection)
 */

import { describe, it, expect } from "vitest";
import {
  addDaysISO,
  daysBetween,
  fetchAllIncidents,
  fetchIncidentDetail,
  MAX_NUM_RESULTS,
} from "./fetch.ts";
import type { OecdAimIncidentRaw } from "./transform.ts";

function mkInc(id: string, date: string): OecdAimIncidentRaw {
  return {
    id,
    title: `Incident ${id}`,
    articles: null,
    n_articles: 0,
    date,
    summary: "",
    properties: null,
    aiid_ids: [],
    language_counts: null,
    is_legacy: null,
  };
}

describe("date arithmetic", () => {
  it("addDaysISO handles month boundaries", () => {
    expect(addDaysISO("2024-01-31", 1)).toBe("2024-02-01");
    expect(addDaysISO("2024-02-29", 1)).toBe(
      "2024-03-01", // leap year
    );
    expect(addDaysISO("2025-02-28", 1)).toBe("2025-03-01");
  });

  it("addDaysISO accepts negatives", () => {
    expect(addDaysISO("2024-02-01", -1)).toBe("2024-01-31");
  });

  it("daysBetween is signed and inclusive of both endpoints", () => {
    expect(daysBetween("2024-01-01", "2024-01-08")).toBe(7);
    expect(daysBetween("2024-01-08", "2024-01-01")).toBe(-7);
    expect(daysBetween("2024-01-01", "2024-01-01")).toBe(0);
  });
});

describe("fetchAllIncidents — simple case", () => {
  it("walks a single window and returns all incidents", async () => {
    const fakeFetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          total_results: 2,
          incidents: [mkInc("2024-01-15-aaaa", "2024-01-15"), mkInc("2024-01-10-bbbb", "2024-01-10")],
        }),
        text: async () => "",
      } as unknown as Response;
    };

    const res = await fetchAllIncidents("2024-01-01", "2024-01-14", {
      fetchImpl: fakeFetch,
      delayMs: 0,
    });
    expect(res.incidents).toHaveLength(2);
    expect(res.incidents.map((i) => i.id).sort()).toEqual([
      "2024-01-10-bbbb",
      "2024-01-15-aaaa",
    ]);
    expect(res.windowSplits).toBe(0);
  });
});

describe("fetchAllIncidents — adaptive halving", () => {
  it("recursively halves windows that exceed MAX_NUM_RESULTS", async () => {
    let calls = 0;
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        from_date: string;
        to_date: string;
      };
      const span = daysBetween(body.from_date, body.to_date);
      // Pretend the full 13-day window has 200 results; halves have 50.
      const total = span >= 6 ? 200 : 50;
      const incidents = Array.from(
        { length: Math.min(total, MAX_NUM_RESULTS) },
        (_, i) => mkInc(`${body.from_date}-x${i.toString().padStart(3, "0")}`, body.from_date),
      );
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ total_results: total, incidents }),
        text: async () => "",
      } as unknown as Response;
    };

    const res = await fetchAllIncidents("2024-01-01", "2024-01-13", {
      fetchImpl: fakeFetch,
      delayMs: 0,
    });
    expect(res.windowSplits).toBeGreaterThan(0);
    // Each emitting slice (those returning total ≤ 100) emits 50 distinct
    // ids; recursion may produce a tree with multiple emitting leaves. Each
    // slice has a unique `from_date` so no dedup happens across leaves.
    expect(res.incidents.length).toBe(50 * res.windowSplits + 50);
    // Each split adds exactly two recursive calls; calls = 1 (top) + 2 per split.
    expect(calls).toBe(1 + 2 * res.windowSplits);
  });

  it("dedupes overlapping ids across recursive halves", async () => {
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        from_date: string;
        to_date: string;
      };
      const span = daysBetween(body.from_date, body.to_date);
      // Always return the SAME incident id regardless of slice — should be deduped.
      const incidents = [mkInc("2024-01-05-shared", "2024-01-05")];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          total_results: span > 1 ? 200 : 1,
          incidents,
        }),
        text: async () => "",
      } as unknown as Response;
    };

    const res = await fetchAllIncidents("2024-01-01", "2024-01-13", {
      fetchImpl: fakeFetch,
      delayMs: 0,
    });
    expect(res.incidents).toHaveLength(1);
    expect(res.incidents[0].id).toBe("2024-01-05-shared");
  });
});

describe("fetchAllIncidents — error paths", () => {
  it("throws when a single-day slice exceeds MAX_NUM_RESULTS", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        total_results: 999,
        incidents: Array.from({ length: 100 }, (_, i) => mkInc(`x${i}`, "2024-01-01")),
      }),
      text: async () => "",
    } as unknown as Response);

    await expect(
      fetchAllIncidents("2024-01-01", "2024-01-01", {
        fetchImpl: fakeFetch,
        delayMs: 0,
      }),
    ).rejects.toThrow(/single-day slice/);
  });

  it("throws when the upstream response has unexpected shape", async () => {
    const fakeFetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ wrong: true }),
        text: async () => "",
      }) as unknown as Response;

    await expect(
      fetchAllIncidents("2024-01-01", "2024-01-01", {
        fetchImpl: fakeFetch,
        delayMs: 0,
      }),
    ).rejects.toThrow(/unexpected shape/);
  });

  it("throws on non-OK response", async () => {
    const fakeFetch = async () =>
      ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
        text: async () => "boom",
      }) as unknown as Response;

    await expect(
      fetchAllIncidents("2024-01-01", "2024-01-01", {
        fetchImpl: fakeFetch,
        delayMs: 0,
      }),
    ).rejects.toThrow(/500/);
  });

  it("aborts when maxRequests is exceeded", async () => {
    const fakeFetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ total_results: 0, incidents: [] }),
        text: async () => "",
      }) as unknown as Response;

    await expect(
      fetchAllIncidents("2024-01-01", "2024-12-31", {
        fetchImpl: fakeFetch,
        delayMs: 0,
        maxRequests: 2,
      }),
    ).rejects.toThrow(/exceeded maxRequests/);
  });
});

describe("fetchIncidentDetail", () => {
  it("validates the AIM id format before sending the request", async () => {
    const fakeFetch = async () => {
      throw new Error("should not reach fetch");
    };
    await expect(
      fetchIncidentDetail("../../etc/passwd", { fetchImpl: fakeFetch }),
    ).rejects.toThrow(/malformed AIM id/);
    await expect(
      fetchIncidentDetail("not a valid id", { fetchImpl: fakeFetch }),
    ).rejects.toThrow(/malformed AIM id/);
  });

  it("accepts the live AIM id format YYYY-MM-DD-XXXX", async () => {
    let captured = "";
    const fakeFetch = async (url: string | URL | Request) => {
      captured = String(url);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "2024-06-15-abcd", articles: null, title: "x" }),
        text: async () => "",
      } as unknown as Response;
    };
    const res = await fetchIncidentDetail("2024-06-15-abcd", { fetchImpl: fakeFetch });
    expect(res.id).toBe("2024-06-15-abcd");
    expect(captured).toContain("2024-06-15-abcd");
  });
});
