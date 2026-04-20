/**
 * QUA-623: the integrity endpoint ran 7 `SELECT DISTINCT ... WHERE NOT EXISTS`
 * scans without LIMIT. A data-integrity regression could return a huge
 * `missing_refs` array and OOM the response. We cap each check at
 * MAX_MISSING_REFS and set a `truncated` flag when the cap is hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type SqlDispatcher, mockDbModule } from "./test-utils";

/** Rows the mocked `db.execute` should return for each check. */
let rowsByTable: Record<string, { ref: string }[]>;

function resetRows() {
  rowsByTable = {};
}

const dispatch: SqlDispatcher = (query, _params) => {
  // Each checkDangling call composes `<original-query> LIMIT $N`. We route
  // the query to the right synthetic result set by looking at the first
  // recognizable table name inside it.
  if (query.includes("FROM facts")) return rowsByTable.facts ?? [];
  if (query.includes("FROM summaries")) return rowsByTable.summaries ?? [];
  if (query.includes("FROM citation_quotes") && query.includes("page_id"))
    return rowsByTable.citation_quotes_page ?? [];
  if (query.includes("FROM citation_quotes") && query.includes("resource_id"))
    return rowsByTable.citation_quotes_resource ?? [];
  if (query.includes("FROM edit_logs")) return rowsByTable.edit_logs ?? [];
  if (query.includes("FROM entities ent")) return rowsByTable.related_entries ?? [];
  if (query.includes("FROM resource_citations")) return rowsByTable.resource_citations ?? [];
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { integrityRoute } = await import("../routes/operational/integrity.js");

describe("Integrity endpoint — QUA-623 unbounded query cap", () => {
  beforeEach(() => {
    resetRows();
  });

  it("reports `status: clean` when all tables are consistent", async () => {
    // All empty → clean.
    const res = await integrityRoute.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      issues: unknown[];
      summary: { tables_checked: number; issues_found: number };
    };
    expect(body.status).toBe("clean");
    expect(body.issues).toEqual([]);
    expect(body.summary.tables_checked).toBe(7);
    expect(body.summary.issues_found).toBe(0);
  });

  it("reports each dangling ref with `truncated: false` when below the cap", async () => {
    rowsByTable.facts = [{ ref: "orphan-1" }, { ref: "orphan-2" }];
    rowsByTable.summaries = [{ ref: "s-orphan" }];
    const res = await integrityRoute.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      issues: {
        table: string;
        missing_refs: string[];
        count: number;
        truncated: boolean;
      }[];
    };
    expect(body.status).toBe("issues_found");
    const facts = body.issues.find((i) => i.table === "facts");
    expect(facts).toBeDefined();
    expect(facts!.missing_refs).toEqual(["orphan-1", "orphan-2"]);
    expect(facts!.count).toBe(2);
    expect(facts!.truncated).toBe(false);
  });

  it("sets `truncated: true` and caps `missing_refs` when an issue exceeds MAX_MISSING_REFS", async () => {
    // MAX_MISSING_REFS is 1000. Return 1001 rows so the +1 sentinel fires.
    rowsByTable.facts = Array.from({ length: 1001 }, (_, i) => ({
      ref: `orphan-${i}`,
    }));
    const res = await integrityRoute.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: {
        table: string;
        missing_refs: string[];
        count: number;
        truncated: boolean;
      }[];
    };
    const facts = body.issues.find((i) => i.table === "facts");
    expect(facts).toBeDefined();
    expect(facts!.truncated).toBe(true);
    // Capped back to MAX_MISSING_REFS (1000); the +1 sentinel row is dropped.
    expect(facts!.missing_refs.length).toBe(1000);
    expect(facts!.count).toBe(1000);
  });
});
