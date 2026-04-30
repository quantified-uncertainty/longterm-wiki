"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@lib/utils";

export interface ProfileTab {
  id: string;
  label: string;
  count?: number;
  /**
   * Tab body. Ignored when `href` is set — those entries are nav links, not
   * Radix tabs, and have no content panel.
   */
  content?: React.ReactNode;
  /** Icon node shown next to the tab label in vertical layout. Ignored in horizontal. */
  icon?: React.ReactNode;
  /** Group id for vertical layout. Tabs without a group land in an ungrouped column. */
  group?: string;
  /**
   * When set, the tab renders as a `<Link>` navigating to this URL instead of
   * a Radix tab trigger. Use for destinations that pull in heavy CSS or that
   * have their own full-page layout (e.g., /wiki/E<N>).
   * Only supported in vertical layout.
   */
  href?: string;
}

/**
 * Display metadata for a vertical-layout group header. Order of the array
 * controls display order. Groups referenced by a tab but absent from this list
 * fall back to rendering in insertion order with the group id as the label.
 */
export interface ProfileTabGroup {
  id: string;
  label: string;
}

/**
 * URL-routing mode for the active tab.
 * - `"query"` (default): active tab read from `?tab=<id>`; clicks call
 *   `router.replace` to update the query.
 * - `"path"`: active tab read from the path segment after `basePath`; tab
 *   triggers render as `<Link>` so navigation is SSR-friendly and the URL
 *   is shareable as `${basePath}/${tabId}` (the default tab is `${basePath}`).
 */
export type TabRouting =
  | { mode: "query" }
  | { mode: "path"; basePath: string };

export interface ProfileTabsProps {
  tabs: ProfileTab[];
  /** Accessible label for the tab list, e.g. "Organization sections" */
  ariaLabel?: string;
  /**
   * Layout orientation. `"horizontal"` (default) renders the traditional
   * top-tab row; `"vertical"` renders a left-side grouped nav with tab content
   * in the right column.
   */
  layout?: "horizontal" | "vertical";
  /** Ordered groups (vertical layout only). */
  groups?: ProfileTabGroup[];
  /** URL routing mode. Defaults to `{ mode: "query" }` (existing behavior). */
  tabRouting?: TabRouting;
}

// ─── Shared helpers ─────────────────────────────────────────────────────

const HORIZONTAL_TABLIST =
  "w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0 overflow-x-auto";

const HORIZONTAL_TRIGGER =
  "shrink-0 rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none cursor-pointer transition-colors hover:bg-muted/50 hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none";

// Shared layout for every vertical-nav row (both Radix triggers and link-tabs).
const VERTICAL_ROW_BASE =
  "group relative flex items-center gap-3 w-full justify-between rounded-lg border-0 px-3 py-2 text-left text-[13px] text-muted-foreground shadow-none cursor-pointer transition-colors hover:bg-muted/40 hover:text-foreground";

// Radix tab trigger variant. Active-state treatment (bg-background, ring,
// shadow) is defined in globals.css on `.profile-tab-vertical[data-state="active"]`
// — Tailwind's `data-[state=active]:*` variants don't compile reliably for
// this project.
const VERTICAL_TRIGGER = `profile-tab-vertical ${VERTICAL_ROW_BASE}`;

function CountBadge({ count }: { count: number }) {
  return (
    <span className="ml-1.5 text-[11px] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
      {count}
    </span>
  );
}

function TabLabel({ tab, layout }: { tab: ProfileTab; layout: "horizontal" | "vertical" }) {
  const count = tab.count != null && tab.count > 0 ? tab.count : null;
  if (layout === "vertical") {
    return (
      <>
        <span className="flex items-center gap-3 min-w-0">
          {tab.icon && (
            <span className="shrink-0 text-muted-foreground/60 group-data-[state=active]:text-foreground/80 [&_svg]:w-[15px] [&_svg]:h-[15px]">
              {tab.icon}
            </span>
          )}
          <span className="truncate">{tab.label}</span>
        </span>
        {count !== null && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60 group-data-[state=active]:text-muted-foreground">
            {count}
          </span>
        )}
      </>
    );
  }
  return (
    <>
      {tab.label}
      {count !== null && <CountBadge count={count} />}
    </>
  );
}

function ariaLabelFor(tab: ProfileTab) {
  return tab.count != null && tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label;
}

// ─── Group helpers (vertical layout) ───────────────────────────────────

