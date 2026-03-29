import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  isSid,
  validateAllTables,
  type TableResult,
} from "./validate-sid-display.ts";

// ---------------------------------------------------------------------------
// Mock fetchAllRecords to avoid hitting the wiki-server
// ---------------------------------------------------------------------------

vi.mock("./validate-soft-fks.ts", () => ({
  fetchAllRecords: vi.fn(),
}));

import { fetchAllRecords } from "./validate-soft-fks.ts";
const mockFetchAllRecords = vi.mocked(fetchAllRecords);

beforeEach(() => {
  mockFetchAllRecords.mockReset();
});

// ---------------------------------------------------------------------------
// isSid unit tests
// ---------------------------------------------------------------------------

describe("isSid", () => {
  it("returns true for sid_-prefixed strings", () => {
    expect(isSid("sid_1LcLlMGLbw")).toBe(true);
    expect(isSid("sid_abc")).toBe(true);
    expect(isSid("sid_")).toBe(true);
  });

  it("returns false for non-sid_ strings", () => {
    expect(isSid("John Smith")).toBe(false);
    expect(isSid("anthropic")).toBe(false);
    expect(isSid("")).toBe(false);
    expect(isSid("SID_uppercase")).toBe(false);
    expect(isSid("xsid_not_prefix")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateAllTables — display name error detection
// ---------------------------------------------------------------------------

describe("validateAllTables", () => {
  it("detects sid_ in personDisplayName as error", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: "sid_1LcLlMGLbw",
        orgDisplayName: "Anthropic",
        personId: "john-smith",
        organizationId: "anthropic",
        personEntityId: "ent-123",
        orgEntityId: "ent-456",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
        maxLimit: 200,
      },
    ];

    const results = await validateAllTables(specs);
    expect(results).toHaveLength(1);
    expect(results[0].displayErrors).toHaveLength(1);
    expect(results[0].displayErrors[0]).toEqual({
      table: "personnel",
      recordId: "rec-1",
      field: "personDisplayName",
      value: "sid_1LcLlMGLbw",
    });
  });

  it("does not report human-readable display names", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: "John Smith",
        orgDisplayName: "Anthropic",
        personId: "john-smith",
        organizationId: "anthropic",
        personEntityId: "ent-123",
        orgEntityId: "ent-456",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
        maxLimit: 200,
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].displayErrors).toHaveLength(0);
    expect(results[0].idWarnings).toHaveLength(0);
  });

  it("does not report null display names", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: null,
        orgDisplayName: null,
        personId: "john-smith",
        organizationId: "anthropic",
        personEntityId: "ent-123",
        orgEntityId: "ent-456",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
        maxLimit: 200,
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].displayErrors).toHaveLength(0);
  });

  it("reports sid_ in raw ID with null entity FK as warning", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: "John Smith",
        orgDisplayName: "Anthropic",
        personId: "sid_1LcLlMGLbw",
        organizationId: "anthropic",
        personEntityId: null,
        orgEntityId: "ent-456",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
        maxLimit: 200,
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].displayErrors).toHaveLength(0);
    expect(results[0].idWarnings).toHaveLength(1);
    expect(results[0].idWarnings[0]).toEqual({
      table: "personnel",
      recordId: "rec-1",
      idField: "personId",
      idValue: "sid_1LcLlMGLbw",
      entityFkField: "personEntityId",
    });
  });

  it("does not warn for sid_ in raw ID when entity FK is resolved", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: "John Smith",
        orgDisplayName: "Anthropic",
        personId: "sid_1LcLlMGLbw",
        organizationId: "anthropic",
        personEntityId: "ent-resolved",
        orgEntityId: "ent-456",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
        maxLimit: 200,
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].idWarnings).toHaveLength(0);
  });

  it("detects errors across multiple tables", async () => {
    // First table: personnel with error
    // Second table: grants with error
    let callCount = 0;
    mockFetchAllRecords.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          {
            id: "p-1",
            personDisplayName: "sid_aaaaaaaaaa",
            orgDisplayName: "Good Corp",
            personId: "slug",
            organizationId: "org",
            personEntityId: "e1",
            orgEntityId: "e2",
          },
        ];
      }
      return [
        {
          id: "g-1",
          granteeDisplayName: "sid_bbbbbbbbbb",
          orgDisplayName: "Good Foundation",
          granteeId: "slug",
          organizationId: "org",
          granteeEntityId: "e3",
          orgEntityId: "e4",
        },
      ];
    });

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
      },
      {
        apiPath: "/api/grants/all",
        responseKey: "grants",
        displayFields: [
          { displayField: "granteeDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "granteeId", entityFkField: "granteeEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
      },
    ];

    const results = await validateAllTables(specs);
    expect(results).toHaveLength(2);
    expect(results[0].displayErrors).toHaveLength(1);
    expect(results[0].displayErrors[0].value).toBe("sid_aaaaaaaaaa");
    expect(results[1].displayErrors).toHaveLength(1);
    expect(results[1].displayErrors[0].value).toBe("sid_bbbbbbbbbb");
  });

  it("handles empty API response gracefully", async () => {
    mockFetchAllRecords.mockResolvedValue(null);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [{ displayField: "personDisplayName" }],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
        ],
      },
    ];

    const results = await validateAllTables(specs);
    expect(results).toHaveLength(1);
    expect(results[0].totalRecords).toBe(0);
    expect(results[0].displayErrors).toHaveLength(0);
    expect(results[0].idWarnings).toHaveLength(0);
  });

  it("handles undefined display name fields (field absent from record)", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        // personDisplayName is absent (undefined)
        orgDisplayName: "Good Corp",
        personId: "slug",
        organizationId: "org",
        personEntityId: "e1",
        orgEntityId: "e2",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].displayErrors).toHaveLength(0);
  });

  it("detects both display errors and ID warnings on the same record", async () => {
    mockFetchAllRecords.mockResolvedValue([
      {
        id: "rec-1",
        personDisplayName: "sid_display_bad",
        orgDisplayName: "Good Corp",
        personId: "sid_id_also_bad",
        organizationId: "org",
        personEntityId: null,
        orgEntityId: "e2",
      },
    ]);

    const specs = [
      {
        apiPath: "/api/personnel/all",
        responseKey: "personnel",
        displayFields: [
          { displayField: "personDisplayName" },
          { displayField: "orgDisplayName" },
        ],
        idFields: [
          { idField: "personId", entityFkField: "personEntityId" },
          { idField: "organizationId", entityFkField: "orgEntityId" },
        ],
      },
    ];

    const results = await validateAllTables(specs);
    expect(results[0].displayErrors).toHaveLength(1);
    expect(results[0].displayErrors[0].value).toBe("sid_display_bad");
    expect(results[0].idWarnings).toHaveLength(1);
    expect(results[0].idWarnings[0].idValue).toBe("sid_id_also_bad");
  });
});
