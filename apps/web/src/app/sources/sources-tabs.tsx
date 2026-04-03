"use client";

import { type ReactNode, useEffect, useState } from "react";
import { ProfileTabs } from "@/components/directory/ProfileTabs";
import { ResourcesTable, type ResourceRow } from "../resources/resources-table";
import { PublicationsTable, type PublicationRow } from "../publications/publications-table";
import { Loader2 } from "lucide-react";

interface SourcesTabsProps {
  resourceCount: number;
  publicationRows: PublicationRow[];
  publicationCount: number;
  /** Pre-rendered server content for the Data Sources tab */
  dataSourcesContent?: ReactNode;
}

export function SourcesTabs({
  resourceCount,
  publicationRows,
  publicationCount,
  dataSourcesContent,
}: SourcesTabsProps) {
  const [resourceRows, setResourceRows] = useState<ResourceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/resources/rows")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ResourceRow[]>;
      })
      .then((data) => {
        if (!cancelled) setResourceRows(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load resources"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resourceContent =
    loadError ? (
      <div className="flex items-center justify-center h-40 text-sm text-destructive">
        Failed to load resources: {loadError}
      </div>
    ) : resourceRows === null ? (
      <div className="flex items-center justify-center h-40 gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading {resourceCount.toLocaleString()} resources...
      </div>
    ) : (
      <ResourcesTable rows={resourceRows} />
    );

  return (
    <ProfileTabs
      tabs={[
        {
          id: "resources",
          label: "Resources",
          count: resourceCount,
          content: resourceContent,
        },
        {
          id: "publications",
          label: "Publications",
          count: publicationCount,
          content: <PublicationsTable publications={publicationRows} />,
        },
        ...(dataSourcesContent
          ? [
              {
                id: "data-sources",
                label: "Data Sources",
                content: dataSourcesContent,
              },
            ]
          : []),
      ]}
    />
  );
}
