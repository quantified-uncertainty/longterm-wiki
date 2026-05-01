/**
 * Tests for `crux tb benchmark` (QUA-936 — extends the policy-only benchmark
 * to cover organization entities and reject unsupported types cleanly).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  takeSnapshot,
  listSnapshots,
  findByTag,
  diff,
} from "./research-benchmark.ts";

function setupEntities(tmp: string, entries: Array<{ file: string; data: unknown[] }>): string {
  const entitiesDir = path.join(tmp, "entities");
  fs.mkdirSync(entitiesDir, { recursive: true });
  for (const { file, data } of entries) {
    fs.writeFileSync(path.join(entitiesDir, file), yaml.dump(data));
  }
  return entitiesDir;
}

const POLICY_FIXTURE = {
  id: "fisa-702",
  type: "policy",
  title: "FISA Section 702",
  description: "long description here",
  billNumber: "S.123",
  introduced: "2008",
  policyStatus: "enacted",
  author: "Author Name",
  jurisdiction: "United States",
  fullTextUrl: "https://example.com",
  provisions: [{ title: "p1" }, { title: "p2" }],
  stakeholders: [{ name: "s1" }],
  tags: ["a"],
  relatedEntries: [{ id: "x", type: "policy" }],
};

const ORG_FIXTURE = {
  id: "anthropic",
  type: "organization",
  title: "Anthropic",
  description: "AI safety lab",
  website: "https://anthropic.com",
  orgType: "frontier-lab",
  founded: "2021",
  headquarters: "San Francisco",
  employees: "500+",
  products: [{ name: "Claude" }, { name: "Claude Code" }],
  keyPeople: ["dario-amodei", "daniela-amodei"],
  keyDates: [{ date: "2021", description: "founded" }],
  tags: ["safety"],
  relatedEntries: [{ id: "openai", type: "organization", relationship: "competitor" }],
};

describe("takeSnapshot — type dispatch (QUA-936)", () => {
  it("scores a policy entity using policyCoverageScore", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "responses.yaml", data: [POLICY_FIXTURE] },
      ]);
      const snap = takeSnapshot("fisa-702", "baseline", { entitiesDir, benchDir: tmp });
      expect(snap.entity_slug).toBe("fisa-702");
      expect(snap.entity_type).toBe("policy");
      // Policy components are top_level / provisions / stakeholders / tags / relatedEntries.
      expect(snap.components).toHaveProperty("top_level");
      expect(snap.components).toHaveProperty("provisions");
      expect(snap.components).toHaveProperty("stakeholders");
      expect(snap.components).not.toHaveProperty("products");
      expect(snap.facts_in_yaml).toHaveProperty("provisions");
      expect(typeof snap.coverage_score).toBe("number");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scores an organization entity using organizationCoverageScore", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "organizations.yaml", data: [ORG_FIXTURE] },
      ]);
      const snap = takeSnapshot("anthropic", "baseline", { entitiesDir, benchDir: tmp });
      expect(snap.entity_slug).toBe("anthropic");
      expect(snap.entity_type).toBe("organization");
      // Org components are top_level / products / keyPeople / keyDates / factbase.
      expect(snap.components).toHaveProperty("top_level");
      expect(snap.components).toHaveProperty("products");
      expect(snap.components).toHaveProperty("keyPeople");
      expect(snap.components).toHaveProperty("keyDates");
      expect(snap.components).not.toHaveProperty("provisions");
      expect(snap.facts_in_yaml).toHaveProperty("products");
      expect(typeof snap.coverage_score).toBe("number");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("looks up entities across multiple yaml files (multi-file scan)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "responses.yaml", data: [POLICY_FIXTURE] },
        { file: "organizations.yaml", data: [ORG_FIXTURE] },
      ]);
      const policySnap = takeSnapshot("fisa-702", "p", { entitiesDir, benchDir: tmp });
      const orgSnap = takeSnapshot("anthropic", "o", { entitiesDir, benchDir: tmp });
      expect(policySnap.entity_type).toBe("policy");
      expect(orgSnap.entity_type).toBe("organization");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unsupported types with a clear error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        {
          file: "people.yaml",
          data: [{ id: "alice", type: "person", title: "Alice" }],
        },
      ]);
      expect(() =>
        takeSnapshot("alice", "baseline", { entitiesDir, benchDir: tmp }),
      ).toThrow(/Type "person" not supported/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing entities with a clear error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "responses.yaml", data: [POLICY_FIXTURE] },
      ]);
      expect(() =>
        takeSnapshot("no-such-slug", "baseline", { entitiesDir, benchDir: tmp }),
      ).toThrow(/Entity not found: no-such-slug/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists entity_type to the snapshot file (QUA-936)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "organizations.yaml", data: [ORG_FIXTURE] },
      ]);
      takeSnapshot("anthropic", "baseline", { entitiesDir, benchDir: tmp });
      const snaps = listSnapshots("anthropic", { benchDir: tmp });
      expect(snaps).toHaveLength(1);
      expect(snaps[0].entity_type).toBe("organization");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("listSnapshots / findByTag", () => {
  it("returns saved snapshots in timestamp order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "organizations.yaml", data: [ORG_FIXTURE] },
      ]);
      takeSnapshot("anthropic", "first", { entitiesDir, benchDir: tmp });
      takeSnapshot("anthropic", "second", { entitiesDir, benchDir: tmp });
      const snaps = listSnapshots("anthropic", { benchDir: tmp });
      expect(snaps).toHaveLength(2);
      expect(findByTag("anthropic", "first", { benchDir: tmp })?.tag).toBe("first");
      expect(findByTag("anthropic", "second", { benchDir: tmp })?.tag).toBe("second");
      expect(findByTag("anthropic", "ghost", { benchDir: tmp })).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("diff", () => {
  it("renders org-shaped components when diffing two org snapshots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    try {
      const entitiesDir = setupEntities(tmp, [
        { file: "organizations.yaml", data: [ORG_FIXTURE] },
      ]);
      takeSnapshot("anthropic", "before", { entitiesDir, benchDir: tmp });

      // Improve the org and snapshot again
      const improved = {
        ...ORG_FIXTURE,
        products: [
          { name: "Claude" },
          { name: "Claude Code" },
          { name: "Claude API" },
        ],
        keyPeople: ["dario-amodei", "daniela-amodei", "jared-kaplan"],
      };
      fs.writeFileSync(
        path.join(entitiesDir, "organizations.yaml"),
        yaml.dump([improved]),
      );
      takeSnapshot("anthropic", "after", { entitiesDir, benchDir: tmp });

      const out = diff("anthropic", "before", "after", { benchDir: tmp });
      expect(out).toContain("anthropic (organization)");
      expect(out).toContain("before → after");
      // Org component keys appear in the diff
      expect(out).toContain("products");
      expect(out).toContain("keyPeople");
      expect(out).toContain("keyDates");
      // Policy keys do NOT appear in the diff
      expect(out).not.toContain("provisions");
      expect(out).not.toContain("stakeholders");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a clear message when one side is missing", () => {
    expect(diff("ghost", "a", "b", { benchDir: "/tmp/does-not-exist-xyz" }))
      .toMatch(/No snapshot tagged "a" for ghost/);
  });
});
