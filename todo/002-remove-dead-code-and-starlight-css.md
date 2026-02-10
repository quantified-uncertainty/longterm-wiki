# Remove dead code: Mermaid.tsx, unused UI components, Starlight CSS vars

**Priority:** High
**Effort:** ~30–45 min
**Risk:** Low (dead code removal, nothing references these)

## Problem

Several files exist in the codebase that are never imported or used. They add confusion and increase bundle surface area.

### A. Dead `Mermaid.tsx` component

- `app/src/components/wiki/Mermaid.tsx` is exported from `wiki/index.ts` but **never imported anywhere**
- The active Mermaid component is `MermaidDiagram.tsx` (used in `mdx-components.tsx`, `TransitionModelContent.tsx`, `CauseEffectGraph/index.tsx`)
- `Mermaid.tsx` also uses Starlight CSS variables (`--sl-color-bg-nav`, `--sl-color-text-accent`)

**Fix:**
1. Delete `app/src/components/wiki/Mermaid.tsx`
2. Remove `export { Mermaid } from "./Mermaid"` from `app/src/components/wiki/index.ts`

### B. Starlight CSS variable compat shim

Lines 52–93 of `app/src/app/globals.css` define `--sl-color-gray-*`, `--sl-color-text`, `--sl-color-accent`, `--sl-color-bg`, `--sl-color-white` etc. These exist solely for the dead `Mermaid.tsx`.

**Fix:** Remove all `--sl-color-*` variable definitions from `globals.css` (both light and dark mode blocks).

### C. Six unused shadcn/ui components

These exist in `app/src/components/ui/` but are never imported by any file:

- `button.tsx`
- `hover-card.tsx`
- `input.tsx`
- `select.tsx`
- `sortable-header.tsx`
- `toggle.tsx`
- `toggle-group.tsx`

**Fix:** Delete all 7 files. They can be regenerated via `npx shadcn@latest add <component>` if needed later.

## Verification

1. `grep -r "Mermaid" app/src/ --include="*.ts*"` should show only `MermaidDiagram` references
2. `grep -r "\-\-sl-color" app/src/` should return 0 results
3. `pnpm build` succeeds
4. `pnpm test` passes
