"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CoverageBars } from "./coverage-bars";
import { ActionQueue } from "./action-queue";

interface SourceCheckTabsProps {
  verdictsContent: React.ReactNode;
  coverageContent: React.ReactNode;
}

const tabTriggerClass =
  "rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none";

/**
 * Client-side tab switcher for the consolidated source-check dashboard.
 * Server-rendered content is passed in as ReactNode props.
 *
 * Tabs:
 * - Verdicts: all source-check verdicts with expandable evidence and record type filters
 * - Coverage: entity type coverage analysis with visual coverage bars
 * - Action Queue: prioritized list of items needing attention
 */
export function SourceCheckTabs({
  verdictsContent,
  coverageContent,
}: SourceCheckTabsProps) {
  return (
    <Tabs defaultValue="verdicts">
      <TabsList className="w-full justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none h-auto pb-0">
        <TabsTrigger value="verdicts" className={tabTriggerClass}>
          Verdicts
        </TabsTrigger>
        <TabsTrigger value="coverage" className={tabTriggerClass}>
          Coverage
        </TabsTrigger>
        <TabsTrigger value="action-queue" className={tabTriggerClass}>
          Action Queue
        </TabsTrigger>
      </TabsList>
      <TabsContent value="verdicts" className="mt-6">
        {verdictsContent}
      </TabsContent>
      <TabsContent value="coverage" className="mt-6">
        <div className="space-y-8">
          <CoverageBars />
          {coverageContent}
        </div>
      </TabsContent>
      <TabsContent value="action-queue" className="mt-6">
        <ActionQueue />
      </TabsContent>
    </Tabs>
  );
}
