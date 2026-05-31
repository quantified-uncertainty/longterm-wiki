/**
 * recordAttempts dedupes the batch before the upsert (QUA-1071).
 *
 * A duplicate (table, recordId) in one INSERT ... ON CONFLICT DO UPDATE makes
 * Postgres reject the whole statement, so the batch must be deduped first.
 * We capture the rows handed to `.values()` via a stubbed Drizzle builder.
 */

import { describe, it, expect } from "vitest";
import { recordAttempts, type AttemptInput } from "../attempts.js";

interface CapturedRow {
  tableName: string;
  recordId: string;
  lastOutcome: string;
}

/** Minimal Drizzle insert-chain stub that records the rows passed to values(). */
function stubDb(capture: { rows: CapturedRow[] }) {
  return {
    insert: () => ({
      values: (rows: CapturedRow[]) => {
        capture.rows = rows;
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(rows.map((r) => ({ recordId: r.recordId }))),
          }),
        };
      },
    }),
  } as unknown as Parameters<typeof recordAttempts>[0];
}

describe("recordAttempts dedup", () => {
  it("collapses duplicate (table, recordId), keeping the last outcome", async () => {
    const cap = { rows: [] as CapturedRow[] };
    const items: AttemptInput[] = [
      { table: "facts", recordId: "1", outcome: "no-match" },
      { table: "facts", recordId: "1", outcome: "matched" }, // dup — should win
      { table: "facts", recordId: "2", outcome: "skipped" },
      { table: "page_citations", recordId: "1", outcome: "no-match" }, // different table
    ];

    const n = await recordAttempts(stubDb(cap), items);

    expect(cap.rows).toHaveLength(3);
    expect(n).toBe(3);
    const facts1 = cap.rows.find((r) => r.tableName === "facts" && r.recordId === "1");
    expect(facts1?.lastOutcome).toBe("matched");
  });

  it("is a no-op for an empty batch", async () => {
    const cap = { rows: [] as CapturedRow[] };
    const n = await recordAttempts(stubDb(cap), []);
    expect(n).toBe(0);
    expect(cap.rows).toHaveLength(0);
  });
});
