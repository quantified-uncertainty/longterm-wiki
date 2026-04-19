/**
 * QUA-576: schema.ts must model resources.stable_id as NOT NULL to match
 * DB state established by migration 0184 (QUA-536 Phase A).
 *
 * If this test fails, schema.ts has drifted back to the pre-QUA-576 state
 * where downstream callers default to unreachable `?? null` paths. See the
 * ticket for the allow-list of "still load-bearing" defensive fallbacks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { resources } from "../schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RECONCILE_MIGRATION = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0201_qua_576_resources_stableid_notnull.sql",
);
const JOURNAL = join(__dirname, "..", "..", "drizzle", "meta", "_journal.json");

describe("QUA-576 resources.stable_id schema/DB alignment", () => {
  it("resources.stableId column is NOT NULL and UNIQUE", () => {
    const { stableId } = getTableColumns(resources);
    expect(stableId.notNull).toBe(true);
    expect(stableId.isUnique).toBe(true);
  });

  it("reconcile migration 0201 guards against NULL stable_id rows", () => {
    const sql = readFileSync(RECONCILE_MIGRATION, "utf-8");
    expect(sql).toMatch(/stable_id IS NULL/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(
      /ALTER TABLE "resources" ALTER COLUMN "stable_id" SET NOT NULL/,
    );
  });

  it("drizzle journal includes the 0201 reconcile entry", () => {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf-8"));
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0201_qua_576_resources_stableid_notnull",
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(201);
  });
});
