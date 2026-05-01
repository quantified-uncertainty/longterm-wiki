import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres facts and things tables ----

let factsStore: Map<string, Record<string, unknown>>;
let thingsStore: Map<string, Record<string, unknown>>; // key: `${source_table}::${source_id}`
/** key: `${recordType}::${recordId}::${fieldName ?? ''}` (matches the verdicts PK) */
let verdictsStore: Map<string, Record<string, unknown>>;
/** key: `${recordType}::${recordId}::${sourceUrl ?? ''}::${checkerModel ?? ''}` */
let evidenceStore: Map<string, Record<string, unknown>>;
/** key: `${recordType}::${recordId}::${suggestedUrl}` */
let suggestionsStore: Map<string, Record<string, unknown>>;
/** key: `${claimId}::${recordType}::${recordId}` (matches uq_crl_claim_record) */
let claimLinksStore: Map<string, Record<string, unknown>>;
let nextId: number;

function resetStores() {
  factsStore = new Map();
  thingsStore = new Map();
  verdictsStore = new Map();
  evidenceStore = new Map();
  suggestionsStore = new Map();
  claimLinksStore = new Map();
  nextId = 1;
}

/** Inject a verdict row directly. Used by the QUA-930 cascade tests. */
function injectVerdict(
  recordType: string,
  recordId: string,
  fieldName: string | null = null,
  extra: Record<string, unknown> = {},
) {
  verdictsStore.set(`${recordType}::${recordId}::${fieldName ?? ""}`, {
    record_type: recordType,
    record_id: recordId,
    field_name: fieldName,
    entity_id: null,
    verdict: "confirmed",
    confidence: 0.9,
    reasoning: null,
    ...extra,
  });
}

/** Inject an evidence row directly. */
function injectEvidence(
  recordType: string,
  recordId: string,
  sourceUrl: string,
  extra: Record<string, unknown> = {},
) {
  evidenceStore.set(`${recordType}::${recordId}::${sourceUrl}::cm`, {
    record_type: recordType,
    record_id: recordId,
    field_name: null,
    entity_id: null,
    source_url: sourceUrl,
    verdict: "confirmed",
    confidence: 0.9,
    checker_model: "cm",
    ...extra,
  });
}

/** Inject a sourcing URL suggestion row directly. */
function injectSuggestion(
  recordType: string,
  recordId: string,
  suggestedUrl: string,
  extra: Record<string, unknown> = {},
) {
  suggestionsStore.set(`${recordType}::${recordId}::${suggestedUrl}`, {
    record_type: recordType,
    record_id: recordId,
    field_name: null,
    entity_id: null,
    suggested_url: suggestedUrl,
    title: null,
    snippet: null,
    relevance_score: null,
    source_provider: "exa",
    generator_model: null,
    status: "pending",
    ...extra,
  });
}

/** Inject a claim_record_links row directly. */
function injectClaimLink(
  recordType: string,
  recordId: string,
  claimId: number,
  extra: Record<string, unknown> = {},
) {
  claimLinksStore.set(`${claimId}::${recordType}::${recordId}`, {
    claim_id: claimId,
    record_type: recordType,
    record_id: recordId,
    match_verdict: null,
    match_confidence: null,
    ...extra,
  });
}

function thingsKey(sourceTable: string, sourceId: string) {
  return `${sourceTable}::${sourceId}`;
}

/** Inject a things row directly. Used for the prune-cleans-things test. */
function injectThing(sourceTable: string, sourceId: string) {
  thingsStore.set(thingsKey(sourceTable, sourceId), {
    source_table: sourceTable,
    source_id: sourceId,
  });
}

