import { describe, it, expect } from "vitest";
import {
  detectNarrowPatches,
  parseDiff,
  formatFindings,
} from "./narrow-patch-detector.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

// Excerpt of the real QUA-346 / PR #4257 diff. This is the exact shape we want
// to flag: a conditional added to a generic cell renderer that gates on a
// literal column name AND probes the value's signature with startsWith.
const QUA_346_DIFF = `diff --git a/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx b/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
index 4aac1f341..1fcb9b6c3 100644
--- a/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
+++ b/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
@@ -339,6 +339,23 @@ function CellValue({
     return <JsonValue value={value} />;
   }

+  // FactBase fact IDs (f_xxx) -> render as link with "view →" label instead of leaking raw ID.
+  if (
+    (columnName === "fact_id" || columnName === "factId") &&
+    typeof value === "string" &&
+    value.startsWith("f_")
+  ) {
+    return (
+      <Link
+        href={\`/factbase/fact/\${encodeURIComponent(value)}\`}
+        className="text-blue-600 dark:text-blue-400 hover:underline text-[11px]"
+        title={value}
+      >
+        view →
+      </Link>
+    );
+  }
+
   // Entity reference columns -> show resolved name as link
   const isEntityRef = isEntityRefColumn(columnName);
`;

// The proper systemic fix (QUA-354 / PR #4268): replaces the column-name gate
// with a content-based regex. This should NOT flag — the added block no longer
// contains a column-name literal equality.
const QUA_354_PROPER_FIX_DIFF = `diff --git a/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx b/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
index 1fcb9b6c3..6af073f14 100644
--- a/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
+++ b/apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx
@@ -258,6 +258,13 @@ const GLOBAL_HIDDEN_COLUMNS = new Set(["id"]);
 /** Max rows to show initially before "Show all" */
 const INITIAL_ROW_LIMIT = 20;

+// ── ID detection ──────────────────────────────────────────────────────────
+
+// FactBase fact IDs are \`f_\` + 8-12 alphanumeric chars.
+// Used by the cell renderer to detect raw fact IDs in any column and link them
+// to /factbase/fact/<id> instead of leaking the raw ID as visible text.
+const FACT_ID_RE = /^f_[A-Za-z0-9]{8,}$/;
+
 // ── Numeric formatting columns ────────────────────────────────────────────

 /** Columns representing monetary amounts (Drizzle returns numeric() as strings) */
@@ -340,11 +347,10 @@ function CellValue({
   }

   // FactBase fact IDs (f_xxx) -> render as link with "view →" label instead of leaking raw ID.
-  if (
-    (columnName === "fact_id" || columnName === "factId") &&
-    typeof value === "string" &&
-    value.startsWith("f_")
-  ) {
+  // Content-based, not column-name-gated: any cell value matching the fact-ID format gets
+  // rendered as a link, no matter which column it lives in.
+  if (typeof value === "string" && FACT_ID_RE.test(value)) {
     return (
       <Link
         href={\`/factbase/fact/\${encodeURIComponent(value)}\`}
`;

// False-positive guard #1: pure currency formatting. Adds a conditional gated
// on a column name, but the body uses toLocaleString — no value probe. Must NOT
// flag.
const CURRENCY_FORMAT_DIFF = `diff --git a/apps/web/src/components/cell-formatter.tsx b/apps/web/src/components/cell-formatter.tsx
index 1111111..2222222 100644
--- a/apps/web/src/components/cell-formatter.tsx
+++ b/apps/web/src/components/cell-formatter.tsx
@@ -10,6 +10,11 @@ export function Cell({ columnName, value }) {
     return <span>{value}</span>;
   }

+  if (columnName === "revenue" && typeof value === "number") {
+    return <span>\${value.toLocaleString("en-US")}</span>;
+  }
+
   return <span>{String(value)}</span>;
 }
`;

// False-positive guard #2: pure percentage formatting using toFixed.
const PERCENT_FORMAT_DIFF = `diff --git a/apps/web/src/components/cell-formatter.tsx b/apps/web/src/components/cell-formatter.tsx
index 1111111..2222222 100644
--- a/apps/web/src/components/cell-formatter.tsx
+++ b/apps/web/src/components/cell-formatter.tsx
@@ -10,6 +10,10 @@ export function Cell({ columnName, value }) {
     return <span>{value}</span>;
   }

+  if (columnName === "growth_rate" && typeof value === "number") {
+    return <span>{(value * 100).toFixed(1)}%</span>;
+  }
+
   return <span>{String(value)}</span>;
 }
`;

