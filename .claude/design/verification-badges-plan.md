# Verification Badges: Implementation Plan

**Goal:** Surface source-check verification status across all entity display surfaces — wiki page headers, directory tables, entity detail page tabs (grants, personnel, divisions), and inline EntityLinks. Small colored dots with hover details, consistent with existing `VerificationDot` pattern.

**Principle:** Compute on-page from live PG data. No new frontmatter fields, no database.json dependency for verification status.

---

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │  source_check_verdicts (PG)  │
                    │  recordType + recordId → verdict │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼────────┐ ┌────▼─────┐ ┌────────▼────────┐
     │ Row-level joins  │ │ Bulk API │ │ Entity aggregate │
     │ (grants, pers.)  │ │ endpoint │ │    endpoint      │
     └────────┬────────┘ └────┬─────┘ └────────┬────────┘
              │                │                │
     ┌────────▼────────┐ ┌────▼─────┐ ┌────────▼────────┐
     │ Table cells with │ │ KB table │ │ Header badge /  │
     │ VerificationDot  │ │ cells    │ │ EntityLink dot  │
     └─────────────────┘ └──────────┘ └─────────────────┘
```

**Three data paths:**
1. **PG-sourced tables** (grants, personnel): LEFT JOIN verdicts in existing SQL queries
2. **KB-sourced tables** (divisions, key-persons): New bulk verdict endpoint, client-side merge
3. **Entity-level aggregate**: New lightweight endpoint for header/EntityLink badges

---

## Phase 1: Server-Side — Verdict Data in API Responses

### 1A. Add verdict fields to grants `/by-entity` endpoint

**File:** `apps/wiki-server/src/routes/tablebase/grants.ts` (~line 275)

**Change:** LEFT JOIN `source_check_verdicts` in the existing data query.

```sql
SELECT g.*, scv.verdict AS verification_verdict, scv.confidence AS verification_confidence,
       scv.sources_checked, scv.last_computed_at AS verification_checked_at
FROM grants g
LEFT JOIN source_check_verdicts scv
  ON scv.record_type = 'grant'
  AND scv.record_id = g.id
  AND scv.field_name IS NULL  -- whole-row verdict only
LEFT JOIN entities ge ON g.grantee_entity_id = ge.stable_id
LEFT JOIN entities oe ON g.org_entity_id = oe.stable_id
WHERE g.organization_id = :entityId
ORDER BY ...
```

**Response shape change:** Add to each grant row:
```typescript
verification?: {
  verdict: SourceCheckVerdict | null;  // confirmed | contradicted | outdated | partial | unverifiable
  confidence: number | null;
  sourcesChecked: number;
  checkedAt: string | null;
} | null;
```

**Performance:** Single LEFT JOIN on indexed columns (`idx_scv_type` + PK). Negligible cost — the verdicts table is small (thousands of rows, not millions).

### 1B. Add verdict fields to personnel `/by-entity` endpoint

**File:** `apps/wiki-server/src/routes/tablebase/personnel.ts` (~line 215)

**Same pattern:** LEFT JOIN `source_check_verdicts` with `record_type = 'personnel'`.

### 1C. Add verdict fields to other PG-sourced endpoints

Apply the same LEFT JOIN pattern to:
- `investments/by-entity` → `record_type = 'investment'`
- `publications/by-entity` → `record_type = 'publication'`
- `funding-rounds/by-entity` → `record_type = 'funding-round'`
- `divisions/by-entity` (if it exists in PG) → `record_type = 'division'`
- `policy-stakeholders/by-entity` → `record_type = 'policy-stakeholder'`

Each is the same mechanical change: one LEFT JOIN, three new fields in the response.

### 1D. New endpoint: bulk verdicts by entity

**File:** `apps/wiki-server/src/routes/source-check/source-checks.ts` (new route)

For KB-sourced data that doesn't come from PG queries, we need a way to fetch all verdicts for an entity's records in one call.

```
GET /api/source-checks/verdicts/by-entity/:entityId
```

**Response:**
```typescript
{
  entityId: string;
  verdicts: Array<{
    recordType: string;
    recordId: string;
    fieldName: string | null;
    verdict: SourceCheckVerdict;
    confidence: number | null;
    sourcesChecked: number;
    checkedAt: string;
  }>;
  summary: {
    total: number;
    confirmed: number;
    contradicted: number;
    outdated: number;
    partial: number;
    unverifiable: number;
    unchecked: number;  // records with no verdict at all
  };
}
```

**SQL:**
```sql
SELECT record_type, record_id, field_name, verdict, confidence,
       sources_checked, last_computed_at
