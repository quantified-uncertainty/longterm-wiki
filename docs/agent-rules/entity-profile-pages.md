# Entity Profile Pages — Use `EntityProfileShell`

Every directory-detail page (`/organizations/[slug]`, `/people/[slug]`,
`/ai-models/[slug]`, and analogous pages for projects, legislation, benchmarks,
etc.) **must** use the shared `EntityProfileShell` component instead of
hand-rolling its own wrapper layout.

## Why this exists

Previously every entity profile page hand-wrote its own outer container,
breadcrumbs, header (avatar / title / pills / coverage badge / sourcing
dot), stat-card grid, and sidebar layout. Each time a cross-cutting piece of
chrome needed to change ("show the sourcing rollup next to the title",
"add a coverage popover", "change the Data link style") we had to touch every
page individually, and features silently drifted between types. See QUA-328,
which replaces QUA-117 / QUA-194 / QUA-152 / QUA-205 — all of which were
"add X to every entity page" tickets that existed only because the layout
wasn't shared.

The shell gives each page a single canonical code path for:

- outer container + breadcrumbs
- header title row with title, type pills, coverage popover, and sourcing
  rollup badge
- metadata row, header-link pills, optional footer (e.g. founders)
- stat cards
- tabs (via `ProfileTabs`) or free children
- optional right-hand sidebar (2-column grid layout)

Adding a new "show on all entity pages" item is a one-line change inside
`EntityProfileShell.tsx`.

## Files

- `apps/web/src/components/entity/EntityProfileShell.tsx` — the shell component
  (server component; safe to render from any Next.js page or layout)
- `apps/web/src/components/entity/entity-sourcing.ts` —
  `fetchEntitySourcingSummary()` + `rollupVerdictFromSummary()` for the
  sourcing rollup badge
- Reference implementations:
  - `apps/web/src/app/organizations/[slug]/page.tsx` (uses the shell with
    `tabs` and no sidebar)
  - `apps/web/src/app/organizations/[slug]/data/page.tsx` (uses the shell with
    `children` — the long-form data table — and the same slot-builder helper)
  - `apps/web/src/app/people/[slug]/page.tsx` (uses `tabs` **and** `sidebar`
    for the 2-column people layout)
  - `apps/web/src/app/ai-models/[slug]/page.tsx` (uses `children` + `sidebar`
    with no tabs)

## API at a glance

```tsx
<EntityProfileShell
  breadcrumbs={[{ label: "Organizations", href: "/organizations" }, { label: entity.name }]}
  entityId={entity.id}
  avatar={<InitialsCircle name={entity.name} />}
  title={entity.name}
  aliases={entity.aliases}
  titlePills={<>...</>}              // badges next to the title
  coverage={{ score, signals }}       // data-coverage popover (optional)
  verdict={rollupVerdict}             // sourcing rollup verdict (optional)
  subtitle={entity.description}
  metadata={<>Founded ... · HQ ... · website</>}
  headerLinks={[{ label: "Wiki page", href: wikiHref }, { label: "Data", href: `/organizations/${entity.id}/data` }]}
  headerFooter={<FoundersList founders={founders} />}
  statCards={<StatCardsGrid cards={cards} />}
  tabs={tabs}                         // ProfileTab[]
  tabsAriaLabel="Organization sections"
  sidebar={<SidebarContent />}        // optional right-hand sidebar
>
  {/* Optional children render inside the main column below tabs */}
</EntityProfileShell>
```

- When `sidebar` is provided, the main column renders in a `lg:grid-cols-3`
  2-column layout with the sidebar on the right.
- When `tabs` is provided, `ProfileTabs` is rendered automatically — pages
  should not import `ProfileTabs` directly anymore.
- The sourcing rollup dot is **always** rendered in the header, using
  `SourcingDot` + `recordVerdictToStatus`, so every entity page has a
  consistent sourcing badge. Pass `verdict` as the raw verdict string
  (`"confirmed" | "contradicted" | ...`) or `null` for "unchecked".

## Fetching the sourcing rollup

Use the helper from `@/components/entity/entity-sourcing`:

```ts
const sourcingSummary = await fetchEntitySourcingSummary([entity.id, entity.stableId, slug]);
const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);
```

`fetchEntitySourcingSummary` takes one or more candidate identifiers
(slug, stableId, numericId) and matches any of them against the upstream row,
which makes it robust to whichever form the wiki-server recorded the verdict
under. The call is ISR-cached (default 300s) so every per-page request for the
same build shares a single network fetch.

`rollupVerdictFromSummary` picks the most actionable verdict present
(`contradicted > outdated > partial > unverifiable > confirmed > unchecked`),
or `null` when no verdicts exist.

## When NOT to use the shell

- **Dashboards** (`/internal/*`) — these have their own layout patterns,
  described in `docs/agent-rules/internal-dashboards.md`.
- **Wiki pages** (`/wiki/E<N>`) — MDX content uses its own article layout.
- **Directory index pages** (`/organizations`, `/people`) — the shell is for
  the per-entity detail pages, not the list pages.

## Adding a new entity type directory

When adding a new directory (e.g. `/policies/[slug]`), your detail page should:

1. Resolve the entity and fetch its data as usual.
2. Call `fetchEntitySourcingSummary` for the sourcing rollup.
3. Render `<EntityProfileShell>` with the slots it needs.
4. Leave the per-type sections as either `tabs` or `children`, and optional
   `sidebar` content.

Do not introduce a new per-type wrapper component. If the shell is missing a
slot you need, **add the slot to the shell** rather than forking the layout.
