/**
 * Drift check — swap_fk_target() procedure body is defined in two places:
 *
 *   drizzle/helpers/swap_fk_target.sql  (canonical reference copy)
 *   drizzle/0199_install_swap_fk_target.sql  (Drizzle install migration)
 *
 * The procedure body MUST be identical between the two. Drizzle doesn't
 * rescan the helpers/ folder, so the install migration is what actually
 * runs; the helpers/ copy exists so developers have a single-file reference
 * with the preamble comments and canonical version in one place.
 *
 * If you're updating the procedure, update both files in the same commit.
 * Better: create a new `NNNN_update_swap_fk_target.sql` migration with the
 * new body and update helpers/ to match — Drizzle's journal ensures the
 * new version is applied to every env.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const drizzleDir = path.resolve(__dirname, "../../drizzle");

/** Extract the CREATE OR REPLACE PROCEDURE block from a .sql file. */
function extractProcedureBody(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  const start = content.indexOf("CREATE OR REPLACE PROCEDURE swap_fk_target");
  if (start < 0) {
    throw new Error(`Procedure declaration not found in ${filePath}`);
  }
  // The body ends at the closing `$proc$;` dollar-quoted tag.
  const endMarker = "$proc$;";
  const end = content.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(`Procedure terminator not found in ${filePath}`);
  }
  return content.slice(start, end + endMarker.length).trim();
}

describe("swap_fk_target helper + install migration parity", () => {
  it("procedure body is identical in helpers/swap_fk_target.sql and 0199_install_swap_fk_target.sql", () => {
    const helper = extractProcedureBody(
      path.join(drizzleDir, "helpers/swap_fk_target.sql"),
    );
    const install = extractProcedureBody(
      path.join(drizzleDir, "0199_install_swap_fk_target.sql"),
    );
    // Assert byte-identical. If someone changes one without the other, this
    // fails with the full diff in the error output.
    expect(install).toBe(helper);
  });
});
