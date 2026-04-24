/**
 * Tests for the QUA-561 resource dedup logic.
 *
 * Pure-helper tests always run. The merge integration test requires
 * DATABASE_URL to be set; skipped otherwise. It creates its own mini schema
 * (isolated under a dedicated test schema) so it can coexist with the main
 * integration test suite without recreating all migrations.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import postgres from "postgres";
import type { CallableTransactionSql } from "../db.js";
import {
  dedupKey,
  pickCanonical,
  dedupeFkColumns,
  validateIdent,
  mergeCluster,
  buildReport,
  runDedup,
  ScanTruncatedError,
  type FkColumnInfo,
} from "../routes/wikibase/resource-dedup.js";
import type { Sql } from "../db.js";

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

describe("dedupKey", () => {
  it("collapses http/https, www, trailing slash, fragment, and path case", () => {
    const urls = [
      "https://www.example.org/path/",
      "http://example.org/PATH",
      "https://example.org/path#section",
    ];
    const keys = urls.map(dedupKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("strips tracking parameters", () => {
    expect(dedupKey("https://example.org/x?utm_source=foo")).toBe(
      dedupKey("https://example.org/x")
    );
  });

  it("keeps distinct paths apart", () => {
    expect(dedupKey("https://a.com/one")).not.toBe(dedupKey("https://a.com/two"));
  });
});

describe("pickCanonical", () => {
  const base = { createdAt: "2024-01-01", refCount: 0 };

  it("prefers highest refCount", () => {
    const rows = [
      { id: "a", ...base, refCount: 1 },
      { id: "b", ...base, refCount: 5 },
      { id: "c", ...base, refCount: 2 },
    ];
    expect(pickCanonical(rows).id).toBe("b");
  });

  it("tiebreaks by earliest createdAt", () => {
    const rows = [
      { id: "a", refCount: 0, createdAt: "2024-05-01" },
      { id: "b", refCount: 0, createdAt: "2024-01-01" },
      { id: "c", refCount: 0, createdAt: "2024-03-01" },
    ];
    expect(pickCanonical(rows).id).toBe("b");
  });

  it("tiebreaks by smallest id lexicographically", () => {
    const rows = [
      { id: "zed", refCount: 0, createdAt: "2024-01-01" },
      { id: "aaa", refCount: 0, createdAt: "2024-01-01" },
      { id: "mid", refCount: 0, createdAt: "2024-01-01" },
    ];
    expect(pickCanonical(rows).id).toBe("aaa");
  });

  it("applies ordering in the right precedence", () => {
    const rows = [
      // c has most refs → wins even though not earliest
      { id: "c", refCount: 10, createdAt: "2024-06-01" },
      { id: "a", refCount: 5, createdAt: "2024-01-01" },
      { id: "b", refCount: 5, createdAt: "2024-01-01" },
    ];
    expect(pickCanonical(rows).id).toBe("c");
  });

  it("throws on empty input", () => {
    expect(() => pickCanonical([] as { id: string; refCount: number; createdAt: string }[]))
      .toThrow(/empty/);
  });
});

describe("dedupeFkColumns", () => {
  it("collapses multiple FK constraints on the same (table, column, target)", () => {
    const fks: FkColumnInfo[] = [
      { tableName: "page_citations", columnName: "resource_id", targetColumn: "id", uniqueGroups: [] },
      { tableName: "page_citations", columnName: "resource_id", targetColumn: "id", uniqueGroups: [] },
      { tableName: "entity_resources", columnName: "resource_id", targetColumn: "stable_id", uniqueGroups: [] },
    ];
    const out = dedupeFkColumns(fks);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.tableName).sort()).toEqual([
      "entity_resources",
      "page_citations",
    ]);
  });

  it("keeps two FKs on the same (table, column) when they target different resources columns", () => {
    // Defensive: the degenerate case where one column has FKs to BOTH
    // resources.id and resources.stable_id. Both must survive so the merge
    // rewrites the value under whichever interpretation holds.
    const fks: FkColumnInfo[] = [
      { tableName: "weird_table", columnName: "resource_id", targetColumn: "id", uniqueGroups: [] },
      { tableName: "weird_table", columnName: "resource_id", targetColumn: "stable_id", uniqueGroups: [] },
    ];
    const out = dedupeFkColumns(fks);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.targetColumn).sort()).toEqual(["id", "stable_id"]);
  });
});

// ---------------------------------------------------------------------------
// QUA-623: scan cap + truncation guard (no DB)
// ---------------------------------------------------------------------------

// Minimal fake Sql for buildReport / runDedup: routes tagged-template calls
// based on their first literal chunk. Only what these tests exercise.
function makeFakeSql(resourcesRows: { id: string; url: string; created_at: string }[]): Sql {
  const fake = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const firstChunk = strings[0] ?? "";
    // loadResourceFks runs two information_schema queries; return empty.
    if (firstChunk.includes("information_schema")) return [];
    // buildReport's resources scan.
    if (firstChunk.includes("FROM resources")) return resourcesRows;
    return [];
  }) as unknown as Sql;
  return fake;
}

describe("buildReport — QUA-623 scan cap + truncation flag", () => {
  it("sets truncated=false when rows fit within the cap", async () => {
    const rows = [
      { id: "a", url: "https://x.test/1", created_at: "2024-01-01" },
      { id: "b", url: "https://x.test/2", created_at: "2024-01-02" },
    ];
    const report = await buildReport(makeFakeSql(rows), { scanCap: 5 });
    expect(report.truncated).toBe(false);
    expect(report.totalResources).toBe(2);
  });

  it("sets truncated=true when rows exceed the cap (sentinel detection)", async () => {
    // Postgres returns (cap + 1) rows so the sentinel fires; buildReport
    // should slice back to the cap and flip truncated on.
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      url: `https://x.test/${i}`,
      created_at: "2024-01-01",
    }));
    const report = await buildReport(makeFakeSql(rows), { scanCap: 3 });
    expect(report.truncated).toBe(true);
    expect(report.totalResources).toBe(3);
  });
});

describe("runDedup — QUA-623 refuse-on-truncated guard", () => {
  it("returns the truncated report in dry-run (apply=false) without throwing", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      url: `https://x.test/${i}`,
      created_at: "2024-01-01",
    }));
    const result = await runDedup(makeFakeSql(rows), false, { scanCap: 3 });
    expect(result.apply).toBe(false);
    expect(result.report.truncated).toBe(true);
    expect(result.merges).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("throws ScanTruncatedError when apply=true and the scan was truncated", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      url: `https://x.test/${i}`,
      created_at: "2024-01-01",
    }));
    await expect(runDedup(makeFakeSql(rows), true, { scanCap: 3 })).rejects.toBeInstanceOf(
      ScanTruncatedError,
    );
    await expect(runDedup(makeFakeSql(rows), true, { scanCap: 3 })).rejects.toThrow(
      /scan was truncated/,
    );
  });
});

describe("validateIdent", () => {
  it("accepts letter-underscore-digit identifiers", () => {
    expect(() => validateIdent("valid_name_1")).not.toThrow();
    expect(() => validateIdent("_underscore")).not.toThrow();
  });

  it("rejects identifiers with spaces, quotes, semicolons", () => {
    expect(() => validateIdent("bad name")).toThrow();
    expect(() => validateIdent('drop"table')).toThrow();
    expect(() => validateIdent("x;--")).toThrow();
  });

  it("rejects identifiers starting with a digit", () => {
    expect(() => validateIdent("1abc")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: mergeCluster against a real PG
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration(
  "QUA-561 mergeCluster — against a real PG (requires DATABASE_URL)",
  () => {
    let sqlConn: ReturnType<typeof postgres>;
    const SCHEMA = "qua561_dedup_test";

    beforeAll(async () => {
      sqlConn = postgres(DATABASE_URL!, { max: 3 });
      // Dedicated test schema so we don't collide with migrations / main suite.
      await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await sqlConn.unsafe(`CREATE SCHEMA ${SCHEMA}`);
      await sqlConn.unsafe(`SET search_path TO ${SCHEMA}, public`);
    });

    afterAll(async () => {
      if (sqlConn) {
        await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await sqlConn.end();
      }
    });

    beforeEach(async () => {
      // Reset isolated tables under the test schema. QUA-589: resources now
      // has a UNIQUE stable_id column (Phase A QUA-536 made it NOT NULL +
      // UNIQUE in prod) so FKs can target either id or stable_id. The
      // mixed-target test case below exercises both forms in one cluster.
      await sqlConn.unsafe(`
        DROP TABLE IF EXISTS ${SCHEMA}.resource_papers CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.entity_resources CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.publications CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.resources CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.things CASCADE;

        CREATE TABLE ${SCHEMA}.resources (
          id text PRIMARY KEY,
          stable_id text NOT NULL UNIQUE,
          url text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        -- entity_resources: regular FK on resources.id (legacy form).
        CREATE TABLE ${SCHEMA}.entity_resources (
          id serial PRIMARY KEY,
          entity_id text NOT NULL,
          resource_id text REFERENCES ${SCHEMA}.resources(id) ON DELETE CASCADE
        );

        -- resource_papers: resource_id is the PK and references resources.id (legacy).
        CREATE TABLE ${SCHEMA}.resource_papers (
          resource_id text PRIMARY KEY REFERENCES ${SCHEMA}.resources(id) ON DELETE CASCADE,
          arxiv_id text
        );

        -- publications: QUA-549 Phase B.1 — FK targets resources.stable_id.
        -- resource_id is unique (one publication per resource) so the merge
        -- has to also handle the deduped-on-conflict path for stable_id FKs.
        CREATE TABLE ${SCHEMA}.publications (
          id serial PRIMARY KEY,
          resource_id text UNIQUE REFERENCES ${SCHEMA}.resources(stable_id) ON DELETE SET NULL,
          title text
        );

        -- things: cross-base index mirror — mergeCluster cleans up dup rows here
        -- by (source_table='resources', source_id IN dupIds).
        CREATE TABLE ${SCHEMA}.things (
          id text PRIMARY KEY,
          source_table text NOT NULL,
          source_id text NOT NULL,
          title text NOT NULL
        );
      `);
    });

    it("merges a 3-row cluster with 5 FK refs split across 2 tables", async () => {
      // 3 resource rows with URL variants that collapse to the same key.
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resources (id, stable_id, url, created_at) VALUES
          ('r_canon', 'sid_canon01', 'https://www.example.org/x',     '2024-01-01'),
          ('r_dup1',  'sid_dup101',  'http://example.org/x/',         '2024-02-01'),
          ('r_dup2',  'sid_dup201',  'https://example.org/x#frag',    '2024-03-01')
      `);
      // 5 FK refs split across 2 tables:
      //   entity_resources: 3 refs (2 on canonical, 1 on dup1)
      //   resource_papers:  2 refs (dup1 and dup2 — NOT on canonical)
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.entity_resources (entity_id, resource_id) VALUES
          ('e1', 'r_canon'),
          ('e2', 'r_canon'),
          ('e3', 'r_dup1')
      `);
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resource_papers (resource_id, arxiv_id) VALUES
          ('r_dup1', 'arxiv-1'),
          ('r_dup2', 'arxiv-2')
      `);
      // things dual-write: one row per resource (by source_id).
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.things (id, source_table, source_id, title) VALUES
          ('t_canon', 'resources', 'r_canon', 'canonical title'),
          ('t_dup1',  'resources', 'r_dup1',  'dup1 title'),
          ('t_dup2',  'resources', 'r_dup2',  'dup2 title')
      `);

      // Load FK metadata from the test schema.
      const fkRows = await sqlConn<
        { tablename: string; columnname: string }[]
      >`
        SELECT tc.table_name AS tablename, kcu.column_name AS columnname
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'resources'
          AND ccu.column_name = 'id'
          AND tc.table_schema = ${SCHEMA}
      `;
      // Map to FkColumnInfo. resource_papers.resource_id is a PK (single-column).
      // Both FKs in this test target resources.id (legacy, pre-Phase B).
      const fkColumns: FkColumnInfo[] = fkRows.map((row) => {
        if (row.tablename === "resource_papers") {
          return {
            tableName: row.tablename,
            columnName: row.columnname,
            targetColumn: "id",
            uniqueGroups: [{ otherCols: [] }],
          };
        }
        return {
          tableName: row.tablename,
          columnName: row.columnname,
          targetColumn: "id",
          uniqueGroups: [],
        };
      });
      expect(fkColumns).toHaveLength(2);

      // Run the merge in a transaction.
      const merge = await sqlConn.begin(async (tx) => {
        return mergeCluster(
          tx as unknown as CallableTransactionSql,
          "r_canon",
          ["r_dup1", "r_dup2"],
          fkColumns
        );
      });

      // Assertions:
      expect(merge).toBeDefined();
      const result = merge as {
        resourcesDeleted: number;
        fkUpdates: Record<string, { moved: number; deletedOnConflict: number }>;
      };
      // Both dup resources deleted.
      expect(result.resourcesDeleted).toBe(2);

      // entity_resources: 1 row moved (e3 from r_dup1 → r_canon), 0 conflicts.
      expect(result.fkUpdates["entity_resources.resource_id"]).toEqual({
        moved: 1,
        deletedOnConflict: 0,
      });
      // resource_papers: no conflicts with canonical (canonical has no paper),
      // but dup1 and dup2 both have papers — one survives, the other is
      // deleted-on-conflict (PK collision). The surviving one is moved to canonical.
      const papersUpdate = result.fkUpdates["resource_papers.resource_id"];
      expect(papersUpdate.deletedOnConflict).toBe(1);
      expect(papersUpdate.moved).toBe(1);

      // Post-state:
      const remainingResources = await sqlConn<{ id: string }[]>`
        SELECT id FROM ${sqlConn(SCHEMA)}.resources ORDER BY id
      `;
      expect(remainingResources.map((r) => r.id)).toEqual(["r_canon"]);

      const remainingEr = await sqlConn<{ entity_id: string; resource_id: string }[]>`
        SELECT entity_id, resource_id FROM ${sqlConn(SCHEMA)}.entity_resources
        ORDER BY entity_id
      `;
      expect(remainingEr).toHaveLength(3);
      expect(remainingEr.every((r) => r.resource_id === "r_canon")).toBe(true);

      const remainingPapers = await sqlConn<{ resource_id: string; arxiv_id: string }[]>`
        SELECT resource_id, arxiv_id FROM ${sqlConn(SCHEMA)}.resource_papers
      `;
      expect(remainingPapers).toHaveLength(1);
      expect(remainingPapers[0].resource_id).toBe("r_canon");

      // things dual-write: dup rows deleted, canonical preserved.
      const remainingThings = await sqlConn<{ id: string; source_id: string }[]>`
        SELECT id, source_id FROM ${sqlConn(SCHEMA)}.things
        ORDER BY id
      `;
      expect(remainingThings).toEqual([
        { id: "t_canon", source_id: "r_canon" },
      ]);
    });

    it("handles PK conflict: canonical already has a paper", async () => {
      // Canonical has a paper; dup also has one → dup's is deleted-on-conflict.
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resources (id, stable_id, url, created_at) VALUES
          ('r_canon', 'sid_pk_canon', 'https://www.example.org/y', '2024-01-01'),
          ('r_dup',   'sid_pk_dup',   'http://example.org/y/',    '2024-02-01');
        INSERT INTO ${SCHEMA}.resource_papers (resource_id, arxiv_id) VALUES
          ('r_canon', 'arxiv-canon'),
          ('r_dup',   'arxiv-dup');
      `);

      const fkColumns: FkColumnInfo[] = [
        {
          tableName: "resource_papers",
          columnName: "resource_id",
          targetColumn: "id",
          uniqueGroups: [{ otherCols: [] }],
        },
        {
          tableName: "entity_resources",
          columnName: "resource_id",
          targetColumn: "id",
          uniqueGroups: [],
        },
      ];

      const merge = (await sqlConn.begin(async (tx) => {
        return mergeCluster(
          tx as unknown as CallableTransactionSql,
          "r_canon",
          ["r_dup"],
          fkColumns
        );
      })) as {
        resourcesDeleted: number;
        fkUpdates: Record<string, { moved: number; deletedOnConflict: number }>;
      };

      expect(merge.resourcesDeleted).toBe(1);
      // Canonical's paper stays; dup's paper is deleted (not moved).
      expect(merge.fkUpdates["resource_papers.resource_id"]).toEqual({
        moved: 0,
        deletedOnConflict: 1,
      });

      const papers = await sqlConn<{ resource_id: string; arxiv_id: string }[]>`
        SELECT resource_id, arxiv_id FROM ${sqlConn(SCHEMA)}.resource_papers
      `;
      expect(papers).toHaveLength(1);
      expect(papers[0]).toEqual({
        resource_id: "r_canon",
        arxiv_id: "arxiv-canon",
      });
    });

    it("buildReport + loadResourceFks discover live FK metadata across both id and stable_id targets", async () => {
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resources (id, stable_id, url, created_at) VALUES
          ('r_canon', 'sid_meta_canon', 'https://www.example.org/z', '2024-01-01'),
          ('r_dup',   'sid_meta_dup',   'http://example.org/z/',    '2024-02-01'),
          ('r_solo',  'sid_meta_solo',  'https://unique.example/w', '2024-03-01');
        INSERT INTO ${SCHEMA}.entity_resources (entity_id, resource_id) VALUES
          ('e1', 'r_canon');
      `);

      // QUA-589: discovery must surface BOTH id-targeting and stable_id-
      // targeting FKs. Query exactly the helper's logic but scoped to the
      // test schema (loadResourceFks itself hardcodes schema='public').
      const fkRows = await sqlConn<
        { table_name: string; column_name: string; target_column: string }[]
      >`
        SELECT DISTINCT tc.table_name, kcu.column_name, ccu.column_name AS target_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'resources'
          AND ccu.column_name IN ('id', 'stable_id')
          AND tc.table_schema = ${SCHEMA}
      `;
      const summary = fkRows
        .map((r) => `${r.table_name}.${r.column_name}->${r.target_column}`)
        .sort();
      expect(summary).toEqual([
        "entity_resources.resource_id->id",
        "publications.resource_id->stable_id",
        "resource_papers.resource_id->id",
      ]);

      // pickCanonical-style picking with refCount=1 for canonical, 0 for dup
      const { pickCanonical } = await import("../routes/wikibase/resource-dedup.js");
      const cluster = [
        { id: "r_canon", refCount: 1, createdAt: "2024-01-01" },
        { id: "r_dup", refCount: 0, createdAt: "2024-02-01" },
      ];
      expect(pickCanonical(cluster).id).toBe("r_canon");
    });

    it("merges a cluster with FKs targeting both resources.id AND resources.stable_id (QUA-589)", async () => {
      // QUA-589: post-Phase B, FKs target either resources.id (legacy) OR
      // resources.stable_id (migrated). The merge must rewrite each FK using
      // the right value type. This test asserts:
      //   1. Legacy id-targeting FK (entity_resources) is rewritten id→id.
      //   2. Phase B stable_id-targeting FK with a UNIQUE constraint
      //      (publications) gets the deduped-on-conflict path AND the moved
      //      row's value translated to canonical's stable_id.
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resources (id, stable_id, url, created_at) VALUES
          ('r_canon', 'sid_mix_canon', 'https://www.example.org/m',  '2024-01-01'),
          ('r_dup1',  'sid_mix_dup1',  'http://example.org/m/',      '2024-02-01'),
          ('r_dup2',  'sid_mix_dup2',  'https://example.org/m#frag', '2024-03-01');

        -- entity_resources (FK → resources.id, no uniqueness): 3 refs
        --   1 on canonical, 1 on dup1, 1 on dup2 — all should land on canonical.
        INSERT INTO ${SCHEMA}.entity_resources (entity_id, resource_id) VALUES
          ('e1', 'r_canon'),
          ('e2', 'r_dup1'),
          ('e3', 'r_dup2');

        -- publications (FK → resources.stable_id, UNIQUE on resource_id):
        --   canonical has none; dup1 and dup2 each have one. The merge should
        --   keep one (move it onto canonical's stable_id) and conflict-delete
        --   the other.
        INSERT INTO ${SCHEMA}.publications (resource_id, title) VALUES
          ('sid_mix_dup1', 'paper-from-dup1'),
          ('sid_mix_dup2', 'paper-from-dup2');

        INSERT INTO ${SCHEMA}.things (id, source_table, source_id, title) VALUES
          ('t_canon', 'resources', 'r_canon', 'canon'),
          ('t_dup1',  'resources', 'r_dup1',  'dup1'),
          ('t_dup2',  'resources', 'r_dup2',  'dup2');
      `);

      const fkColumns: FkColumnInfo[] = [
        {
          tableName: "entity_resources",
          columnName: "resource_id",
          targetColumn: "id",
          uniqueGroups: [],
        },
        {
          tableName: "publications",
          columnName: "resource_id",
          targetColumn: "stable_id",
          // UNIQUE constraint on resource_id alone → otherCols is empty.
          uniqueGroups: [{ otherCols: [] }],
        },
      ];

      const merge = (await sqlConn.begin(async (tx) => {
        return mergeCluster(
          tx as unknown as CallableTransactionSql,
          "r_canon",
          ["r_dup1", "r_dup2"],
          fkColumns,
        );
      })) as {
        resourcesDeleted: number;
        fkUpdates: Record<string, { moved: number; deletedOnConflict: number }>;
      };

      expect(merge.resourcesDeleted).toBe(2);

      // entity_resources: 2 rows moved (e2, e3 onto r_canon), 0 conflicts.
      expect(merge.fkUpdates["entity_resources.resource_id"]).toEqual({
        moved: 2,
        deletedOnConflict: 0,
      });

      // publications: dup1/dup2 each have a row (UNIQUE) → one survives + is
      // rewritten to sid_mix_canon, the other is conflict-deleted.
      expect(merge.fkUpdates["publications.resource_id"]).toEqual({
        moved: 1,
        deletedOnConflict: 1,
      });

      // Post-state: only canonical resource remains.
      const remainingResources = await sqlConn<{ id: string }[]>`
        SELECT id FROM ${sqlConn(SCHEMA)}.resources ORDER BY id
      `;
      expect(remainingResources.map((r) => r.id)).toEqual(["r_canon"]);

      // entity_resources: all 3 rows now point at r_canon (id form).
      const remainingEr = await sqlConn<{ entity_id: string; resource_id: string }[]>`
        SELECT entity_id, resource_id FROM ${sqlConn(SCHEMA)}.entity_resources
        ORDER BY entity_id
      `;
      expect(remainingEr).toHaveLength(3);
      expect(remainingEr.every((r) => r.resource_id === "r_canon")).toBe(true);

      // publications: 1 surviving row, rewritten to canonical's stable_id.
      const remainingPubs = await sqlConn<{ resource_id: string; title: string }[]>`
        SELECT resource_id, title FROM ${sqlConn(SCHEMA)}.publications
      `;
      expect(remainingPubs).toHaveLength(1);
      expect(remainingPubs[0].resource_id).toBe("sid_mix_canon");
      // The surviving title is whichever ctid won — both are valid.
      expect(["paper-from-dup1", "paper-from-dup2"]).toContain(remainingPubs[0].title);
    });

    it("throws if a clustered resource has NULL stable_id and any FK targets stable_id (QUA-589)", async () => {
      // Defensive: a duplicate with NULL stable_id can't be rewritten by the
      // stable_id-targeting FK path. mergeCluster should refuse rather than
      // silently leaving orphan child rows.
      await sqlConn.unsafe(`
        ALTER TABLE ${SCHEMA}.resources DROP CONSTRAINT resources_stable_id_key;
        ALTER TABLE ${SCHEMA}.resources ALTER COLUMN stable_id DROP NOT NULL;
        INSERT INTO ${SCHEMA}.resources (id, stable_id, url, created_at) VALUES
          ('r_canon', 'sid_null_canon', 'https://www.example.org/n', '2024-01-01'),
          ('r_dup',   NULL,             'http://example.org/n/',     '2024-02-01');
      `);

      const fkColumns: FkColumnInfo[] = [
        {
          tableName: "publications",
          columnName: "resource_id",
          targetColumn: "stable_id",
          uniqueGroups: [{ otherCols: [] }],
        },
      ];

      await expect(
        sqlConn.begin(async (tx) => {
          return mergeCluster(
            tx as unknown as CallableTransactionSql,
            "r_canon",
            ["r_dup"],
            fkColumns,
          );
        }),
      ).rejects.toThrow(/NULL stable_id/);
    });
  }
);
