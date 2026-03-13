"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface OrgTab {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

/**
 * Client-side tab container for organization profile pages.
 * Receives pre-rendered server content as ReactNode children in each tab.
 */
export function OrgProfileTabs({ tabs }: { tabs: OrgTab[] }) {
  if (tabs.length === 0) return null;

  // If only one tab, render its content directly without tab chrome
  if (tabs.length === 1) {
    return <>{tabs[0].content}</>;
  }

  return (
    <Tabs defaultValue={tabs[0].id}>
      <TabsList className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
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
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-6">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
