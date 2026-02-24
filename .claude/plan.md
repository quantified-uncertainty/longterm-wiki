# Unified Citation Architecture — Implementation Plan

## The Problem

Every wiki page currently has **two competing bibliography systems** that don't talk to each other:

1. **remark-gfm footnotes** — `[^1]: [Title](URL)` in MDX. Standard Markdown. Complete coverage (87 citations on Kalshi). But renders as a plain list of links at the bottom with zero metadata.

2. **References component** — renders from resource YAML entries (`data/resources/*.yaml`). Rich metadata (title, author, date, credibility, publication, verification dots). But only covers sources that happen to have hand-written YAML entries (31/87 for Kalshi).

Meanwhile, **CitationOverlay** (a third system) injects verification dots onto the footnote refs using portal DOM manipulation, reading from a Postgres `citation_quotes` table. And **ResourceLink (`<R>`)** is a fourth system — an inline citation component that references resource YAML — but is imported and never actually used on any page.

The result: readers see a messy footnote section at the bottom, then a separate "References" section with different numbering and different content. The verification dots are disconnected from the bibliography. Rich metadata exists for some sources but not others. It's unclear what's verified and what isn't.

## The Vision

**For 5 exemplar pages** (Kalshi, Anthropic, MIRI, existential-risk, + one person page), build a clean citation system that:

- Has a **single, beautiful bibliography** at the bottom of each page
- Shows **rich metadata for every source** (title, author, date, credibility, verification status)
- **Deduplicates** — 5 footnotes citing the same URL → 1 source entry with back-refs
- **Inline hover cards** on `[1]` refs showing source details + verification verdict + supporting quote
- **100% resource coverage** — every cited URL has a resource YAML entry (auto-created)
- **Full verification** — every citation has been accuracy-checked with supporting quotes

