/**
 * Tests for soft FK validation.
 *
 * Unit tests with mocked API responses to verify the validation logic
 * without requiring a running wiki-server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResult } from "../lib/wiki-server/client.ts";

// We mock the apiRequest function so tests don't need a real wiki-server.
vi.mock("../lib/wiki-server/client.ts", () => ({
  apiRequest: vi.fn(),
  getServerUrl: vi.fn(() => "http://localhost:3002"),
  getApiKey: vi.fn(() => "test-key"),
  buildHeaders: vi.fn(() => ({ "Content-Type": "application/json" })),
}));

// Import after mocking
import { apiRequest } from "../lib/wiki-server/client.ts";
import {
  validateTable,
  buildEntityLookup,
  buildDivisionIdSet,
  fetchAllRecords,
  TABLE_SPECS,
  type TableSpec,
  type TableStats,
} from "./validate-soft-fks.ts";

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

// ---------------------------------------------------------------------------
// fetchAllRecords
// ---------------------------------------------------------------------------

describe("fetchAllRecords", () => {
  it("returns records from a single page", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        personnel: [
          { id: "abc1234567", personId: "jane-doe", organizationId: "anthropic" },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/personnel/all", "personnel");
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("abc1234567");
  });

  it("paginates through multiple pages", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [{ id: "a" }, { id: "b" }],
          total: 3,
        },
      } as ApiResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [{ id: "c" }],
          total: 3,
        },
      } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/test/all", "items", 2);
    expect(result).toHaveLength(3);
    expect(result!.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("returns null when API is unavailable", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/test/all", "items");
    expect(result).toBeNull();
  });

  it("returns null when response key is missing", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { wrongKey: [] },
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/test/all", "items");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEntityLookup
// ---------------------------------------------------------------------------

describe("buildEntityLookup", () => {
  it("builds slug and stableId sets from entity data", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        entities: [
          { id: "anthropic", stableId: "ABCdef1234" },
          { id: "openai", stableId: "XYZabc9876" },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const lookup = await buildEntityLookup();
    expect(lookup).not.toBeNull();
    expect(lookup!.slugs.has("anthropic")).toBe(true);
    expect(lookup!.slugs.has("openai")).toBe(true);
    expect(lookup!.stableIds.has("ABCdef1234")).toBe(true);
    expect(lookup!.stableIds.has("XYZabc9876")).toBe(true);
    expect(lookup!.combined.has("anthropic")).toBe(true);
    expect(lookup!.combined.has("ABCdef1234")).toBe(true);
  });

  it("returns null on API failure", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "server down",
    } as ApiResult<Record<string, unknown>>);

    const lookup = await buildEntityLookup();
    expect(lookup).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildDivisionIdSet
// ---------------------------------------------------------------------------

describe("buildDivisionIdSet", () => {
  it("builds set of division IDs", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        divisions: [
          { id: "div1234567" },
          { id: "div9876543" },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const ids = await buildDivisionIdSet();
    expect(ids).not.toBeNull();
    expect(ids!.has("div1234567")).toBe(true);
    expect(ids!.has("div9876543")).toBe(true);
    expect(ids!.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateTable
// ---------------------------------------------------------------------------

describe("validateTable", () => {
  const entityLookup = new Set(["anthropic", "openai", "ABCdef1234", "XYZabc9876", "jane-doe"]);
  const divisionIds = new Set(["div1234567"]);

  it("counts all references as resolved when entity IDs match", async () => {
    const spec: TableSpec = {
      apiPath: "/api/personnel/all",
      responseKey: "personnel",
      fields: [
        { legacyField: "personId", resolvedField: "personEntityId", entityType: "person" },
        { legacyField: "organizationId", resolvedField: "orgEntityId", entityType: "organization" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        personnel: [
          {
            id: "rec1",
            personId: "jane-doe",
            organizationId: "anthropic",
            personEntityId: "ABCdef1234",
            orgEntityId: "XYZabc9876",
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRecords).toBe(1);
    expect(stats.totalRefs).toBe(2);
    expect(stats.resolvedRefs).toBe(2);
    expect(stats.unresolvedRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });

  it("resolves via legacy field slug when resolvedField FK is NULL", async () => {
    const spec: TableSpec = {
      apiPath: "/api/personnel/all",
      responseKey: "personnel",
      fields: [
        { legacyField: "personId", resolvedField: "personEntityId", entityType: "person" },
        { legacyField: "organizationId", resolvedField: "orgEntityId", entityType: "organization" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        personnel: [
          {
            id: "rec2",
            personId: "jane-doe", // in entityLookup
            organizationId: "anthropic", // in entityLookup
            personEntityId: null,
            orgEntityId: null,
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRefs).toBe(2);
    expect(stats.resolvedRefs).toBe(2);
    expect(stats.unresolvedRefs).toBe(0);
  });

  it("flags unresolved references when slug not in entity lookup", async () => {
    const spec: TableSpec = {
      apiPath: "/api/personnel/all",
      responseKey: "personnel",
      fields: [
        { legacyField: "personId", resolvedField: "personEntityId", entityType: "person" },
        { legacyField: "organizationId", resolvedField: "orgEntityId", entityType: "organization" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        personnel: [
          {
            id: "rec3",
            personId: "unknown-person",
            organizationId: "unknown-org",
            personEntityId: null,
            orgEntityId: null,
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRefs).toBe(2);
    expect(stats.resolvedRefs).toBe(0);
    expect(stats.unresolvedRefs).toBe(2);
    expect(stats.unresolvedList).toHaveLength(2);
    expect(stats.unresolvedList[0]).toMatchObject({
      table: "personnel",
      recordId: "rec3",
      field: "personId",
      value: "unknown-person",
    });
  });

  it("flags display names as unresolved", async () => {
    const spec: TableSpec = {
      apiPath: "/api/personnel/all",
      responseKey: "personnel",
      fields: [
        { legacyField: "personId", resolvedField: "personEntityId", entityType: "person" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        personnel: [
          {
            id: "rec4",
            personId: "new:John Smith",
            personEntityId: null,
          },
          {
            id: "rec5",
            personId: "Jane M. Doe",
            personEntityId: null,
          },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRefs).toBe(2);
    expect(stats.unresolvedRefs).toBe(2);
    // Both display names counted as unresolved
    expect(stats.unresolvedList[0].value).toBe("new:John Smith");
    expect(stats.unresolvedList[1].value).toBe("Jane M. Doe");
  });

  it("skips null/empty fields", async () => {
    const spec: TableSpec = {
      apiPath: "/api/grants/all",
      responseKey: "grants",
      fields: [
        { legacyField: "granteeId", resolvedField: "granteeEntityId", entityType: "organization" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        grants: [
          { id: "g1", granteeId: null, granteeEntityId: null },
          { id: "g2", granteeId: "", granteeEntityId: null },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRecords).toBe(2);
    expect(stats.totalRefs).toBe(0);
    expect(stats.unresolvedRefs).toBe(0);
  });

  it("validates division references against division IDs", async () => {
    const spec: TableSpec = {
      apiPath: "/api/division-personnel/all",
      responseKey: "divisionPersonnel",
      fields: [
        { legacyField: "divisionId" },
        { legacyField: "personId", entityType: "person" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        divisionPersonnel: [
          { id: "dp1", divisionId: "div1234567", personId: "jane-doe" },
          { id: "dp2", divisionId: "nonexistent", personId: "unknown-person" },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRefs).toBe(4);
    expect(stats.resolvedRefs).toBe(2); // div1234567 + jane-doe
    expect(stats.unresolvedRefs).toBe(2); // nonexistent + unknown-person
  });

  it("returns empty stats when API returns null (server unavailable)", async () => {
    const spec: TableSpec = {
      apiPath: "/api/personnel/all",
      responseKey: "personnel",
      fields: [
        { legacyField: "personId", resolvedField: "personEntityId" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRecords).toBe(0);
    expect(stats.totalRefs).toBe(0);
    expect(stats.unresolvedRefs).toBe(0);
  });

  it("handles mixed resolved and unresolved in a single table", async () => {
    const spec: TableSpec = {
      apiPath: "/api/investments/all",
      responseKey: "investments",
      fields: [
        { legacyField: "companyId", resolvedField: "companyEntityId", entityType: "organization" },
        { legacyField: "investorId", resolvedField: "investorEntityId", entityType: "organization" },
      ],
    };

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        investments: [
          {
            id: "inv1",
            companyId: "anthropic",
            investorId: "google",
            companyEntityId: "ABCdef1234",
            investorEntityId: null,
          },
          {
            id: "inv2",
            companyId: "openai",
            investorId: "microsoft",
            companyEntityId: null,
            investorEntityId: null,
          },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const stats = await validateTable(spec, entityLookup, divisionIds);
    expect(stats.totalRecords).toBe(2);
    expect(stats.totalRefs).toBe(4);
    // inv1.companyId resolved via resolvedField, inv2.companyId resolved via slug
    // inv1.investorId "google" not in lookup, inv2.investorId "microsoft" not in lookup
    expect(stats.resolvedRefs).toBe(2);
    expect(stats.unresolvedRefs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TABLE_SPECS coverage
// ---------------------------------------------------------------------------

describe("TABLE_SPECS", () => {
  it("includes all expected PG tables", () => {
    const tables = TABLE_SPECS.map((s) => s.responseKey);
    expect(tables).toContain("personnel");
    expect(tables).toContain("grants");
    expect(tables).toContain("fundingRounds");
    expect(tables).toContain("investments");
    expect(tables).toContain("equityPositions");
    expect(tables).toContain("divisions");
    expect(tables).toContain("divisionPersonnel");
    expect(tables).toContain("fundingPrograms");
    expect(tables).toContain("benchmarkResults");
  });

  it("each spec has at least one field", () => {
    for (const spec of TABLE_SPECS) {
      expect(spec.fields.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("each spec has valid API path and response key", () => {
    for (const spec of TABLE_SPECS) {
      expect(spec.apiPath).toMatch(/^\/api\//);
      expect(spec.responseKey.length).toBeGreaterThan(0);
    }
  });
});