FROM source_check_verdicts
WHERE entity_id = :entityId
ORDER BY record_type, record_id
```

This uses the existing `idx_scv_entity` index. Single query, fast.

The `summary` field is computed server-side from the rows. This summary is what the entity-level badge uses.

### 1E. Shared RPC types

**File:** `apps/wiki-server/src/api-types.ts`

Add shared verdict schema:
```typescript
export const InlineVerdictResponseSchema = z.object({
  verdict: z.enum(["confirmed", "contradicted", "outdated", "partial", "unverifiable"]).nullable(),
  confidence: z.number().nullable(),
  sourcesChecked: z.number(),
  checkedAt: z.string().nullable(),
});
```

Use this in the grants/personnel/etc. response schemas for type consistency.

---

## Phase 2: Shared UI Component — `RecordVerificationDot`

### 2A. New component (or extend VerificationDot)

**File:** `apps/web/src/components/verification/RecordVerificationDot.tsx`

The existing `VerificationDot` uses citation-pipeline verdict vocabulary (`accurate`, `minor_issues`, etc.). Source-check uses a different vocabulary (`confirmed`, `contradicted`, `outdated`, `partial`, `unverifiable`). Rather than force-mapping between them, create a sibling component for source-check verdicts.

```typescript
interface RecordVerificationDotProps {
  verdict: SourceCheckVerdict | null;  // confirmed | contradicted | outdated | partial | unverifiable
  confidence?: number | null;
  sourcesChecked?: number;
  checkedAt?: string | null;
  size?: "sm" | "md";  // sm = 1.5px (inline), md = 2px (table cell)
  showLabel?: boolean;
}
```

**Color mapping (source-check vocabulary):**
| Verdict | Color | Dot class | Label |
|---------|-------|-----------|-------|
| `confirmed` | Emerald | `bg-emerald-500` | "Verified" |
| `contradicted` | Red | `bg-red-500` | "Contradicted" |
| `outdated` | Amber | `bg-amber-500` | "Outdated" |
| `partial` | Blue | `bg-blue-400` | "Partially verified" |
| `unverifiable` | Gray | `bg-muted-foreground/40` | "Unverifiable" |
| `null` (no verdict) | None | (no dot rendered) | — |

**Hover behavior:** Radix `HoverCard` (matching existing `CitationOverlay` pattern):
- 200ms open delay, 150ms close delay
- Shows: verdict label + icon, confidence %, sources checked count, last checked date
- Width: `w-56` (smaller than citation overlay since less content)

### 2B. Shared verdict constants

**File:** `apps/web/src/components/verification/verdict-config.ts`

```typescript
export const SOURCE_CHECK_VERDICT_CONFIG = {
  confirmed:    { color: "bg-emerald-500", icon: CheckCircle2, label: "Verified", textColor: "text-emerald-700" },
  contradicted: { color: "bg-red-500",     icon: XCircle,      label: "Contradicted", textColor: "text-red-700" },
  outdated:     { color: "bg-amber-500",   icon: Clock,        label: "Outdated", textColor: "text-amber-700" },
  partial:      { color: "bg-blue-400",    icon: AlertCircle,  label: "Partial", textColor: "text-blue-700" },
  unverifiable: { color: "bg-muted-foreground/40", icon: HelpCircle, label: "Unverifiable", textColor: "text-muted-foreground" },
} as const;
```

### 2C. Entity-level aggregate badge

**File:** `apps/web/src/components/verification/EntityVerificationBadge.tsx`

For entity headers (wiki page, org profile). Shows a single dot representing the overall verification health of the entity, with a hover card showing the breakdown.

```typescript
interface EntityVerificationBadgeProps {
  entityId: string;
  // OR pre-fetched summary:
  summary?: {
    total: number;
    confirmed: number;
    contradicted: number;
    outdated: number;
    partial: number;
    unverifiable: number;
  };
}
```

**Display logic:**
- If `contradicted > 0` → red dot (worst case dominates)
- If `outdated > 0` → amber dot
- If `confirmed / total > 0.8` → emerald dot
- If `partial > 0` or mixed → blue dot
- If all `unverifiable` → gray dot
- If `total === 0` → no dot (nothing to verify)

**Hover card shows:**
- "Entity Verification" header
- Mini bar chart or text breakdown: "12 confirmed, 2 outdated, 1 contradicted"
- Overall confidence average
- Link to full verification details

**Data fetching:** Client-side `useSWR` or `useEffect` call to `GET /api/source-checks/verdicts/by-entity/:entityId`. Cached per entity with a reasonable stale time (5 min). The component renders nothing until data loads (no layout shift — just a dot appearing).

---

## Phase 3: Integration — PG-Sourced Tables

### 3A. Grants table

**File:** `apps/web/src/app/organizations/[slug]/interactive-grants-table.tsx`

1. Add `verification` to `GrantRow`:
```typescript
export interface GrantRow {
  // ... existing fields ...
  verification?: {
    verdict: string | null;
    confidence: number | null;
    sourcesChecked: number;
    checkedAt: string | null;
  } | null;
}
```

2. Add column definition:
```typescript
{ id: "verification", label: "✓", defaultVisible: true, align: "center",
  onlyIfData: (rows) => rows.some(r => r.verification?.verdict) }