// False-positive guard #3: unrelated refactor. No column-name gate, no value probe.
const UNRELATED_REFACTOR_DIFF = `diff --git a/crux/lib/helpers.ts b/crux/lib/helpers.ts
index 1111111..2222222 100644
--- a/crux/lib/helpers.ts
+++ b/crux/lib/helpers.ts
@@ -5,6 +5,10 @@ export function sum(nums: number[]): number {
   return nums.reduce((a, b) => a + b, 0);
 }

+export function avg(nums: number[]): number {
+  return nums.length === 0 ? 0 : sum(nums) / nums.length;
+}
+
 export function clamp(n: number, lo: number, hi: number): number {
   return Math.max(lo, Math.min(hi, n));
 }
`;

// False-positive guard #4: content-based probe WITHOUT a column gate. This is
// the RIGHT pattern — should not flag even though it probes the value.
const CONTENT_BASED_DIFF = `diff --git a/apps/web/src/components/cell-formatter.tsx b/apps/web/src/components/cell-formatter.tsx
index 1111111..2222222 100644
--- a/apps/web/src/components/cell-formatter.tsx
+++ b/apps/web/src/components/cell-formatter.tsx
@@ -10,6 +10,10 @@ export function Cell({ columnName, value }) {
     return <span>{value}</span>;
   }

+  if (typeof value === "string" && /^f_[A-Za-z0-9]{8,}$/.test(value)) {
+    return <Link href={\`/factbase/fact/\${value}\`}>view →</Link>;
+  }
+
   return <span>{String(value)}</span>;
 }
`;

// False-positive guard #5: test file with the signature. Tests legitimately
// contain the pattern as fixtures — should be skipped.
const TEST_FILE_DIFF = `diff --git a/apps/web/src/components/cell-formatter.test.tsx b/apps/web/src/components/cell-formatter.test.tsx
index 1111111..2222222 100644
--- a/apps/web/src/components/cell-formatter.test.tsx
+++ b/apps/web/src/components/cell-formatter.test.tsx
@@ -10,6 +10,15 @@ describe("Cell", () => {
     expect(true).toBe(true);
   });

+  it("flags legacy pattern", () => {
+    const value = "f_abc";
+    const columnName = "fact_id";
+    if (columnName === "fact_id" && value.startsWith("f_")) {
+      expect(true).toBe(true);
+    }
+  });
+
 });
`;

// ─── parseDiff tests ──────────────────────────────────────────────────────

