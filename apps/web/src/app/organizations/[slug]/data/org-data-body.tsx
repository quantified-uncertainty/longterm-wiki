import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { EntityDbPage } from "@/components/directory/EntityDbPage";
import { DataViewTabs } from "@/components/directory/DataViewTabs";
import { ClaimsPipelineSummary } from "@/components/entity/claims-pipeline-summary";

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
    <div className="space-y-6">
      <DataViewTabs
        structuredContent={structuredContent}
        databaseContent={databaseContent}
      />
      <ClaimsPipelineSummary entityId={slug} />
    </div>
  );
}