function bucketByGroup(
  tabs: ProfileTab[],
  groups: ProfileTabGroup[] | undefined,
): Array<{ id: string; label: string | null; tabs: ProfileTab[] }> {
  // Collect tabs into their groups, preserving tab insertion order inside.
  const byId = new Map<string, ProfileTab[]>();
  const ungrouped: ProfileTab[] = [];
  for (const t of tabs) {
    if (!t.group) {
      ungrouped.push(t);
      continue;
    }
    const bucket = byId.get(t.group) ?? [];
    bucket.push(t);
    byId.set(t.group, bucket);
  }

  const result: Array<{ id: string; label: string | null; tabs: ProfileTab[] }> = [];
  // Ungrouped tabs render first, with no header (keeps single-group pages clean).
  if (ungrouped.length > 0) {
    result.push({ id: "__ungrouped", label: null, tabs: ungrouped });
  }
  // Emit groups in the order provided by `groups`, then any extras that
  // appeared on tabs but weren't declared.
  const seen = new Set<string>();
  if (groups) {
    for (const g of groups) {
      const bucket = byId.get(g.id);
      if (bucket && bucket.length > 0) {
        result.push({ id: g.id, label: g.label, tabs: bucket });
        seen.add(g.id);
      }
    }
  }
  for (const [id, bucket] of byId) {
    if (!seen.has(id)) {
      result.push({ id, label: id, tabs: bucket });
    }
  }
  return result;
}

// ─── Path-mode helpers ─────────────────────────────────────────────────

// Strip a single trailing slash so `${basePath}/${id}` doesn't double-slash
// when callers pass `basePath="/organizations/anthropic/"`. Empty string and
// bare `/` are not valid mount points — see invariant in `ProfileTabsPathMode`.
function normalizeBasePath(basePath: string): string {
  return basePath.endsWith("/") && basePath.length > 1
    ? basePath.slice(0, -1)
    : basePath;
}

// URL the trigger Link should navigate to. The default tab lives at the bare
// basePath (no segment); other tabs get `${basePath}/${id}`. Tabs with an
// explicit `href` keep their own destination — those are link-tabs (e.g. wiki
// pages) and override path-mode routing.
function tabHrefFor(tab: ProfileTab, basePath: string, defaultTabId: string): string {
  if (tab.href) return tab.href;
  const base = normalizeBasePath(basePath);
  return tab.id === defaultTabId ? base : `${base}/${tab.id}`;
}

// Pick the active tab + flag any unknown segment so we can surface a notice.
function pickActiveTabFromPath(
  pathname: string,
  basePath: string,
  tabs: ProfileTab[],
  defaultTabId: string,
): { activeTab: string; unknownRequested: string | null } {
  const base = normalizeBasePath(basePath);
  // Bare basePath (or basePath + trailing slash) → default tab.
  if (pathname === base || pathname === `${base}/`) {
    return { activeTab: defaultTabId, unknownRequested: null };
  }
  if (pathname.startsWith(`${base}/`)) {
    const remainder = pathname.slice(base.length + 1);
    const segment = remainder.split("/")[0] ?? "";
    if (segment === "") {
      return { activeTab: defaultTabId, unknownRequested: null };
    }
    const selectableIds = new Set(tabs.filter((t) => !t.href).map((t) => t.id));
    if (selectableIds.has(segment)) {
      return { activeTab: segment, unknownRequested: null };
    }
    return { activeTab: defaultTabId, unknownRequested: segment };
  }
  // pathname doesn't share the basePath prefix at all (shouldn't happen in
  // practice, but be tolerant — fall back to default rather than blow up).
  return { activeTab: defaultTabId, unknownRequested: null };
}

// ─── Renderers ──────────────────────────────────────────────────────────

// In path mode, render a Radix-styled Link that visually matches a TabsTrigger
// but doesn't participate in TabsRoot's controlled value. Active state is
// driven by aria-selected so the existing CSS targeting `[data-state="active"]`
// keeps working without coupling to Radix's internal state machine.
const HORIZONTAL_LINK_TRIGGER = `${HORIZONTAL_TRIGGER} no-underline`;
const VERTICAL_LINK_TRIGGER = `profile-tab-vertical ${VERTICAL_ROW_BASE} no-underline`;

