# Strip Astro `client:load` directives from all MDX files

**Priority:** High
**Effort:** ~45 min
**Risk:** Low (mechanical find-and-replace)

## Problem

441 MDX files contain ~1,026 instances of Astro-specific `client:load` hydration directives. These are meaningless in Next.js and are pure migration cruft from the Starlight era.

### Scope by component (approximate)

| Component | Instances |
|-----------|-----------|
| `<Mermaid client:load>` | ~461 |
| `<DataExternalLinks client:load>` | ~280 |
| `<Backlinks client:load>` | ~122 |
| `<ATMPage client:load>` | ~40 |
| `<TransitionModelContent client:load>` | ~30 |
| `<FactorSubItemsList client:load>` | ~20 |
| Other components | ~73 |

## Fix

Regex find-and-replace across all MDX files. Must handle two cases:

**Inline:** `<Mermaid client:load chart={...}>` → `<Mermaid chart={...}>`

**Multiline:**
```mdx
<TransitionModelContent
  client:load
  slug="compute"
/>
```
→
```mdx
<TransitionModelContent
  slug="compute"
/>
```

Suggested sed pattern: `s/\s*client:load\b//g` across `content/docs/**/*.mdx`

Also clean up any resulting blank lines or extra whitespace from multiline removals.

## Verification

1. `grep -r "client:load" content/docs/ | wc -l` should return 0
2. `pnpm build` succeeds
3. Spot-check a few files to ensure component props weren't mangled
