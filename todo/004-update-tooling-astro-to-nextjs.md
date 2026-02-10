# Update tooling Astro references to Next.js patterns

**Priority:** Medium
**Effort:** ~60–90 min
**Risk:** Medium (validation logic changes)

## Problem

Six files in `tooling/` still reference Astro-era patterns: looking for `astro.config.mjs`, checking for `.astro` file extensions, and constructing Astro-convention paths. These fail gracefully (return empty/skip) but mean validation isn't actually checking the real Next.js file structure.

## Files to update

### 1. `tooling/lib/sidebar-utils.mjs`
- Parses non-existent `astro.config.mjs` for sidebar config
- Returns empty object gracefully
- **Fix:** Either remove (if sidebar validation is no longer needed) or rewrite to read from Next.js routing/navigation config

### 2. `tooling/lib/validation-engine.mjs`
- Comments reference astro.config parsing
- **Fix:** Remove dead comments and any unused code paths

### 3. `tooling/lib/rules/internal-links.mjs`
- Hardcodes `CONTENT_DIR` path instead of using content-types constants
- References "Astro/Starlight convention" in comments
- May check for `.astro` file extensions when resolving links
- **Fix:** Update to use content-types constants and check for `.mdx`/`.tsx` files

### 4. `tooling/validate/validate-entity-links.mjs`
- Constructs file paths with `.astro` extensions
- **Fix:** Update to `.mdx` and Next.js `page.tsx` patterns

### 5. `tooling/validate/validate-internal-links.mjs`
- Looks for `.astro` files when verifying internal links
- Comments reference "Astro/Starlight convention"
- **Fix:** Update file resolution to Next.js page patterns (`.mdx`, `page.tsx`)

### 6. `tooling/validate/validate-sidebar-labels.mjs`
- Looks for `astro.config.mjs` to extract sidebar labels
- **Fix:** Either remove (if sidebar config moved to Next.js) or update to read from the appropriate Next.js config

## Additional cleanup

While in these files, also:
- Replace hardcoded paths with imports from `content-types.mjs` where applicable
- Update any remaining Astro-convention comments to reflect Next.js reality

## Verification

1. `grep -r "astro" tooling/ --include="*.mjs" -l` should return 0 files
2. `node tooling/crux.mjs validate` runs without errors related to missing astro files
3. Internal link validation actually catches broken links (not just skipping everything)