function HorizontalTabsList({
  tabs,
  ariaLabel,
  pathRouting,
}: {
  tabs: ProfileTab[];
  ariaLabel?: string;
  /** Set in path mode. Triggers render as `<Link>` with active state derived from `activeTab`. */
  pathRouting?: { basePath: string; activeTab: string; defaultTabId: string };
}) {
  return (
    <TabsList aria-label={ariaLabel ?? "Page sections"} className={HORIZONTAL_TABLIST}>
      {tabs.map((tab) => {
        if (pathRouting) {
          const isActive = tab.id === pathRouting.activeTab;
          return (
            <Link
              key={tab.id}
              href={tabHrefFor(tab, pathRouting.basePath, pathRouting.defaultTabId)}
              prefetch
              role="tab"
              aria-label={ariaLabelFor(tab)}
              aria-selected={isActive}
              data-state={isActive ? "active" : "inactive"}
              data-tab-id={tab.id}
              className={HORIZONTAL_LINK_TRIGGER}
            >
              <TabLabel tab={tab} layout="horizontal" />
            </Link>
          );
        }
        return (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className={HORIZONTAL_TRIGGER}
            aria-label={ariaLabelFor(tab)}
          >
            <TabLabel tab={tab} layout="horizontal" />
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}

// Link-tab variant — same row layout, no active state (these always
// navigate away instead of selecting a tab).
const VERTICAL_LINK = `${VERTICAL_ROW_BASE} no-underline`;

function VerticalTabsNav({
  tabs,
  groups,
  ariaLabel,
  pathRouting,
}: {
  tabs: ProfileTab[];
  groups?: ProfileTabGroup[];
  ariaLabel?: string;
  /** Set in path mode. Non-link tabs render as `<Link>` with active state derived from `activeTab`. */
  pathRouting?: { basePath: string; activeTab: string; defaultTabId: string };
}) {
  const buckets = bucketByGroup(tabs, groups);
  // TabsList supplies the RovingFocusGroup context that TabsTrigger needs.
  // Link-tabs (plain <Link>) render as siblings inside it; they don't
  // participate in roving focus, but they still render and click through —
  // which matches their intent (navigate away, not select a tab).
  return (
    <TabsList
      aria-label={ariaLabel ?? "Page sections"}
      className="flex flex-col items-stretch gap-0 bg-transparent p-0 h-auto w-full"
    >
      {buckets.map((bucket, idx) => (
        <div
          key={bucket.id}
          className={cn("flex flex-col gap-0.5", idx > 0 && "mt-7")}
        >
          {bucket.label != null && (
            <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.12em] text-muted-foreground/80 uppercase">
              {bucket.label}
            </div>
          )}
          {bucket.tabs.map((tab) => {
            // Tabs with an explicit `href` are link-tabs in either mode — they
            // navigate to a fixed destination (e.g. wiki page) rather than
            // participating in tab routing.
            if (tab.href) {
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  aria-label={ariaLabelFor(tab)}
                  className={VERTICAL_LINK}
                >
                  <TabLabel tab={tab} layout="vertical" />
                </Link>
              );
            }
            if (pathRouting) {
              const isActive = tab.id === pathRouting.activeTab;
              return (
                <Link
                  key={tab.id}
                  href={tabHrefFor(tab, pathRouting.basePath, pathRouting.defaultTabId)}
                  prefetch
                  role="tab"
                  aria-label={ariaLabelFor(tab)}
                  aria-selected={isActive}
                  data-state={isActive ? "active" : "inactive"}
                  data-tab-id={tab.id}
                  className={VERTICAL_LINK_TRIGGER}
                >
                  <TabLabel tab={tab} layout="vertical" />
                </Link>
              );
            }
            return (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={VERTICAL_TRIGGER}
                aria-label={ariaLabelFor(tab)}
              >
                <TabLabel tab={tab} layout="vertical" />
              </TabsTrigger>
            );
          })}
        </div>
      ))}
    </TabsList>
  );
}

function TabsContentList({ tabs, layout }: { tabs: ProfileTab[]; layout: "horizontal" | "vertical" }) {
  return (
    <>
      {/* Skip link-tabs — they have no content panel. */}
      {tabs.filter((t) => !t.href).map((tab) => (
        <TabsContent
          key={tab.id}
          value={tab.id}
          className={cn("min-w-0", layout === "horizontal" ? "mt-6" : "mt-0")}
        >
          {tab.content}
        </TabsContent>
      ))}
    </>
  );
}

// ─── Layout wrappers ────────────────────────────────────────────────────

// QUA-656: Both Fallback and Inner call these with `onChange` set, so the
// rendered `<Tabs>` always uses controlled props (`value` + `onValueChange`).
// Keeping the wire shape identical between the two Suspense states is what
// lets the Suspense transition avoid tripping React #418 during ISR cache
// boundaries — the only thing that changes across the transition is the
// handler identity, not the DOM structure.
function HorizontalLayout({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  notice,
  pathRouting,
}: {
  tabs: ProfileTab[];
  activeTab: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  notice?: React.ReactNode;
  pathRouting?: { basePath: string; defaultTabId: string };
}) {
  return (
    <Tabs value={activeTab} onValueChange={onChange}>
      <HorizontalTabsList
        tabs={tabs}
        ariaLabel={ariaLabel}
        pathRouting={pathRouting ? { ...pathRouting, activeTab } : undefined}
      />
      {notice}
      <TabsContentList tabs={tabs} layout="horizontal" />
    </Tabs>
  );
}

function VerticalLayout({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  groups,
  notice,
  pathRouting,
}: {
  tabs: ProfileTab[];
  activeTab: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  groups?: ProfileTabGroup[];
  notice?: React.ReactNode;
  pathRouting?: { basePath: string; defaultTabId: string };
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={onChange}
      orientation="vertical"
      className="flex-col gap-0"
    >
      <div className="grid grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)] gap-x-10 gap-y-6">
        <div className="md:sticky md:top-4 md:self-start">
          <VerticalTabsNav
            tabs={tabs}
            groups={groups}
            ariaLabel={ariaLabel}
            pathRouting={pathRouting ? { ...pathRouting, activeTab } : undefined}
          />
        </div>
        <div className="min-w-0">
          {notice}
          <TabsContentList tabs={tabs} layout="vertical" />
        </div>
      </div>
    </Tabs>
  );
}

// ─── Public component with URL-sync + Suspense fallback ────────────────

function UnknownTabNotice({
  requested,
  fallback,
}: {
  requested: string;
  fallback: string;
}) {
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-amber-300/60 bg-amber-50/50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
    >
      No <span className="font-mono">{requested}</span> data for this entity — showing{" "}
      <span className="font-medium">{fallback}</span> instead.
    </div>
  );
}

// Shared helper: pick the tab that both Fallback and Inner should start with.
// Keeping this in one place means the two Suspense states can never diverge
// on "which tab is active on first paint".
function pickDefaultTab(tabs: ProfileTab[]): ProfileTab {
  const selectable = tabs.filter((t) => !t.href);
  return selectable[0] ?? tabs[0];
}

function noop() {}

function ProfileTabsInner({
  tabs,
  ariaLabel,
  layout,
  groups,
}: {
  tabs: ProfileTab[];
  ariaLabel?: string;
  layout: "horizontal" | "vertical";
  groups?: ProfileTabGroup[];
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const defaultTab = pickDefaultTab(tabs);
  const defaultTabId = defaultTab.id;
  const selectableTabs = tabs.filter((t) => !t.href);

  // QUA-656: Inner starts with the same default tab the Fallback renders,
  // and reconciles with `?tab=` in a post-hydration effect. Prior design
  // derived activeTab from searchParams synchronously, which — combined
  // with the Fallback rendering `defaultValue` (uncontrolled) vs Inner's
  // `value` (controlled) — produced structurally different Radix trees
  // across the Suspense transition. During Vercel ISR cache boundaries,
  // HTML and RSC could come from different renders and mis-match on
  // hydration (React #418, args[]=HTML element-type mismatch).
  const [activeTab, setActiveTab] = useState<string>(defaultTabId);
  const [unknownTabRequested, setUnknownTabRequested] = useState<string | null>(null);

  // `searchParams` object identity changes every parent render; depend on
  // the resolved `tab` value instead so the effect only fires when the URL
  // actually changes. `selectableIdsKey` likewise guards against new array
  // identity on every render.
  const tabParam = searchParams.get("tab");
  const selectableIdsKey = selectableTabs.map((t) => t.id).join("|");

  useEffect(() => {
    if (!tabParam) {
      setActiveTab(defaultTabId);
      setUnknownTabRequested(null);
      return;
    }
    const ids = selectableIdsKey.split("|");
    if (ids.includes(tabParam)) {
      setActiveTab(tabParam);
      setUnknownTabRequested(null);
    } else {
      setActiveTab(defaultTabId);
      setUnknownTabRequested(tabParam);
    }
  }, [tabParam, defaultTabId, selectableIdsKey]);

  function handleTabChange(value: string) {
    if (value === defaultTabId) {
      router.replace(pathname, { scroll: false });
    } else {
      router.replace(`${pathname}?tab=${value}`, { scroll: false });
    }
  }

  const notice = unknownTabRequested ? (
    <UnknownTabNotice requested={unknownTabRequested} fallback={defaultTab.label} />
  ) : null;

  return layout === "vertical" ? (
    <VerticalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleTabChange}
      ariaLabel={ariaLabel}
      groups={groups}
      notice={notice}
    />
  ) : (
    <HorizontalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleTabChange}
      ariaLabel={ariaLabel}
      notice={notice}
    />
  );
}

function ProfileTabsFallback({
  tabs,
  ariaLabel,
  layout,
  groups,
}: {
  tabs: ProfileTab[];
  ariaLabel?: string;
  layout: "horizontal" | "vertical";
  groups?: ProfileTabGroup[];
}) {
  // QUA-656: Fallback renders the SAME controlled <Tabs value={...}
  // onValueChange={...}> tree Inner starts with — only the handler identity
  // differs. That way when Suspense swaps Fallback → Inner after the
  // searchParams hook resolves, the DOM doesn't restructure and React
  // doesn't have to reconcile incompatible tab-root configurations.
  const defaultTabId = pickDefaultTab(tabs).id;
  return layout === "vertical" ? (
    <VerticalLayout
      tabs={tabs}
      activeTab={defaultTabId}
      onChange={noop}
      ariaLabel={ariaLabel}
      groups={groups}
    />
  ) : (
    <HorizontalLayout
      tabs={tabs}
      activeTab={defaultTabId}
      onChange={noop}
      ariaLabel={ariaLabel}
    />
  );
}

// Path-mode renderer. Skips Suspense — `usePathname()` is sync on both server
// and client, so the rendered DOM is identical across SSR and hydration. The
// QUA-656 invariant (Fallback/Inner shape parity) is satisfied trivially:
// there's no Fallback, and the single render path is structurally stable.
function ProfileTabsPathMode({
  tabs,
  ariaLabel,
  layout,
  groups,
  basePath,
}: {
  tabs: ProfileTab[];
  ariaLabel?: string;
  layout: "horizontal" | "vertical";
  groups?: ProfileTabGroup[];
  basePath: string;
}) {
  // basePath must be a non-root absolute path (`/organizations/anthropic`,
  // not `""` or `"/"`). Mounting at root would produce empty hrefs for the
  // default tab and ambiguous segment parsing for non-default tabs.
  if (!basePath || basePath === "/") {
    throw new Error(
      `ProfileTabs path mode requires a non-root basePath, got ${JSON.stringify(basePath)}`,
    );
  }
  const pathname = usePathname();
  const defaultTab = pickDefaultTab(tabs);
  const { activeTab, unknownRequested } = pickActiveTabFromPath(
    pathname ?? "",
    basePath,
    tabs,
    defaultTab.id,
  );

  const notice = unknownRequested ? (
    <UnknownTabNotice requested={unknownRequested} fallback={defaultTab.label} />
  ) : null;

  // Triggers are <Link>s, so they handle navigation themselves. Pass noop to
  // satisfy the controlled <Tabs> wire shape.
  const pathRouting = { basePath, defaultTabId: defaultTab.id };
  return layout === "vertical" ? (
    <VerticalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={noop}
      ariaLabel={ariaLabel}
      groups={groups}
      notice={notice}
      pathRouting={pathRouting}
    />
  ) : (
    <HorizontalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={noop}
      ariaLabel={ariaLabel}
      notice={notice}
      pathRouting={pathRouting}
    />
  );
}

/**
 * Reusable tabbed layout for profile pages (organizations, people, etc.).
 * - Filters out tabs where `count === 0`
 * - Renders content directly (no tab chrome) when only one tab remains
 * - `tabRouting={{ mode: "query" }}` (default) syncs active tab to `?tab=`
 * - `tabRouting={{ mode: "path", basePath }}` reads/writes the active tab as
 *   a path segment after `basePath`, with triggers rendered as `<Link>` for
 *   SSR-friendliness and shareable URLs
 * - `layout="vertical"` renders a grouped left-side nav (see `groups`)
 */
export function ProfileTabs({
  tabs,
  ariaLabel,
  layout = "horizontal",
  groups,
  tabRouting = { mode: "query" },
}: ProfileTabsProps) {
  const visibleTabs = tabs.filter((t) => t.count !== 0);
  if (visibleTabs.length === 0) return null;
  // Single-tab short-circuit — matches QUA-463 hydration fix: skip Suspense
  // so server and client agree on a plain fragment.
  if (visibleTabs.length === 1) {
    return <>{visibleTabs[0].content}</>;
  }
  if (tabRouting.mode === "path") {
    return (
      <ProfileTabsPathMode
        tabs={visibleTabs}
        ariaLabel={ariaLabel}
        layout={layout}
        groups={groups}
        basePath={tabRouting.basePath}
      />
    );
  }
  return (
    <Suspense
      fallback={
        <ProfileTabsFallback
          tabs={visibleTabs}
          ariaLabel={ariaLabel}
          layout={layout}
          groups={groups}
        />
      }
    >
      <ProfileTabsInner
        tabs={visibleTabs}
        ariaLabel={ariaLabel}
        layout={layout}
        groups={groups}
      />
    </Suspense>
  );
}
