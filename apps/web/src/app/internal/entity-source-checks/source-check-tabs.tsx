"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface SourceCheckTabsProps {
  verdictsContent: React.ReactNode;
  coverageContent: React.ReactNode;
}

/**
 * Client-side tab switcher for the consolidated source-check dashboard.
 * Server-rendered content is passed in as ReactNode props.
 *
 * Previously had a FactBase tab, but it showed the same data as Verdicts
 * (which already has record type filter buttons). Removed to deduplicate.
 */
export function SourceCheckTabs({
  verdictsContent,
  coverageContent,
}: SourceCheckTabsProps) {
  return (
    <Tabs defaultValue="verdicts">
      <TabsList className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0">
        <TabsTrigger
          value="verdicts"
          className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          Verdicts
        </TabsTrigger>
        <TabsTrigger
          value="coverage"
          className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          Coverage
        </TabsTrigger>
      </TabsList>
      <TabsContent value="verdicts" className="mt-6">
        {verdictsContent}
      </TabsContent>
      <TabsContent value="coverage" className="mt-6">
        {coverageContent}
      </TabsContent>
    </Tabs>
  );
}
