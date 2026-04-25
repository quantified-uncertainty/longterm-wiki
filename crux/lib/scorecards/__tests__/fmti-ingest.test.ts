/**
 * Integration-shape tests for the FMTI ingester orchestration.
 *
 * Exercises fetch-batching across multiple waves, --dry-run behavior,
 * indicator-enrichment from sibling waves, and unresolved-org reporting.
 *
 * Network is mocked via the injectable `fetchImpl` parameter so these tests
 * never touch GitHub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ingestFmtiWaves } from "../fmti-ingest.ts";
import { FMTI_WAVES } from "../fmti.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf-8");

const DEC2025_IND = fixture("dec2025-indicators-mini.csv");
const DEC2025_SCO = fixture("dec2025-scores-mini.csv");
const OCT2023 = fixture("oct2023-scores-mini.csv");

// Mock the wiki-server entity-matcher import — we don't want the test
// reading the real database.json. The matcher is consulted by the resolver
// but tests cover the empty-matcher path (everything goes through overrides
// or stub creation).
vi.mock("../../grant-import/entity-matcher.ts", async () => {
  return {
    buildEntityMatcher: () => ({
      allNames: new Map(),
      match: (_name: string) => null,
    }),
    normalizeGranteeName: (name: string) => name.trim(),
    matchGrantee: () => null,
  };
});

// Mock the wiki-server sync clients — non-dry-run paths shouldn't hit the
// network either.
vi.mock("../../wiki-server/scorecard-snapshots.ts", () => ({
  syncScorecardSnapshots: vi.fn(async (items: Array<Record<string, unknown>>) => ({
    ok: true,
    data: { upserted: items.length, verdictsWritten: 0, claimsLinked: 0 },
  })),
}));
vi.mock("../../wiki-server/scorecard-grades.ts", () => ({
  syncScorecardGrades: vi.fn(async (items: Array<Record<string, unknown>>) => ({
    ok: true,
    data: { upserted: items.length, verdictsWritten: 0, claimsLinked: 0 },
  })),
}));
vi.mock("../../wiki-server/entities.ts", () => ({
  syncEntities: vi.fn(async () => ({ ok: true, data: { upserted: 1 } })),
}));

// Override the wiki-server URL so getServerUrl() returns truthy.
vi.mock("../../wiki-server/client.ts", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getServerUrl: () => "https://example.invalid",
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mock fetch builder
// ---------------------------------------------------------------------------

function makeMockFetch(byUrl: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = byUrl[url];
    if (body == null) {
      return new Response(`not stubbed: ${url}`, { status: 404 });
    }
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const dec2025 = FMTI_WAVES.find((w) => w.snapshotId === "fmti-dec-2025")!;
const may2024 = FMTI_WAVES.find((w) => w.snapshotId === "fmti-may-2024")!;
const oct2023 = FMTI_WAVES.find((w) => w.snapshotId === "fmti-oct-2023")!;

const URL_DEC_IND = `https://raw.githubusercontent.com/stanford-crfm/fmti/main/${dec2025.pathPrefix}/${dec2025.indicatorsFile}`;
const URL_DEC_SCO = `https://raw.githubusercontent.com/stanford-crfm/fmti/main/${dec2025.pathPrefix}/${dec2025.scoresFile}`;
const URL_MAY_SCO = `https://raw.githubusercontent.com/stanford-crfm/fmti/main/${may2024.pathPrefix}/${may2024.scoresFile}`;
const URL_OCT_SCO = `https://raw.githubusercontent.com/stanford-crfm/fmti/main/${oct2023.pathPrefix}/${oct2023.scoresFile}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestFmtiWaves — single wave dry-run", () => {
  it("fetches Dec 2025 and emits unresolvedOrgs without --ensure-stubs", async () => {
    const fetchImpl = makeMockFetch({
      [URL_DEC_IND]: DEC2025_IND,
      [URL_DEC_SCO]: DEC2025_SCO,
    });

    const result = await ingestFmtiWaves({
      waveId: "fmti-dec-2025",
      dryRun: true,
      fetchImpl,
    });

    expect(result.errors).toEqual([]);
    expect(result.waves).toHaveLength(1);
    const w = result.waves[0];
    // Three orgs in fixture, none in (empty) matcher and no overrides match.
    expect(w.resolvedOrgs).toBe(0);
    expect(w.unresolvedOrgs.sort()).toEqual(["AcmeAI", "BetaLabs", "GammaCorp"]);
    expect(w.gradeCount).toBe(0);
    expect(w.dryRun).toBe(true);
    expect(w.syncResult).toBeNull();
    expect(w.snapshot.notes).toContain("Unresolved");
  });

  it("with --ensure-stubs, builds full grade rows for every org", async () => {
    const fetchImpl = makeMockFetch({
      [URL_DEC_IND]: DEC2025_IND,
      [URL_DEC_SCO]: DEC2025_SCO,
    });

    const result = await ingestFmtiWaves({
      waveId: "fmti-dec-2025",
      dryRun: true,
      ensureStubEntities: true,
      fetchImpl,
    });

    const w = result.waves[0];
    expect(w.resolvedOrgs).toBe(3);
    expect(w.unresolvedOrgs).toEqual([]);
    // 3 orgs × (5 indicators + 4 subdomains + 3 domains + 1 overall) = 39.
    expect(w.gradeCount).toBe(39);
  });

  it("propagates fetch errors as wave-scoped errors without aborting siblings", async () => {
    const fetchImpl = makeMockFetch({}); // no URLs stubbed

    const result = await ingestFmtiWaves({
      waveId: "fmti-dec-2025",
      dryRun: true,
      fetchImpl,
    });
    expect(result.waves).toHaveLength(0);
    expect(result.errors[0]).toMatch(/fmti-dec-2025/);
  });

  it("rejects unknown wave id", async () => {
    const result = await ingestFmtiWaves({
      waveId: "fmti-bogus",
      fetchImpl: makeMockFetch({}),
    });
    expect(result.waves).toEqual([]);
    expect(result.errors[0]).toMatch(/Unknown FMTI wave/);
  });
});

describe("ingestFmtiWaves — multi-wave + indicator enrichment", () => {
  it("borrows domain/subdomain from sibling waves when a wave lacks indicators-defs", async () => {
    // May 2024 has no indicators-defs file. Inject a reduced May 2024 scores
    // CSV whose indicator names overlap with Dec 2025 indicators so the
    // enrichment can match — the missing indicator gets a blank domain.
    const may2024Scores = [
      "Indicator,AcmeAI,BetaLabs",
      // matches Dec 2025
      "Data acquisition methods,1,0",
      "Compute usage,0,1",
      // does NOT match Dec 2025 — should fall through to overall
      "Mystery May indicator,1,1",
      "",
    ].join("\n");

    const fetchImpl = makeMockFetch({
      [URL_DEC_IND]: DEC2025_IND,
      [URL_DEC_SCO]: DEC2025_SCO,
      [URL_MAY_SCO]: may2024Scores,
    });

    const result = await ingestFmtiWaves({
      dryRun: true,
      ensureStubEntities: true,
      fetchImpl,
    });

    // Both waves should be present. (Oct 2023 not stubbed → error.)
    const may = result.waves.find((w) => w.waveId === "fmti-may-2024");
    expect(may, "May 2024 should be parsed").toBeDefined();
    // 2 orgs × (3 indicators + 2 subdomains [Data Acquisition, Compute] +
    // 1 domain [Upstream] + 1 overall) = 14. Mystery indicator has no
    // domain, so it adds a row but not subdomain/domain rollups.
    // = 2 × (3 + 2 + 1 + 1) = 14.
    expect(may!.gradeCount).toBe(14);
  });

  it("tags only the latest published wave with isLatest=true", async () => {
    const fetchImpl = makeMockFetch({
      [URL_DEC_IND]: DEC2025_IND,
      [URL_DEC_SCO]: DEC2025_SCO,
      [URL_OCT_SCO]: OCT2023,
    });

    const result = await ingestFmtiWaves({
      dryRun: true,
      ensureStubEntities: true,
      fetchImpl,
    });

    const dec = result.waves.find((w) => w.waveId === "fmti-dec-2025")!;
    const oct = result.waves.find((w) => w.waveId === "fmti-oct-2023")!;
    expect(dec.snapshot.isLatest).toBe(true);
    expect(oct.snapshot.isLatest).toBe(false);
  });
});

describe("ingestFmtiWaves — live mode", () => {
  it("calls the snapshot+grades sync endpoints once per wave", async () => {
    const fetchImpl = makeMockFetch({
      [URL_DEC_IND]: DEC2025_IND,
      [URL_DEC_SCO]: DEC2025_SCO,
    });

    const { syncScorecardSnapshots } = await import(
      "../../wiki-server/scorecard-snapshots.ts"
    );
    const { syncScorecardGrades } = await import(
      "../../wiki-server/scorecard-grades.ts"
    );

    const result = await ingestFmtiWaves({
      waveId: "fmti-dec-2025",
      dryRun: false,
      ensureStubEntities: true,
      fetchImpl,
    });

    const w = result.waves[0];
    expect(w.syncResult).not.toBeNull();
    expect(w.syncResult!.errors).toEqual([]);
    expect(w.syncResult!.snapshots).toBe(1);
    expect(w.syncResult!.grades).toBe(39);
    expect(syncScorecardSnapshots).toHaveBeenCalledTimes(1);
    expect(syncScorecardGrades).toHaveBeenCalledTimes(1);
  });
});
