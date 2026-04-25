/**
 * Sync engine tests (QUA-698).
 *
 * Exercises the resolver/payload/dry-run pipeline with synthetic adapters
 * and a hand-built EntityMatcher — no network, no fixture files needed.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSnapshot,
  snapshotToPayload,
  gradeToPayload,
  syncSource,
  analyzeSource,
} from "../sync.ts";
import type {
  RawGrade,
  RawSnapshot,
  ScorecardSourceAdapter,
} from "../types.ts";
import type { OrgResolverContext } from "../org-aliases.ts";
import type { EntityMatcher } from "../../grant-import/types.ts";

function makeMatcher(map: Record<string, string>): EntityMatcher {
  const nameMap = new Map(
    Object.entries(map).map(([name, stableId]) => [
      name.toLowerCase(),
      { stableId, slug: name, name },
    ]),
  );
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

function makeCtx(
  matchMap: Record<string, string>,
  overrides: Record<string, string> = {},
): OrgResolverContext {
  // Lower-case override keys to match the loadOverrides() normalization.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) lower[k.toLowerCase()] = v;
  return { matcher: makeMatcher(matchMap), overrides: lower };
}

function snap(id: string, source: "fli_index" | "saferai" = "fli_index"): RawSnapshot {
  return {
    id,
    scorecardSource: source,
    waveLabel: "Test wave",
    publishedAt: "2026-01-01",
    sourceUrl: "https://example.org",
    methodologyUrl: null,
    license: null,
    notes: null,
    isLatest: true,
    sourceActive: true,
  };
}

function grade(
  snapshotId: string,
  org: string,
  dimSlug: string,
  raw: string,
): RawGrade {
  return {
    snapshotId,
    orgName: org,
    dimensionSlug: dimSlug,
    dimensionLabel: dimSlug === "overall" ? "Overall" : dimSlug,
    scoreRaw: raw,
    scoreLetter: raw,
    scoreNumeric: null,
  };
}

describe("resolveSnapshot", () => {
  it("partitions resolved + unresolved", () => {
    const ctx = makeCtx({ anthropic: "sid_aaa", openai: "sid_bbb" });
    const grades = [
      grade("s1", "Anthropic", "overall", "B"),
      grade("s1", "MysteryLab", "overall", "A"),
    ];
    const r = resolveSnapshot(ctx, grades);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].entityId).toBe("sid_aaa");
    expect(r.unresolved).toEqual(["MysteryLab"]);
  });

  it("dedupes unresolved names across rows from the same org", () => {
    const ctx = makeCtx({});
    const grades = [
      grade("s1", "MysteryLab", "overall", "B"),
      grade("s1", "MysteryLab", "risk", "C"),
    ];
    const r = resolveSnapshot(ctx, grades);
    expect(r.unresolved).toEqual(["MysteryLab"]);
  });

  it("uses overrides before direct match", () => {
    const ctx = makeCtx(
      { anthropic: "sid_aaa" },
      { "AnthropIc PBC": "anthropic" },
    );
    const r = resolveSnapshot(ctx, [
      grade("s1", "Anthropic PBC", "overall", "B"),
    ]);
    expect(r.resolved[0].entityId).toBe("sid_aaa");
  });
});

describe("snapshotToPayload", () => {
  it("derives orgCount + dimensionCount from resolved grades", () => {
    const s = snap("s1");
    const ctx = makeCtx({ anthropic: "sid_aaa", openai: "sid_bbb" });
    const r = resolveSnapshot(ctx, [
      grade("s1", "Anthropic", "overall", "B"),
      grade("s1", "Anthropic", "risk", "C"),
      grade("s1", "OpenAI", "overall", "D"),
    ]);
    const payload = snapshotToPayload(s, r.resolved);
    expect(payload).toMatchObject({
      id: "s1",
      orgCount: 2,
      dimensionCount: 2,
      isLatest: true,
      sourceActive: true,
    });
  });
});

describe("gradeToPayload — ID determinism", () => {
  it("derives a pipe-joined ID from snapshot + entity + dimension", () => {
    const ctx = makeCtx({ anthropic: "sid_aaa" });
    const r = resolveSnapshot(ctx, [grade("s1", "Anthropic", "overall", "B")]);
    const p = gradeToPayload(r.resolved[0]);
    expect(p.id).toBe("s1|sid_aaa|overall");
    expect(p.snapshotId).toBe("s1");
    expect(p.entityId).toBe("sid_aaa");
    expect(p.dimensionSlug).toBe("overall");
  });

  it("produces identical IDs across reruns (idempotent upsert)", () => {
    const ctx = makeCtx({ anthropic: "sid_aaa" });
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = resolveSnapshot(ctx, [
        grade("s1", "Anthropic", "overall", "B"),
      ]);
      ids.add(gradeToPayload(r.resolved[0]).id as string);
    }
    expect(ids.size).toBe(1);
  });
});

describe("syncSource — dry run", () => {
  function adapter(
    snapshots: RawSnapshot[],
    gradesBySnap: Record<string, RawGrade[]>,
  ): ScorecardSourceAdapter {
    return {
      source: "fli_index",
      name: "Fake",
      listSnapshots: () => snapshots,
      parseGrades: (snap) => gradesBySnap[snap.id] ?? [],
    };
  }

  it("returns counts without writing on dryRun", async () => {
    const ctx = makeCtx({ anthropic: "sid_aaa" });
    const a = adapter(
      [snap("s1")],
      { s1: [grade("s1", "Anthropic", "overall", "B")] },
    );
    const r = await syncSource(a, ctx, { dryRun: true });
    expect(r).toMatchObject({
      source: "fli_index",
      snapshots: 1,
      grades: 1,
    });
    expect(r.snapshotResp).toBeUndefined();
    expect(r.gradesResp).toBeUndefined();
  });

  it("hard-fails on unresolved org names — never silently drops", async () => {
    const ctx = makeCtx({ anthropic: "sid_aaa" });
    const a = adapter(
      [snap("s1")],
      {
        s1: [
          grade("s1", "Anthropic", "overall", "B"),
          grade("s1", "MysteryLab", "overall", "A"),
        ],
      },
    );
    await expect(syncSource(a, ctx, { dryRun: true })).rejects.toThrow(
      /unresolved org names/i,
    );
  });

  it("includes the snapshot ID + suggested fix in the unresolved error", async () => {
    const ctx = makeCtx({});
    const a = adapter(
      [snap("s1")],
      { s1: [grade("s1", "MysteryLab", "overall", "A")] },
    );
    await expect(syncSource(a, ctx, { dryRun: true })).rejects.toThrow(
      /MysteryLab/,
    );
    await expect(syncSource(a, ctx, { dryRun: true })).rejects.toThrow(
      /org-aliases\.yaml/,
    );
  });

  it("returns 0/0 for empty source (no snapshots)", async () => {
    const ctx = makeCtx({});
    const a = adapter([], {});
    const r = await syncSource(a, ctx, { dryRun: true });
    expect(r).toEqual({ source: "fli_index", snapshots: 0, grades: 0 });
  });
});

describe("analyzeSource", () => {
  function adapter(
    snapshots: RawSnapshot[],
    gradesBySnap: Record<string, RawGrade[]>,
  ): ScorecardSourceAdapter {
    return {
      source: "fli_index",
      name: "Fake",
      listSnapshots: () => snapshots,
      parseGrades: (snap) => gradesBySnap[snap.id] ?? [],
    };
  }

  it("collects unresolved across all snapshots without throwing", () => {
    const ctx = makeCtx({ anthropic: "sid_aaa" });
    const a = adapter(
      [snap("s1"), snap("s2")],
      {
        s1: [
          grade("s1", "Anthropic", "overall", "B"),
          grade("s1", "MysteryLab1", "overall", "A"),
        ],
        s2: [
          grade("s2", "Anthropic", "overall", "C"),
          grade("s2", "MysteryLab2", "overall", "D"),
        ],
      },
    );
    const r = analyzeSource(a, ctx);
    expect(r).toMatchObject({
      source: "fli_index",
      snapshots: 2,
      grades: 4,
      uniqueOrgs: 3,
      resolved: 2,
    });
    expect(r.unresolved.sort()).toEqual(["MysteryLab1", "MysteryLab2"]);
  });
});
