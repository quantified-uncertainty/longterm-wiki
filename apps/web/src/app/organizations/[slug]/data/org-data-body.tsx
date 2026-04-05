import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { EntityDbPage } from "@/components/directory/EntityDbPage";
import { DataViewTabs } from "@/components/directory/DataViewTabs";

/**
 * Body content for the organization data page.
 * Renders the Structured Facts / Database Records tabs.
 */
export function OrgDataBody({ slug }: { slug: string }) {
  const structuredContent = <FactBaseEntityBody entityId={slug} skipVerdicts />;
  const databaseContent = (
    <EntityDbPage
      slug={slug}
      backHref={`/organizations/${slug}`}
      backLabel="Back to Organization profile"
      embedded
    />
  );

  return (
    <DataViewTabs
      structuredContent={structuredContent}
      databaseContent={databaseContent}
    />
  );
}
