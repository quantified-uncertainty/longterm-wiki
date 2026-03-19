import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectOrphans,
  fetchAllPgEntities,
  runCheck,
  PRUNE_SAFETY_THRESHOLD,
  type PgEntityRecord,
} from "./validate-orphan-entities.ts";

// Mock the YAML/KB loading functions used by loadYamlEntityIds.
// Default: returns empty entities. Tests override via mockYamlEntities().
vi.mock("../wiki-server/sync-entities.ts", () => ({
  loadEntityYamls: vi.fn(() => ({ entities: [], errorFiles: 0 })),
  loadKBOnlyEntities: vi.fn(() => []),
}));

import { loadEntityYamls } from "../wiki-server/sync-entities.ts";

// Helper to set up YAML mock with specific entity IDs
function mockYamlEntities(ids: string[]): void {
  vi.mocked(loadEntityYamls).mockReturnValue({
    entities: ids.map((id) => ({ id })) as any,
    errorFiles: 0,
  });
}

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

    const result = await fetchAllPgEntities();
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

    const result = await fetchAllPgEntities();
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

    const result = await fetchAllPgEntities();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("returns error on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await fetchAllPgEntities();
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

    const result = await fetchAllPgEntities();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// runCheck — integration (mocked YAML + network)
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    // Use clearAllMocks instead of restoreAllMocks to preserve the vi.mock()
    // module mock while clearing call counts and mockReturnValue overrides.
    vi.clearAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
    // Default: YAML has no entities (tests override as needed)
    mockYamlEntities([]);
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

  it("passes when all PG entities match YAML", async () => {
    mockYamlEntities(["anthropic", "openai"]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            { id: "anthropic", entityType: "organization", title: "Anthropic" },
            { id: "openai", entityType: "organization", title: "OpenAI" },
          ],
          total: 2,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it("fails when orphan entities are detected", async () => {
    // YAML has "anthropic" but PG has an extra entity not in YAML
    mockYamlEntities(["anthropic"]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            { id: "anthropic", entityType: "organization", title: "Anthropic" },
            { id: "ghost-policy", entityType: "policy", title: "Ghost Policy" },
          ],
          total: 2,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
  });

  it("fix mode passes when orphan type has no YAML entities (skipped, not pruned)", async () => {
    // YAML has no entities at all. PG has one orphan.
    // The orphan type "policy" has zero keepIds, so it's skipped entirely
    // (no pruning attempted, no safety abort).
    mockYamlEntities([]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: [
            { id: "ghost-policy", entityType: "policy", title: "Ghost Policy" },
          ],
          total: 1,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true, fix: true });
    // Passes because the orphan type has no YAML entities — the prune loop
    // skips it with a warning, and no safety threshold is triggered.
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it("fix mode fails when safety threshold blocks pruning due to partial YAML load", async () => {
    // Scenario: PG has 100 "organization" entities but YAML only loaded 5.
    // 95 would be pruned (95%), far exceeding the 20% threshold.
    // The prune should abort and --fix should report failure.
    mockYamlEntities(["org-1", "org-2", "org-3", "org-4", "org-5"]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // PG has 100 entities — 5 match YAML, 95 are orphans
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 100 }, (_, i) => ({
            id: `org-${i + 1}`,
            entityType: "organization",
            title: `Organization ${i + 1}`,
          })),
          total: 100,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true, fix: true });

    // The safety threshold (20%) should block pruning — 95% exceeds it
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThan(0);

    // Verify the prune endpoint was never called (only 1 fetch for listing)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fix mode passes when orphan percentage is below safety threshold", async () => {
    // Scenario: PG has 100 "organization" entities, YAML has 95.
    // Only 5 are orphans (5%), well below the 20% threshold.
    mockYamlEntities(
      Array.from({ length: 95 }, (_, i) => `org-${i + 1}`),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // PG has 100 entities — 95 match YAML, 5 are orphans
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 100 }, (_, i) => ({
            id: `org-${i + 1}`,
            entityType: "organization",
            title: `Organization ${i + 1}`,
          })),
          total: 100,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Prune endpoint succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deleted: 5,
          ids: ["org-96", "org-97", "org-98", "org-99", "org-100"],
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true, fix: true });

    // Below threshold, prune should proceed and pass
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);

    // Verify both list and prune endpoints were called
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fix mode handles exactly 20% orphan rate (boundary — allowed)", async () => {
    // Exactly at the boundary: 20 out of 100 are orphans (20%).
    // The threshold check is > 0.2, so exactly 20% should pass.
    mockYamlEntities(
      Array.from({ length: 80 }, (_, i) => `org-${i + 1}`),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 100 }, (_, i) => ({
            id: `org-${i + 1}`,
            entityType: "organization",
            title: `Organization ${i + 1}`,
          })),
          total: 100,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Prune endpoint succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deleted: 20,
          ids: Array.from({ length: 20 }, (_, i) => `org-${81 + i}`),
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true, fix: true });
    // Exactly 20% is at the boundary — should pass (threshold is >20%, not >=20%)
    expect(result.passed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fix mode blocks at 21% orphan rate (just above threshold)", async () => {
    // 21 out of 100 are orphans (21%) — just above the 20% threshold.
    mockYamlEntities(
      Array.from({ length: 79 }, (_, i) => `org-${i + 1}`),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: Array.from({ length: 100 }, (_, i) => ({
            id: `org-${i + 1}`,
            entityType: "organization",
            title: `Organization ${i + 1}`,
          })),
          total: 100,
          limit: 500,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true, fix: true });
    // 21% exceeds the 20% threshold — should fail
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThan(0);

    // Prune endpoint should NOT be called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("PRUNE_SAFETY_THRESHOLD is exported and set to 0.2", () => {
    expect(PRUNE_SAFETY_THRESHOLD).toBe(0.2);
  });
});
