"use client";

import { Suspense } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface ProfileTab {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

export interface ProfileTabsProps {
  tabs: ProfileTab[];
  /** Accessible label for the tab list, e.g. "Organization sections" */
  ariaLabel?: string;
}

/**
 * Inner component that reads search params (must be wrapped in Suspense).
 */
function ProfileTabsInner({ tabs, ariaLabel }: { tabs: ProfileTab[]; ariaLabel?: string }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  // Filter out tabs with explicit count of 0
  const visibleTabs = tabs.filter((t) => t.count !== 0);

  if (visibleTabs.length === 0) return null;

  // If only one tab, render its content directly without tab chrome
  if (visibleTabs.length === 1) {
    return <>{visibleTabs[0].content}</>;
  }

  const defaultTabId = visibleTabs[0].id;
  const tabParam = searchParams.get("tab");
  // Use URL tab param if it matches a visible tab, otherwise default
  const activeTab = tabParam && visibleTabs.some((t) => t.id === tabParam)
    ? tabParam
    : defaultTabId;

  function handleTabChange(value: string) {
    // Omit ?tab= when it matches the first tab (clean URLs)
    if (value === defaultTabId) {
      router.replace(pathname, { scroll: false });
    } else {
      router.replace(`${pathname}?tab=${value}`, { scroll: false });
    }
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList aria-label={ariaLabel ?? "Page sections"} className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0 overflow-x-auto">
        {visibleTabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="shrink-0 rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            aria-label={tab.count != null && tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="ml-1.5 text-[11px] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                {tab.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleTabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-6 min-w-0">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * Static fallback rendered during SSR before useSearchParams resolves.
 * Shows the default (first) tab without URL syncing.
 */
function ProfileTabsFallback({ tabs, ariaLabel }: { tabs: ProfileTab[]; ariaLabel?: string }) {
  const visibleTabs = tabs.filter((t) => t.count !== 0);
  if (visibleTabs.length === 0) return null;
  if (visibleTabs.length === 1) return <>{visibleTabs[0].content}</>;
  return (
    <Tabs defaultValue={visibleTabs[0].id}>
      <TabsList aria-label={ariaLabel ?? "Page sections"} className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0 overflow-x-auto">
        {visibleTabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="shrink-0 rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="ml-1.5 text-[11px] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                {tab.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleTabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-6 min-w-0">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * Reusable tabbed layout for profile pages (organizations, people, etc.).
 * - Automatically hides tabs where count is 0
 * - Renders content directly (no tab chrome) when only one tab remains
 * - Syncs active tab to ?tab= URL query param for shareable links
 */
export function ProfileTabs({ tabs, ariaLabel }: ProfileTabsProps) {
  return (
    <Suspense fallback={<ProfileTabsFallback tabs={tabs} ariaLabel={ariaLabel} />}>
      <ProfileTabsInner tabs={tabs} ariaLabel={ariaLabel} />
    </Suspense>
  );
}