describe("parseDiff", () => {
  it("extracts file name and added lines from a single-hunk diff", () => {
    const hunks = parseDiff(QUA_346_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe(
      "apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx"
    );
    expect(hunks[0].newStartLine).toBe(339);
    const addedJoined = hunks[0].addedLines.map((l) => l.text).join("\n");
    expect(addedJoined).toContain(`columnName === "fact_id"`);
    expect(addedJoined).toContain(`value.startsWith("f_")`);
  });

  it("tracks correct line numbers on the new side", () => {
    const hunks = parseDiff(QUA_346_DIFF);
    const columnGateLine = hunks[0].addedLines.find((l) =>
      l.text.includes(`columnName === "fact_id"`)
    );
    expect(columnGateLine).toBeDefined();
    // The gate should be on or after newStartLine.
    expect(columnGateLine!.line).toBeGreaterThanOrEqual(339);
  });

  it("returns empty when the diff is empty", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("handles multi-hunk diffs", () => {
    const hunks = parseDiff(QUA_354_PROPER_FIX_DIFF);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── detectNarrowPatches tests ────────────────────────────────────────────

describe("detectNarrowPatches — acceptance fixtures", () => {
  it("fires on the QUA-346 diff (the canonical narrow patch)", () => {
    const findings = detectNarrowPatches(QUA_346_DIFF);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.severity).toBe("MEDIUM");
    expect(f.file).toBe(
      "apps/web/src/app/internal/entity-profile/entity-profile-viewer.tsx"
    );
    expect(f.relatedIncidents).toContain("QUA-316");
    expect(f.relatedIncidents).toContain("QUA-346");
    expect(f.message).toMatch(/narrow-patch/i);
    expect(f.message).toMatch(/content-based/i);
    // Path contains "viewer" → renderer-file message variant.
    expect(f.message).toMatch(/renderer|formatter|validator/i);
  });

  it("does NOT fire on the QUA-354 proper systemic fix", () => {
    const findings = detectNarrowPatches(QUA_354_PROPER_FIX_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on pure currency formatting (toLocaleString)", () => {
    const findings = detectNarrowPatches(CURRENCY_FORMAT_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on pure percentage formatting (toFixed)", () => {
    const findings = detectNarrowPatches(PERCENT_FORMAT_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on unrelated refactors", () => {
    const findings = detectNarrowPatches(UNRELATED_REFACTOR_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on content-based probes without a column gate", () => {
    const findings = detectNarrowPatches(CONTENT_BASED_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on test files even when the signature matches", () => {
    const findings = detectNarrowPatches(TEST_FILE_DIFF);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array on empty diff", () => {
    expect(detectNarrowPatches("")).toEqual([]);
  });
});

// ─── Adversarial / edge-case variants ─────────────────────────────────────

describe("detectNarrowPatches — variants of the same signature", () => {
  it("flags `.test(` probes (regex match)", () => {
    const diff = `diff --git a/apps/web/src/components/render.tsx b/apps/web/src/components/render.tsx
--- a/apps/web/src/components/render.tsx
+++ b/apps/web/src/components/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "entity_id" && /^sid_/.test(value)) {
+    return <Link href={\`/wiki/\${value}\`}>view →</Link>;
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toContain("render.tsx");
  });

  it("flags `.includes(` probes", () => {
    const diff = `diff --git a/apps/web/src/components/render.tsx b/apps/web/src/components/render.tsx
--- a/apps/web/src/components/render.tsx
+++ b/apps/web/src/components/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "ref" && value.includes("sid_")) {
+    return <Link href={\`/wiki/\${value}\`}>view →</Link>;
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
  });

  it("flags `.match(` probes", () => {
    const diff = `diff --git a/apps/web/src/components/render.tsx b/apps/web/src/components/render.tsx
--- a/apps/web/src/components/render.tsx
+++ b/apps/web/src/components/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "slug" && value.match(/^sid_/)) {
+    return <Link>view →</Link>;
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
  });

  it("flags `field.name === 'x'` variants", () => {
    const diff = `diff --git a/apps/web/src/components/render.tsx b/apps/web/src/components/render.tsx
--- a/apps/web/src/components/render.tsx
+++ b/apps/web/src/components/render.tsx
@@ -5,0 +6,5 @@
+  if (field.name === "fact_id" && value.startsWith("f_")) {
+    return <Link>view →</Link>;
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
  });

  it("emits the non-renderer message variant for paths without renderer keywords", () => {
    const diff = `diff --git a/crux/lib/other/misc.ts b/crux/lib/other/misc.ts
--- a/crux/lib/other/misc.ts
+++ b/crux/lib/other/misc.ts
@@ -5,0 +6,5 @@
+  if (columnName === "fact_id" && value.startsWith("f_")) {
+    return "masked";
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    // Message should still reference QUA-316/QUA-346 but not claim renderer path.
    expect(findings[0].message).toMatch(/QUA-316.*QUA-346|QUA-346.*QUA-316/);
    expect(findings[0].message).not.toMatch(
      /renderer\/formatter\/validator, which/
    );
  });
});

// ─── Regression tests for issues found during self-review ────────────────

describe("detectNarrowPatches — regressions from review", () => {
  it("handles paths that contain `/b/` segments (uses +++ b/ for filename)", () => {
    // Regression: original parseDiff used `\bb/(.+)$` against the `diff --git`
    // header, which greedily matched the first `b/` in the path.
    const diff = `diff --git a/src/b/component.tsx b/src/b/component.tsx
index 1111..2222 100644
--- a/src/b/component.tsx
+++ b/src/b/component.tsx
@@ -10,0 +11,5 @@
+  if (columnName === "fact_id" && value.startsWith("f_")) {
+    return <Link>view →</Link>;
+  }
+
`;
    const hunks = parseDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe("src/b/component.tsx");
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/b/component.tsx");
  });

  it("handles CRLF line endings", () => {
    // Regression: split("\n") leaves trailing \r, which used to fall into the
    // unknown-line branch and silently abort the hunk.
    const unixDiff = `diff --git a/src/render.tsx b/src/render.tsx
--- a/src/render.tsx
+++ b/src/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "fact_id" && value.startsWith("f_")) {
+    return <Link>view →</Link>;
+  }
+
`;
    const crlfDiff = unixDiff.replace(/\n/g, "\r\n");
    const findings = detectNarrowPatches(crlfDiff);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/render.tsx");
    expect(findings[0].line).toBeGreaterThanOrEqual(6);
  });

  it("does NOT co-fire when two unrelated changes sit in the same hunk", () => {
    // Regression: the old implementation joined all added lines per hunk and
    // tested the regexes against the joined text, so an unrelated column gate
    // in one edit and an unrelated value probe in another would co-fire.
    // Now the detector splits into contiguous runs.
    const diff = `diff --git a/src/render.tsx b/src/render.tsx
--- a/src/render.tsx
+++ b/src/render.tsx
@@ -10,6 +10,14 @@
   if (value == null) return null;

+  // unrelated format change — gates on column name, no probe
+  if (columnName === "revenue") {
+    return formatCurrency(value);
+  }
+
   return <span>{value}</span>;
 }

+// totally separate helper added lower in the same hunk — uses .startsWith but
+// does NOT gate on a column name, so by itself it's fine.
+export function hasFactPrefix(v: string): boolean {
+  return v.startsWith("f_");
+}
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(0);
  });

  it("flags `field.name === 'x'` specifically (not `name === 'x'`)", () => {
    // Regression: `name === "x"` is too broad (common object-lookup idiom).
    // The `key` alternative was also removed for the same reason.
    const nakedName = `diff --git a/src/helper.ts b/src/helper.ts
--- a/src/helper.ts
+++ b/src/helper.ts
@@ -5,0 +6,5 @@
+  if (name === "fact_id" && value.startsWith("f_")) {
+    return "masked";
+  }
+
`;
    expect(detectNarrowPatches(nakedName)).toHaveLength(0);

    const nakedKey = `diff --git a/src/helper.ts b/src/helper.ts
--- a/src/helper.ts
+++ b/src/helper.ts
@@ -5,0 +6,5 @@
+  if (key === "fact_id" && value.startsWith("f_")) {
+    return "masked";
+  }
+
`;
    expect(detectNarrowPatches(nakedKey)).toHaveLength(0);

    // But the qualified forms (field.name, row.column) still flag.
    const qualified = `diff --git a/src/helper.ts b/src/helper.ts
--- a/src/helper.ts
+++ b/src/helper.ts
@@ -5,0 +6,5 @@
+  if (field.name === "fact_id" && value.startsWith("f_")) {
+    return "masked";
+  }
+
`;
    expect(detectNarrowPatches(qualified)).toHaveLength(1);
  });

  it("flags `.search(` and `.exec(` value probes (added in review)", () => {
    const diffSearch = `diff --git a/src/render.tsx b/src/render.tsx
--- a/src/render.tsx
+++ b/src/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "slug" && value.search(/^sid_/) >= 0) {
+    return <Link>view →</Link>;
+  }
+
`;
    expect(detectNarrowPatches(diffSearch)).toHaveLength(1);

    const diffExec = `diff --git a/src/render.tsx b/src/render.tsx
--- a/src/render.tsx
+++ b/src/render.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "slug" && /^sid_/.exec(value)) {
+    return <Link>view →</Link>;
+  }
+
`;
    expect(detectNarrowPatches(diffExec)).toHaveLength(1);
  });

  it("skips deleted files (+++ /dev/null) without crashing", () => {
    const diff = `diff --git a/src/old.tsx b/src/old.tsx
deleted file mode 100644
index 1111..0000
--- a/src/old.tsx
+++ /dev/null
@@ -1,5 +0,0 @@
-if (columnName === "fact_id" && value.startsWith("f_")) {
-  return <Link>view →</Link>;
-}
`;
    expect(() => detectNarrowPatches(diff)).not.toThrow();
    expect(detectNarrowPatches(diff)).toHaveLength(0);
  });

  it("handles multi-file diffs (each file parsed independently)", () => {
    const diff = `diff --git a/src/a.tsx b/src/a.tsx
--- a/src/a.tsx
+++ b/src/a.tsx
@@ -5,0 +6,5 @@
+  if (columnName === "fact_id" && value.startsWith("f_")) {
+    return null;
+  }
+
diff --git a/src/b.tsx b/src/b.tsx
--- a/src/b.tsx
+++ b/src/b.tsx
@@ -10,0 +11,3 @@
+export function unrelated() {
+  return 42;
+}
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/a.tsx");
  });

  it("handles hunk headers without line-count commas (@@ -1 +1 @@)", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,5 @@
-export const x = 1;
+if (columnName === "fact_id" && value.startsWith("f_")) {
+  return null;
+}
+export const x = 2;
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeGreaterThanOrEqual(1);
  });

  it("reports a precise line number for the column-gate line", () => {
    const diff = `diff --git a/src/render.tsx b/src/render.tsx
--- a/src/render.tsx
+++ b/src/render.tsx
@@ -10,0 +11,6 @@
+  // a comment
+  const prefix = "f_";
+  if (columnName === "fact_id" && value.startsWith(prefix)) {
+    return <Link>view →</Link>;
+  }
+
`;
    const findings = detectNarrowPatches(diff);
    expect(findings).toHaveLength(1);
    // The gate is on the 3rd added line (line 13 in the new file).
    expect(findings[0].line).toBe(13);
  });
});

// ─── formatFindings ───────────────────────────────────────────────────────

describe("formatFindings", () => {
  it("prints 'no matches' for empty findings", () => {
    expect(formatFindings([])).toContain("no matches");
  });

  it("prints each finding with file:line, message, related, snippet", () => {
    const findings = detectNarrowPatches(QUA_346_DIFF);
    const out = formatFindings(findings);
    expect(out).toContain("[MEDIUM]");
    expect(out).toContain("entity-profile-viewer.tsx");
    expect(out).toContain("QUA-316, QUA-346");
    expect(out).toContain("snippet:");
  });
});
