"use client";

import { Suspense } from "react";
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

// ─── Renderers ──────────────────────────────────────────────────────────

function HorizontalTabsList({ tabs, ariaLabel }: { tabs: ProfileTab[]; ariaLabel?: string }) {
  return (
    <TabsList aria-label={ariaLabel ?? "Page sections"} className={HORIZONTAL_TABLIST}>
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.id}
          value={tab.id}
          className={HORIZONTAL_TRIGGER}
          aria-label={ariaLabelFor(tab)}
        >
          <TabLabel tab={tab} layout="horizontal" />
        </TabsTrigger>
      ))}
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
}: {
  tabs: ProfileTab[];
  groups?: ProfileTabGroup[];
  ariaLabel?: string;
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
          {bucket.tabs.map((tab) =>
            tab.href ? (
              <Link
                key={tab.id}
                href={tab.href}
                aria-label={ariaLabelFor(tab)}
                className={VERTICAL_LINK}
              >
                <TabLabel tab={tab} layout="vertical" />
              </Link>
            ) : (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={VERTICAL_TRIGGER}
                aria-label={ariaLabelFor(tab)}
              >
                <TabLabel tab={tab} layout="vertical" />
              </TabsTrigger>
            ),
          )}
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

function HorizontalLayout({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
}: {
  tabs: ProfileTab[];
  activeTab: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
}) {
  const content = (
    <>
      <HorizontalTabsList tabs={tabs} ariaLabel={ariaLabel} />
      <TabsContentList tabs={tabs} layout="horizontal" />
    </>
  );
  return onChange ? (
    <Tabs value={activeTab} onValueChange={onChange}>
      {content}
    </Tabs>
  ) : (
    <Tabs defaultValue={activeTab}>{content}</Tabs>
  );
}

function VerticalLayout({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  groups,
}: {
  tabs: ProfileTab[];
  activeTab: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  groups?: ProfileTabGroup[];
}) {
  const content = (
    <div className="grid grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)] gap-x-10 gap-y-6">
      <div className="md:sticky md:top-4 md:self-start">
        <VerticalTabsNav tabs={tabs} groups={groups} ariaLabel={ariaLabel} />
      </div>
      <div className="min-w-0">
        <TabsContentList tabs={tabs} layout="vertical" />
      </div>
    </div>
  );
  return onChange ? (
    <Tabs
      value={activeTab}
      onValueChange={onChange}
      orientation="vertical"
      className="flex-col gap-0"
    >
      {content}
    </Tabs>
  ) : (
    <Tabs defaultValue={activeTab} orientation="vertical" className="flex-col gap-0">
      {content}
    </Tabs>
  );
}

// ─── Public component with URL-sync + Suspense fallback ────────────────

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

  // Link tabs (with href) aren't Radix tabs — they navigate on click. Pick
  // the first non-link tab as the default active id.
  const selectableTabs = tabs.filter((t) => !t.href);
  const defaultTabId = selectableTabs[0]?.id ?? tabs[0].id;
  const tabParam = searchParams.get("tab");
  const activeTab =
    tabParam && selectableTabs.some((t) => t.id === tabParam) ? tabParam : defaultTabId;

  function handleTabChange(value: string) {
    if (value === defaultTabId) {
      router.replace(pathname, { scroll: false });
    } else {
      router.replace(`${pathname}?tab=${value}`, { scroll: false });
    }
  }

  return layout === "vertical" ? (
    <VerticalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleTabChange}
      ariaLabel={ariaLabel}
      groups={groups}
    />
  ) : (
    <HorizontalLayout
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleTabChange}
      ariaLabel={ariaLabel}
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
  const selectable = tabs.filter((t) => !t.href);
  const activeTab = selectable[0]?.id ?? tabs[0].id;
  return layout === "vertical" ? (
    <VerticalLayout tabs={tabs} activeTab={activeTab} ariaLabel={ariaLabel} groups={groups} />
  ) : (
    <HorizontalLayout tabs={tabs} activeTab={activeTab} ariaLabel={ariaLabel} />
  );
}

/**
 * Reusable tabbed layout for profile pages (organizations, people, etc.).
 * - Filters out tabs where `count === 0`
 * - Renders content directly (no tab chrome) when only one tab remains
 * - Syncs active tab to `?tab=` URL query param for shareable links
 * - `layout="vertical"` renders a grouped left-side nav (see `groups`)
 */
export function ProfileTabs({ tabs, ariaLabel, layout = "horizontal", groups }: ProfileTabsProps) {
  const visibleTabs = tabs.filter((t) => t.count !== 0);
  if (visibleTabs.length === 0) return null;
  // Single-tab short-circuit — matches QUA-463 hydration fix: skip Suspense so
  // server and client agree on a plain fragment.
  if (visibleTabs.length === 1) {
    return <>{visibleTabs[0].content}</>;
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
