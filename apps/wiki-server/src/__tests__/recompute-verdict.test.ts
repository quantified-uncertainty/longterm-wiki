/**
 * Integration tests for `recomputeVerdict` (QUA-791).
 *
 * Exercises the DB-touching helper end-to-end with a mocked SQL
 * dispatcher: read evidence rows → aggregate → upsert verdict via
 * UPDATE-then-INSERT-fallback, including the unique-violation retry.
 *
 * Pure-aggregator unit tests live in `sourcing-aggregation.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type SqlDispatcher, mockDbModule } from "./test-utils";

let dispatch: SqlDispatcher = () => [];
let capturedQueries: Array<{ query: string; params: unknown[] }> = [];

vi.mock("../db.js", () =>
  mockDbModule((q, p) => {
    capturedQueries.push({ query: q, params: p });
    return dispatch(q, p);
  }),
);

const { recomputeVerdict, recomputeVerdictBestEffort } = await import(
  "../routes/sourcing/recompute-verdict.js"
);
const { getDrizzleDb } = await import("../db.js");

describe("recomputeVerdict — end-to-end", () => {
  beforeEach(() => {
    capturedQueries = [];
    dispatch = () => [];
  });

  it("returns 'unchecked' aggregate and skips writes when no evidence rows exist", async () => {
    let writeCalls = 0;
    dispatch = (q) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) return [];
      if (/^(update|insert)/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        writeCalls++;
        return [];
      }
      return [];
    };

    const result = await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });

    expect(result.aggregate.verdict).toBe("unchecked");
    expect(result.aggregate.sourcesChecked).toBe(0);
    expect(result.reasoning).toMatch(/no evidence/i);
    // Short-circuit: no UPDATE/INSERT against source_check_verdicts when
    // there's no evidence to roll up. Preserves back-compat for callers
    // that use POST /verdicts as a verdict-only marker write.
    expect(writeCalls).toBe(0);
  });

  it("aggregates relevance-weighted majority from multiple evidence rows", async () => {
    dispatch = (q) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        return [
          { verdict: "confirmed", relevance_score: 0.95, confidence: 0.9 },
          { verdict: "confirmed", relevance_score: 0.85, confidence: 0.85 },
          { verdict: "partial", relevance_score: 0.5, confidence: 0.7 },
        ];
      }
      // UPDATE returns one row (verdict already exists) — no INSERT path.
      if (/^update/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        return [{ record_id: "p_test" }];
      }
      return [];
    };

    const result = await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });

    expect(result.aggregate.verdict).toBe("confirmed");
    expect(result.aggregate.sourcesChecked).toBe(3);
    expect(result.aggregate.contributing).toHaveLength(2); // confirmed + partial
    expect(result.aggregate.contributing[0].verdict).toBe("confirmed");
    expect(result.aggregate.contributing[0].rowCount).toBe(2);
  });

  it("retries with UPDATE when INSERT hits a unique-violation race", async () => {
    let updateCalls = 0;
    let insertCalls = 0;
    dispatch = (q) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        return [{ verdict: "confirmed", relevance_score: 1.0, confidence: 0.9 }];
      }
      if (/^update/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        updateCalls++;
        if (updateCalls === 1) return []; // first UPDATE: no row → INSERT path
        return [{ record_id: "p_test" }]; // retry UPDATE: row now exists, success
      }
      if (/^insert/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        insertCalls++;
        // Simulate a unique-violation that postgres throws as 23505
        const err = new Error('duplicate key value violates unique constraint "source_check_verdicts_pkey" — 23505');
        throw err;
      }
      return [];
    };

    const result = await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });

    // Should still succeed despite the race
    expect(result.aggregate.verdict).toBe("confirmed");
    expect(updateCalls).toBe(2); // 1 initial + 1 retry
    expect(insertCalls).toBe(1);
  });

  it("propagates non-unique-violation errors from INSERT", async () => {
    dispatch = (q) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        return [{ verdict: "confirmed", relevance_score: 1.0, confidence: 0.9 }];
      }
      if (/^update/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        return [];
      }
      if (/^insert/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        // Drizzle catches and re-wraps this as Error('Failed query: ...')
        // with the original on `.cause`. The "FOREIGN KEY" string appears
        // on the cause, so the recompute helper's isUniqueViolation
        // check returns false and the error propagates.
        throw new Error("violates foreign key constraint on target_table");
      }
      return [];
    };

    await expect(
      recomputeVerdict(getDrizzleDb(), {
        recordType: "personnel",
        recordId: "p_test",
        fieldName: null,
      }),
    ).rejects.toThrow();
  });

  it("filters evidence by COALESCE(field_name, '') so NULL-fieldName matches NULL rows", async () => {
    dispatch = (q, p) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        // The query's WHERE clause should include a COALESCE on field_name
        // matching the empty string passed for NULL fieldName.
        expect(q).toMatch(/COALESCE/i);
        expect(p).toContain("");
        return [];
      }
      if (/^update/i.test(q.trim())) return [];
      return [];
    };

    await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });
  });

  it("clears needs_recheck on every recompute (we just looked)", async () => {
    let updateBody = "";
    dispatch = (q, p) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        return [{ verdict: "confirmed", relevance_score: 1.0, confidence: 0.9 }];
      }
      if (/^update/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        updateBody = q;
        return [{ record_id: "p_test" }];
      }
      return [];
    };

    await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });

    // Drizzle parameterizes booleans, so we need to find the param index.
    // The SET clause includes `needs_recheck` as a column being set.
    expect(updateBody).toMatch(/needs_recheck/i);
  });

  it("sets next_check_due to ~90 days when INSERTing a fresh row", async () => {
    let insertedParams: unknown[] = [];
    dispatch = (q, p) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        return [{ verdict: "confirmed", relevance_score: 1.0, confidence: 0.9 }];
      }
      if (/^update/i.test(q.trim())) return []; // no existing row
      if (/^insert/i.test(q.trim()) && /source_check_verdicts/i.test(q)) {
        insertedParams = [...p];
        // Verify the query literally references next_check_due
        expect(q).toMatch(/next_check_due/i);
        return [];
      }
      return [];
    };

    const before = Date.now();
    await recomputeVerdict(getDrizzleDb(), {
      recordType: "personnel",
      recordId: "p_test",
      fieldName: null,
    });
    const after = Date.now();

    // postgres-js serializes Date params to ISO strings in the bound-param
    // list. Look for a string roughly 90 days out from `before`.
    const ninetyDayMs = 90 * 24 * 60 * 60 * 1000;
    const tolerance = (after - before) + 60_000; // 60s slack for clock jitter
    const hasNinetyDay = insertedParams.some((v) => {
      if (typeof v !== "string") return false;
      const t = Date.parse(v);
      if (Number.isNaN(t)) return false;
      const delta = t - before;
      return Math.abs(delta - ninetyDayMs) < tolerance;
    });
    expect(hasNinetyDay, `expected a ~90-day ISO timestamp in params: ${insertedParams.map(String).join(', ')}`).toBe(true);
  });
});

describe("recomputeVerdictBestEffort", () => {
  beforeEach(() => {
    capturedQueries = [];
    dispatch = () => [];
  });

  it("swallows recompute errors and returns void", async () => {
    dispatch = (q) => {
      if (/select/i.test(q) && /source_check_evidence/i.test(q)) {
        throw new Error("simulated DB error");
      }
      return [];
    };

    // Should NOT throw — best-effort wraps the failure.
    await expect(
      recomputeVerdictBestEffort(getDrizzleDb(), {
        recordType: "personnel",
        recordId: "p_test",
        fieldName: null,
      }),
    ).resolves.toBeUndefined();
  });
});
