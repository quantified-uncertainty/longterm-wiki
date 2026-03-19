/**
 * Tests for resource reference validation.
 *
 * Unit tests with mocked API responses to verify the validation logic
 * without requiring a running wiki-server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResult } from "../lib/wiki-server/client.ts";

// Mock the apiRequest function so tests don't need a real wiki-server.
vi.mock("../lib/wiki-server/client.ts", () => ({
  apiRequest: vi.fn(),
  getServerUrl: vi.fn(() => "http://localhost:3002"),
  getApiKey: vi.fn(() => "test-key"),
  buildHeaders: vi.fn(() => ({ "Content-Type": "application/json" })),
}));

// Mock fs for loadPublicationIds
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("publications.yaml")) {
        return true;
      }
      return actual.existsSync(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (typeof path === "string" && path.includes("publications.yaml")) {
        return `
- id: nature
  domains: [nature.com]
  name: Nature
  type: academic_journal
  credibility: 5
- id: arxiv
  domains: [arxiv.org]
  name: arXiv
  type: preprint_server
  credibility: 2
- id: openai-blog
  domains: [openai.com/blog]
  name: OpenAI Blog
  type: company_blog
  credibility: 3
`;
      }
      return actual.readFileSync(path, encoding as BufferEncoding);
    }),
  };
});

import { apiRequest } from "../lib/wiki-server/client.ts";
import {
  validateResources,
  loadPublicationIds,
  runValidation,
  fetchAllRecords,
  buildEntityStableIdSet,
} from "./validate-resource-refs.ts";

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

// ---------------------------------------------------------------------------
// loadPublicationIds
// ---------------------------------------------------------------------------

describe("loadPublicationIds", () => {
  it("loads publication IDs from mocked YAML", () => {
    const ids = loadPublicationIds();
    expect(ids.has("nature")).toBe(true);
    expect(ids.has("arxiv")).toBe(true);
    expect(ids.has("openai-blog")).toBe(true);
    expect(ids.size).toBe(3);
  });

  it("does not include non-existent IDs", () => {
    const ids = loadPublicationIds();
    expect(ids.has("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchAllRecords
// ---------------------------------------------------------------------------

describe("fetchAllRecords", () => {
  it("returns records from a single page", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        resources: [
          { id: "res-001", authorEntityIds: null, publicationId: null },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/resources/all", "resources");
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("res-001");
  });

  it("paginates through multiple pages", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        data: {
          resources: [{ id: "a" }, { id: "b" }],
          total: 3,
        },
      } as ApiResult<Record<string, unknown>>)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          resources: [{ id: "c" }],
          total: 3,
        },
      } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/resources/all", "resources", 2);
    expect(result).toHaveLength(3);
    expect(result!.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("returns null when API is unavailable", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/resources/all", "resources");
    expect(result).toBeNull();
  });

  it("returns null when response key is missing", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { wrongKey: [] },
    } as ApiResult<Record<string, unknown>>);

    const result = await fetchAllRecords("/api/resources/all", "resources");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEntityStableIdSet
// ---------------------------------------------------------------------------

describe("buildEntityStableIdSet", () => {
  it("builds set of entity stableIds", async () => {
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

    const ids = await buildEntityStableIdSet();
    expect(ids).not.toBeNull();
    expect(ids!.has("ABCdef1234")).toBe(true);
    expect(ids!.has("XYZabc9876")).toBe(true);
    expect(ids!.size).toBe(2);
  });

  it("returns null on API failure", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "server down",
    } as ApiResult<Record<string, unknown>>);

    const ids = await buildEntityStableIdSet();
    expect(ids).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateResources — authorEntityIds
// ---------------------------------------------------------------------------

describe("validateResources — authorEntityIds", () => {
  const entityStableIds = new Set(["ABCdef1234", "XYZabc9876", "QWErty5678"]);
  const publicationIds = new Set(["nature", "arxiv"]);

  it("validates all authorEntityIds when all exist", () => {
    const resources = [
      {
        id: "res-001",
        authorEntityIds: ["ABCdef1234", "XYZabc9876"],
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.authorEntityIdRefs).toBe(2);
    expect(stats.validAuthorEntityIdRefs).toBe(2);
    expect(stats.invalidAuthorEntityIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });

  it("flags invalid authorEntityIds that don't exist in entities", () => {
    const resources = [
      {
        id: "res-002",
        authorEntityIds: ["ABCdef1234", "INVALID123"],
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.authorEntityIdRefs).toBe(2);
    expect(stats.validAuthorEntityIdRefs).toBe(1);
    expect(stats.invalidAuthorEntityIdRefs).toBe(1);
    expect(stats.unresolvedList).toHaveLength(1);
    expect(stats.unresolvedList[0]).toMatchObject({
      resourceId: "res-002",
      field: "authorEntityIds",
      value: "INVALID123",
    });
  });

  it("skips resources with null authorEntityIds", () => {
    const resources = [
      {
        id: "res-003",
        authorEntityIds: null,
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.authorEntityIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });

  it("skips resources with empty authorEntityIds array", () => {
    const resources = [
      {
        id: "res-004",
        authorEntityIds: [],
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.authorEntityIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });

  it("flags all invalid when none match", () => {
    const resources = [
      {
        id: "res-005",
        authorEntityIds: ["INVALID111", "INVALID222", "INVALID333"],
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.authorEntityIdRefs).toBe(3);
    expect(stats.validAuthorEntityIdRefs).toBe(0);
    expect(stats.invalidAuthorEntityIdRefs).toBe(3);
    expect(stats.unresolvedList).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// validateResources — publicationId
// ---------------------------------------------------------------------------

describe("validateResources — publicationId", () => {
  const entityStableIds = new Set(["ABCdef1234"]);
  const publicationIds = new Set(["nature", "arxiv", "openai-blog"]);

  it("validates publicationId when it exists in publications", () => {
    const resources = [
      {
        id: "res-010",
        authorEntityIds: null,
        publicationId: "nature",
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.publicationIdRefs).toBe(1);
    expect(stats.validPublicationIdRefs).toBe(1);
    expect(stats.invalidPublicationIdRefs).toBe(0);
  });

  it("flags invalid publicationId not in publications.yaml", () => {
    const resources = [
      {
        id: "res-011",
        authorEntityIds: null,
        publicationId: "nonexistent-pub",
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.publicationIdRefs).toBe(1);
    expect(stats.validPublicationIdRefs).toBe(0);
    expect(stats.invalidPublicationIdRefs).toBe(1);
    expect(stats.unresolvedList).toHaveLength(1);
    expect(stats.unresolvedList[0]).toMatchObject({
      resourceId: "res-011",
      field: "publicationId",
      value: "nonexistent-pub",
    });
  });

  it("skips null publicationId", () => {
    const resources = [
      {
        id: "res-012",
        authorEntityIds: null,
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.publicationIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });

  it("skips empty string publicationId", () => {
    const resources = [
      {
        id: "res-013",
        authorEntityIds: null,
        publicationId: "",
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.publicationIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateResources — combined
// ---------------------------------------------------------------------------

describe("validateResources — combined", () => {
  const entityStableIds = new Set(["ABCdef1234", "XYZabc9876"]);
  const publicationIds = new Set(["nature", "arxiv"]);

  it("validates both fields across multiple resources", () => {
    const resources = [
      {
        id: "res-020",
        authorEntityIds: ["ABCdef1234"],
        publicationId: "nature",
      },
      {
        id: "res-021",
        authorEntityIds: ["INVALID999"],
        publicationId: "invalid-pub",
      },
      {
        id: "res-022",
        authorEntityIds: null,
        publicationId: null,
      },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.totalResources).toBe(3);
    expect(stats.authorEntityIdRefs).toBe(2);
    expect(stats.validAuthorEntityIdRefs).toBe(1);
    expect(stats.invalidAuthorEntityIdRefs).toBe(1);
    expect(stats.publicationIdRefs).toBe(2);
    expect(stats.validPublicationIdRefs).toBe(1);
    expect(stats.invalidPublicationIdRefs).toBe(1);
    expect(stats.unresolvedList).toHaveLength(2);
  });

  it("handles resources with no reference fields at all", () => {
    const resources = [
      { id: "res-030" },
      { id: "res-031", authorEntityIds: null },
      { id: "res-032", publicationId: null },
    ];

    const stats = validateResources(resources, entityStableIds, publicationIds);
    expect(stats.totalResources).toBe(3);
    expect(stats.authorEntityIdRefs).toBe(0);
    expect(stats.publicationIdRefs).toBe(0);
    expect(stats.unresolvedList).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runValidation — integration with API mocking
// ---------------------------------------------------------------------------

describe("runValidation", () => {
  it("returns passed=true with null stats when entities API fails", async () => {
    // Entity lookup fails
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    } as ApiResult<Record<string, unknown>>);

    const result = await runValidation({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.stats).toBeNull();
  });

  it("returns passed=true with null stats when resources API fails", async () => {
    // Entity lookup succeeds
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        entities: [
          { id: "anthropic", stableId: "ABCdef1234" },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    // Resources API fails
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    } as ApiResult<Record<string, unknown>>);

    const result = await runValidation({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.stats).toBeNull();
  });

  it("validates resources when API returns data", async () => {
    // Entity lookup succeeds
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

    // Resources API succeeds
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        resources: [
          {
            id: "res-100",
            authorEntityIds: ["ABCdef1234", "INVALID999"],
            publicationId: "nature",
          },
          {
            id: "res-101",
            authorEntityIds: null,
            publicationId: "nonexistent",
          },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const result = await runValidation({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.stats).not.toBeNull();
    expect(result.stats!.totalResources).toBe(2);
    expect(result.stats!.authorEntityIdRefs).toBe(2);
    expect(result.stats!.validAuthorEntityIdRefs).toBe(1);
    expect(result.stats!.invalidAuthorEntityIdRefs).toBe(1);
    expect(result.stats!.publicationIdRefs).toBe(2);
    expect(result.stats!.validPublicationIdRefs).toBe(1);
    expect(result.stats!.invalidPublicationIdRefs).toBe(1);
    expect(result.stats!.unresolvedList).toHaveLength(2);
  });

  it("reports zero invalid refs when all references are valid", async () => {
    // Entity lookup succeeds
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        entities: [
          { id: "anthropic", stableId: "ABCdef1234" },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    // Resources with all valid refs
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        resources: [
          {
            id: "res-200",
            authorEntityIds: ["ABCdef1234"],
            publicationId: "arxiv",
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const result = await runValidation({ ci: true });
    expect(result.stats!.invalidAuthorEntityIdRefs).toBe(0);
    expect(result.stats!.invalidPublicationIdRefs).toBe(0);
    expect(result.stats!.unresolvedList).toHaveLength(0);
  });
});
