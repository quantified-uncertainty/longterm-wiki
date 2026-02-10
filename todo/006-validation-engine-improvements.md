# Validation engine: extract shared utilities and improve coverage

**Priority:** Low–Medium
**Effort:** ~90–120 min
**Risk:** Low (internal tooling)

## Problem

The 34 validation rules in `crux/lib/rules/` have significant code duplication, no test coverage, and a few minor bugs. The validation engine works well but could be more maintainable.

## Proposed improvements

### A. Extract shared line-matching utility (~30 min)

Eight+ rules independently implement the same "match regex on lines while tracking position for code-block detection" loop:

```js
let position = 0;
for (let i = 0; i < lines.length; i++) {
  let match;
  while ((match = regex.exec(line)) !== null) {
    const absolutePos = position + match.index;
    if (!isInCodeBlock(content.body, absolutePos)) { ... }
  }
  position += line.length + 1;
}
```

**Fix:** Extract to a utility function in `crux/lib/mdx-utils.mjs`:
```js
export function matchLinesOutsideCode(body, regex, callback) { ... }
```

Rules affected: `dollar-signs`, `comparison-operators`, `tilde-dollar`, `fake-urls`, `placeholders`, `temporal-artifacts`, `vague-citations`, `consecutive-bold-labels`

### B. Fix regex recreation in loops (~15 min)

Three rules (`dollar-signs.mjs`, `comparison-operators.mjs`, `tilde-dollar.mjs`) create new `RegExp` objects inside line loops instead of compiling once and resetting `lastIndex`.

**Fix:** Compile regex once, use `regex.lastIndex = 0` inside the loop.

### C. Remove unused singleton export (~5 min)

`crux/lib/validation-engine.mjs:473` exports a pre-instantiated `engine = new ValidationEngine()` singleton that nothing imports. Every script creates its own instance.

**Fix:** Remove the unused export.

### D. Consolidate skip-logic for stub/documentation pages (~20 min)

The pattern "skip validation for stub or internal documentation pages" is reimplemented in 3+ rules independently.

**Fix:** Extract to a shared `shouldSkipPage(content)` utility.

### E. DRY up color output in auto-fix.mjs (~10 min)

`crux/auto-fix.mjs` defines ANSI colors inline instead of using the shared `getColors()` from `crux/lib/output.mjs`.

**Fix:** Import and use the shared utility.

### F. Consolidate duplicate content-types path constants (~15 min)

Both `crux/lib/content-types.mjs` and `app/scripts/lib/content-types.mjs` maintain parallel constant definitions.

**Fix:** Have `app/scripts/lib/content-types.mjs` import from `crux/lib/content-types.mjs` (or a shared location).

### G. Add test coverage for validation rules (longer-term, ~60+ min)

34 rules have zero test coverage. At minimum, add tests for the CRITICAL rules:
- `dollar-signs`
- `comparison-operators`
- `frontmatter-schema`
- `entitylink-ids`
- `internal-links`
- `fake-urls`
- `component-props`
- `citation-urls`

## Verification

1. `node crux/crux.mjs validate` produces same results before and after refactoring
2. Any new tests pass
3. No regressions in validation output
