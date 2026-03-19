import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectOrphans,
  fetchAllPgEntities,
  runCheck,
  type PgEntityRecord,
  type OrphanEntity,
} from "./validate-orphan-entities.ts";

// ---------------------------------------------------------------------------
// detectOrphans — pure logic, no network
// ---------------------------------------------------------------------------

describe("detectOrphans", () => {
  it("returns empty array when all PG entities have YAML sources", () => {
    const yamlIds = new Set(["anthropic", "openai", "deepmind"]);
    const pgEntities: PgEntityRecord[] = [
      { id: "anthropic", entityType: "organization", title: "Anthropic" },
      { id: "openai", entityType: "organization", title: "OpenAI" },
      { id: "deepmind", entityType: "organization", title: "DeepMind" },
    ];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toEqual([]);
  });

  it("identifies PG entities without YAML sources", () => {
    const yamlIds = new Set(["anthropic", "openai"]);
    const pgEntities: PgEntityRecord[] = [
      { id: "anthropic", entityType: "organization", title: "Anthropic" },
      { id: "openai", entityType: "organization", title: "OpenAI" },
      { id: "ghost-policy", entityType: "policy", title: "Ghost Policy" },
      { id: "stale-model", entityType: "ai-model", title: "Stale Model" },
    ];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toHaveLength(2);
    expect(orphans).toContainEqual({
      id: "ghost-policy",
      entityType: "policy",
      title: "Ghost Policy",
      stableId: undefined,
    });
    expect(orphans).toContainEqual({
      id: "stale-model",
      entityType: "ai-model",
      title: "Stale Model",
      stableId: undefined,
    });
  });

  it("returns all PG entities as orphans when YAML set is empty", () => {
    const yamlIds = new Set<string>();
    const pgEntities: PgEntityRecord[] = [
      { id: "a", entityType: "concept", title: "A" },
      { id: "b", entityType: "concept", title: "B" },
    ];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toHaveLength(2);
  });

  it("returns empty array when PG has no entities", () => {
    const yamlIds = new Set(["anthropic", "openai"]);
    const pgEntities: PgEntityRecord[] = [];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toEqual([]);
  });

  it("preserves stableId in orphan records", () => {
    const yamlIds = new Set(["anthropic"]);
    const pgEntities: PgEntityRecord[] = [
      { id: "anthropic", entityType: "organization", title: "Anthropic", stableId: "aB1cD2eF3g" },
      { id: "ghost", entityType: "policy", title: "Ghost", stableId: "xY9zW8vU7t" },
    ];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].stableId).toBe("xY9zW8vU7t");
  });

  it("handles entities with null stableId", () => {
    const yamlIds = new Set(["anthropic"]);
    const pgEntities: PgEntityRecord[] = [
      { id: "no-stable", entityType: "policy", title: "No Stable", stableId: null },
    ];

    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].stableId).toBeNull();
  });

  it("matches entity IDs case-sensitively", () => {
    const yamlIds = new Set(["Anthropic"]);
    const pgEntities: PgEntityRecord[] = [
      { id: "anthropic", entityType: "organization", title: "Anthropic" },
    ];

    // "Anthropic" (YAML) !== "anthropic" (PG) — should be detected as orphan
    const orphans = detectOrphans(yamlIds, pgEntities);
    expect(orphans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAllPgEntities — pagination logic
// ---------------------------------------------------------------------------

describe("fetchAllPgEntities", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined)
      process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined)
      process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("fetches all entities when they fit in one page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            { id: "a", entityType: "concept", title: "A" },
            { id: "b", entityType: "concept", title: "B" },
          ],
          total: 2,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAllPgEntities("http://localhost:3000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe("a");
      expect(result.data[1].id).toBe("b");
    }
  });

  it("paginates through multiple pages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Page 1: 500 entities, total 700
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 500 }, (_, i) => ({
            id: `e${i}`,
            entityType: "concept",
            title: `Entity ${i}`,
          })),
          total: 700,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Page 2: 200 entities
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 200 }, (_, i) => ({
            id: `e${500 + i}`,
            entityType: "concept",
            title: `Entity ${500 + i}`,
          })),
          total: 700,
          limit: 500,
          offset: 500,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAllPgEntities("http://localhost:3000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(700);
    }

    // Verify two API calls were made
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const result = await fetchAllPgEntities("http://localhost:3000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("returns error on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await fetchAllPgEntities("http://localhost:3000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("server_error");
    }
  });

  it("returns empty array when PG has zero entities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAllPgEntities("http://localhost:3000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// runCheck — integration (mocked network)
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined)
      process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined)
      process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("passes when server URL is not configured (fail-open)", async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it("passes when server is unreachable (fail-open)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Connection refused"),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it("fails when orphan entities are detected", async () => {
    // Mock the PG API to return entities that include some not in YAML
    // We can't easily mock loadEntityYamls here without module mocking,
    // but we can verify the overall flow via the API mock.
    // The PG response will include many entities; the YAML set is loaded
    // from actual files. Any entities in PG that aren't in YAML are orphans.

    // Return a PG entity list with a definitely-fake entity
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            {
              id: "definitely-not-a-real-yaml-entity-12345",
              entityType: "policy",
              title: "Fake Ghost Policy",
            },
          ],
          total: 1,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
  });

  it("passes after fix mode prunes orphans", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First call: list entities — return a fake orphan
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            {
              id: "definitely-not-a-real-yaml-entity-99999",
              entityType: "policy",
              title: "Another Ghost",
            },
          ],
          total: 1,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Second call: prune endpoint — but since the orphan type has no YAML entities,
    // the prune is skipped with a warning. The check still passes because --fix was used.
    const result = await runCheck({ ci: true, fix: true });
    expect(result.passed).toBe(true);
  });
});