```

Column header is just "✓" to keep it compact. The `onlyIfData` check ensures the column only appears when there are any verdicts — avoids an empty column on entities with no source-checks.

3. Cell renderer in `CellContent`:
```typescript
case "verification":
  return g.verification?.verdict
    ? <RecordVerificationDot verdict={g.verification.verdict} confidence={g.verification.confidence} />
    : null;
```

4. Transform function (`toGrantRow` and PG `formatRow`): Map the new API fields into the `verification` property.

### 3B. Personnel table

**File:** `apps/web/src/app/organizations/[slug]/people-section.tsx`

Same pattern. Add `verification` to `PersonEntry`, render `RecordVerificationDot` in a new narrow column after the name.

Since the people table has both KB and PG sources merged together, the PG-sourced rows will have verdicts from the LEFT JOIN, while KB-sourced rows (key-persons, board-seats) will need enrichment from the bulk endpoint (Phase 4).

### 3C. Other PG-sourced tables

Apply same pattern to investments, publications, funding-rounds tables. Each is mechanical:
1. Add `verification` to row type
2. Add column definition
3. Add cell renderer
4. Map from API response

---

## Phase 4: Integration — KB-Sourced Tables

### 4A. Client-side verdict fetching hook

**File:** `apps/web/src/hooks/useEntityVerdicts.ts`

```typescript
export function useEntityVerdicts(entityId: string | undefined) {
  // Fetches GET /api/source-checks/verdicts/by-entity/:entityId
  // Returns: { verdicts: Map<string, VerdictInfo>, summary, isLoading }
  // Map key: `${recordType}:${recordId}`
}
```

This hook is called once per entity detail page and provides a lookup map that any tab can use to enrich its rows.

### 4B. Divisions table enrichment

**File:** `apps/web/src/app/organizations/[slug]/divisions-section.tsx`

Divisions are 100% KB-sourced. The verdict lookup would be:
```typescript
const divVerdict = verdictMap.get(`division:${div.key}`);
```

Add a `RecordVerificationDot` in the division name cell (inline after the name, not a separate column — matches the pattern of inline badges like "Active"/"Dissolved").

### 4C. Key-persons and board-seats

These are rendered in the people section. For KB-sourced person entries without PG personnel records, look up:
```typescript
const verdict = verdictMap.get(`personnel:${entry.recordId}`) ?? verdictMap.get(`fact:${entry.factId}`);
```

### 4D. Other KB-sourced sections

Policy positions, safety milestones, products — each section can optionally render dots if verdicts exist. Low priority since these are less data-dense.

---

## Phase 5: Entity-Level Headers

### 5A. Organization profile header

**File:** `apps/web/src/app/organizations/[slug]/page.tsx` (~line 747)

Add `EntityVerificationBadge` next to the org-type badge:
```tsx
<span className="...org-type-badge...">{orgTypeLabel}</span>
<EntityVerificationBadge entityId={entity.stableId} />
```

The badge renders as a small dot inline with the header. Hover shows the aggregate breakdown.

### 5B. Person profile header

**File:** `apps/web/src/app/people/[slug]/page.tsx`

Same pattern — `EntityVerificationBadge` next to person name or role.

### 5C. Wiki page header

**File:** `apps/web/src/app/wiki/[id]/page.tsx`

The page already has `ContentConfidenceBanner` and `CitationHealthBanner`. An entity-level verification dot could go:
- In the `ContentMeta` breadcrumb area (subtle, next to the title)
- Or in the existing `PageStatus` expandable section (grouped with quality scores)

**Recommendation:** Put a small dot in `ContentMeta` next to the page title, and expand the existing `VerificationStatus` section (which already shows verdict distribution) to also show the aggregate summary from the new endpoint.

### 5D. EntityLink tooltip

**File:** `apps/web/src/components/wiki/EntityLink.tsx`

The tooltip already shows quality score. Add a verification line:
```
Quality: 72/100
Verification: 14/16 confirmed ●  (green dot)
```

This requires the EntityLink to fetch verification summary data. Since EntityLinks are rendered hundreds of times per page, this MUST be:
- Pre-fetched in a page-level context (like `CitationQuotesProvider`)
- OR lazy-loaded only on hover (fetch on hover, cache)

**Recommendation:** Lazy-load on hover. The Radix HoverCard already has a 200ms delay. Fire the fetch on `onMouseEnter`, cache per entity with SWR. Most EntityLinks won't be hovered, so this avoids hundreds of unnecessary API calls.

---

## Phase 6: Directory Tables (Browse Pages)

### 6A. Organizations directory

**File:** `apps/web/src/app/organizations/organizations-table.tsx`

The organizations directory table shows all orgs. Adding per-org verification status requires either:
- A new batch endpoint: `GET /api/source-checks/verdicts/summary?entityIds=X,Y,Z` (returns aggregate per entity)
- Or pre-computed in the existing data pipeline

**Recommendation:** New batch endpoint. The directory page already makes server-side data calls. One additional call with all visible entity IDs returns a map of `entityId → summary`. This is a single SQL query:

```sql
SELECT entity_id, verdict, COUNT(*) as cnt
FROM source_check_verdicts
WHERE entity_id = ANY(:entityIds)
GROUP BY entity_id, verdict
```

Add a narrow verification column to the directory table showing the aggregate dot.

### 6B. Other directory tables

Same pattern for people, AI models, approaches, etc. Each directory page makes one batch call for all entities on the current page.

---

## Rollout Order

| Step | Scope | Effort | Impact |
|------|-------|--------|--------|
| **1** | `RecordVerificationDot` component + verdict constants | S | Foundation |
| **2** | Grants LEFT JOIN + table column | M | High — most data-dense table |
| **3** | Personnel LEFT JOIN + table column | M | High — second most visible |
| **4** | Bulk verdicts endpoint + `useEntityVerdicts` hook | M | Enables KB tables |
| **5** | Divisions/key-persons enrichment | S | Medium |
| **6** | `EntityVerificationBadge` + org/person headers | M | High visibility |
| **7** | Wiki page header dot | S | High visibility |
| **8** | Directory table batch endpoint + columns | M | Medium — browse pages |
| **9** | EntityLink hover enrichment | S | Polish |

Steps 1-3 are the core — they cover the highest-impact surfaces (org detail page tabs with grants and personnel). Steps 4-5 extend to KB tables. Steps 6-9 are progressively more visible but lower-data-density surfaces.

---

## Technical Considerations

### Performance
- LEFT JOINs on `source_check_verdicts` are cheap — indexed on `(record_type)` and the PK is `(record_type, record_id, COALESCE(field_name, ''))`. The table has thousands of rows, not millions.
- Bulk endpoint groups by entity_id (indexed via `idx_scv_entity`).
- EntityLink hover fetches are lazy and cached — no impact on page load.
- Directory batch endpoint is a single grouped query.

### Caching
- Wiki-server responses for entity detail pages use ISR with `revalidate: 300` (5 min). Verification data inherits this caching.
- Client-side SWR caching for hover fetches: `staleTime: 5 * 60 * 1000` (5 min).
- No build-time computation needed — all data is live from PG.

### Dual verdict vocabulary
Source-check uses `confirmed | contradicted | outdated | partial | unverifiable`. Citation pipeline uses `accurate | minor_issues | inaccurate | unsupported | not_verifiable`. These are kept separate — `RecordVerificationDot` handles source-check vocabulary, `VerificationDot` handles citation vocabulary. No forced mapping between them.

### Records without verdicts
Many records will have no verdict (never source-checked). The UI should render nothing for these — no dot, no placeholder. The column uses `onlyIfData` to auto-hide when no rows have verdicts. This avoids visual noise on entities that haven't been source-checked yet.

### Null entity_id
Some verdicts may have `entity_id = NULL` (older data). The bulk endpoint filters on `entity_id`, so these won't appear in entity-level views. They're still accessible via the existing verdict list endpoints for the verification dashboard.

---

## Files Modified (Summary)

### Wiki-server (API changes)
| File | Change |
|------|--------|
| `apps/wiki-server/src/routes/tablebase/grants.ts` | LEFT JOIN verdicts, add to response |
| `apps/wiki-server/src/routes/tablebase/personnel.ts` | LEFT JOIN verdicts, add to response |
| `apps/wiki-server/src/routes/tablebase/investments.ts` | LEFT JOIN verdicts, add to response |
| `apps/wiki-server/src/routes/tablebase/publications.ts` | LEFT JOIN verdicts, add to response |
| `apps/wiki-server/src/routes/source-check/source-checks.ts` | New `/verdicts/by-entity/:entityId` and batch endpoints |
| `apps/wiki-server/src/api-types.ts` | Shared verdict response schema |

### Frontend (new components)
| File | Change |
|------|--------|
| `apps/web/src/components/verification/RecordVerificationDot.tsx` | New — dot + hover card |
| `apps/web/src/components/verification/EntityVerificationBadge.tsx` | New — entity-level aggregate |
| `apps/web/src/components/verification/verdict-config.ts` | New — shared constants |
| `apps/web/src/hooks/useEntityVerdicts.ts` | New — bulk verdict fetching hook |

### Frontend (modified tables/headers)
| File | Change |
|------|--------|
| `apps/web/src/app/organizations/[slug]/interactive-grants-table.tsx` | Add verification column |
| `apps/web/src/app/organizations/[slug]/people-section.tsx` | Add verification to PersonEntry |
| `apps/web/src/app/organizations/[slug]/divisions-section.tsx` | Add verdict dots |
| `apps/web/src/app/organizations/[slug]/page.tsx` | Add EntityVerificationBadge to header |
| `apps/web/src/app/people/[slug]/page.tsx` | Add EntityVerificationBadge to header |
| `apps/web/src/app/wiki/[id]/page.tsx` | Add verification dot to ContentMeta |
| `apps/web/src/components/wiki/EntityLink.tsx` | Add verification to hover tooltip |
| `apps/web/src/app/organizations/organizations-table.tsx` | Add verification column |
| `apps/web/src/app/people/people-table.tsx` | Add verification column |

---

## What This Plan Does NOT Cover

- **Frontmatter `verificationStatus` field**: Not needed — computed live from PG data instead of stored in MDX. More accurate, always fresh.
- **Blocking gates in improve/auto-update**: Separate concern (#2822 deliverables 3-4). This plan is display-only.
- **Verification debt dashboard**: Could be built from the same data, but is a separate feature.
- **Unifying citation and source-check vocabularies**: Kept separate intentionally. The two systems verify different things (citation accuracy vs structured data correctness).
