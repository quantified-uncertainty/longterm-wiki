/**
 * Tests for the QUA-928 coverage-metric refactor.
 *
 * The /coverage and /coverage-matrix endpoints now expose three explicit
 * percentages instead of a single ambiguous `coveragePercent`:
 *
 *   - checkabilityPercent       = checkable / total
 *   - checkableCoveragePercent  = checked   / checkable
 *   - fullCoveragePercent       = checked   / total
 *
 * The split distinguishes authoring quality (do facts have sources, are their
 * properties verifiable?) from verification quality (of the eligible records,
 * how many have a verdict?). The all-facts denominator was mathematically
 * unreachable for facts because ~33% are excluded by collector design, so the
 * QUA-852 enforcement gate now references `checkableCoveragePercent` rather
 * than the joint metric.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule } from "./test-utils";

let capturedQueries: string[] = [];
let capturedParams: unknown[][] = [];

let tableTotals: Array<{ table_name?: string; record_type?: string; total: number }> = [];
let verifiedCounts: Array<{ record_type: string; verified: number }> = [];
let checkedCounts: Array<{ record_type: string; checked_records: number }> = [];
let verdictRows: Array<{ record_type: string; verdict: string; cnt: number }> = [];
let checkableFacts = 0;

const dispatch: SqlDispatcher = (query, params) => {
  capturedQueries.push(query);
  capturedParams.push(params);

  // Order matters: the LIVE_RECORDS_CTE for the matrix queries also contains
  // `AS record_type` inside its CTE body, so the union-totals patterns must
  // be guarded by "no leading WITH" / a specific shape from the SELECT line.
  const hasCte = /^\s*WITH\s+live_records/i.test(query);

  // QUA-928 checkable-facts query — distinct fact_ids with source filter.
  if (!hasCte && /FROM\s+facts/i.test(query) && /AS\s+checkable\b/i.test(query)) {
    return [{ checkable: checkableFacts }];
  }
  // /coverage UNION ALL totals — column alias is `table_name`.
  if (!hasCte && /UNION ALL/i.test(query) && /AS\s+table_name/i.test(query)) {
    return tableTotals.map((r) => ({ table_name: r.table_name, total: r.total }));
  }
  // /coverage-matrix UNION ALL totals — column alias is `record_type` AND the
  // outer query also selects `count(*)::int AS total`. The CTE has `id::text AS record_id`
  // (no `AS total`), so the `AS total` distinguishes them.
  if (!hasCte && /UNION ALL/i.test(query) && /AS\s+record_type/i.test(query) && /AS\s+total/i.test(query)) {
    return tableTotals.map((r) => ({ record_type: r.record_type, total: r.total }));
  }
  // /coverage-matrix verdict row counts: `count(*) AS cnt`, GROUP BY (record_type, verdict).
  if (hasCte && /AS\s+cnt\b/i.test(query) && /GROUP\s+BY\s+v\.record_type\s*,\s*v\.verdict/i.test(query)) {
    return verdictRows;
  }
  // /coverage-matrix checked-records: `AS checked_records`.
  if (hasCte && /AS\s+checked_records\b/i.test(query)) {
    return checkedCounts;
  }
  // /coverage verified count: `AS verified`.
  if (hasCte && /AS\s+verified\b/i.test(query)) {
    return verifiedCounts;
  }
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

interface CoverageRow {
  recordType: string;
  total: number;
  checkable: number;
  verified: number;
  percentage: number;
  checkabilityPercent: number;
  checkableCoveragePercent: number;
  fullCoveragePercent: number;
  exempt: boolean;
}

interface CoverageResponse {
  coverage: CoverageRow[];
  exemptTypes: string[];
}

interface MatrixRow {
  recordType: string;
  totalRecords: number;
  checkableRecords: number;
  checkedRecords: number;
  verdicts: Record<string, number>;
  checkabilityPercent: number;
  checkableCoveragePercent: number;
  fullCoveragePercent: number;
  greenPercent: number;
  exempt: boolean;
}

interface MatrixResponse {
  tables: MatrixRow[];
  totals: {
    totalRecords: number;
    checkableRecords: number;
    totalVerdicts: number;
    confirmedPercent: number;
    checkabilityPercent: number;
    checkableCoveragePercent: number;
    fullCoveragePercent: number;
  };
  exemptTypes: string[];
}

describe("QUA-928: GET /api/sourcing/coverage — checkability split", () => {
  let app: Hono;

  beforeEach(() => {
    capturedQueries = [];
    capturedParams = [];
    tableTotals = [];
    verifiedCounts = [];
    checkedCounts = [];
    verdictRows = [];
    checkableFacts = 0;
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns the new checkability fields for the fact recordType", async () => {
    // Mirror the prod numbers from the QUA-928 description: 2,744 total
    // facts, ~1,834 checkable, ~1,816 actually checked. The new strict-
    // checked count (excluding 'unchecked' + 'not_applicable') drives the
    // new percentages; `verified` is kept only for the legacy `percentage`.
    tableTotals = [{ table_name: "fact", total: 2744 }];
    verifiedCounts = [{ record_type: "fact", verified: 1816 }];
    checkedCounts = [{ record_type: "fact", checked_records: 1816 }];
    checkableFacts = 1834;

    const res = await app.request("/api/sourcing/coverage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageResponse;
    const fact = body.coverage.find((r) => r.recordType === "fact");

    expect(fact).toBeDefined();
    expect(fact!.total).toBe(2744);
    expect(fact!.checkable).toBe(1834);
    expect(fact!.verified).toBe(1816);

    // Three explicit percentages, all rounded to one decimal.
    expect(fact!.checkabilityPercent).toBeCloseTo(66.8, 1);
    expect(fact!.checkableCoveragePercent).toBeCloseTo(99.0, 1);
    expect(fact!.fullCoveragePercent).toBeCloseTo(66.2, 1);
  });

  it("treats non-fact recordTypes as fully checkable (checkable == total)", async () => {
    tableTotals = [
      { table_name: "grant", total: 5876 },
      { table_name: "personnel", total: 1699 },
    ];
    verifiedCounts = [
      { record_type: "grant", verified: 5873 },
      { record_type: "personnel", verified: 1124 },
    ];
    checkedCounts = [
      { record_type: "grant", checked_records: 5873 },
      { record_type: "personnel", checked_records: 1124 },
    ];
    checkableFacts = 0; // no facts in this test

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;

    const grant = body.coverage.find((r) => r.recordType === "grant");
    const personnel = body.coverage.find((r) => r.recordType === "personnel");

    expect(grant!.checkable).toBe(5876);
    expect(grant!.checkabilityPercent).toBe(100);
    expect(grant!.checkableCoveragePercent).toBeCloseTo(99.9, 1);

    expect(personnel!.checkable).toBe(1699);
    expect(personnel!.checkabilityPercent).toBe(100);
    expect(personnel!.checkableCoveragePercent).toBeCloseTo(66.2, 1);
  });

  it("guards against divide-by-zero for empty tables", async () => {
    tableTotals = [{ table_name: "wiki-page", total: 0 }];
    verifiedCounts = [];
    checkedCounts = [];
    checkableFacts = 0;

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const wikiPage = body.coverage.find((r) => r.recordType === "wiki-page");

    expect(wikiPage!.total).toBe(0);
    expect(wikiPage!.checkable).toBe(0);
    expect(wikiPage!.checkabilityPercent).toBe(0);
    expect(wikiPage!.checkableCoveragePercent).toBe(0);
    expect(wikiPage!.fullCoveragePercent).toBe(0);
  });

  it("clamps checkable facts to total when the helper returns a stale count", async () => {
    // Defensive: if countCheckableFacts() races ahead of the table count
    // (e.g. a fact was deleted between the two queries), the row-level
    // checkable must not exceed total — that would push percentages > 100%.
    tableTotals = [{ table_name: "fact", total: 100 }];
    verifiedCounts = [{ record_type: "fact", verified: 80 }];
    checkedCounts = [{ record_type: "fact", checked_records: 80 }];
    checkableFacts = 105; // stale; higher than current total

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const fact = body.coverage.find((r) => r.recordType === "fact");

    expect(fact!.total).toBe(100);
    expect(fact!.checkable).toBe(100);
    expect(fact!.checkabilityPercent).toBe(100);
  });

  it("clamps the numerator so percentages cannot exceed 100% under race conditions", async () => {
    // Race: a verdict still exists for a record whose property was just
    // flipped from `verifiable: true` to `verifiable: false`, so
    // `checked_records > checkable`. Without the clamp,
    // `checkableCoveragePercent` would render as e.g. 105%, looking like
    // a bug. The clamp inside coveragePercents() caps it at 100.
    tableTotals = [{ table_name: "fact", total: 100 }];
    verifiedCounts = [{ record_type: "fact", verified: 95 }];
    checkedCounts = [{ record_type: "fact", checked_records: 90 }];
    checkableFacts = 80; // intentionally lower than checked_records

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const fact = body.coverage.find((r) => r.recordType === "fact");

    expect(fact!.checkable).toBe(80);
    // Without the clamp this would be 90/80 = 112.5%
    expect(fact!.checkableCoveragePercent).toBe(100);
    // fullCoveragePercent is checked / total but the clamp pulls checked
    // down to 80 too, so it lands at 80% (matches the cap on numerator).
    expect(fact!.fullCoveragePercent).toBe(80);
    expect(fact!.fullCoveragePercent).toBeLessThanOrEqual(100);
  });

  it("never reports `checkableCoveragePercent` numbers that disagree between /coverage and /coverage-matrix", async () => {
    // Pin the cross-endpoint consistency contract: same recordType, same
    // input data, same percentage value on both endpoints. Under the bug
    // /coverage used `verified` (which counts unchecked rows) and
    // /coverage-matrix used the strict `checked_records`, producing
    // different numbers under the same field name.
    tableTotals = [{ table_name: "fact", total: 100 }];
    verifiedCounts = [{ record_type: "fact", verified: 90 }]; // includes 'unchecked'
    checkedCounts = [{ record_type: "fact", checked_records: 70 }]; // strict
    checkableFacts = 80;

    const coverageRes = await app.request("/api/sourcing/coverage");
    const coverageBody = (await coverageRes.json()) as CoverageResponse;
    const coverageFact = coverageBody.coverage.find(
      (r) => r.recordType === "fact",
    );

    // Reset for the matrix call (handlers share dispatch but query
    // shapes differ — same canned data drives both).
    tableTotals = [{ record_type: "fact", total: 100 }];
    checkedCounts = [{ record_type: "fact", checked_records: 70 }];
    verdictRows = [];
    checkableFacts = 80;

    const matrixRes = await app.request("/api/sourcing/coverage-matrix");
    const matrixBody = (await matrixRes.json()) as MatrixResponse;
    const matrixFact = matrixBody.tables.find((t) => t.recordType === "fact");

    expect(coverageFact!.checkableCoveragePercent).toBe(
      matrixFact!.checkableCoveragePercent,
    );
    expect(coverageFact!.fullCoveragePercent).toBe(matrixFact!.fullCoveragePercent);
    expect(coverageFact!.checkabilityPercent).toBe(matrixFact!.checkabilityPercent);
  });

  it("never emits a `coveragePercent` field — the ambiguous name is removed", async () => {
    tableTotals = [{ table_name: "grant", total: 100 }];
    verifiedCounts = [{ record_type: "grant", verified: 80 }];

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const grant = body.coverage.find((r) => r.recordType === "grant");

    expect(grant).toBeDefined();
    expect(grant! as unknown as Record<string, unknown>).not.toHaveProperty(
      "coveragePercent",
    );
  });

  it("preserves the legacy `percentage` field for backwards-compat callers", async () => {
    // CoverageBars and EntitySourcingViewer still consume `percentage`.
    // Removing it would break those surfaces; the new explicit *Percent
    // fields are added alongside, not in place of, this legacy alias.
    tableTotals = [{ table_name: "grant", total: 100 }];
    verifiedCounts = [{ record_type: "grant", verified: 80 }];

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const grant = body.coverage.find((r) => r.recordType === "grant");

    expect(grant!.percentage).toBe(80);
  });

  it("scopes the checkable-facts query to verifiable properties", async () => {
    // Sanity check: the SQL must actually filter the fact set rather than
    // count everything. If the WHERE clause is dropped, the metric becomes
    // a copy of `total` and the gate loses its meaning.
    tableTotals = [{ table_name: "fact", total: 100 }];
    verifiedCounts = [];

    await app.request("/api/sourcing/coverage");

    const checkableQuery = capturedQueries.find(
      (q) => /FROM\s+facts/i.test(q) && /AS\s+checkable/i.test(q),
    );
    expect(
      checkableQuery,
      "expected a dedicated query that scopes facts to checkable subset",
    ).toBeDefined();
    expect(/source\s+IS\s+NOT\s+NULL/i.test(checkableQuery!)).toBe(true);
    // QUA-928 review: `source IS NOT NULL` alone still lets `source = ''`
    // through, so without the empty-string guard the metric would silently
    // count facts with a blank source as checkable. Assert both halves.
    expect(/source\s*<>\s*''/i.test(checkableQuery!)).toBe(true);
    expect(/measure\s*=\s*ANY/i.test(checkableQuery!)).toBe(true);
  });

  it("binds the non-verifiable property list as a single text[] param (QUA-985)", async () => {
    // Regression for QUA-985 prod 500.
    //
    // Drizzle's `sql` template tag spreads JS arrays as a row constructor
    // `($1, $2, ..., $N)` rather than binding them as a postgres array
    // parameter. With the broken binding the ANY clause renders as
    // `ANY(($1, ..., $12)::text[])` — Postgres rejects the cast because a
    // record is not an array, returning HTTP 500 to /coverage and
    // /coverage-matrix on prod once properties.yaml grew to 12+ entries.
    //
    // The fix wraps the array in `sql.param(arr)` so it binds as a single
    // `text[]` parameter, rendering as `ANY($1::text[])`.
    tableTotals = [{ table_name: "fact", total: 100 }];
    verifiedCounts = [];

    const res = await app.request("/api/sourcing/coverage");
    expect(res.status).toBe(200);

    const idx = capturedQueries.findIndex(
      (q) => /FROM\s+facts/i.test(q) && /AS\s+checkable/i.test(q),
    );
    expect(idx, "expected the checkable-facts query to be issued").toBeGreaterThanOrEqual(0);

    const checkableQuery = capturedQueries[idx];
    const checkableParams = capturedParams[idx];

    // Must NOT spread the array as a row constructor (the QUA-985 prod bug).
    expect(checkableQuery).not.toMatch(/ANY\(\s*\(\s*\$\d+\s*,/);
    // Must bind as a single ::text[] parameter.
    expect(checkableQuery).toMatch(/ANY\(\s*\$\d+::text\[\]\s*\)/);

    // The params slot for the array binding must contain a single JS array
    // (postgres-js then serialises it as `text[]`), not the spread elements.
    const arrayParams = checkableParams.filter((p) => Array.isArray(p));
    expect(arrayParams).toHaveLength(1);
    // Content check, not just shape: the bound array must equal the spread
    // of `getNonVerifiablePropertyIds()`. Without this, a future refactor
    // that introduces a second array param to the same SELECT would silently
    // pass the shape check while binding the wrong array.
    const { getNonVerifiablePropertyIds } = await import("../property-metadata.js");
    expect(arrayParams[0]).toEqual([...getNonVerifiablePropertyIds()]);
    // Sanity: properties.yaml has at least one verifiable:false entry.
    expect((arrayParams[0] as unknown[]).length).toBeGreaterThan(0);
  });

  it("survives an empty non-verifiable property list (QUA-985 red-team)", async () => {
    // Adversarial input: if properties.yaml has zero `verifiable: false`
    // entries, `[...emptySet]` is `[]` and `sql.param([])` should bind as
    // `'{}'::text[]`. The query `ANY('{}')` matches nothing, so the
    // `NOT (measure = ANY(...))` clause is true for every row — every
    // sourced fact counts as checkable. Verify the query still binds as
    // a single text[] param (no row-constructor regression on empty input)
    // and the endpoint still returns 200.
    const propertyMetadata = await import("../property-metadata.js");
    const spy = vi
      .spyOn(propertyMetadata, "getNonVerifiablePropertyIds")
      .mockReturnValue(new Set<string>());

    try {
      tableTotals = [{ table_name: "fact", total: 100 }];
      verifiedCounts = [];

      const res = await app.request("/api/sourcing/coverage");
      expect(res.status).toBe(200);

      const idx = capturedQueries.findIndex(
        (q) => /FROM\s+facts/i.test(q) && /AS\s+checkable/i.test(q),
      );
      expect(idx, "expected the checkable-facts query to be issued").toBeGreaterThanOrEqual(0);
      expect(capturedQueries[idx]).toMatch(/ANY\(\s*\$\d+::text\[\]\s*\)/);
      const arrayParams = capturedParams[idx].filter((p) => Array.isArray(p));
      expect(arrayParams).toHaveLength(1);
      expect(arrayParams[0]).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("/coverage-matrix shares the fix via countCheckableFacts (QUA-985)", async () => {
    // /coverage-matrix and /coverage both call countCheckableFacts(db). The
    // QUA-985 prod 500 affected both endpoints. This is a smoke test that
    // /coverage-matrix also issues the checkable query in the fixed shape,
    // so a future refactor that inlines the helper into one endpoint can't
    // re-introduce the bug on the other.
    tableTotals = [{ record_type: "fact", total: 100 }];
    checkedCounts = [];
    verdictRows = [];

    const res = await app.request("/api/sourcing/coverage-matrix");
    expect(res.status).toBe(200);

    const idx = capturedQueries.findIndex(
      (q) => /FROM\s+facts/i.test(q) && /AS\s+checkable/i.test(q),
    );
    expect(idx, "expected the checkable-facts query to be issued").toBeGreaterThanOrEqual(0);
    expect(capturedQueries[idx]).not.toMatch(/ANY\(\s*\(\s*\$\d+\s*,/);
    expect(capturedQueries[idx]).toMatch(/ANY\(\s*\$\d+::text\[\]\s*\)/);
  });
});

describe("QUA-928: GET /api/sourcing/coverage-matrix — checkability split", () => {
  let app: Hono;

  beforeEach(() => {
    capturedQueries = [];
    capturedParams = [];
    tableTotals = [];
    verifiedCounts = [];
    checkedCounts = [];
    verdictRows = [];
    checkableFacts = 0;
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("emits per-row checkable fields and grand totals matching the gate semantics", async () => {
    tableTotals = [
      { record_type: "fact", total: 2744 },
      { record_type: "grant", total: 5876 },
      { record_type: "citation", total: 3490 }, // exempt — see SOURCING_EXEMPT_TYPES
    ];
    checkedCounts = [
      { record_type: "fact", checked_records: 1816 },
      { record_type: "grant", checked_records: 5873 },
    ];
    verdictRows = [
      { record_type: "fact", verdict: "confirmed", cnt: 1150 },
      { record_type: "grant", verdict: "confirmed", cnt: 4906 },
    ];
    checkableFacts = 1834;

    const res = await app.request("/api/sourcing/coverage-matrix");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MatrixResponse;

    const fact = body.tables.find((t) => t.recordType === "fact");
    expect(fact!.checkableRecords).toBe(1834);
    expect(fact!.checkabilityPercent).toBeCloseTo(66.8, 1);
    expect(fact!.checkableCoveragePercent).toBeCloseTo(99.0, 1);
    expect(fact!.fullCoveragePercent).toBeCloseTo(66.2, 1);

    const grant = body.tables.find((t) => t.recordType === "grant");
    expect(grant!.checkableRecords).toBe(5876);
    expect(grant!.checkabilityPercent).toBe(100);
    expect(grant!.checkableCoveragePercent).toBeCloseTo(99.9, 1);

    // Grand totals exclude the exempt wiki-page rows.
    expect(body.totals.totalRecords).toBe(2744 + 5876);
    expect(body.totals.checkableRecords).toBe(1834 + 5876);
    expect(body.totals.checkableCoveragePercent).toBeCloseTo(
      ((1816 + 5873) / (1834 + 5876)) * 100,
      1,
    );
  });

  it("removes the ambiguous `coveragePercent` field from every row and the totals block", async () => {
    tableTotals = [{ record_type: "fact", total: 2744 }];
    checkedCounts = [{ record_type: "fact", checked_records: 1816 }];
    verdictRows = [];
    checkableFacts = 1834;

    const res = await app.request("/api/sourcing/coverage-matrix");
    const body = (await res.json()) as MatrixResponse;

    const fact = body.tables.find((t) => t.recordType === "fact")!;
    expect(fact as unknown as Record<string, unknown>).not.toHaveProperty(
      "coveragePercent",
    );
    expect(body.totals as unknown as Record<string, unknown>).not.toHaveProperty(
      "coveragePercent",
    );
  });

  it("returns zero for every percentage when total = 0 (no NaN, no Infinity)", async () => {
    tableTotals = [{ record_type: "fact", total: 0 }];
    checkedCounts = [];
    verdictRows = [];
    checkableFacts = 0;

    const res = await app.request("/api/sourcing/coverage-matrix");
    const body = (await res.json()) as MatrixResponse;
    const fact = body.tables.find((t) => t.recordType === "fact");

    expect(fact!.totalRecords).toBe(0);
    expect(fact!.checkableRecords).toBe(0);
    expect(fact!.checkabilityPercent).toBe(0);
    expect(fact!.checkableCoveragePercent).toBe(0);
    expect(fact!.fullCoveragePercent).toBe(0);
    expect(Number.isFinite(fact!.checkabilityPercent)).toBe(true);
  });

  it("treats non-fact recordTypes as fully checkable in the matrix", async () => {
    tableTotals = [{ record_type: "personnel", total: 1699 }];
    checkedCounts = [{ record_type: "personnel", checked_records: 1124 }];
    verdictRows = [];
    checkableFacts = 0;

    const res = await app.request("/api/sourcing/coverage-matrix");
    const body = (await res.json()) as MatrixResponse;
    const personnel = body.tables.find((t) => t.recordType === "personnel");

    expect(personnel!.checkableRecords).toBe(1699);
    expect(personnel!.checkabilityPercent).toBe(100);
    expect(personnel!.checkableCoveragePercent).toBeCloseTo(66.2, 1);
    expect(personnel!.fullCoveragePercent).toBeCloseTo(66.2, 1);
  });
});
