"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface ProfileTab {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

/**
 * Reusable tabbed layout for profile pages (organizations, people, etc.).
 * - Automatically hides tabs where count is 0
 * - Renders content directly (no tab chrome) when only one tab remains
 */
export function ProfileTabs({ tabs }: { tabs: ProfileTab[] }) {
  // Filter out tabs with explicit count of 0
  const visibleTabs = tabs.filter((t) => t.count !== 0);

  if (visibleTabs.length === 0) return null;

  // If only one tab, render its content directly without tab chrome
  if (visibleTabs.length === 1) {
    return <>{visibleTabs[0].content}</>;
  }

  return (
    <Tabs defaultValue={visibleTabs[0].id}>
      <TabsList className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0">
        {visibleTabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <>
                <span className="sr-only"> ({tab.count})</span>
                <span aria-hidden="true" className="ml-1.5 text-[11px] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {tab.count}
                </span>
              </>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleTabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-6">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
