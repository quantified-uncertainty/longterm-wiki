import type { ProfileTabGroup } from "@/components/directory";

/**
 * Vertical-nav group metadata for the organization profile page.
 * Order controls display order on the left rail.
 */
export const ORG_TAB_GROUPS: ProfileTabGroup[] = [
  { id: "entity", label: "Entity" },
  { id: "about", label: "About" },
  { id: "business", label: "Business" },
  { id: "governance", label: "Policy & Governance" },
  { id: "output", label: "Output & Research" },
  { id: "data", label: "Data" },
];

/**
 * Every tab id that can appear on `/organizations/<slug>`. Tabs are rendered
 * conditionally based on the entity's available data, but any URL using one
 * of these segments is a valid path-routing target — the catch-all route
 * matches it and `ProfileTabsPathMode` picks the active tab.
 *
 * Used for:
 *   - Render-audit enumeration (QUA-879)
 *   - validate-tab-routes gate check (QUA-881)
 *
 * Keep in sync with the conditional `tabs.push(...)` calls in the catch-all
 * `[[...tab]]/page.tsx` builder. The "wiki" link-tab is intentionally
 * excluded — it navigates to `/wiki/E<N>` rather than a tab segment, so
 * `/organizations/<slug>/wiki` is not a meaningful URL.
 */
export const ORG_TAB_IDS = [
  "overview",
  "facts",
  "database",
  "people",
  "timeline",
  "funding-rounds",
  "shareholders",
  "grants-made",
  "grants-received",
  "funding-programs",
  "partnerships",
  "market-data",
  "products",
  "safety",
  "publications",
  "announcements",
  "press",
  "divisions",
  "policy",
  "scorecards",
  "projects",
] as const;

export type OrgTabId = (typeof ORG_TAB_IDS)[number];

/** Default tab when the URL is the bare `/organizations/<slug>`. */
export const ORG_DEFAULT_TAB_ID: OrgTabId = "overview";

/** Shared tailwind size class for tab icons in the vertical nav. */
export const ORG_TAB_ICON_CLASS = "w-4 h-4";