/** Composite key for the unique index */
function factKey(entityId: string, factId: string) {
  return `${entityId}::${factId}`;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- ref-check: SELECT id/stable_id FROM entities/resources WHERE column IN (...) ---
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    // Return all queried IDs as existing (ref check passes)
    return params.map((p) => ({ id: p }));
  }

  // --- entity resolution: SELECT stable_id FROM entities WHERE stable_id/id/wiki_id = ... ---
  if (q.includes("stable_id") && q.includes('"entities"') && q.includes("limit")) {
    // Return the first param as both the entity stableId (pass-through for tests)
    return params.length > 0 ? [{ stable_id: params[0] }] : [];
  }

  // --- facts: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes('"facts"')) {
    const COLS = 21;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const entityId = params[o] as string;
      const factIdVal = params[o + 1] as string;
      const key = factKey(entityId, factIdVal);
      const existing = factsStore.get(key);

      const row: Record<string, unknown> = {
        id: existing?.id ?? nextId++,
        entity_id: entityId,
        fact_id: factIdVal,
        label: params[o + 2],
        value: params[o + 3],
        numeric: params[o + 4],
        low: params[o + 5],
        high: params[o + 6],
        as_of: params[o + 7],
        valid_end: params[o + 8],
        currency: params[o + 9],
        measure: params[o + 10],
        subject: params[o + 11],
        note: params[o + 12],
        source: params[o + 13],
        format: params[o + 14],
        format_divisor: params[o + 15],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      factsStore.set(key, row);
      rows.push(row);
    }
    return rows;
  }

  // Discriminator: stale queries don't filter by entity_id, while
  // timeseries and by-entity queries always have entity_id = $N.
  const hasEntityIdFilter = q.includes('entity_id" =');

  // --- facts: STALE SELECT (is not null + order by, NO entity_id filter) ---
  if (
    q.includes('"facts"') &&
    q.includes("is not null") &&
    q.includes("order by") &&
    !hasEntityIdFilter &&
    !q.includes("count(*)")
  ) {
    let results = Array.from(factsStore.values()).filter(
      (r) => r.as_of !== null
    );
    // olderThan filter — first string param is the date threshold
    const dateParam = params.find((p) => typeof p === "string") as string | undefined;
    if (dateParam) {
      results = results.filter((r) => String(r.as_of) <= dateParam);
    }
    results.sort((a, b) =>
      String(a.as_of || "").localeCompare(String(b.as_of || ""))
    );
    const limitIdx = params.findIndex((p) => typeof p === "number");
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : 50;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    return results.slice(offset, offset + limit).map((r) => ({
      entityId: r.entity_id,
      factId: r.fact_id,
      label: r.label,
      asOf: r.as_of,
      measure: r.measure,
      value: r.value,
      numeric: r.numeric,
    }));
  }

  // --- facts: STALE COUNT (count + is not null, NO entity_id filter) ---
  if (
    q.includes("count(*)") &&
    q.includes('"facts"') &&
    q.includes("is not null") &&
    !hasEntityIdFilter
  ) {
    let results = Array.from(factsStore.values()).filter(
      (r) => r.as_of !== null
    );
    const dateParam = params.find((p) => typeof p === "string") as string | undefined;
    if (dateParam) {
      results = results.filter((r) => String(r.as_of) <= dateParam);
    }
    return [{ count: results.length }];
  }

  // --- facts: SELECT by entity_id + measure + as_of IS NOT NULL (timeseries) ---
  if (
    q.includes('"facts"') &&
    q.includes("where") &&
    q.includes("is not null") &&
    q.includes("order by")
  ) {
    const entityId = params[0] as string;
    let results = Array.from(factsStore.values()).filter(
      (r) => r.entity_id === entityId && r.as_of !== null
    );

    // If measure is specified
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }

    results.sort((a, b) =>
      String(a.as_of || "").localeCompare(String(b.as_of || ""))
    );

    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit =
      limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    return results.slice(0, limit);
  }

  // --- facts: SELECT by entity_id (by-entity) ---
  if (
    q.includes('"facts"') &&
    q.includes("where") &&
    q.includes("order by") &&
    q.includes("limit") &&
    !q.includes("count(*)")
  ) {
    const entityId = params[0] as string;
    let results = Array.from(factsStore.values()).filter(
      (r) => r.entity_id === entityId
    );

    // If measure is specified (second param before limit)
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }

    results.sort((a, b) =>
      String(a.fact_id || "").localeCompare(String(b.fact_id || ""))
    );

    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit =
      limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    return results.slice(offset, offset + limit);
  }

  // --- facts: COUNT(*) with entity_id filter (by-entity count) ---
  if (q.includes("count(*)") && q.includes('"facts"')) {
    if (q.includes("where")) {
      const entityId = params[0] as string;
      let count = 0;
      for (const row of factsStore.values()) {
        if (row.entity_id === entityId) {
          if (params.length > 1 && typeof params[1] === "string") {
            if (row.measure === params[1]) count++;
          } else {
            count++;
          }
        }
      }
      return [{ count }];
    }
    return [{ count: factsStore.size }];
  }

  // --- facts: count(distinct entity_id) ---
  if (q.includes("count(distinct") && q.includes("entity_id")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      unique.add(row.entity_id as string);
    }
    return [{ count: unique.size }];
  }

  // --- facts: count(distinct measure) ---
  if (q.includes("count(distinct") && q.includes("measure")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      if (row.measure) unique.add(row.measure as string);
    }
    return [{ count: unique.size }];
  }

  // --- prune: SELECT id, entity_id, fact_id FROM facts WHERE entity_id IN (...) ---
  // No order by, no count, no measure filter — match the prune query shape.
  if (
    q.includes('"facts"') &&
    q.includes("where") &&
    q.includes("entity_id") &&
    q.includes(" in ") &&
    !q.includes("order by") &&
    !q.includes("count(*)") &&
    !q.includes("delete") &&
    !q.includes("insert")
  ) {
    const ids = new Set(params as string[]);
    const rows: Array<{ id: unknown; entity_id: unknown; fact_id: unknown }> = [];
    for (const row of factsStore.values()) {
      if (ids.has(row.entity_id as string)) {
        rows.push({
          id: row.id,
          entity_id: row.entity_id,
          fact_id: row.fact_id,
        });
      }
    }
    return rows;
  }

  // --- prune: DELETE FROM facts WHERE id IN (...) ---
  if (q.includes("delete") && q.includes('"facts"')) {
    const idsToDelete = new Set(params);
    for (const [key, row] of factsStore) {
      if (idsToDelete.has(row.id)) {
        factsStore.delete(key);
      }
    }
    return [];
  }

  // --- prune: DELETE FROM things WHERE source_table = ? AND source_id IN (...) ---
  if (q.includes("delete") && q.includes('"things"')) {
    // First param is the source_table literal, the rest are source_ids.
    const sourceTable = params[0] as string;
    const sourceIds = new Set(params.slice(1) as string[]);
    for (const [key, row] of thingsStore) {
      if (
        row.source_table === sourceTable &&
        sourceIds.has(row.source_id as string)
      ) {
        thingsStore.delete(key);
      }
    }
    return [];
  }

  // --- source_check_verdicts: INSERT ... ON CONFLICT (writeInlineVerdicts) ---
  // writeInlineVerdicts emits literal `NULL` for field_name and SQL constants
  // for sources_checked / needs_recheck / next_check_due / NOW() values, so
  // those slots do not appear in `params`. Param order matches the bound
  // template variables in writeInlineVerdicts.ts:
  //   [recordType, recordId, entityId, verdict, confidence, reasoning]
  if (
    q.includes("insert into source_check_verdicts") ||
    (q.includes("source_check_verdicts") && q.includes("on conflict"))
  ) {
    const recordType = String(params[0] ?? "");
    const recordId = String(params[1] ?? "");
    const entityId = params[2] ?? null;
    const verdict = params[3] ?? null;
    const confidence = params[4] ?? null;
    const reasoning = params[5] ?? null;
    verdictsStore.set(`${recordType}::${recordId}::`, {
      record_type: recordType,
      record_id: recordId,
      field_name: null,
      entity_id: entityId,
      verdict,
      confidence,
      reasoning,
    });
    return [];
  }

  // --- source_check_evidence: INSERT ... ON CONFLICT (writeInlineVerdicts) ---
  // Param order:
  //   [recordType, recordId, entityId, sourceUrl, verdict, confidence,
  //    extractedQuote, checkerModel, (checkedAt if explicit)]
  if (
    q.includes("insert into source_check_evidence") ||
    (q.includes("source_check_evidence") && q.includes("on conflict"))
  ) {
    const recordType = String(params[0] ?? "");
    const recordId = String(params[1] ?? "");
    const entityId = params[2] ?? null;
    const sourceUrl = String(params[3] ?? "");
    const verdict = params[4] ?? null;
    const confidence = params[5] ?? null;
    const extractedQuote = params[6] ?? null;
    const checkerModel = String(params[7] ?? "");
    evidenceStore.set(
      `${recordType}::${recordId}::${sourceUrl}::${checkerModel}`,
      {
        record_type: recordType,
        record_id: recordId,
        field_name: null,
        entity_id: entityId,
        source_url: sourceUrl,
        verdict,
        confidence,
        extracted_quote: extractedQuote,
        checker_model: checkerModel,
      },
    );
    return [];
  }

  // --- recomputeVerdict: SELECT FROM source_check_evidence ---
  // Returns existing evidence rows for the (recordType, recordId, fieldName).
  // Tests don't care about the exact aggregate result, so return empty —
  // recomputeVerdict will short-circuit to "unchecked" without DELETing.
  if (q.includes("source_check_evidence") && q.includes("select")) {
    return [];
  }

  // --- recomputeVerdict: UPDATE source_check_verdicts (when no evidence) ---
  if (q.includes("update") && q.includes("source_check_verdicts")) {
    return [];
  }

  // --- DELETE FROM <table> WHERE record_type=$1 AND record_id IN ($2..) (QUA-930 cascade) ---
  // Shared handler for all five (record_type, record_id)-keyed cascade tables.
  // Also handles the existing recomputeVerdict DELETE on source_check_verdicts
  // (no IN clause) by falling through to the no-op path.
  const cascadeStores: Array<[string, Map<string, Record<string, unknown>>]> = [
    ["source_check_verdicts", verdictsStore],
    ["source_check_evidence", evidenceStore],
    ["sourcing_url_suggestions", suggestionsStore],
    ["claim_record_links", claimLinksStore],
  ];
  for (const [tableName, store] of cascadeStores) {
    if (q.includes("delete") && q.includes(tableName)) {
      if (
        q.includes("record_type") &&
        q.includes("record_id") &&
        q.includes(" in ")
      ) {
        const recordType = String(params[0] ?? "");
        const recordIds = new Set(params.slice(1) as string[]);
        const deleted: Array<{ record_id: string }> = [];
        for (const [key, row] of store) {
          if (
            row.record_type === recordType &&
            recordIds.has(row.record_id as string)
          ) {
            store.delete(key);
            deleted.push({ record_id: row.record_id as string });
          }
        }
        return deleted;
      }
      return [];
    }
  }

  // --- entity_ids: COUNT (for health check) ---
  if (q.includes("count(*)") && !q.includes('"facts"')) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function seedFact(
  app: Hono,
  entityId: string,
  factId: string,
  opts: Record<string, unknown> = {}
) {
  return postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
    facts: [
      {
        entityId,
        factId,
        label: opts.label ?? `Fact ${factId}`,
        value: opts.value ?? "100",
        numeric: opts.numeric ?? 100,
        asOf: opts.asOf ?? "2025-06",
        measure: opts.measure ?? "revenue",
        ...opts,
      },
    ],
  });
}

