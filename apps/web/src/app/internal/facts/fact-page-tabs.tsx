"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BarChart3, Database } from "lucide-react";

export function FactPageTabs({
  dashboardContent,
  dataContent,
}: {
  dashboardContent: React.ReactNode;
  dataContent: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="dashboard">
      <TabsList>
        <TabsTrigger value="dashboard" className="gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" />
          Dashboard
        </TabsTrigger>
        <TabsTrigger value="data" className="gap-1.5">
          <Database className="h-3.5 w-3.5" />
          Data
        </TabsTrigger>
      </TabsList>
      <TabsContent value="dashboard">{dashboardContent}</TabsContent>
      <TabsContent value="data">{dataContent}</TabsContent>
    </Tabs>
  );
}
