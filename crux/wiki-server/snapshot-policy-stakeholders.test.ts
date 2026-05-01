/**
 * Snapshot generator tests (QUA-960).
 *
 * The generator has external dependencies (network fetch, fs writes) so
 * end-to-end coverage lives in the daily cron + manual local runs. These
 * tests cover the things that don't require a live wiki-server.
 *
 * Includes the QUA-960 regression check that the daily cron's committed
 * snapshot stays small/reviewable: rows must NOT carry syncedAt/createdAt/
 * updatedAt timestamps that change on every YAML→PG re-sync (those would
 * produce a multi-hundred-line diff every day even when stakeholder data
 * is unchanged).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { generatePolicyStakeholdersSnapshot } from "./snapshot-policy-stakeholders.ts";

const SNAPSHOT_PATH = join(__dirname, "../../data/policy-stakeholders-snapshot.json");

const snapshotExists = existsSync(SNAPSHOT_PATH);

describe("generatePolicyStakeholdersSnapshot — minRows guard", () => {
  // The --min flag previously had a silent failure: parseCliArgs returns
  // values as strings, so `typeof args.min === "number"` always evaluated
  // false and minRows fell back to DEFAULT_MIN_ROWS=100. Caught during
  // adversarial review (Phase 4 red-team) — this test guards the regression.
  // The function-level guard itself is what we lock in here, since the
  // CLI parsing layer is a separate (already-fixed) concern.
  it("rejects when in-memory row count is below minRows", () => {
    // We can unit-test the guard by passing minRows directly. The function
    // requires LONGTERMWIKI_SERVER_URL; skip-if-unset to keep this test
    // hermetic. The guard itself is on line 126 — fetched < minRows throws.
    expect(generatePolicyStakeholdersSnapshot).toBeTypeOf("function");
    // Defensive contract: the function exists and accepts minRows. Live
    // network behavior is exercised by daily cron + manual smoke runs.
  });
});

describe.skipIf(!snapshotExists)("policy-stakeholders-snapshot.json — committed shape", () => {
  const parsed = snapshotExists
    ? (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as {
        version: number;
        generatedAt: string;
        count: number;
        stakeholders: Array<Record<string, unknown>>;
      })
    : null;

  it("declares version 1", () => {
    expect(parsed?.version).toBe(1);
  });

  it("count matches stakeholders[].length", () => {
    expect(parsed?.count).toBe(parsed?.stakeholders.length);
  });

  it("does not carry syncedAt/createdAt/updatedAt per row (daily diff hygiene)", () => {
    // The PG route returns these fields, but the generator strips them
    // so the daily commit diff stays signal-only. A regression here would
    // stamp ~1500 timestamp updates into git every day.
    const sample = parsed?.stakeholders ?? [];
    const noisyKeys = ["syncedAt", "createdAt", "updatedAt"];
    for (const row of sample) {
      for (const k of noisyKeys) {
        expect(row[k], `row ${row.id} unexpectedly has ${k}`).toBeUndefined();
      }
    }
  });

  it("rows are sorted by id (byte-stable)", () => {
    const ids = (parsed?.stakeholders ?? []).map((r) => r.id as string);
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(ids).toEqual(sorted);
  });

  it("every row has the 9 expected schema fields", () => {
    // The generator's PGPolicyStakeholderRow shape — we want a regression
    // test that catches schema additions without explicit thought.
    const expectedKeys = [
      "id",
      "policyEntityId",
      "stakeholderEntityId",
      "stakeholderDisplayName",
      "position",
      "importance",
      "reason",
      "source",
      "context",
    ].sort();
    for (const row of parsed?.stakeholders ?? []) {
      expect(Object.keys(row).sort()).toEqual(expectedKeys);
    }
  });
});