/**
 * Inject a row directly into the in-memory store, bypassing the sync endpoint
 * validation. Used to seed legacy/corrupt rows that the new write-time
 * superRefine would reject — e.g. format=number with numeric=null. Issue #4017.
 */
function injectRawRow(row: Record<string, unknown>) {
  const key = factKey(row.entity_id as string, row.fact_id as string);
  const now = new Date();
  factsStore.set(key, {
    id: nextId++,
    label: null,
    value: null,
    numeric: null,
    low: null,
    high: null,
    as_of: null,
    valid_end: null,
    currency: null,
    measure: null,
    subject: null,
    note: null,
    source: null,
    format: null,
    format_divisor: null,
    synced_at: now,
    created_at: now,
    updated_at: now,
    ...row,
  });
}

// ---- Tests ----

describe("Facts API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/facts/sync", () => {
    it("creates new facts", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc123",
            label: "Valuation",
            value: "61000000000",
            numeric: 61000000000,
            asOf: "2024-03",
            measure: "valuation",
          },
          {
            entityId: "anthropic",
            factId: "def456",
            label: "Revenue",
            value: "1000000000",
            numeric: 1000000000,
            asOf: "2025-01",
            measure: "revenue",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("updates existing facts", async () => {
      await seedFact(app, "anthropic", "abc123", {
        label: "Old label",
        value: "100",
      });

      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc123",
            label: "Updated label",
            value: "200",
            numeric: 200,
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", { facts: [] });
      expect(res.status).toBe(400);
    });

    it("rejects facts without entityId", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [{ factId: "abc" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/facts/sync?forceSkipSourcing=true&reason=test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });

    // Issue #4017 — numeric formats with NULL columns previously got
    // silently coerced to 0 on read. Reject them at the write boundary.
    it("rejects format=number with null numeric (issue #4017)", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "bad-number",
            value: "unknown",
            numeric: null,
            format: "number",
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects format=min with null numeric (issue #4017)", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "bad-min",
            value: "≥unknown",
            numeric: null,
            format: "min",
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects format=range with null low/high (issue #4017)", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "bad-range",
            value: "?",
            low: null,
            high: null,
            format: "range",
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("accepts format=number with explicit zero (real zero is not null)", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "real-zero",
            value: "0",
            numeric: 0,
            format: "number",
          },
        ],
      });
      expect(res.status).toBe(200);
    });

    // ---- QUA-850: inline sourcing wiring ----

    it("writes a verdict row when a fact carries an inline `sourcing` block", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "rev2024",
            label: "Revenue",
            value: "1000000000",
            numeric: 1000000000,
            asOf: "2024",
            measure: "revenue",
            source: "https://anthropic.com/about",
            sourcing: {
              verdict: "confirmed",
              evidence: "Annual report states $1B revenue.",
              confidence: 0.9,
              checkedAt: "2026-04-29T00:00:00.000Z",
              checkedBy: "claude-haiku-4-5-20251001",
            },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upserted: number; verdictsWritten: number };
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(1);

      // The verdict was upserted via record_type='fact', record_id=factId.
      const verdict = verdictsStore.get("fact::rev2024::");
      expect(verdict).toBeDefined();
      expect(verdict!.verdict).toBe("confirmed");
      expect(verdict!.entity_id).toBe("anthropic");

      // Evidence row was upserted at the fact's source URL using the
      // sourcing.checkedBy as the checker_model — same convention used by
      // tablebase routes.
      const evidence = evidenceStore.get(
        "fact::rev2024::https://anthropic.com/about::claude-haiku-4-5-20251001",
      );
      expect(evidence).toBeDefined();
      expect(evidence!.verdict).toBe("confirmed");
      expect(evidence!.extracted_quote).toBe("Annual report states $1B revenue.");
    });

    it("is backwards-compatible: facts without sourcing succeed and write zero verdicts", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "rev2025",
            value: "2000000000",
            numeric: 2000000000,
            asOf: "2025",
            measure: "revenue",
            // no sourcing block
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upserted: number; verdictsWritten: number };
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
      expect(verdictsStore.size).toBe(0);
      expect(evidenceStore.size).toBe(0);
    });

    it("writes verdicts for the subset of facts that carry sourcing in a mixed batch", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "fact-a",
            value: "100",
            numeric: 100,
            measure: "revenue",
          },
          {
            entityId: "anthropic",
            factId: "fact-b",
            value: "200",
            numeric: 200,
            measure: "revenue",
            sourcing: { verdict: "partial", confidence: 0.5 },
          },
          {
            entityId: "anthropic",
            factId: "fact-c",
            value: "300",
            numeric: 300,
            measure: "revenue",
            sourcing: { verdict: "contradicted" },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upserted: number; verdictsWritten: number };
      expect(body.upserted).toBe(3);
      expect(body.verdictsWritten).toBe(2);
      expect(verdictsStore.has("fact::fact-a::")).toBe(false);
      expect(verdictsStore.get("fact::fact-b::")?.verdict).toBe("partial");
      expect(verdictsStore.get("fact::fact-c::")?.verdict).toBe("contradicted");
    });

    it("rejects an invalid verdict enum value with 400 (not silent fail-open)", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "rev-bad",
            value: "100",
            numeric: 100,
            measure: "revenue",
            sourcing: { verdict: "definitely-not-a-real-verdict" },
          },
        ],
      });
      expect(res.status).toBe(400);
      // Schema rejection — no rows written.
      expect(factsStore.size).toBe(0);
      expect(verdictsStore.size).toBe(0);
    });

    // QUA-852 / QUA-729 Phase C: SOURCE_CHECK_REQUIRED.fact = true. Items
    // without a `sourcing` block are rejected unless the caller passes
    // `?forceSkipSourcing=true&reason=...` (audit-logged escape hatch).
    describe("sourcing enforcement (QUA-852)", () => {
      it("rejects fact items without sourcing when no bypass is provided", async () => {
        const res = await postJson(app, "/api/facts/sync", {
          facts: [
            {
              entityId: "anthropic",
              factId: "no-source-1",
              value: "100",
              numeric: 100,
              measure: "revenue",
            },
          ],
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { message?: string };
        expect(body.message ?? "").toMatch(/sourcing/i);
        // Nothing should have been written.
        expect(factsStore.size).toBe(0);
        expect(verdictsStore.size).toBe(0);
      });

      it("rejects mixed batches where any item lacks sourcing", async () => {
        const res = await postJson(app, "/api/facts/sync", {
          facts: [
            {
              entityId: "anthropic",
              factId: "with-sourcing",
              value: "100",
              numeric: 100,
              measure: "revenue",
              sourcing: { verdict: "confirmed" },
            },
            {
              entityId: "anthropic",
              factId: "no-sourcing",
              value: "200",
              numeric: 200,
              measure: "revenue",
            },
          ],
        });
        expect(res.status).toBe(400);
        // Whole batch fails — no partial writes.
        expect(factsStore.size).toBe(0);
        expect(verdictsStore.size).toBe(0);
      });

      it("accepts items with sourcing without bypass", async () => {
        const res = await postJson(app, "/api/facts/sync", {
          facts: [
            {
              entityId: "anthropic",
              factId: "all-sourced",
              value: "100",
              numeric: 100,
              measure: "revenue",
              sourcing: { verdict: "confirmed", confidence: 0.9 },
            },
          ],
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { upserted: number; verdictsWritten: number };
        expect(body.upserted).toBe(1);
        expect(body.verdictsWritten).toBe(1);
      });

      it("accepts unsourced items when forceSkipSourcing=true is provided", async () => {
        const res = await postJson(
          app,
          "/api/facts/sync?forceSkipSourcing=true&reason=bulk%20YAML%20re-sync",
          {
            facts: [
              {
                entityId: "anthropic",
                factId: "bypass-1",
                value: "100",
                numeric: 100,
                measure: "revenue",
              },
            ],
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { upserted: number };
        expect(body.upserted).toBe(1);
      });
    });
  });

  // ---- By Entity ----

  describe("GET /api/facts/by-entity/:entityId", () => {
    it("returns facts for an entity", async () => {
      await seedFact(app, "anthropic", "abc123", {
        label: "Valuation",
        measure: "valuation",
      });
      await seedFact(app, "anthropic", "def456", {
        label: "Revenue",
        measure: "revenue",
      });

      const res = await app.request("/api/facts/by-entity/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.facts).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns empty for unknown entity", async () => {
      const res = await app.request("/api/facts/by-entity/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    // PR #4020 review H3 — the original PR only filtered malformed rows in
    // /export, leaving /by-entity exposed. Inject a legacy row directly
    // (bypassing the sync endpoint, which now rejects these via superRefine).
    it("filters out legacy malformed numeric rows (issue #4017 H3)", async () => {
      // Two valid rows + one malformed (format=number, numeric=null)
      injectRawRow({ entity_id: "anthropic", fact_id: "valid-1", numeric: 100, format: "number" });
      injectRawRow({ entity_id: "anthropic", fact_id: "bad-malformed", numeric: null, format: "number" });
      injectRawRow({ entity_id: "anthropic", fact_id: "valid-2", numeric: 200, format: "number" });

      const res = await app.request("/api/facts/by-entity/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();

      // The malformed row is filtered from the response
      expect(body.facts).toHaveLength(2);
      expect(body.facts.map((f: { factId: string }) => f.factId).sort()).toEqual(["valid-1", "valid-2"]);

      // total still reflects the database total (3) — pagination consumers
      // need this contract so they don't hang waiting for more pages
      expect(body.total).toBe(3);
    });

    it("filters malformed range rows from /by-entity", async () => {
      injectRawRow({ entity_id: "anthropic", fact_id: "valid-range", low: 10, high: 20, format: "range" });
      injectRawRow({ entity_id: "anthropic", fact_id: "bad-range-no-low", low: null, high: 20, format: "range" });
      injectRawRow({ entity_id: "anthropic", fact_id: "bad-range-no-high", low: 10, high: null, format: "range" });

      const res = await app.request("/api/facts/by-entity/anthropic");
      const body = await res.json();
      expect(body.facts).toHaveLength(1);
      expect(body.facts[0].factId).toBe("valid-range");
    });
  });

  // ---- Timeseries ----

  describe("GET /api/facts/timeseries/:entityId", () => {
    it("returns timeseries for a measure", async () => {
      await seedFact(app, "anthropic", "rev-q1", {
        label: "Revenue Q1",
        asOf: "2025-01",
        measure: "revenue",
        numeric: 1000000000,
      });
      await seedFact(app, "anthropic", "rev-q2", {
        label: "Revenue Q2",
        asOf: "2025-06",
        measure: "revenue",
        numeric: 4000000000,
      });

      const res = await app.request(
        "/api/facts/timeseries/anthropic?measure=revenue"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.measure).toBe("revenue");
      expect(body.points.length).toBeGreaterThan(0);
    });

    it("requires measure parameter", async () => {
      const res = await app.request("/api/facts/timeseries/anthropic");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toBeDefined();
    });

    // PR #4020 review H3 — same fix as /by-entity, applied to /timeseries
    it("filters out legacy malformed numeric rows (issue #4017 H3)", async () => {
      injectRawRow({
        entity_id: "anthropic",
        fact_id: "rev-q1",
        numeric: 1000000000,
        format: "number",
        as_of: "2025-01",
        measure: "revenue",
      });
      injectRawRow({
        entity_id: "anthropic",
        fact_id: "rev-bad",
        numeric: null,
        format: "number",
        as_of: "2025-04",
        measure: "revenue",
      });
      injectRawRow({
        entity_id: "anthropic",
        fact_id: "rev-q2",
        numeric: 4000000000,
        format: "number",
        as_of: "2025-06",
        measure: "revenue",
      });

      const res = await app.request("/api/facts/timeseries/anthropic?measure=revenue");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.points).toHaveLength(2);
      // total reflects the FILTERED count for /timeseries (not the DB count)
      // because the route doesn't run a separate count query
      expect(body.total).toBe(2);
      expect(body.points.map((p: { factId: string }) => p.factId).sort()).toEqual(["rev-q1", "rev-q2"]);
    });
  });

  // ---- Validation error shape (zv helper) ----

  describe("zv() validator error shape", () => {
    it("returns validation_error for invalid by-entity query params", async () => {
      const res = await app.request(
        "/api/facts/by-entity/anthropic?limit=-1"
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(typeof body.message).toBe("string");
    });

    it("returns validation_error for invalid stale query params", async () => {
      const res = await app.request("/api/facts/stale?limit=0");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(typeof body.message).toBe("string");
    });

    it("clamps limit above max page size instead of rejecting", async () => {
      const res = await app.request(
        "/api/facts/by-entity/anthropic?limit=999"
      );
      // Should succeed with clamped limit, not reject with 400
      expect(res.status).toBe(200);
    });
  });

  // ---- Stats ----

  describe("GET /api/facts/stats", () => {
    it("returns fact statistics", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });
      await seedFact(app, "openai", "def", { measure: "revenue" });

      const res = await app.request("/api/facts/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.uniqueEntities).toBe(2);
      expect(body.uniqueMeasures).toBe(2);
    });
  });

  // ---- Stale ----

  describe("GET /api/facts/stale", () => {
    it("returns stale facts ordered by asOf", async () => {
      await seedFact(app, "anthropic", "old-fact", {
        asOf: "2023-01",
        measure: "revenue",
      });
      await seedFact(app, "anthropic", "recent-fact", {
        asOf: "2025-12",
        measure: "revenue",
      });

      const res = await app.request("/api/facts/stale?olderThan=2024-01");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
    });

    it("returns all facts with asOf when no olderThan given", async () => {
      await seedFact(app, "anthropic", "f1", { asOf: "2025-06" });

      const res = await app.request("/api/facts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts.length).toBeGreaterThan(0);
    });

    it("returns empty when no stale facts", async () => {
      const res = await app.request("/api/facts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Range values ----

  describe("Range value facts", () => {
    it("syncs facts with low/high range", async () => {
      const res = await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "rev-guidance",
            label: "Revenue guidance",
            value: "20000000000-26000000000",
            low: 20000000000,
            high: 26000000000,
            asOf: "2026-01",
            measure: "revenue-guidance",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  // ---- Auth ----

  describe("Bearer auth", () => {
    it("rejects unauthenticated sync when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc",
            label: "Test",
          },
        ],
      });

      expect(res.status).toBe(401);
    });

    it("accepts sync with correct Bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await authedApp.request("/api/facts/sync?forceSkipSourcing=true&reason=test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          facts: [
            {
              entityId: "anthropic",
              factId: "abc",
              label: "Test",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
    });
  });

  // ---- Prune ----

  describe("POST /api/facts/prune (QUA-462)", () => {
    it("deletes facts whose factId is not in the keep list for an entity", async () => {
      // Seed three facts for anthropic.
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_keep1", label: "Keep 1", value: "1", numeric: 1, asOf: "2025-01", measure: "x" },
          { entityId: "anthropic", factId: "f_keep2", label: "Keep 2", value: "2", numeric: 2, asOf: "2025-02", measure: "x" },
          { entityId: "anthropic", factId: "f_stale", label: "Stale", value: "3", numeric: 3, asOf: "2025-03", measure: "x" },
        ],
      });
      expect(factsStore.size).toBe(3);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_keep1", "f_keep2"] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.ids).toEqual([{ entityId: "anthropic", factId: "f_stale" }]);
      expect(factsStore.size).toBe(2);
      // The kept rows are still there.
      expect(factKey("anthropic", "f_keep1") in Object.fromEntries(factsStore)).toBe(true);
      expect(factKey("anthropic", "f_stale") in Object.fromEntries(factsStore)).toBe(false);
    });

    it("deletes ALL facts for an entity when its keep list is empty (constellation case from QUA-462)", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "constellation", factId: "f_alcohol1", label: "Founded", value: "1945", numeric: 1945, asOf: "1945", measure: "founded" },
          { entityId: "constellation", factId: "f_alcohol2", label: "HQ", value: "Victor", measure: "hq" },
          { entityId: "constellation", factId: "f_alcohol3", label: "Industry", value: "Alcohol", measure: "industry" },
          // Unrelated entity that must NOT be touched.
          { entityId: "anthropic", factId: "f_keep", label: "Valuation", value: "61000000000", numeric: 61000000000, measure: "valuation" },
        ],
      });
      expect(factsStore.size).toBe(4);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "constellation", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(3);
      // The other entity's facts are left alone — partial syncs are safe.
      expect(factsStore.size).toBe(1);
      const remaining = Array.from(factsStore.values())[0];
      expect(remaining.entity_id).toBe("anthropic");
    });

    it("never touches facts for entities not in the request (cross-entity safety)", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_a", label: "A", value: "1", numeric: 1, measure: "x" },
          { entityId: "openai", factId: "f_b", label: "B", value: "2", numeric: 2, measure: "x" },
          { entityId: "deepmind", factId: "f_c", label: "C", value: "3", numeric: 3, measure: "x" },
        ],
      });

      // Prune with only anthropic in the request — openai and deepmind facts
      // must survive even though the request technically "doesn't keep" them.
      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_a"] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(factsStore.size).toBe(3);
    });

    it("removes the dual-write things rows for deleted facts", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "constellation", factId: "f_old", label: "Founded", value: "1945", numeric: 1945, measure: "founded" },
        ],
      });
      // Inject the matching things row that the sync's dual-write would
      // have produced (the dispatcher's no-op INSERT path doesn't track it).
      injectThing("facts", "constellation:f_old");
      expect(thingsStore.size).toBe(1);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "constellation", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(factsStore.size).toBe(0);
      // The dual-write row was cleaned up — orphan things rows would otherwise
      // keep the constellation founded fact visible on /organizations/*/data.
      expect(thingsStore.size).toBe(0);
    });

    it("returns 0 deleted when all facts in the keep list match what is in PG", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_a", label: "A", value: "1", numeric: 1, measure: "x" },
        ],
      });

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_a"] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(body.ids).toEqual([]);
    });

    it("returns 0 deleted when entries is empty", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_a", label: "A", value: "1", numeric: 1, measure: "x" },
        ],
      });

      const res = await postJson(app, "/api/facts/prune", { entries: [] });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(factsStore.size).toBe(1);
    });

    it("rejects malformed entries", async () => {
      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "", factIds: [] }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects request with no entries field", async () => {
      const res = await postJson(app, "/api/facts/prune", {});
      expect(res.status).toBe(400);
    });

    it("is idempotent — a second prune is a no-op", async () => {
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_keep", label: "K", value: "1", numeric: 1, measure: "x" },
          { entityId: "anthropic", factId: "f_stale", label: "S", value: "2", numeric: 2, measure: "x" },
        ],
      });

      const first = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_keep"] }],
      });
      expect(first.status).toBe(200);
      expect((await first.json()).deleted).toBe(1);
      expect(factsStore.size).toBe(1);

      // Second call: PG already matches YAML, nothing to do.
      const second = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_keep"] }],
      });
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.deleted).toBe(0);
      expect(body.ids).toEqual([]);
      expect(factsStore.size).toBe(1);
    });

    it("handles URL-unsafe characters in entityId / factId (things-row key safety)", async () => {
      // Characters that need percent-encoding in the things.source_id key.
      // The toFactThingKey used by /sync and /prune must match so the
      // dual-write row is found and deleted.
      const entityId = "sid_with:colon";
      const factId = "f_with space";
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId, factId, label: "X", value: "1", numeric: 1, measure: "x" },
        ],
      });
      // Inject the matching things row (dispatch does not track dual-writes).
      // The encoded key is what /sync produces and what /prune queries.
      injectThing(
        "facts",
        `${encodeURIComponent(entityId)}:${encodeURIComponent(factId)}`,
      );
      expect(thingsStore.size).toBe(1);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId, factIds: [] }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.ids[0]).toEqual({ entityId, factId });
      expect(factsStore.size).toBe(0);
      expect(thingsStore.size).toBe(0);
    });

    it("handles a larger batch across many entities", async () => {
      // Seed 50 entities × 3 facts = 150 rows, keep only 1 fact per entity → 100 stale.
      const facts: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 50; i++) {
        const eid = `sid_ent${i}`;
        for (const suf of ["keep", "stale1", "stale2"]) {
          facts.push({
            entityId: eid,
            factId: `f_${suf}`,
            label: suf,
            value: "1",
            numeric: 1,
            measure: "x",
          });
        }
      }
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", { facts });
      expect(factsStore.size).toBe(150);

      const entries = Array.from({ length: 50 }, (_, i) => ({
        entityId: `sid_ent${i}`,
        factIds: ["f_keep"],
      }));
      const res = await postJson(app, "/api/facts/prune", { entries });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(100);
      expect(body.ids).toHaveLength(100);
      // Every surviving row is a "keep".
      expect(factsStore.size).toBe(50);
      for (const row of factsStore.values()) {
        expect(row.fact_id).toBe("f_keep");
      }
    });

    it("returns a stable response shape for the typed client cast (PruneFactsResult)", async () => {
      // The client in crux/wiki-server/sync-facts.ts casts the response as
      // `PruneFactsResult` — inferred from this exact route via Hono RPC in
      // crux/lib/wiki-server/facts.ts. If a future refactor changes the
      // shape, this test catches it before the crux side silently breaks.
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", {
        facts: [
          { entityId: "anthropic", factId: "f_stale", label: "S", value: "1", numeric: 1, measure: "x" },
        ],
      });
      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });
      const body = await res.json();
      expect(typeof body.deleted).toBe("number");
      expect(Array.isArray(body.ids)).toBe(true);
      expect(typeof body.truncated).toBe("boolean");
      expect(body.ids[0]).toHaveProperty("entityId");
      expect(body.ids[0]).toHaveProperty("factId");
      // Exactly these two keys on the id record — no accidental extra fields.
      expect(Object.keys(body.ids[0]).sort()).toEqual(["entityId", "factId"]);
      // Top-level keys are {cascaded, deleted, ids, truncated} (QUA-930 added
      // cascaded for sync-facts cli logging) — no accidental extras.
      expect(Object.keys(body).sort()).toEqual([
        "cascaded",
        "deleted",
        "ids",
        "truncated",
      ]);
      // Cascaded sub-shape — all 4 cascade-target tables represented.
      expect(Object.keys(body.cascaded).sort()).toEqual([
        "claimLinks",
        "evidence",
        "suggestions",
        "verdicts",
      ]);
      expect(typeof body.cascaded.verdicts).toBe("number");
      expect(typeof body.cascaded.evidence).toBe("number");
      expect(typeof body.cascaded.suggestions).toBe("number");
      expect(typeof body.cascaded.claimLinks).toBe("number");
    });

    it("caps the returned `ids` at MAX_PRUNE_RESPONSE_IDS and sets truncated=true", async () => {
      // Seed 1002 stale facts, prune with an empty keep list, and verify the
      // response caps ids at 1000 and sets truncated=true. This protects
      // against unbounded response payloads (per the review).
      // The /sync endpoint caps each batch at 500 facts, so split into chunks.
      const makeFact = (i: number) => ({
        entityId: "anthropic",
        factId: `f_${i}`,
        label: "X",
        value: "1",
        numeric: 1,
        measure: "x",
      });
      const batch1 = Array.from({ length: 500 }, (_, i) => makeFact(i));
      const batch2 = Array.from({ length: 500 }, (_, i) => makeFact(i + 500));
      const batch3 = Array.from({ length: 2 }, (_, i) => makeFact(i + 1000));
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", { facts: batch1 });
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", { facts: batch2 });
      await postJson(app, "/api/facts/sync?forceSkipSourcing=true&reason=test", { facts: batch3 });
      expect(factsStore.size).toBe(1002);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1002);
      expect(body.ids).toHaveLength(1000);
      expect(body.truncated).toBe(true);
      expect(factsStore.size).toBe(0);
    });
  });

  // ---- QUA-930: cascade deletion of dependent sourcing rows ----

  describe("POST /api/facts/prune cascade (QUA-930)", () => {
    it("deletes dependent verdicts/evidence/suggestions/claim-links when a fact is pruned", async () => {
      // Seed a fact and inject the dependent sourcing rows that the
      // sourcing pipeline would have produced for it.
      await seedFact(app, "anthropic", "f_stale", { measure: "revenue" });
      injectVerdict("fact", "f_stale");
      injectEvidence("fact", "f_stale", "https://example.com/source");
      injectSuggestion("fact", "f_stale", "https://example.com/suggested");
      injectClaimLink("fact", "f_stale", 100);
      // Also seed an unrelated fact + its dependents to confirm the cascade
      // is scoped to deleted facts only.
      await seedFact(app, "anthropic", "f_keep", { measure: "valuation" });
      injectVerdict("fact", "f_keep");
      injectEvidence("fact", "f_keep", "https://example.com/keep-source");
      injectClaimLink("fact", "f_keep", 200);
      expect(verdictsStore.size).toBe(2);
      expect(evidenceStore.size).toBe(2);
      expect(suggestionsStore.size).toBe(1);
      expect(claimLinksStore.size).toBe(2);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_keep"] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.ids).toEqual([{ entityId: "anthropic", factId: "f_stale" }]);
      // Cascade counts surfaced in response so the sync-facts CLI can log them.
      expect(body.cascaded).toEqual({
        verdicts: 1,
        evidence: 1,
        suggestions: 1,
        claimLinks: 1,
      });
      // The kept fact's verdict / evidence / claim-link are untouched.
      expect(verdictsStore.size).toBe(1);
      expect(Array.from(verdictsStore.values())[0].record_id).toBe("f_keep");
      expect(evidenceStore.size).toBe(1);
      expect(Array.from(evidenceStore.values())[0].record_id).toBe("f_keep");
      expect(suggestionsStore.size).toBe(0);
      expect(claimLinksStore.size).toBe(1);
      expect(Array.from(claimLinksStore.values())[0].record_id).toBe("f_keep");
    });

    it("returns zero cascade counts when there are no dependents", async () => {
      await seedFact(app, "anthropic", "f_stale", { measure: "revenue" });
      // No verdicts/evidence/suggestions/claim-links injected.

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.cascaded).toEqual({
        verdicts: 0,
        evidence: 0,
        suggestions: 0,
        claimLinks: 0,
      });
    });

    it("does NOT cascade across record types — only fact-typed rows are deleted", async () => {
      // Seed a fact and a same-id dependent row of a different record type.
      // The cascade must scope by record_type='fact' so a deleted fact_id
      // does not collide with e.g. a personnel id that happens to share the
      // same string. (Today PG primary keys make this unlikely, but the
      // record_type filter is a defense-in-depth guarantee.)
      await seedFact(app, "anthropic", "f_stale", { measure: "revenue" });
      injectVerdict("fact", "f_stale");
      injectVerdict("personnel", "f_stale"); // same id, different record_type

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.cascaded.verdicts).toBe(1);
      // The personnel verdict survives — it's not a fact orphan.
      expect(verdictsStore.size).toBe(1);
      const remaining = Array.from(verdictsStore.values())[0];
      expect(remaining.record_type).toBe("personnel");
    });

    it("returns all-zero cascade counts when no facts are stale", async () => {
      await seedFact(app, "anthropic", "f_keep", { measure: "x" });
      injectVerdict("fact", "f_keep");

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: ["f_keep"] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(body.cascaded).toEqual({
        verdicts: 0,
        evidence: 0,
        suggestions: 0,
        claimLinks: 0,
      });
      // Verdict still there.
      expect(verdictsStore.size).toBe(1);
    });

    it("cascades across multiple stale facts in one call", async () => {
      await seedFact(app, "anthropic", "f_a", { measure: "x" });
      await seedFact(app, "anthropic", "f_b", { measure: "y" });
      await seedFact(app, "anthropic", "f_c", { measure: "z" });
      injectVerdict("fact", "f_a");
      injectVerdict("fact", "f_b");
      injectVerdict("fact", "f_c");
      injectEvidence("fact", "f_a", "https://example.com/a");
      injectEvidence("fact", "f_b", "https://example.com/b1");
      injectEvidence("fact", "f_b", "https://example.com/b2");
      injectSuggestion("fact", "f_c", "https://example.com/suggested-c");
      injectClaimLink("fact", "f_a", 10);
      injectClaimLink("fact", "f_a", 11); // a fact can have multiple links
      injectClaimLink("fact", "f_b", 12);

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(3);
      expect(body.cascaded.verdicts).toBe(3);
      expect(body.cascaded.evidence).toBe(3);
      expect(body.cascaded.suggestions).toBe(1);
      expect(body.cascaded.claimLinks).toBe(3);
      expect(verdictsStore.size).toBe(0);
      expect(evidenceStore.size).toBe(0);
      expect(suggestionsStore.size).toBe(0);
      expect(claimLinksStore.size).toBe(0);
    });

    it("cascades claim_record_links scoped by record_type='fact' only", async () => {
      // QUA-930: same defense-in-depth check as the verdict test —
      // claim_record_links rows for a different record_type must survive.
      await seedFact(app, "anthropic", "f_stale", { measure: "x" });
      injectClaimLink("fact", "f_stale", 1);
      injectClaimLink("personnel", "f_stale", 2); // same id, different type

      const res = await postJson(app, "/api/facts/prune", {
        entries: [{ entityId: "anthropic", factIds: [] }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.cascaded.claimLinks).toBe(1);
      // The personnel link survives.
      expect(claimLinksStore.size).toBe(1);
      const remaining = Array.from(claimLinksStore.values())[0];
      expect(remaining.record_type).toBe("personnel");
    });
  });
});