This is the foundation for the claim-first architecture (PR #939). In that future, claims reference resources; resources are the canonical source registry. Building that registry now — and making it render beautifully — is prerequisite infrastructure.

---

## Architecture Analysis: Three Options Considered

### Option A: Resource-First (deprecate `[^N]`)

Replace `[^N]` footnotes entirely with `<R id="resource-id" n={1} />`. Resources become the only citation mechanism.

**Pros**: Single system, no translation layer, resource ID is the canonical key.
**Cons**: Massive migration (625 pages). LLMs naturally generate `[^N]` — fighting this adds friction to every page creation. Non-standard Markdown (not portable). The `<R>` component was built for this and was never adopted — suggesting it doesn't fit the workflow.

**Verdict: Rejected.** Too much migration cost for the benefit. Standard Markdown is a feature, not a bug.

### Option B: Footnotes as Canonical, Resources as Enrichment (recommended)

Keep `[^N]` footnotes as the authoring format. Auto-create resource YAML entries for every footnoted URL. Build a unified rendering layer that merges footnote data + resource metadata + verification data into one bibliography.

**Pros**: Zero migration cost for existing pages. LLM-friendly authoring. Incremental improvement (pages get better as resources are registered). Clean separation of concerns (content authors write Markdown; the build pipeline enriches it).
**Cons**: URL is the join key (fragile if URLs change). Multiple footnotes per URL require grouping logic.

**Verdict: Recommended.** Minimum change for maximum improvement.

### Option C: Claim-First Now (jump to PR #939 architecture)

Skip the footnote/resource unification and go straight to claims as the primary data type. Pages are composed from verified claim stores.

**Pros**: Most aligned with long-term vision. Solves the problem at the root.
**Cons**: Requires building the full claim pipeline (extraction, verification, storage, composition) before any rendering improvement. The experiments in PR #939 show it works but aren't production-ready. 1 month isn't enough to build claim extraction + claim-based rendering + exemplar page polish.

**Verdict: Stretch goal for Week 4.** Extract claims for exemplar pages as data-only (no rendering changes). Build rendering on top of Option B.

---

## Recommended Architecture (Option B)

### Data Model

```
Resource (YAML)                    ← one per unique source URL
  ├─ id (hash of URL)
  ├─ title, url, type, authors, published_date
  ├─ credibility, summary, publication
  └─ auto-created from footnote URLs

Footnote Definition (MDX)          ← one per [^N] in page
  ├─ [^N]: [Title](URL)
  └─ maps to resource via URL

Citation Quote (Postgres)          ← one per claim-per-footnote
  ├─ pageId, footnote, url, resource_id
  ├─ claimText, sourceQuote
  └─ accuracyVerdict, accuracyScore

Footnote Index (database.json)     ← NEW: built at build time
  ├─ pageId → { N → { resourceId, url } }
  └─ used by UnifiedReferences to render

Source Group (render-time concept)  ← NEW: grouping for display
  ├─ one resource → many footnotes
  ├─ renders as single bibliography entry
  └─ shows back-refs: "Cited as [17] [18] [19] [20] [21]"
```

### Rendering Architecture

**Current (broken):**
```
<article>
  {page.content}                    ← remark-gfm footnotes at bottom
  <References pageId={slug} />      ← separate resource bibliography
</article>
<CitationOverlay quotes={...} />    ← DOM portals onto footnote refs
```

**Target (clean):**
```
<article class="suppress-gfm-footnotes">
  {page.content}                    ← footnotes section hidden via CSS
  <UnifiedReferences                ← single bibliography
    pageId={slug}
    footnoteIndex={footnoteIndex}
    quotes={citationQuotes}
  />
</article>
<InlineCitationCards                ← hover cards on [N] refs
  footnoteIndex={footnoteIndex}
  quotes={citationQuotes}
/>
```

### Data Flow

```
                    AUTHORING TIME
                    ─────────────
Page creation (crux content improve)
  → MDX with [^N]: [Title](URL) footnotes
  → pnpm crux citations register-resources <pageId>
      → Parse footnote definitions from MDX
      → For each unique URL without a resource entry:
          1. Fetch URL (or use citation_content cache)
          2. Extract metadata (title, domain, type, date, authors)
          3. Create resource YAML entry
          4. Report created/existing/failed

                    BUILD TIME
                    ──────────
pnpm build (build-data.mjs)
  → Parse all footnote definitions from MDX
  → Match each footnote URL to a resource entry
  → Produce footnoteIndex: { pageId → { N → resourceId } }
  → Produce pageResources (existing, but now complete)
  → Store in database.json

                    RENDER TIME (server)
                    ────────────────────
Wiki page server component
  → Load footnoteIndex from database.json
  → Load citationQuotes from Postgres via wiki-server
  → Load resource metadata from database.json
  → Pass all three to UnifiedReferences + InlineCitationCards

                    RENDER TIME (client)
                    ────────────────────
InlineCitationCards (useEffect after hydration)
  → Find all <a data-footnote-ref> in the DOM
  → For each, look up footnoteIndex → resource metadata
  → Look up citationQuotes → verification verdict
  → Render hover card with combined data
```

---

## Implementation Phases

### Phase 1: Data Foundation (Week 1)

**Goal**: Every footnote on exemplar pages has a resource YAML entry.

#### 1.1 Resource Auto-Registration Command

New file: `crux/citations/register-resources.ts`
New subcommand: `pnpm crux citations register-resources <pageId>`

Logic:
1. Read MDX file, parse all `[^N]: [Title](URL)` definitions
2. Extract unique URLs (87 footnotes on Kalshi → ~35 unique URLs)
3. For each URL, check if a resource exists (by URL matching across all `data/resources/*.yaml`)
4. For unmatched URLs:
   - Check citation_content cache (SQLite/Postgres) for fetched page title
   - If not cached, do a lightweight HEAD/GET to extract title
   - Generate resource ID: `hashOfUrl.slice(0, 16)` (matches existing convention)
   - Determine resource type from domain/URL patterns (paper, blog, report, government, reference)
   - Extract published_date from URL if available (e.g., `/2026/01/07/`)
   - Assign credibility estimate from domain reputation table
   - Append to appropriate `data/resources/` YAML file (file chosen by domain category)
5. Report: "Kalshi: 35 unique URLs, 31 already registered, 4 newly created, 0 failed"

#### 1.2 Enhanced Footnote Index in build-data.mjs

Modify `apps/web/scripts/build-data.mjs`:

After computing `pageResources`, also compute `footnoteIndex`:

```javascript
const footnoteIndex = {};
for (const page of pages) {
  if (!page.rawContent) continue;
  const pageFootnotes = {};
  const footnoteRe = /^\[(\^(\d+))\]:\s*\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gm;
  let m;
  while ((m = footnoteRe.exec(page.rawContent)) !== null) {
    const num = parseInt(m[2], 10);
    const title = m[3];
    const url = m[4];
    const resourceId = urlToId.get(url) ?? urlToId.get(url.replace(/\/$/, ''));
    pageFootnotes[num] = { resourceId: resourceId || null, url, title };
  }
  if (Object.keys(pageFootnotes).length > 0) {
    footnoteIndex[page.id] = pageFootnotes;
  }
}
database.footnoteIndex = footnoteIndex;
```

Also add data accessor in `apps/web/src/data/index.ts`:
```typescript
export function getFootnoteIndex(pageId: string): Record<number, { resourceId: string | null; url: string; title: string }> | undefined
```

#### 1.3 Run on Exemplar Pages

```bash
pnpm crux citations register-resources kalshi
pnpm crux citations register-resources anthropic
pnpm crux citations register-resources miri
pnpm crux citations register-resources existential-risk
pnpm crux citations register-resources dario-amodei   # or another person page
```

Verify: `pnpm run build` produces complete footnoteIndex for each exemplar page.

---

### Phase 2: Unified Rendering (Week 2)

**Goal**: Single, beautiful bibliography. Rich inline hover cards.

#### 2.1 UnifiedReferences Component

New file: `apps/web/src/components/wiki/UnifiedReferences.tsx`

This is a **server component** (static rendering, SEO-friendly).

**Props:**
```typescript
interface UnifiedReferencesProps {
  pageId: string;
  quotes?: CitationQuote[];       // from Postgres
  className?: string;
}
```

**Rendering logic:**

1. Load footnoteIndex for this page (from database.json)
2. Load resource data for all referenced resources
3. Group footnotes by resource:
   ```
   Resource "Sigma World Timeline" → footnotes [5, 6, 15, 16, 17, 18, 19, 20, 21]
   Resource "Contrary Research"    → footnotes [2, 8, 9, 10, 11, 12, 13, 14, 33, 34]
   ```
4. Sort groups by first footnote number (preserves reading order)
5. For each group, render:
   - **Index number** (sequential, 1-based — this is the source number, not footnote number)
   - **Title** (linked to URL)
   - **Metadata line**: publication/domain · author · year · type
   - **Credibility badge** (if available)
   - **Verification dot** (aggregate: best verdict across all claims citing this source)
   - **Back-refs**: "Referenced by [5] [6] [15] [16] [17] [18] [19] [20] [21]"
   - **Expandable details**:
     - Source summary
     - Per-claim verification table (from citation_quotes):
       ```
       Claim: "Kalshi received CFTC approval in Nov 2020"  ✓ Accurate (95%)
       Claim: "Launched in July 2021"                       ✓ Accurate (98%)
       Claim: "Court victory Sept 2024"                     ⚠ Minor issues (72%)
       ```

6. Footnotes **without** resource entries (shouldn't happen after Phase 1, but graceful fallback):
   - Render with title from footnote definition + URL domain
   - No credibility badge or expanded metadata

7. **Citation health footer** (existing, carried forward)

#### 2.2 Suppress remark-gfm Footnote Section

Add CSS to the wiki page stylesheet:
```css
article.prose section[data-footnotes] {
  display: none;
}
```

This hides the remark-gfm generated footnote section. The HTML is still present (for accessibility and SEO), but visually replaced by UnifiedReferences.

The inline `[N]` superscript links need their `href` updated to point to the new References anchors. Two approaches:
- **Build-time**: rehype plugin rewrites `#user-content-fn-N` → `#ref-source-M` (where M is the source group index)
- **Client-time**: InlineCitationCards component rewrites hrefs after hydration

Recommend **client-time** for now (simpler, doesn't require remark/rehype plugin work).

#### 2.3 InlineCitationCards Component

Replace `CitationOverlay.tsx` with enhanced `InlineCitationCards.tsx`:

Same DOM-portal approach (find `a[data-footnote-ref]`, inject adjacent elements), but the hover card now shows:

```
┌─────────────────────────────────────────┐
│  ✓ Verified accurate          95% conf  │
│                                         │
│  Sigma World: From Launch to Lawsuits   │
│  sigma.world · 2025 · Web article       │
│  Credibility: ★★★☆☆                    │
│                                         │
│  "Kalshi received DCM designation from  │
│   the CFTC in November 2020"            │
│                                         │
│  ─────────────────────────────────────  │
│  🕐 Checked Feb 22, 2026    Source ↗    │
│  View in References ↓                   │
└─────────────────────────────────────────┘
```

Data sources:
- Resource metadata (title, domain, credibility): from footnoteIndex + resource data (passed via context)
- Verification (verdict, score, quote): from citationQuotes (existing context)

#### 2.4 Wire Up in Page Layout

Modify `apps/web/src/app/wiki/[id]/page.tsx`:

```tsx
// Replace:
<References pageId={slug} />

// With:
<UnifiedReferences pageId={slug} quotes={citationQuotes} />
```

And update the CitationQuotesProvider to also provide footnote index + resource data for the hover cards.

#### 2.5 Deprecate Old Components

After UnifiedReferences is working:
- `References.tsx` → keep for now but mark deprecated
- `ResourceLink.tsx` (`<R>`) → evaluate if still needed. If no pages use it, remove.
- `CitationOverlay.tsx` → replaced by InlineCitationCards

---

### Phase 3: Citation Quality (Week 3)

**Goal**: Every citation on exemplar pages is accuracy-verified.

#### 3.1 Full Verification Pipeline

For each exemplar page:
```bash
pnpm crux citations extract-quotes <pageId>     # Extract supporting quotes from sources
pnpm crux citations check-accuracy <pageId>      # Verify each claim against source
pnpm crux citations verify <pageId>              # Full verification pass
```

#### 3.2 Fix Broken Citations

Kalshi has 3 broken citations (HTTP 403). For each:
1. Try alternative URLs (archive.org, Google cache)
2. If source is permanently unavailable, either:
   - Find an alternative source for the claim
   - Remove the claim if unsupported
   - Mark as "not verifiable" with a note

#### 3.3 Accuracy Review

Review all claims flagged as `inaccurate` or `unsupported`:
- On Kalshi: Sigma World source discrepancies (Series C vs Series E funding)
- Fix prose to match sources, or find better sources
- Goal: 0 inaccurate claims, <5% unsupported on each exemplar page

#### 3.4 Content Polish

For each exemplar page:
- Run `pnpm crux content improve <pageId> --tier=polish --apply`
- Ensure all claims are properly cited
- Ensure no `{/* NEEDS CITATION */}` markers
- Cross-check facts against related pages

---

### Phase 4: Polish + Foundation (Week 4)

**Goal**: Production-ready rendering. Page quality tiers. Claim data layer.

#### 4.1 Rendering Polish

- Dark mode: verify all new components (hover cards, badges, expandable details)
- Mobile: hover cards → tap to open (touch-friendly)
- Performance: lazy-load citation details (don't fetch all quotes on initial render)
- Accessibility: ARIA labels on hover cards, keyboard navigation through references
- Animation: smooth expand/collapse on reference details

#### 4.2 Page Quality Tiers (optional, discuss with user)

Add `tier` to page frontmatter schema:
- `showcase`: Full resource coverage, verified, claim-extracted
- `standard`: Partial resource coverage, some verification
- `draft`: Minimal quality, hidden from sidebar/search

Alternatively, auto-derive tier from quality score:
- quality >= 60 → showcase
- quality >= 30 → standard
- quality < 30 → draft

Draft pages hidden from sidebar but still accessible by direct URL.

#### 4.3 Claim Extraction (Stretch Goal)

For exemplar pages, run claim extraction experiments:
```bash
pnpm crux claims extract <pageId>    # From crux/experiments/claim-first-*.ts
```

Store results in `data/claims/<entity>.yaml` using the schema from PR #939.
This is **data-only** — no rendering changes. Establishes the claim store that the claim-first architecture will eventually render from.

#### 4.4 Internal Dashboard

Create `/internal/citation-quality` dashboard showing:
- Per-page: resource coverage, verification coverage, accuracy rate
- Per-source: credibility, citation count across pages, accuracy
- Trends: accuracy improvement over time (from citation_accuracy_snapshots)
- Broken citations: list of URLs returning errors

---

## Key Design Decisions

### Why keep `[^N]` footnotes?

1. **LLMs generate them naturally** — every content pipeline step uses standard Markdown
2. **Portable** — the MDX files are valid Markdown outside this wiki
3. **Complete coverage** — every page already has them
4. **Zero migration** — no need to rewrite 625 pages

### Why auto-create resources vs. requiring manual creation?

1. **Coverage gap is the #1 problem** — 87 footnotes but 31 resources on Kalshi
2. **Manual creation doesn't scale** — would need someone to write YAML for every URL
3. **Auto-created entries are good enough** — title, URL, domain, type, date covers 90% of use cases
4. **Human enhancement is additive** — can always add summary, credibility, tags later

### Why suppress remark-gfm footnotes instead of removing them?

1. **The HTML is still there** — screen readers and search engines can still access it
2. **Reversible** — remove the CSS to restore original behavior
3. **No remark/rehype plugin complexity** — avoids touching the MDX compilation pipeline
4. **Progressive enhancement** — pages without UnifiedReferences still work normally

### Why group by source instead of listing every footnote?

On Kalshi, footnotes [17]-[21] all cite the same Sigma World article. Listing it 5 times is noise. Grouping shows:
- **35 unique sources** instead of 87 footnote entries
- Each source shows which claims cite it (back-refs)
- Per-claim verification within each source
- Much more readable and information-dense

### Why not build a custom remark/rehype plugin?

A plugin could:
- Rewrite footnote anchors at compile time
- Inject resource metadata into the footnote section
- Eliminate the need for client-side DOM manipulation

But:
- The MDX compilation pipeline is complex and shared across all pages
- Bugs in a remark plugin affect every page
- Client-side enhancement is simpler, safer, and more debuggable
- We can upgrade to a plugin later once the design is proven

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `crux/citations/register-resources.ts` | Auto-registration command |
| `apps/web/src/components/wiki/UnifiedReferences.tsx` | Unified bibliography component |
| `apps/web/src/components/wiki/InlineCitationCards.tsx` | Enhanced hover cards |

### Modified Files
| File | Change |
|------|--------|
| `apps/web/scripts/build-data.mjs` | Add footnoteIndex computation |
| `apps/web/src/data/index.ts` | Export footnoteIndex accessor |
| `apps/web/src/app/wiki/[id]/page.tsx` | Use UnifiedReferences, pass data |
| `apps/web/src/components/wiki/CitationQuotesContext.tsx` | Add footnoteIndex + resource data to context |
| `crux/commands/citations.ts` | Add register-resources subcommand |
| Global CSS | Suppress `section[data-footnotes]` |

### Potentially Deprecated
| File | Status |
|------|--------|
| `apps/web/src/components/wiki/References.tsx` | Replaced by UnifiedReferences |
| `apps/web/src/components/wiki/CitationOverlay.tsx` | Replaced by InlineCitationCards |
| `apps/web/src/components/wiki/ResourceLink.tsx` | Evaluate if any pages use `<R>` |

---

## Exemplar Pages

| Page | Current Footnotes | Current Resources | Unique URLs (est.) | Gap |
|------|-------------------|-------------------|--------------------|-----|
| kalshi | 87 | 31 | ~35 | ~4 |
| anthropic | TBD | TBD | TBD | TBD |
| miri | TBD | TBD | TBD | TBD |
| existential-risk | TBD | TBD | TBD | TBD |
| (person TBD) | TBD | TBD | TBD | TBD |

After Phase 1, all gaps should be 0.

---

## Relationship to Claim-First Architecture (PR #939)

This plan builds **prerequisite infrastructure** for the claim-first system:

| What we build | What it enables for claims |
|---------------|---------------------------|
| Resource auto-registration | Every claim source has a canonical resource entry |
| Footnote index | Claims can reference footnotes; footnotes reference resources |
| Unified bibliography | When pages are composed from claims, references "just work" |
| Full verification on exemplars | Claim extraction already has verification data to incorporate |
| Citation quality dashboard | Monitoring infrastructure for claim accuracy |

The claim store (Phase 4 stretch goal) is the bridge: it sits between resources (sources) and pages (views), exactly as described in the 4-layer architecture of PR #939.

---

## Open Questions

1. **Which person page for the 5th exemplar?** Candidates: Dario Amodei, Eliezer Yudkowsky, Stuart Russell, Geoffrey Hinton
2. **Page quality tiers — automatic or manual?** Auto-derive from quality score, or explicit frontmatter?
3. **How aggressive on hiding low-quality pages?** Just from sidebar, or also from search?
4. **Resource YAML file organization** — currently 10 files by category. Should auto-created resources go in a separate file (`auto-registered.yaml`) or be sorted into category files?
5. **Footnote grouping in bibliography** — group by source (recommended) or preserve footnote order?
