/**
 * Tests for fetchInlineSourcing — QUA-677.
 *
 * Verifies that:
 *   - whole-row verdicts are mapped by recordId
 *   - per-field verdicts (fieldName !== null) are skipped
 *   - `unchecked` and other non-attachable verdict values are skipped
 *   - pagination continues until a short page is returned
 *   - non-ok API responses throw
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListVerdicts } = vi.hoisted(() => ({
  mockListVerdicts: vi.fn(),
}));
vi.mock("./sourcing-client.ts", () => ({
  listVerdicts: mockListVerdicts,
}));

import { fetchInlineSourcing } from "./inline-sourcing.ts";

type Verdict = {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  displayName: string | null;
  entityDisplayName: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string;
  createdAt: string;
  updatedAt: string;
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    recordType: "division",
    recordId: "r1",
    fieldName: null,
    entityId: null,
    displayName: null,
    entityDisplayName: null,
    verdict: "confirmed",
    confidence: 0.9,
    reasoning: "Verified against primary source",
    sourcesChecked: 1,
    needsRecheck: false,
    nextCheckDue: null,
    lastComputedAt: "2026-04-24T00:00:00.000Z",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("fetchInlineSourcing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps whole-row verdicts by recordId", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          verdict({ recordId: "a", verdict: "confirmed" }),
          verdict({ recordId: "b", verdict: "contradicted" }),
        ],
        total: 2,
      },
    });
    const map = await fetchInlineSourcing("division");
    expect(map.size).toBe(2);
    expect(map.get("a")?.verdict).toBe("confirmed");
    expect(map.get("b")?.verdict).toBe("contradicted");
  });

  it("skips per-field verdicts (fieldName !== null)", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          verdict({ recordId: "a", fieldName: null }),
          verdict({ recordId: "b", fieldName: "lead" }),
        ],
        total: 2,
      },
    });
    const map = await fetchInlineSourcing("division");
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
  });

  it("skips unchecked and other non-attachable verdicts", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          verdict({ recordId: "a", verdict: "unchecked" }),
          verdict({ recordId: "b", verdict: "confirmed" }),
          verdict({ recordId: "c", verdict: "bogus" }),
        ],
        total: 3,
      },
    });
    const map = await fetchInlineSourcing("division");
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(false);
  });

  it("populates confidence, checkedAt, and evidence from the row", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          verdict({
            recordId: "a",
            verdict: "partial",
            confidence: 0.6,
            reasoning: "Partial evidence found.",
            lastComputedAt: "2026-04-24T12:00:00.000Z",
          }),
        ],
        total: 1,
      },
    });
    const map = await fetchInlineSourcing("division");
    const s = map.get("a");
    expect(s).toEqual({
      verdict: "partial",
      confidence: 0.6,
      evidence: "Partial evidence found.",
      checkedAt: "2026-04-24T12:00:00.000Z",
    });
  });

  it("omits optional fields when the row has null values", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          verdict({
            recordId: "a",
            confidence: null,
            reasoning: null,
          }),
        ],
        total: 1,
      },
    });
    const map = await fetchInlineSourcing("division");
    const s = map.get("a")!;
    expect(s.verdict).toBe("confirmed");
    expect(s).not.toHaveProperty("confidence");
    expect(s).not.toHaveProperty("evidence");
  });

  it("paginates until a short page is returned", async () => {
    // Full page of 200 → request another page → empty page ends pagination
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      verdict({ recordId: `a${i}` }),
    );
    mockListVerdicts
      .mockResolvedValueOnce({ ok: true, data: { verdicts: fullPage, total: 201 } })
      .mockResolvedValueOnce({
        ok: true,
        data: { verdicts: [verdict({ recordId: "final" })], total: 201 },
      });
    const map = await fetchInlineSourcing("division");
    expect(map.size).toBe(201);
    expect(map.has("final")).toBe(true);
    expect(mockListVerdicts).toHaveBeenCalledTimes(2);
    expect(mockListVerdicts.mock.calls[0][0]).toEqual({
      recordType: "division",
      limit: 200,
      offset: 0,
    });
    expect(mockListVerdicts.mock.calls[1][0]).toEqual({
      recordType: "division",
      limit: 200,
      offset: 200,
    });
  });

  it("stops pagination on a short page without an extra request", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [verdict({ recordId: "only" })], total: 1 },
    });
    const map = await fetchInlineSourcing("division");
    expect(map.size).toBe(1);
    expect(mockListVerdicts).toHaveBeenCalledTimes(1);
  });

  it("throws when the API returns an error", async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: false,
      error: { status: 500, code: "server_error" },
      message: "boom",
    });
    await expect(fetchInlineSourcing("division")).rejects.toThrow(/boom/);
  });

  it("includes the offset in error messages so mid-pagination failures are debuggable", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      verdict({ recordId: `x${i}` }),
    );
    mockListVerdicts
      .mockResolvedValueOnce({ ok: true, data: { verdicts: fullPage, total: 400 } })
      .mockResolvedValueOnce({
        ok: false,
        error: { status: 503 },
        message: "unavailable",
      });
    await expect(fetchInlineSourcing("division")).rejects.toThrow(/offset=200/);
  });
});
