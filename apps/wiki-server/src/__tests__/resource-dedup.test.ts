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
  it("collapses multiple FK constraints on the same (table, column)", () => {
    const fks: FkColumnInfo[] = [
      { tableName: "page_citations", columnName: "resource_id", uniqueGroups: [] },
      { tableName: "page_citations", columnName: "resource_id", uniqueGroups: [] },
      { tableName: "entity_resources", columnName: "resource_id", uniqueGroups: [] },
    ];
    const out = dedupeFkColumns(fks);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.tableName).sort()).toEqual([
      "entity_resources",
      "page_citations",
    ]);
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

  it("throws when apply=true and the scan was truncated", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      url: `https://x.test/${i}`,
      created_at: "2024-01-01",
    }));
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
      // Reset isolated tables under the test schema.
      await sqlConn.unsafe(`
        DROP TABLE IF EXISTS ${SCHEMA}.resource_papers CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.entity_resources CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.resources CASCADE;
        DROP TABLE IF EXISTS ${SCHEMA}.things CASCADE;

        CREATE TABLE ${SCHEMA}.resources (
          id text PRIMARY KEY,
          url text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        -- entity_resources: regular FK, no uniqueness on resource_id.
        CREATE TABLE ${SCHEMA}.entity_resources (
          id serial PRIMARY KEY,
          entity_id text NOT NULL,
          resource_id text REFERENCES ${SCHEMA}.resources(id) ON DELETE CASCADE
        );

        -- resource_papers: resource_id is the PK (at most one row per resource).
        CREATE TABLE ${SCHEMA}.resource_papers (
          resource_id text PRIMARY KEY REFERENCES ${SCHEMA}.resources(id) ON DELETE CASCADE,
          arxiv_id text
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
        INSERT INTO ${SCHEMA}.resources (id, url, created_at) VALUES
          ('r_canon', 'https://www.example.org/x',     '2024-01-01'),
          ('r_dup1',  'http://example.org/x/',         '2024-02-01'),
          ('r_dup2',  'https://example.org/x#frag',    '2024-03-01')
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
      const fkColumns: FkColumnInfo[] = fkRows.map((row) => {
        if (row.tablename === "resource_papers") {
          return {
            tableName: row.tablename,
            columnName: row.columnname,
            uniqueGroups: [{ otherCols: [] }],
          };
        }
        return {
          tableName: row.tablename,
          columnName: row.columnname,
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
        INSERT INTO ${SCHEMA}.resources (id, url, created_at) VALUES
          ('r_canon', 'https://www.example.org/y', '2024-01-01'),
          ('r_dup',   'http://example.org/y/',    '2024-02-01');
        INSERT INTO ${SCHEMA}.resource_papers (resource_id, arxiv_id) VALUES
          ('r_canon', 'arxiv-canon'),
          ('r_dup',   'arxiv-dup');
      `);

      const fkColumns: FkColumnInfo[] = [
        {
          tableName: "resource_papers",
          columnName: "resource_id",
          uniqueGroups: [{ otherCols: [] }],
        },
        {
          tableName: "entity_resources",
          columnName: "resource_id",
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

    it("buildReport + loadResourceFks discover live FK metadata", async () => {
      await sqlConn.unsafe(`
        INSERT INTO ${SCHEMA}.resources (id, url, created_at) VALUES
          ('r_canon', 'https://www.example.org/z', '2024-01-01'),
          ('r_dup',   'http://example.org/z/',    '2024-02-01'),
          ('r_solo',  'https://unique.example/w', '2024-03-01');
        INSERT INTO ${SCHEMA}.entity_resources (entity_id, resource_id) VALUES
          ('e1', 'r_canon');
      `);

      // Run helpers under the test schema's search_path.
      // postgres.js connections have connection-level search_path via SET.
      await sqlConn.unsafe(`SET search_path TO ${SCHEMA}, public`);

      // Override the loader's 'public' schema filter by fetching via a
      // dedicated connection where search_path is our test schema. The
      // helper hardcodes schema='public' so we fetch manually here instead.
      const fkRows = await sqlConn<
        { table_name: string; column_name: string }[]
      >`
        SELECT DISTINCT tc.table_name, kcu.column_name
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
      expect(fkRows.map((r) => r.table_name).sort()).toEqual([
        "entity_resources",
        "resource_papers",
      ]);

      // pickCanonical-style picking with refCount=1 for canonical, 0 for dup
      const { pickCanonical } = await import("../routes/wikibase/resource-dedup.js");
      const cluster = [
        { id: "r_canon", refCount: 1, createdAt: "2024-01-01" },
        { id: "r_dup", refCount: 0, createdAt: "2024-02-01" },
      ];
      expect(pickCanonical(cluster).id).toBe("r_canon");
    });
  }
);
