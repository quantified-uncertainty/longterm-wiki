"use client";

import { ProfileTabs } from "@/components/directory/ProfileTabs";
import { ResourcesTable, type ResourceRow } from "../resources/resources-table";
import { PublicationsTable, type PublicationRow } from "../publications/publications-table";

interface SourcesTabsProps {
  resourceRows: ResourceRow[];
  resourceCount: number;
  publicationRows: PublicationRow[];
  publicationCount: number;
  /** Pre-rendered data sources content (server component passed as children) */
  dataSourcesContent?: React.ReactNode;
}

export function SourcesTabs({
  resourceRows,
  resourceCount,
  publicationRows,
  publicationCount,
  dataSourcesContent,
}: SourcesTabsProps) {
  return (
    <ProfileTabs
      tabs={[
        {
          id: "resources",
          label: "Resources",
          count: resourceCount,
          content: <ResourcesTable rows={resourceRows} />,
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
