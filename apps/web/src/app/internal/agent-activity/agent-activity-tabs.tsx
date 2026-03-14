"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface AgentActivityTabsProps {
  activeContent: React.ReactNode;
  sessionsContent: React.ReactNode;
  insightsContent: React.ReactNode;
}

/**
 * Client-side tab switcher for the consolidated agent activity dashboard.
 * Server-rendered content is passed in as ReactNode props.
 */
export function AgentActivityTabs({
  activeContent,
  sessionsContent,
  insightsContent,
}: AgentActivityTabsProps) {
  return (
    <Tabs defaultValue="active">
      <TabsList className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0">
        <TabsTrigger
          value="active"
          className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          Active
        </TabsTrigger>
        <TabsTrigger
          value="sessions"
          className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          Sessions
        </TabsTrigger>
        <TabsTrigger
          value="insights"
          className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          Insights
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active" className="mt-6">
        {activeContent}
      </TabsContent>
      <TabsContent value="sessions" className="mt-6">
        {sessionsContent}
      </TabsContent>
      <TabsContent value="insights" className="mt-6">
        {insightsContent}
      </TabsContent>
    </Tabs>
  );
}
