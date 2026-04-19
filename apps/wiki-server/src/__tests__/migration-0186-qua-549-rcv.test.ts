import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0186_qua_549_rcv_resource_id_to_stable_id.sql",
);

describe("migration 0186 — QUA-549 resource_content_versions FK swap", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  it("drops both the Drizzle-generated and postgres-default FK names", () => {
    // Regression for the 2026-04-18 deploy halt: the pilot only dropped the
    // Drizzle name (_fk), so prod's postgres-default name (_fkey) survived
    // and the Step 2 UPDATE tripped it because it still pointed at
    // resources(id). Every later Phase B migration drops both; assert 0186
    // does too.
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS\s+resource_content_versions_resource_id_resources_id_fk\b/,
    );
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS\s+resource_content_versions_resource_id_fkey\b/,
    );
  });

  it("rewrites resource_id from hex16 to sid_ via JOIN on resources.id", () => {
    expect(sql).toMatch(
      /UPDATE resource_content_versions[\s\S]+SET resource_id = r\.stable_id[\s\S]+FROM resources r[\s\S]+WHERE rcv\.resource_id = r\.id/,
    );
  });

  it("aborts on unresolved orphans via a DO block RAISE EXCEPTION", () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'QUA-549 migration aborted:/);
  });

  it("re-adds the FK targeting resources.stable_id with ON DELETE SET NULL", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT resource_content_versions_resource_id_resources_stable_id_fk[\s\S]+FOREIGN KEY \(resource_id\) REFERENCES resources\(stable_id\)[\s\S]+ON DELETE SET NULL/,
    );
  });
});
