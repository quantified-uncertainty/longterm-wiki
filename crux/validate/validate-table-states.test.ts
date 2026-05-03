import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./validate-table-states.ts";

describe("validate-table-states", () => {
  it("passes on the current codebase (all violations fixed)", () => {
    // Forward regression guard: if someone adds a bespoke "Loading..." string to a
    // *-table.tsx or page.tsx file outside @/components/ui/table-states.tsx,
    // this test will fail (QUA-1008).
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  // ── Synthesized-violation tests ─────────────────────────────────────────
  // These prove the detector actually fires (not just that the codebase is clean).
  // Without them, a future refactor could short-circuit `passed: true` and the
  // forward-regression test above would still pass.

  describe("on synthesized files", () => {
    let scanRoot: string;

    beforeEach(() => {
      scanRoot = mkdtempSync(join(tmpdir(), "qua-1008-validator-"));
    });

    afterEach(() => {
      rmSync(scanRoot, { recursive: true, force: true });
    });

    function writeTargetFile(relPath: string, content: string): void {
      const full = join(scanRoot, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }

    it("detects bare 'Loading...' in a *-table.tsx", () => {
      writeTargetFile(
        "foo-table.tsx",
        `export function FooTable() {\n  return <div>Loading...</div>;\n}\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].text).toContain("Loading...");
    });

    it("detects 'Loading <thing>...' phrase form", () => {
      writeTargetFile(
        "page.tsx",
        `export default function P() { return <div>Loading organizations...</div>; }\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });

    it("detects unicode ellipsis form", () => {
      writeTargetFile(
        "thingsTable.tsx",
        `<div>Loading…</div>\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });

    it("does not flag canonical JSX call sites", () => {
      writeTargetFile(
        "ok-table.tsx",
        `<TableLoadingRow colSpan={5} label="Loading users..." />\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("does not flag imports from the canonical module", () => {
      writeTargetFile(
        "x-table.tsx",
        `import { TableLoadingRow } from "@/components/ui/table-states";\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("respects // table-states-ok: <reason> opt-out on the same line", () => {
      writeTargetFile(
        "skip-table.tsx",
        `// table-states-ok: legacy widget — keeping bespoke string\n` +
        `<div>Loading...</div>\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("rejects opt-out without a reason (bare 'table-states-ok:' is not enough)", () => {
      writeTargetFile(
        "lazy-table.tsx",
        `// table-states-ok:\n` +
        `<div>Loading...</div>\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });

    it("does not bypass via opt-out substring inside a string literal", () => {
      // `"table-states-ok:"` mentioned inside a string should NOT bypass
      // the validator. Only a real `// table-states-ok: <reason>` comment does.
      writeTargetFile(
        "sneaky-table.tsx",
        `const x = "table-states-ok:";\n<div>Loading...</div>\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });

    it("does not bypass via JSX-component substring inside a string literal", () => {
      // Substring `<TableLoadingRow` inside a string/comment should NOT bypass.
      writeTargetFile(
        "spoof-table.tsx",
        `const usage = "<TableLoadingRow ... Loading... />";\n` +
        `function Foo() { return <div>Loading...</div>; }\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });

    it("ignores trailing-comment mentions of the banned literal", () => {
      // `someCode(); // historical: was Loading... before QUA-1008` should not flag.
      writeTargetFile(
        "doc-table.tsx",
        `const x = 1; // historical: was Loading... before QUA-1008\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("ignores fully commented-out lines", () => {
      writeTargetFile(
        "commented-table.tsx",
        `// <div>Loading...</div>\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("does not scan files outside the target patterns", () => {
      // utils.ts is not *-table.tsx, *Table.tsx, or page.tsx — should be skipped.
      writeTargetFile("utils.ts", `const msg = "Loading...";\n`);
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("does not flag banned literals inside JSX block comments ({/* ... */})", () => {
      // `{/* historical Loading... */}` should not trigger the validator.
      writeTargetFile(
        "block-comment-table.tsx",
        `function Foo() {\n  return (\n    <div>\n      {/* historical Loading... before QUA-1008 */}\n      <TableSkeleton rows={10} columns={5} />\n    </div>\n  );\n}\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("does not flag banned literals inside multi-line JSX block comments", () => {
      // A `{/* ... */}` block comment that spans multiple lines, with the banned
      // literal on a continuation line, must also be ignored.
      writeTargetFile(
        "multi-block-comment-table.tsx",
        `function Foo() {\n  return (\n    <div>\n      {/*\n        old code: <div>Loading...</div>\n        retained for context\n      */}\n      <TableSkeleton rows={10} columns={5} />\n    </div>\n  );\n}\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("does not flag attribute lines inside a multi-line canonical JSX element", () => {
      // `<TableSkeleton` opens on one line, `label="Loading users..."` follows on
      // the next, then `/>` closes. The continuation line carries the banned literal
      // as a prop value of the canonical component — not a violation.
      writeTargetFile(
        "multiline-jsx-table.tsx",
        `function Foo() {\n  return (\n    <TableSkeleton\n      rows={10}\n      columns={5}\n      label="Loading users..."\n    />\n  );\n}\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(true);
    });

    it("still flags banned literals in non-canonical multi-line JSX", () => {
      // After a multi-line non-canonical element ends, subsequent banned literals
      // must still flag (proves we're not stuck in skip-everything mode).
      writeTargetFile(
        "still-flags-table.tsx",
        `function Foo() {\n  return (\n    <SomethingElse\n      foo="bar"\n    />\n    /* not a real one */\n    <div>Loading...</div>\n  );\n}\n`,
      );
      const result = runCheck({ roots: [scanRoot], quiet: true });
      expect(result.passed).toBe(false);
    });
  });
});
